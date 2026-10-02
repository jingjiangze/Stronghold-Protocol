// webrtc-bridge.mjs — host-side WebRTC DataChannel ↔ local WebSocket bridge.
// Started by server/index.js (shell patch) when SP_DIR_URL is set and SP_DC != 0.
// The room owner's phone punches a direct DataChannel to each joining client and
// pipes it to the game server's own WebSocket endpoint on loopback, so clients that
// cannot reach the host over TCP (double CGNAT) still play P2P. Falls back gracefully:
// clients that fail here use the box-hosted room instead.
import { RTCPeerConnection } from 'werift';
import WebSocket from 'ws';

const STUN = () =>
  (process.env.SP_STUN || 'stun:stun.qq.com:3478,stun:stun.miwifi.com:3478,stun:stun.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const DIR = () => (process.env.SP_DIR_URL || '').replace(/\/+$/, '');

export function startBridge({ port }) {
  if (!DIR()) {
    console.error('[dc-bridge] SP_DIR_URL not set, disabled');
    return;
  }
  console.log(`[dc-bridge] watching rooms on 127.0.0.1:${port}, signaling via ${DIR()}`);
  setInterval(() => tick(port).catch((e) => console.error('[dc-bridge]', e.message || e)), 2000);
}

async function tick(port) {
  const rooms = await getJson(`http://127.0.0.1:${port}/_shell/rooms`);
  const room = (rooms.rooms || [])[0]; // bridge the most recent room
  if (!room) return;
  const sig = await getJson(`${DIR()}/signal/${encodeURIComponent(room.code)}`);
  if (!sig.offer || sig.answer) return; // nothing pending / already answered
  try {
    await answerOffer(port, room.code, sig.offer);
  } catch (e) {
    console.error('[dc-bridge] answer failed', e.message || e);
  }
}

async function answerOffer(port, code, offerSdp) {
  const pc = new RTCPeerConnection({ iceServers: STUN() });
  const dc = pc.createDataChannel('ws', { ordered: true });
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await new Promise((r) => setTimeout(r, 1200)); // ICE gathering

  await postJson(`${DIR()}/signal/${encodeURIComponent(code)}`, {
    from: 'host',
    answer: pc.localDescription.sdp,
  });
  console.log('[dc-bridge] answered offer for room', code);

  dc.onopen = () => {
    console.log('[dc-bridge] datachannel open, bridging to ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => {
      if (dc.readyState === 'open') dc.send(ev.data);
    };
    ws.onclose = () => { try { dc.close(); } catch {} };
    ws.onerror = () => { try { dc.close(); } catch {} };
    dc.onmessage = (ev) => {
      if (ws.readyState === 1) ws.send(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    };
    dc.onclose = () => { try { ws.close(); } catch {} };
  };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'dc-bridge' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'dc-bridge' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
