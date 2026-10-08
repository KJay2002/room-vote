import assert from "node:assert/strict";
import test from "node:test";
import {
  answerOptions, createControl, normalizeName, roomSnapshot, roundResult, validateAnswerNames, validateGuests, validateSettings,
} from "./web/firebase-model.mjs";
import { completedRoundReport, excelWorkbookXml, topVoteSummary } from "./web/round-report.mjs";

function fixture() {
  const players = Object.fromEntries(["owner", "noor", "morgan", "alex", "sam"].map((identifier, index) => [identifier, {
    name: identifier === "owner" ? "Jamie" : identifier[0].toUpperCase() + identifier.slice(1),
    joined_at: index, name_key: identifier,
  }]));
  const control = { ...createControl("game-one"), phase: "question", question_index: 0,
    guest_ids: ["alex", "sam"], started_at: 100000, answer_options: validateAnswerNames(["Jamie", "Noor", "Morgan"]) };
  const votes = Object.fromEntries(Object.entries({ owner: "option-002", noor: "option-001", morgan: "option-002", alex: "option-002", sam: "option-001" })
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
  assert.equal(result.winner_id, "option-002");
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
  assert.equal(snapshot.own_vote, "option-002");
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
  for (const duration of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateSettings(["Valid?"], duration));
  }
  assert.equal(validateSettings(["Valid?"], 1).round_seconds, 1);
  assert.equal(validateSettings(["Valid?"], 3600).round_seconds, 3600);
  const questions = Array.from({ length: 100 }, (unused, index) => `Question ${index + 1}?`);
  assert.equal(validateSettings(questions, 120).questions.length, 100);
  assert.deepEqual(validateSettings([" Question? "], 10).questions, ["Question?"]);
  const room = fixture();
  assert.throws(() => validateGuests(room.control, room.players, "owner", ["alex", "sam"]));
  room.control.phase = "lobby";
  for (const selected of [["owner"], ["alex", "alex"], ["alex", "sam", "noor"], ["missing"]]) {
    assert.throws(() => validateGuests(room.control, room.players, "owner", selected));
  }
  assert.deepEqual(validateGuests(room.control, room.players, "owner", ["alex", "sam"]), ["alex", "sam"]);
});

function finishedSnapshot() {
  const room = fixture();
  const first = roundResult(room.control, room.players, room.votes["game-one"][0]);
  const tiedVotes = { ...room.votes["game-one"][0] };
  delete tiedVotes.morgan;
  room.control.questions = ["Repeated question?", "Repeated question?", "No votes?"];
  first.question = room.control.questions[0];
  room.control.question_index = 1;
  const second = roundResult(room.control, room.players, tiedVotes, { 0: first });
  room.control.question_index = 2;
  const third = roundResult(room.control, room.players, {}, { 0: first, 1: second });
  room.control.phase = "finished";
  room.votes["game-one"][1] = tiedVotes;
  room.votes["game-one"][2] = {};
  room.results = { "game-one": { 0: first, 1: second, 2: third } };
  return roomSnapshot(room, "owner", "ABC123");
}

test("Round summary: top-question counts include ties, exclude zero-vote rounds, and preserve question numbers", () => {
  const snapshot = finishedSnapshot();
  const summary = topVoteSummary(snapshot.history, snapshot.answer_options);
  assert.deepEqual(summary.map((member) => [member.name, member.questions.length]), [["Noor", 2], ["Jamie", 1], ["Morgan", 0]]);
  assert.deepEqual(summary[0].questions.map((question) => [question.number, question.tied]), [[1, false], [2, true]]);
  assert.equal(summary[0].outright, 1);
  assert.equal(summary[0].tied, 1);
  assert.equal(summary[0].totalVotes, 5);
  assert.equal(summary.some((member) => member.id === "alex"), false);
});

test("Round export: contains every question, top result, guest pick and individual ballot", () => {
  const report = completedRoundReport(finishedSnapshot());
  assert.equal(report.questionCount, 3);
  assert.equal(report.questions.length, 3);
  assert.equal(report.votes.length, 15);
  assert.equal(report.guests.length, 6);
  assert.deepEqual(report.questions.map((question) => question.maxVotes), [3, 2, 0]);
  assert.equal(report.questions[1].tied, true);
  assert.equal(report.questions[2].topMembers, "No votes");
  assert.equal(report.questions[2].missingVotes, 5);
  assert.equal(report.votes.filter((vote) => vote.number === 2 && vote.player === "Morgan")[0].submitted, false);
});

test("Round export: unavailable mid-game, to non-owners or while private ballots are incomplete", () => {
  const snapshot = finishedSnapshot();
  assert.throws(() => completedRoundReport({ ...snapshot, phase: "results" }), /after all questions/);
  assert.throws(() => completedRoundReport({ ...snapshot, self_id: "alex" }), /Only the room owner/);
  assert.throws(() => completedRoundReport({ ...snapshot, history: snapshot.history.slice(0, 2) }), /after all questions/);
  assert.throws(() => completedRoundReport({ ...snapshot, audit_history: [] }), /not ready/);
  snapshot.audit_history[0].votes[0].candidate_id = null;
  assert.throws(() => completedRoundReport(snapshot), /still syncing/);
});

test("Round summary: each new game is independent and labels stay plain data", () => {
  const snapshot = finishedSnapshot();
  snapshot.history[0].question = "=SUM(1,2) <script>";
  snapshot.audit_history[0].question = snapshot.history[0].question;
  assert.equal(completedRoundReport(snapshot).questions[0].question, "=SUM(1,2) <script>");
  const nextGame = topVoteSummary([], snapshot.answer_options);
  assert.equal(nextGame.length, 3);
  assert.ok(nextGame.every((member) => member.questions.length === 0 && member.totalVotes === 0));
});

test("Live scoreboard: completed results remain visible during later questions without private ballots", () => {
  const room = fixture();
  assert.equal(roomSnapshot(room, "morgan", "ABC123").history.length, 0);
  const first = roundResult(room.control, room.players, room.votes["game-one"][0]);
  room.results = { "game-one": { 0: first } };
  room.control.question_index = 1;
  room.control.started_at = 120000;
  const snapshot = roomSnapshot(room, "morgan", "ABC123", 121000);
  assert.equal(snapshot.phase, "question");
  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.history[0].winner_id, "option-002");
  assert.equal(snapshot.result, null);
  assert.equal("audit_history" in snapshot, false);
  assert.equal("votes" in snapshot, false);
});

test("Excel XML: six sheets contain plain text, numeric votes, ties and no formulas or macros", () => {
  const snapshot = finishedSnapshot();
  snapshot.history[0].question = '=SUM(1,2) <tag> & "quoted"';
  snapshot.audit_history[0].question = snapshot.history[0].question;
  const xml = excelWorkbookXml(snapshot, new Date("2026-10-08T12:00:00Z"));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.equal((xml.match(/<Worksheet /g) || []).length, 6);
  for (const name of ["Round", "Questions", "Scoreboard", "Top questions", "Vote details", "Member scores"]) {
    assert.ok(xml.includes(`ss:Name="${name}"`));
  }
  assert.ok(xml.includes('<Data ss:Type="String">=SUM(1,2) &lt;tag&gt; &amp; &quot;quoted&quot;</Data>'));
  assert.ok(xml.includes('<Data ss:Type="Number">3</Data>'));
  assert.ok(xml.includes("2026-10-08T12:00:00.000Z"));
  assert.equal(/ss:Formula|<script|<!DOCTYPE|<Macro|https?:\/\//i.test(xml), false);
  assert.throws(() => excelWorkbookXml({ ...snapshot, self_id: "alex" }), /Only the room owner/);
});

test("Fixed answers: sixteen default choices do not depend on who joined", () => {
  const control = createControl("fixed-answers");
  const expected = answerOptions(control);
  assert.equal(expected.length, 16);
  assert.equal(expected[0].name, "Player 01");
  const room = fixture();
  room.control.answer_options = control.answer_options;
  const first = roomSnapshot(room, "owner", "ABC123");
  room.players.newcomer = { name: "Not an answer", joined_at: 30 };
  delete room.players.morgan;
  const second = roomSnapshot(room, "owner", "ABC123");
  assert.deepEqual(first.answer_options, expected);
  assert.deepEqual(second.answer_options, expected);
  assert.equal(first.players.find((player) => player.id === "owner").role, "player");
  assert.equal(first.players.find((player) => player.id === "alex").role, "member");
});

test("Fixed answers: configured names can win without being participants", () => {
  const room = fixture();
  room.control.answer_options = validateAnswerNames(["Absent person", "Another name", "Alex"]);
  room.votes["game-one"][0] = { owner: { candidate_id: "option-001" }, alex: { candidate_id: "option-001" }, sam: { candidate_id: "owner" } };
  const result = roundResult(room.control, room.players, room.votes["game-one"][0]);
  assert.equal(result.winner_id, "option-001");
  assert.equal(result.ranking[0].name, "Absent person");
  assert.equal(result.total_votes, 2);
  assert.equal(result.guest_votes[0].candidate_name, "Absent person");
  assert.equal(result.guest_votes[0].matched, true);
  assert.equal(result.guest_votes[1].candidate_id, null);
  assert.equal(roomSnapshot(room, "owner", "ABC123").audit.find((ballot) => ballot.id === "alex").candidate_name, "Absent person");
});

test("Fixed answers: normalize names and reject empty or duplicate choices", () => {
  assert.deepEqual(validateAnswerNames([" First   Person ", "Second.Person"]), { "option-001": "First Person", "option-002": "Second.Person" });
  for (const names of [[], [" "], ["Alex", " ALEX "], ["x".repeat(49)], [123], ["a\u0000b"]]) {
    assert.throws(() => validateAnswerNames(names));
  }
  assert.deepEqual(validateSettings(["Question?"], 10, ["First", "Second"]).answer_options,
    { "option-001": "First", "option-002": "Second" });
});

test("Late arrivals: closed results and exports retain their original participants", () => {
  const room = fixture();
  const first = roundResult(room.control, room.players, room.votes["game-one"][0]);
  room.results = { "game-one": { 0: first } };
  room.players.later = { name: "Late arrival", joined_at: 111000 };
  room.control.questions = [first.question];
  room.control.phase = "finished";
  const snapshot = roomSnapshot(room, "owner", "ABC123");
  assert.equal(snapshot.players.length, 6);
  assert.equal(snapshot.result.participant_count, 5);
  assert.equal(snapshot.audit_history[0].votes.length, 5);
  const report = completedRoundReport(snapshot);
  assert.equal(report.questions[0].missingVotes, 0);
  assert.equal(report.votes.length, 5);
  assert.equal(roundResult(room.control, room.players, room.votes["game-one"][0]).participant_count, 5);
  room.control.question_index = 1;
  room.control.questions.push("Next question?");
  room.control.started_at = 120000;
  assert.equal(roundResult(room.control, room.players).participant_count, 6);
});