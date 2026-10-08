import assert from "node:assert/strict";
import test from "node:test";
import {
  createControl, normalizeName, roomSnapshot, roundResult, validateGuests, validateSettings,
} from "./web/firebase-model.mjs";

function fixture() {
  const players = Object.fromEntries(["owner", "noor", "morgan", "alex", "sam"].map((identifier, index) => [identifier, {
    name: identifier === "owner" ? "Jamie" : identifier[0].toUpperCase() + identifier.slice(1),
    joined_at: index, name_key: identifier,
  }]));
  const control = { ...createControl("game-one"), phase: "question", question_index: 0,
    guest_ids: ["alex", "sam"], started_at: 100000 };
  const votes = Object.fromEntries(Object.entries({ owner: "noor", noor: "owner", morgan: "noor", alex: "noor", sam: "owner" })
    .map(([identifier, candidate]) => [identifier, { candidate_id: candidate, submitted_at: 101000 }]));
  return {
    meta: { owner_id: "owner", created_at: 90000 }, control, players,
    presence: Object.fromEntries(Object.keys(players).map((identifier) => [identifier, { connection: true }])),
    votes: { "game-one": { 0: votes } },
    voted: { "game-one": { 0: Object.fromEntries(Object.keys(votes).map((identifier) => [identifier, true])) } },
  };
}

test("Firebase model: all ballots count, ranking is descending and matching guests score", () => {
  const room = fixture();
  const result = roundResult(room.control, room.players, room.votes["game-one"][0]);
  assert.deepEqual(result.ranking.map((candidate) => candidate.count), [3, 2, 0]);
  assert.equal(result.winner_id, "noor");
  assert.deepEqual(result.guest_votes.map((guest) => guest.score), [1, 0]);
  assert.equal(result.total_votes, 5);
});

test("Firebase model: ties and missing ballots award no points", () => {
  const room = fixture();
  delete room.votes["game-one"][0].morgan;
  const tied = roundResult(room.control, room.players, room.votes["game-one"][0]);
  assert.equal(tied.tied, true);
  assert.equal(tied.winner_id, null);
  assert.deepEqual(tied.guest_votes.map((guest) => guest.score), [0, 0]);
  const empty = roundResult(room.control, room.players);
  assert.equal(empty.tied, false);
  assert.equal(empty.total_votes, 0);
});

test("Firebase model: ordinary snapshots exclude other ballots and owner history", () => {
  const room = fixture();
  const snapshot = roomSnapshot(room, "morgan", "ABC123", 105000);
  assert.equal(snapshot.remaining_ms, 5000);
  assert.equal(snapshot.own_vote, "noor");
  assert.equal(snapshot.result, null);
  assert.equal(snapshot.vote_count, 5);
  for (const key of ["audit", "audit_history", "questions", "votes"]) assert.equal(key in snapshot, false);
  assert.equal(roomSnapshot(room, "owner", "ABC123", 111000).remaining_ms, 0);
  assert.equal(roomSnapshot(room, "owner", "ABC123").audit[3].candidate_name, "Noor");
  assert.equal(roomSnapshot(room, "unknown", "ABC123"), null);
});

test("Firebase model: replaying a result never doubles scores", () => {
  const room = fixture();
  const first = roundResult(room.control, room.players, room.votes["game-one"][0]);
  const replay = roundResult(room.control, room.players, room.votes["game-one"][0], { 0: first });
  assert.deepEqual(replay, first);
  room.results = { "game-one": { 0: first } };
  room.control.phase = "finished";
  const snapshot = roomSnapshot(room, "owner", "ABC123");
  assert.equal(snapshot.players.find((player) => player.id === "alex").score, 1);
  assert.equal(snapshot.audit_history.length, 1);
  assert.equal(snapshot.history.length, 1);
  room.control = { ...createControl("game-two"), guest_ids: ["alex", "sam"] };
  const reset = roomSnapshot(room, "owner", "ABC123");
  assert.equal(reset.players.find((player) => player.id === "alex").score, 0);
  assert.equal(reset.audit_history.length, 0);
});

test("Firebase model: multi-connection presence and partial results are handled", () => {
  const room = fixture();
  room.presence.alex = { first: false, second: true };
  room.presence.sam = {};
  const snapshot = roomSnapshot(room, "owner", "ABC123");
  assert.equal(snapshot.players.find((player) => player.id === "alex").connected, true);
  assert.equal(snapshot.players.find((player) => player.id === "sam").connected, false);
  room.control.phase = "results";
  assert.equal(roomSnapshot(room, "owner", "ABC123"), null);
});

test("Firebase model: names, guest selection and question settings are validated", () => {
  assert.deepEqual(normalizeName("  Jamie   Lee  "), { name: "Jamie Lee", name_key: "jamie lee" });
  for (const name of ["", " ", "a".repeat(25), "Team/One", "a\u0000b"]) assert.throws(() => normalizeName(name));
  assert.throws(() => validateSettings([], 10));
  assert.throws(() => validateSettings(["Valid?"], 1));
  assert.deepEqual(validateSettings([" Question? "], 10).questions, ["Question?"]);
  const room = fixture();
  assert.throws(() => validateGuests(room.control, room.players, "owner", ["alex", "sam"]));
  room.control.phase = "lobby";
  for (const selected of [["owner"], ["alex", "alex"], ["alex", "sam", "noor"], ["missing"]]) {
    assert.throws(() => validateGuests(room.control, room.players, "owner", selected));
  }
  assert.deepEqual(validateGuests(room.control, room.players, "owner", ["alex", "sam"]), ["alex", "sam"]);
});