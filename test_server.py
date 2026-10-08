from concurrent.futures import ThreadPoolExecutor
import json
import os
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import RoomStore, make_server


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.store = RoomStore()
        with patch.dict(os.environ, {"ALLOWED_ORIGINS": "https://example.github.io"}):
            self.server = make_server("127.0.0.1", 0, self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.store.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, data=None, token=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if origin:
            headers["Origin"] = origin
        request = Request(self.base + path, json.dumps(data).encode() if data is not None else None,
                          headers=headers)
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def room_with_players(self):
        status, owner = self.request("/api/rooms", {"name": "Owner"})
        self.assertEqual(status, 201)
        code = owner["code"]
        credentials = [owner]
        for name in ("Member", "Guest One", "Guest Two"):
            status, player = self.request(f"/api/rooms/{code}/join", {"name": name})
            self.assertEqual(status, 201)
            credentials.append(player)
        snapshots = [self.request(f"/api/rooms/{code}/state", token=player["token"])[1]
                     for player in credentials]
        return code, credentials, snapshots

    def test_authenticated_players_role_security_and_poll_broadcast(self):
        code, credentials, snapshots = self.room_with_players()
        owner, member, first_guest, second_guest = credentials
        path = f"/api/rooms/{code}"
        guest_ids = [snapshots[2]["self_id"], snapshots[3]["self_id"]]
        action = {"action": "guests", "guest_ids": guest_ids}
        status, unused = self.request(path + "/action", action, member["token"])
        self.assertEqual(status, 400)
        status, unused = self.request(path + "/action", action, owner["token"])
        self.assertEqual(status, 200)
        self.request(path + "/action", {"action": "start"}, owner["token"])
        status, before = self.request(path + "/state", token=member["token"])
        self.assertEqual(before["phase"], "question")
        self.assertNotIn("audit", before)
        with ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(self.request, path + f"/state?version={before['version']}",
                                  None, member["token"])
            self.request(path + "/action", {
                "action": "vote", "candidate_id": snapshots[1]["self_id"], "question_index": 0,
            }, first_guest["token"])
            status, after = waiting.result(timeout=3)
        self.assertEqual(after["vote_count"], 1)
        self.assertNotIn("audit", after)
        owner_view = self.request(path + "/state", token=owner["token"])[1]
        guest_row = next(row for row in owner_view["audit"] if row["id"] == guest_ids[0])
        self.assertEqual(guest_row["candidate_name"], "Member")
        self.assertEqual(self.request(path + "/state", token=second_guest["token"])[1]["self_id"],
                         guest_ids[1])

    def test_server_timer_finishes_without_a_client_action(self):
        code, credentials, snapshots = self.room_with_players()
        room = self.store.get(code)
        owner_token = credentials[0]["token"]
        room.apply(owner_token, {"action": "guests",
                                "guest_ids": [snapshots[2]["self_id"], snapshots[3]["self_id"]]})
        room.apply(owner_token, {"action": "start"})
        with room.condition:
            room.game.deadline = time.monotonic() + 0.05
            room.arm_timer()
            finished = room.condition.wait_for(lambda: room.game.phase == "results", timeout=2)
        self.assertTrue(finished)
        room.apply(owner_token, {"action": "advance"})
        private = room.snapshot(owner_token, -1)
        self.assertEqual(len(private["audit_history"]), 1)
        public = room.snapshot(credentials[1]["token"], -1)
        self.assertNotIn("audit_history", public)

    def test_authentication_origins_names_and_cross_room_tokens(self):
        code, credentials, snapshots = self.room_with_players()
        path = f"/api/rooms/{code}"
        self.assertEqual(self.request(path + "/state")[0], 401)
        self.assertEqual(self.request(path + "/state", token="forged")[0], 401)
        self.assertEqual(self.request(path + "/join", {"name": "owner"})[0], 400)
        self.assertEqual(self.request(path + "/join", {"name": "Valid"},
                                      origin="https://untrusted.example")[0], 403)
        other = self.request("/api/rooms", {"name": "Other owner"})[1]
        self.assertEqual(self.request(path + "/state", token=other["token"])[0], 401)
        self.request(path + "/action", {"action": "remove", "player_id": snapshots[1]["self_id"]},
                     credentials[0]["token"])
        self.assertEqual(self.request(path + "/state", token=credentials[1]["token"])[0], 401)

    def test_health_and_invalid_requests(self):
        self.assertEqual(self.request("/health"), (200, {"status": "ok"}))
        self.assertEqual(self.request("/api/rooms", ["not an object"])[0], 400)
        self.assertEqual(self.request("/api/rooms/MISSING/state")[0], 404)
        self.assertEqual(self.request("/game.py")[0], 404)

    def test_static_frontend_and_security_headers(self):
        for path in ("/", "/app.js", "/styles.css", "/config.js", "/ballots.svg"):
            with urlopen(self.base + path, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                self.assertGreater(len(response.read()), 20)
        for path in ("/server.py", "/../game.py", "/.github/workflows/pages.yml"):
            self.assertEqual(self.request(path)[0], 404)

    def test_github_pages_origin_and_preflight(self):
        origin = "https://example.github.io"
        request = Request(self.base + "/api/rooms", method="OPTIONS", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
        })
        with urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin)
            self.assertIn("Authorization", response.headers["Access-Control-Allow-Headers"])
        self.assertEqual(self.request("/api/rooms", {"name": "Pages owner"}, origin=origin)[0], 201)
        self.assertEqual(self.request("/api/rooms", {"name": "Blocked"},
                                      origin="https://elsewhere.example")[0], 403)


if __name__ == "__main__":
    unittest.main()