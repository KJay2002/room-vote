from collections import Counter
from dataclasses import dataclass, field
import secrets
import time


DEFAULT_QUESTIONS = [
    "Who is the funniest person in the room?",
    "Who would plan the best surprise party?",
    "Who is most likely to become famous?",
    "Who gives the best advice?",
    "Who would survive longest on a deserted island?",
    "Who has the most contagious laugh?",
    "Who is most likely to be late to their own party?",
    "Who would make the best game show host?",
    "Who is the most competitive?",
    "Who would you pick as your road trip partner?",
]


class GameError(ValueError):
    pass


@dataclass
class Player:
    name: str
    id: str = field(default_factory=lambda: secrets.token_urlsafe(12))
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32), repr=False)
    role: str = "member"
    score: int = 0
    connected: bool = False


@dataclass
class Room:
    code: str
    owner_id: str = ""
    players: dict[str, Player] = field(default_factory=dict)
    questions: list[str] = field(default_factory=lambda: DEFAULT_QUESTIONS.copy())
    round_seconds: int = 10
    phase: str = "lobby"
    question_index: int = -1
    deadline: float | None = None
    votes: dict[str, str] = field(default_factory=dict)
    result: dict | None = None
    history: list[dict] = field(default_factory=list)
    audit_history: list[dict] = field(default_factory=list)

    def add_player(self, name: str) -> Player:
        if self.phase != "lobby":
            raise GameError("This game has started. Wait for the next lobby.")
        if not isinstance(name, str):
            raise GameError("Enter a name between 1 and 24 characters.")
        name = " ".join(name.split())
        if not 1 <= len(name) <= 24 or not name.isprintable():
            raise GameError("Enter a name between 1 and 24 characters.")
        if len(self.players) >= 40:
            raise GameError("This room is full (40 players).")
        if any(player.name.casefold() == name.casefold() for player in self.players.values()):
            raise GameError("That name is already in this room.")
        player = Player(name)
        self.players[player.id] = player
        if not self.owner_id:
            self.owner_id = player.id
        return player

    def require_owner(self, actor_id: str) -> None:
        if actor_id != self.owner_id:
            raise GameError("Only the room owner can do that.")

    def require_lobby(self) -> None:
        if self.phase != "lobby":
            raise GameError("This can only be changed in the lobby.")

    def set_guests(self, actor_id: str, guest_ids: list[str]) -> None:
        self.require_owner(actor_id)
        self.require_lobby()
        if not isinstance(guest_ids, list) or any(not isinstance(value, str) for value in guest_ids):
            raise GameError("Choose up to two guests.")
        if len(guest_ids) > 2 or len(set(guest_ids)) != len(guest_ids):
            raise GameError("Choose up to two different guests.")
        if self.owner_id in guest_ids or any(value not in self.players for value in guest_ids):
            raise GameError("Guests must be other players in this room.")
        for player in self.players.values():
            player.role = "guest" if player.id in guest_ids else "member"

    def configure(self, actor_id: str, questions: list[str], round_seconds: int) -> None:
        self.require_owner(actor_id)
        self.require_lobby()
        if not isinstance(questions, list) or not 1 <= len(questions) <= 30:
            raise GameError("Use between 1 and 30 questions.")
        if any(not isinstance(question, str) or not 1 <= len(question.strip()) <= 180
               or not question.strip().isprintable() for question in questions):
            raise GameError("Each question must have 1 to 180 printable characters.")
        if type(round_seconds) is not int or not 5 <= round_seconds <= 60:
            raise GameError("The timer must be between 5 and 60 seconds.")
        self.questions = [question.strip() for question in questions]
        self.round_seconds = round_seconds

    def start(self, actor_id: str, now: float | None = None) -> None:
        self.require_owner(actor_id)
        self.require_lobby()
        guests = [player for player in self.players.values() if player.role == "guest"]
        if len(guests) != 2:
            raise GameError("Assign exactly two guests before starting.")
        if any(not player.connected for player in guests):
            raise GameError("Both guests must be connected before starting.")
        self.question_index = -1
        self.history.clear()
        self.audit_history.clear()
        for player in self.players.values():
            player.score = 0
        self.begin_round(now)

    def begin_round(self, now: float | None = None) -> None:
        self.question_index += 1
        self.phase = "question"
        self.votes.clear()
        self.result = None
        self.deadline = (time.monotonic() if now is None else now) + self.round_seconds

    def vote(self, actor_id: str, candidate_id: str, question_index: int,
             now: float | None = None) -> None:
        current_time = time.monotonic() if now is None else now
        if self.phase != "question" or self.deadline is None or current_time >= self.deadline:
            raise GameError("Voting is closed for this question.")
        if type(question_index) is not int or question_index != self.question_index:
            raise GameError("That vote belongs to an earlier question.")
        if actor_id not in self.players:
            raise GameError("Join the room before voting.")
        if not isinstance(candidate_id, str) or candidate_id not in self.players:
            raise GameError("Choose a member in this room.")
        if self.players[candidate_id].role != "member":
            raise GameError("Only members appear on the ballot.")
        self.votes[actor_id] = candidate_id

    def finish_round(self, now: float | None = None) -> bool:
        current_time = time.monotonic() if now is None else now
        if self.phase != "question" or self.deadline is None or current_time < self.deadline:
            return False
        counts = Counter(self.votes.values())
        ranking = sorted(
            [{"id": player.id, "name": player.name, "count": counts[player.id]}
             for player in self.players.values() if player.role == "member"],
            key=lambda row: (-row["count"], row["name"].casefold(), row["id"]),
        )
        highest = ranking[0]["count"] if ranking else 0
        leaders = [row for row in ranking if row["count"] == highest] if highest else []
        winner_id = leaders[0]["id"] if len(leaders) == 1 else None
        guest_votes = []
        for player in self.players.values():
            if player.role != "guest":
                continue
            choice = self.votes.get(player.id)
            matched = winner_id is not None and choice == winner_id
            player.score += int(matched)
            guest_votes.append({
                "id": player.id, "name": player.name, "candidate_id": choice,
                "candidate_name": self.players[choice].name if choice else None,
                "matched": matched, "score": player.score,
            })
        self.result = {
            "question": self.questions[self.question_index],
            "ranking": ranking, "winner_id": winner_id,
            "tied": len(leaders) > 1, "total_votes": len(self.votes),
            "guest_votes": guest_votes,
        }
        self.history.append(self.result)
        self.audit_history.append({
            "question": self.questions[self.question_index], "votes": self.ballots(),
        })
        self.phase = "results"
        self.deadline = None
        return True

    def advance(self, actor_id: str, now: float | None = None) -> None:
        self.require_owner(actor_id)
        if self.phase != "results":
            raise GameError("Wait for the current question to finish.")
        if self.question_index + 1 == len(self.questions):
            self.phase = "finished"
        else:
            self.begin_round(now)

    def reset(self, actor_id: str) -> None:
        self.require_owner(actor_id)
        if self.phase not in ("results", "finished"):
            raise GameError("Wait for the current question to finish.")
        self.phase = "lobby"
        self.question_index = -1
        self.deadline = None
        self.votes.clear()
        self.result = None
        self.history.clear()
        self.audit_history.clear()
        for player in self.players.values():
            player.score = 0

    def remove_player(self, actor_id: str, player_id: str) -> None:
        self.require_owner(actor_id)
        self.require_lobby()
        if player_id == self.owner_id or player_id not in self.players:
            raise GameError("Choose another player to remove.")
        del self.players[player_id]

    def ballots(self) -> list[dict]:
        return [{
            "id": player.id, "name": player.name, "role": player.role,
            "candidate_id": self.votes.get(player.id),
            "candidate_name": self.players[self.votes[player.id]].name
            if player.id in self.votes else None,
        } for player in self.players.values()]

    def view(self, viewer_id: str, now: float | None = None) -> dict:
        current_time = time.monotonic() if now is None else now
        owner = viewer_id == self.owner_id
        snapshot = {
            "type": "state", "code": self.code, "owner_id": self.owner_id,
            "self_id": viewer_id, "phase": self.phase,
            "players": [{
                "id": player.id, "name": player.name, "role": player.role,
                "score": player.score, "connected": player.connected,
                "has_voted": player.id in self.votes,
            } for player in self.players.values()],
            "question_index": self.question_index, "question_count": len(self.questions),
            "question": self.questions[self.question_index] if self.question_index >= 0 else None,
            "round_seconds": self.round_seconds,
            "remaining_ms": max(0, int((self.deadline - current_time) * 1000))
            if self.deadline is not None else 0,
            "own_vote": self.votes.get(viewer_id), "vote_count": len(self.votes),
            "result": self.result, "history": self.history if self.phase == "finished" else [],
        }
        if owner:
            snapshot["questions"] = self.questions.copy()
            snapshot["audit"] = self.ballots()
            snapshot["audit_history"] = self.audit_history
        return snapshot