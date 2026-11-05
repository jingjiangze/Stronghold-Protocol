#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal two-player WebSocket relay for the standalone football client.

The browser host is the single simulation authority. This service assigns player slots,
relays player-2 commands to the host, broadcasts host snapshots, and retains the last
snapshot briefly so a known client token can reconnect without inventing a new match.
Bind to 127.0.0.1 by default; expose it only behind a trusted private network/tunnel.
"""
import argparse
import asyncio
import json
import secrets
import string
import time
from dataclasses import dataclass, field
from typing import Any

try:
    import websockets
except ImportError as exc:
    raise SystemExit("Install dependency first: py -m pip install -r requirements.txt") from exc

MAX_MESSAGE_BYTES = 1_000_000
ROOM_TTL_SECONDS = 900
CLIENT_TOKEN_LENGTH = 64
ROOM_ALPHABET = string.ascii_uppercase + string.digits


@dataclass
class Room:
    room_id: str
    created_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    owner_by_token: dict[str, int] = field(default_factory=dict)
    token_by_owner: dict[int, str] = field(default_factory=dict)
    peers: dict[int, Any] = field(default_factory=dict)
    last_state: dict[str, Any] | None = None
    pending_commands: list[dict[str, Any]] = field(default_factory=list)


ROOMS: dict[str, Room] = {}
PEER_INFO: dict[Any, tuple[str, int, str]] = {}
ROOM_LOCK = asyncio.Lock()


def sanitize_room_id(value: Any) -> str:
    text = str(value or "").strip().upper()
    return "".join(char for char in text if char in ROOM_ALPHABET or char == "-")[:40]


def sanitize_token(value: Any) -> str:
    token = str(value or "").strip()
    allowed = set(string.ascii_letters + string.digits + "-_")
    token = "".join(char for char in token if char in allowed)
    return token[:CLIENT_TOKEN_LENGTH]


def new_room_id() -> str:
    return "FOOTBALL-" + "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))


def message_json(message: dict[str, Any]) -> str:
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"))


async def send_json(websocket: Any, message: dict[str, Any]) -> None:
    try:
        await websocket.send(message_json(message))
    except Exception:
        pass


async def safe_send(websocket: Any, message: dict[str, Any]) -> None:
    if websocket is not None:
        await send_json(websocket, message)


async def broadcast_room(room: Room, message: dict[str, Any], skip: Any = None) -> None:
    peers = [peer for peer in room.peers.values() if peer is not None and peer is not skip]
    if not peers:
        return
    await asyncio.gather(*(safe_send(peer, message) for peer in peers), return_exceptions=True)


def choose_owner(room: Room, token: str) -> int | None:
    existing = room.owner_by_token.get(token)
    if existing in (0, 1):
        return existing
    active_tokens = set(room.owner_by_token)
    for slot in (0, 1):
        reserved = room.token_by_owner.get(slot)
        if reserved is None or reserved == token:
            if slot not in room.peers or room.peers.get(slot) is None:
                return slot
    return None


async def assign_peer(websocket: Any, room: Room, owner_id: int, token: str) -> None:
    old = room.peers.get(owner_id)
    if old is not None and old is not websocket:
        try:
            await old.close(code=4001, reason="same client token reconnected")
        except Exception:
            pass
    room.owner_by_token[token] = owner_id
    room.token_by_owner[owner_id] = token
    room.peers[owner_id] = websocket
    room.last_seen = time.time()
    PEER_INFO[websocket] = (room.room_id, owner_id, token)
    await send_json(websocket, {"type": "assigned", "roomId": room.room_id, "ownerId": owner_id,
                                "hasSnapshot": room.last_state is not None})
    if room.last_state is not None:
        await send_json(websocket, {"type": "snapshot", "roomId": room.room_id, "state": room.last_state})
    if room.pending_commands and owner_id == 0:
        pending, room.pending_commands = room.pending_commands[:100], room.pending_commands[100:]
        for command in pending:
            await send_json(websocket, command)
    await broadcast_room(room, {"type": "peer-joined", "roomId": room.room_id, "ownerId": owner_id}, skip=websocket)


async def handle_message(websocket: Any, raw: str) -> None:
    try:
        message = json.loads(raw)
    except Exception:
        await send_json(websocket, {"type": "error", "message": "JSON 无效"})
        return
    if not isinstance(message, dict):
        await send_json(websocket, {"type": "error", "message": "消息必须为对象"})
        return

    kind = str(message.get("type") or "")
    if kind in ("create", "join"):
        token = sanitize_token(message.get("clientToken"))
        if len(token) < 8:
            await send_json(websocket, {"type": "error", "message": "clientToken 无效，请刷新页面重试"})
            return
        requested_room = sanitize_room_id(message.get("roomId"))
        async with ROOM_LOCK:
            if kind == "create" and not requested_room:
                room_id = new_room_id()
                while room_id in ROOMS:
                    room_id = new_room_id()
                room = Room(room_id=room_id)
                ROOMS[room_id] = room
            elif requested_room and requested_room in ROOMS:
                room = ROOMS[requested_room]
                owner_existing = room.owner_by_token.get(token)
                if kind == "create" and owner_existing is None:
                    await send_json(websocket, {"type": "error", "message": "房间已存在，请选择“加入联机房间”"})
                    return
            elif kind == "create":
                room_id = requested_room or new_room_id()
                room = Room(room_id=room_id)
                ROOMS[room_id] = room
            else:
                await send_json(websocket, {"type": "error", "message": "房间不存在或已过期"})
                return
            owner_id = choose_owner(room, token)
            if owner_id is None:
                await send_json(websocket, {"type": "error", "message": "房间已满，两名玩家已连接"})
                return
            await assign_peer(websocket, room, owner_id, token)
        return

    info = PEER_INFO.get(websocket)
    if not info:
        await send_json(websocket, {"type": "error", "message": "请先创建或加入房间"})
        return
    room_id, owner_id, token = info
    room = ROOMS.get(room_id)
    if room is None:
        await send_json(websocket, {"type": "error", "message": "房间已过期"})
        return
    room.last_seen = time.time()

    if kind == "snapshot":
        if owner_id != 0:
            await send_json(websocket, {"type": "error", "message": "只有房主可发布权威状态"})
            return
        state = message.get("state")
        if not isinstance(state, dict):
            await send_json(websocket, {"type": "error", "message": "状态快照无效"})
            return
        room.last_state = state
        await broadcast_room(room, {"type": "snapshot", "roomId": room_id, "state": state}, skip=websocket)
    elif kind == "command":
        action = str(message.get("action") or "")
        if action not in {"deploy", "withdraw", "skill", "item", "itemDeploy", "requestCost", "respondCost", "ready", "restart", "mark", "pause", "speed"}:
            await send_json(websocket, {"type": "error", "message": "未允许的命令"})
            return
        command = {"type": "command", "roomId": room_id, "ownerId": owner_id,
                   "action": action, "payload": message.get("payload") if isinstance(message.get("payload"), dict) else {}}
        if owner_id == 0:
            await broadcast_room(room, {"type": "host-command", "roomId": room_id, "action": action}, skip=websocket)
        else:
            host = room.peers.get(0)
            if host is None:
                if len(room.pending_commands) < 100:
                    room.pending_commands.append(command)
                await send_json(websocket, {"type": "warning", "message": "房主掉线，命令已暂存等待重连"})
            else:
                await send_json(host, command)
    elif kind == "ping":
        await send_json(websocket, {"type": "pong", "time": time.time()})
    else:
        await send_json(websocket, {"type": "error", "message": "未知消息类型"})


async def connection(websocket: Any, path: str | None = None) -> None:
    try:
        async for raw in websocket:
            if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
                await send_json(websocket, {"type": "error", "message": "消息超过大小限制"})
                await websocket.close(code=1009, reason="message too large")
                break
            await handle_message(websocket, raw)
    except Exception:
        pass
    finally:
        info = PEER_INFO.pop(websocket, None)
        if info:
            room_id, owner_id, token = info
            room = ROOMS.get(room_id)
            if room and room.peers.get(owner_id) is websocket:
                room.peers[owner_id] = None
                room.last_seen = time.time()
                await broadcast_room(room, {"type": "peer-left", "roomId": room_id, "ownerId": owner_id})
        try:
            await websocket.close()
        except Exception:
            pass


async def expire_rooms() -> None:
    while True:
        await asyncio.sleep(30)
        cutoff = time.time() - ROOM_TTL_SECONDS
        async with ROOM_LOCK:
            expired = [room_id for room_id, room in ROOMS.items()
                       if room.last_seen < cutoff and not any(room.peers.values())]
            for room_id in expired:
                ROOMS.pop(room_id, None)


async def main_async(host: str, port: int) -> None:
    asyncio.create_task(expire_rooms())
    print("football room relay -> ws://%s:%s" % (host, port))
    print("Bind to 127.0.0.1 for local tests; use a trusted tunnel/private network for remote co-op.")
    async with websockets.serve(connection, host, port, max_size=MAX_MESSAGE_BYTES, ping_interval=20, ping_timeout=20):
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    try:
        asyncio.run(main_async(args.host, args.port))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
