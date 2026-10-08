import argparse
from collections import defaultdict, deque
from dataclasses import dataclass, field
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import secrets
import string
import threading
import time
from urllib.parse import parse_qs, urlsplit

from game import GameError, Player, Room


WEB_ROOT = Path(__file__).parent / "web"
LOGGER = logging.getLogger("room-vote")


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class LiveRoom:
    game: Room
    condition: threading.Condition = field(default_factory=threading.Condition)
    version: int = 0
    last_activity: float = field(default_factory=time.monotonic)
    seen: dict[str, float] = field(default_factory=dict)
    active_polls: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    actions: dict[str, deque] = field(default_factory=lambda: defaultdict(deque))
    timer: threading.Timer | None = None

    def changed(self) -> None:
        self.version += 1
        self.last_activity = time.monotonic()
        self.condition.notify_all()

    def authenticate(self, token: str) -> Player:
        if not token:
            raise RequestError(401, "Your session is missing. Join the room again.")
        player = next((player for player in self.game.players.values()
                       if secrets.compare_digest(player.token, token)), None)
        if player is None:
            raise RequestError(401, "This session has expired or you were removed from the room.")
        return player

    def arm_timer(self) -> None:
        if self.timer is not None:
            self.timer.cancel()
        if self.game.phase != "question" or self.game.deadline is None:
            self.timer = None
            return
        self.timer = threading.Timer(max(0, self.game.deadline - time.monotonic()), self.expire)
        self.timer.daemon = True
        self.timer.start()

    def expire(self) -> None:
        with self.condition:
            if self.game.finish_round():
                self.changed()
            elif self.game.phase == "question":
                self.arm_timer()

    def apply(self, token: str, data: dict) -> None:
        with self.condition:
            player = self.authenticate(token)
            recent = self.actions[player.id]
            now = time.monotonic()
            while recent and recent[0] < now - 10:
                recent.popleft()
            if len(recent) >= 40:
                raise RequestError(429, "Too many actions. Wait a few seconds.")
            recent.append(now)
            if self.game.finish_round():
                self.changed()
            action = data.get("action")
            if action == "vote":
                self.game.vote(player.id, data.get("candidate_id"), data.get("question_index"))
            elif action == "guests":
                self.game.set_guests(player.id, data.get("guest_ids"))
            elif action == "configure":
                self.game.configure(player.id, data.get("questions"), data.get("round_seconds"))
            elif action == "start":
                self.game.start(player.id)
                self.arm_timer()
            elif action == "advance":
                self.game.advance(player.id)
                self.arm_timer()
            elif action == "reset":
                self.game.reset(player.id)
                self.arm_timer()
            elif action == "remove":
                target = data.get("player_id")
                if not isinstance(target, str):
                    raise GameError("Choose another player to remove.")
                self.game.remove_player(player.id, target)
                self.seen.pop(target, None)
                self.actions.pop(target, None)
            else:
                raise GameError("Unknown room action.")
            self.changed()

    def snapshot(self, token: str, version: int, wait_seconds: float = 20) -> dict:
        with self.condition:
            player = self.authenticate(token)
            if self.active_polls[player.id] >= 2:
                raise RequestError(429, "This session is open in too many tabs.")
            self.active_polls[player.id] += 1
            try:
                self.seen[player.id] = time.monotonic()
                self.last_activity = time.monotonic()
                if not player.connected:
                    player.connected = True
                    self.changed()
                self.condition.wait_for(
                    lambda: self.version != version or player.id not in self.game.players,
                    timeout=wait_seconds,
                )
                player = self.authenticate(token)
                self.seen[player.id] = time.monotonic()
                if self.game.finish_round():
                    self.changed()
                snapshot = self.game.view(player.id)
                snapshot["version"] = self.version
                return snapshot
            finally:
                self.active_polls[player.id] -= 1


class RoomStore:
    def __init__(self):
        self.rooms: dict[str, LiveRoom] = {}
        self.lock = threading.Lock()
        self.created: deque = deque()
        self.stopped = threading.Event()
        self.maintenance = threading.Thread(target=self.maintain, daemon=True)
        self.maintenance.start()

    def create(self, name: str) -> tuple[LiveRoom, Player]:
        with self.lock:
            now = time.monotonic()
            while self.created and self.created[0] < now - 60:
                self.created.popleft()
            if len(self.rooms) >= 30 or len(self.created) >= 10:
                raise RequestError(429, "The server is busy. Try creating a room a little later.")
            alphabet = string.ascii_uppercase.replace("O", "").replace("I", "") + "23456789"
            code = "".join(secrets.choice(alphabet) for unused in range(6))
            while code in self.rooms:
                code = "".join(secrets.choice(alphabet) for unused in range(6))
            game = Room(code)
            player = game.add_player(name)
            room = LiveRoom(game)
            self.rooms[code] = room
            self.created.append(now)
            return room, player

    def get(self, code: str) -> LiveRoom:
        with self.lock:
            room = self.rooms.get(code.upper())
        if room is None:
            raise RequestError(404, "This room no longer exists. Ask the owner for a new link.")
        return room

    def maintain(self) -> None:
        while not self.stopped.wait(5):
            with self.lock:
                for code, room in list(self.rooms.items()):
                    with room.condition:
                        now = time.monotonic()
                        changed = False
                        for player in room.game.players.values():
                            if player.connected and now - room.seen.get(player.id, 0) > 45:
                                player.connected = False
                                changed = True
                        if changed:
                            room.changed()
                        if now - room.last_activity > 7200:
                            if room.timer is not None:
                                room.timer.cancel()
                            del self.rooms[code]

    def close(self) -> None:
        self.stopped.set()
        with self.lock:
            for room in self.rooms.values():
                with room.condition:
                    if room.timer is not None:
                        room.timer.cancel()
                    room.version += 1
                    room.condition.notify_all()
        self.maintenance.join(timeout=2)


class GameHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, store: RoomStore, allowed_origins: set[str], **kwargs):
        self.store = store
        self.allowed_origins = allowed_origins
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(35)

    def origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlsplit(origin)
        return (origin in self.allowed_origins or
                (parsed.scheme in ("http", "https") and parsed.netloc == self.headers.get("Host")))

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin and self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def log_message(self, format_string: str, *args) -> None:
        if args and " /api/" in str(args[0]):
            return
        LOGGER.info("%s %s", self.address_string(), format_string % args)

    def json_response(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def token(self) -> str:
        authorization = self.headers.get("Authorization", "")
        return authorization[7:] if authorization.startswith("Bearer ") else ""

    def body(self) -> dict:
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            raise RequestError(415, "Send application/json.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise RequestError(400, "Invalid request length.") from None
        if not 0 < length <= 16384:
            raise RequestError(413, "The request is empty or too large.")
        try:
            data = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            raise RequestError(400, "Invalid JSON request.") from None
        if not isinstance(data, dict):
            raise RequestError(400, "Send a JSON object.")
        return data

    def do_OPTIONS(self) -> None:
        if not self.origin_allowed():
            self.json_response(403, {"error": "This website is not an allowed origin."})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        self.dispatch("GET")

    def do_POST(self) -> None:
        self.dispatch("POST")

    def do_HEAD(self) -> None:
        self.dispatch("HEAD")

    def dispatch(self, method: str) -> None:
        try:
            if not self.origin_allowed():
                raise RequestError(403, "This website is not an allowed origin.")
            parts = urlsplit(self.path)
            if parts.path == "/health" and method == "GET":
                self.json_response(200, {"status": "ok"})
                return
            if parts.path.startswith("/api/"):
                self.api(method, parts.path, parse_qs(parts.query))
                return
            if method not in ("GET", "HEAD"):
                raise RequestError(405, "Method not allowed.")
            relative_path = parts.path.lstrip("/") or "index.html"
            candidate = (WEB_ROOT / relative_path).resolve()
            if not candidate.is_relative_to(WEB_ROOT.resolve()) or not candidate.is_file():
                raise RequestError(404, "File not found.")
            if method == "HEAD":
                super().do_HEAD()
            else:
                super().do_GET()
        except RequestError as error:
            self.close_connection = True
            self.json_response(error.status, {"error": str(error)})
        except GameError as error:
            self.json_response(400, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            LOGGER.exception("Request failed")
            self.close_connection = True
            self.json_response(500, {"error": "The server could not complete this request."})

    def api(self, method: str, path: str, query: dict) -> None:
        if path == "/api/rooms" and method == "POST":
            room, player = self.store.create(self.body().get("name"))
            self.json_response(201, {"code": room.game.code, "token": player.token})
            return
        segments = path.strip("/").split("/")
        if len(segments) != 4 or segments[:2] != ["api", "rooms"]:
            raise RequestError(404, "Endpoint not found.")
        room = self.store.get(segments[2])
        endpoint = segments[3]
        if endpoint == "join" and method == "POST":
            data = self.body()
            with room.condition:
                player = room.game.add_player(data.get("name"))
                room.changed()
            self.json_response(201, {"code": room.game.code, "token": player.token})
        elif endpoint == "state" and method == "GET":
            try:
                version = int(query.get("version", ["-1"])[0])
            except ValueError:
                raise RequestError(400, "Invalid room version.") from None
            self.json_response(200, room.snapshot(self.token(), version))
        elif endpoint == "action" and method == "POST":
            room.apply(self.token(), self.body())
            self.json_response(200, {"ok": True})
        else:
            raise RequestError(405, "Method not allowed.")


def make_server(host: str, port: int, store: RoomStore | None = None) -> ThreadingHTTPServer:
    allowed = {origin.strip().rstrip("/") for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
               if origin.strip()}
    handler = partial(GameHandler, store=store or RoomStore(), allowed_origins=allowed)
    return ThreadingHTTPServer((host, port), handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Room Vote live party game")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8000")))
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    store = RoomStore()
    server = make_server(arguments.host, arguments.port, store)
    LOGGER.info("Room Vote is running at http://%s:%s", arguments.host, server.server_port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        store.close()
        server.server_close()


if __name__ == "__main__":
    main()