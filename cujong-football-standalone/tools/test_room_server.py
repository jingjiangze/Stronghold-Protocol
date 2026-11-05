import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server" / "room-server.py"
SPEC = importlib.util.spec_from_file_location("football_room_server", SERVER_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class RoomServerTests(unittest.TestCase):
    def test_room_code_preserves_hyphens_and_normalizes(self):
        self.assertEqual(MODULE.sanitize_room_id(" football-ab12-cd "), "FOOTBALL-AB12-CD")
        self.assertEqual(MODULE.sanitize_room_id("a b!c"), "ABC")

    def test_client_token_is_safe_and_bounded(self):
        token = MODULE.sanitize_token("abc/def_123-XYZ")
        self.assertEqual(token, "abcdef_123-XYZ")
        self.assertLessEqual(len(MODULE.sanitize_token("A" * 100)), MODULE.CLIENT_TOKEN_LENGTH)

    def test_room_id_uses_expected_prefix_and_alphabet(self):
        room_id = MODULE.new_room_id()
        self.assertTrue(room_id.startswith("FOOTBALL-"))
        self.assertEqual(len(room_id), len("FOOTBALL-") + 6)
        self.assertTrue(all(c in MODULE.ROOM_ALPHABET for c in room_id.split("-", 1)[1]))

    def test_owner_slot_reconnects_stable_token(self):
        room = MODULE.Room("FOOTBALL-ABC123")
        self.assertEqual(MODULE.choose_owner(room, "token-player-one"), 0)
        room.owner_by_token["token-player-one"] = 0
        room.token_by_owner[0] = "token-player-one"
        self.assertEqual(MODULE.choose_owner(room, "token-player-one"), 0)
        self.assertEqual(MODULE.choose_owner(room, "token-player-two"), 1)

    def test_host_snapshot_schema_can_be_serialized(self):
        payload = {"type": "snapshot", "roomId": "FOOTBALL-ABC123", "state": {"score": {"ally": 1, "enemy": 0}}}
        roundtrip = MODULE.json.loads(MODULE.message_json(payload))
        self.assertEqual(roundtrip["state"]["score"]["ally"], 1)


if __name__ == "__main__":
    unittest.main()
