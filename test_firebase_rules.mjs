import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { serverTimestamp } from "firebase/database";
import { createControl, normalizeName, roundResult, validateAnswerNames } from "./web/firebase-model.mjs";
import { completedRoundReport } from "./web/round-report.mjs";
import { createFirebaseClient } from "./web/firebase-client.mjs";

let environment;
const code = "ABC234";
const base = `rooms/${code}`;
const gameId = "game-first";
const database = (uid) => environment.authenticatedContext(uid).database();

before(async () => {
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) throw new Error("Run this test through npm run test:rules, never against a live database.");
  environment = await initializeTestEnvironment({
    projectId: "demo-room-vote",
    database: { rules: await readFile(new URL("./database.rules.json", import.meta.url), "utf8") },
  });
});
beforeEach(async () => { await environment.clearDatabase(); });
after(async () => { await environment?.cleanup(); });

function lobby() {
  const now = Date.now();
  const players = Object.fromEntries(["owner", "member", "guest-one", "guest-two"].map((uid) => [uid, {
    ...normalizeName(uid), joined_at: now,
  }]));
  return {
    meta: { owner_id: "owner", created_at: now },
    control: { ...createControl(gameId), questions: ["Who is funniest?", "Who gives the best advice?"], guest_ids: ["guest-one", "guest-two"] },
    players, player_count: 4,
    names: Object.fromEntries(Object.keys(players).map((uid) => [uid, uid])),
    presence: Object.fromEntries(Object.keys(players).map((uid) => [uid, { device: true }])),
  };
}

async function seed(room = lobby()) {
  await environment.withSecurityRulesDisabled(async (context) => { await context.database().ref(base).set(room); });
  return room;
}

async function begin(room = lobby()) {
  await seed(room);
  const control = { ...room.control, phase: "question", question_index: 0, started_at: serverTimestamp() };
  await assertSucceeds(database("owner").ref(`${base}/control`).set(control));
  room.control = (await database("owner").ref(`${base}/control`).once("value")).val();
  return room;
}

function castVote(uid, candidate, round = "0", game = gameId) {
  return database(uid).ref(base).update({
    [`votes/${game}/${round}/${uid}`]: { candidate_id: candidate, submitted_at: serverTimestamp() },
    [`voted/${game}/${round}/${uid}`]: true,
  });
}

test("rules: authenticated room creation is atomic and ownership cannot be taken over", async () => {
  const owner = database("creator");
  const profile = { ...normalizeName("Jamie"), joined_at: serverTimestamp() };
  const values = {
    meta: { owner_id: "creator", created_at: serverTimestamp() }, control: createControl("unique-game"),
    "players/creator": profile, "names/jamie": "creator", player_count: 1,
  };
  await assertFails(environment.unauthenticatedContext().database().ref(base).update(values));
  await assertSucceeds(owner.ref(base).update(values));
  await assertFails(database("intruder").ref(`${base}/meta/owner_id`).set("intruder"));
  await assertFails(owner.ref(`${base}/meta`).remove());
  await assertFails(owner.ref("rooms").once("value"));
  await assertFails(owner.ref(base).once("value"));
});

test("rules: joins have unique names and cannot set another player's identity or role", async () => {
  await seed();
  const joiner = database("joiner");
  const join = { "players/joiner": { ...normalizeName("Taylor"), joined_at: serverTimestamp() },
    "names/taylor": "joiner", player_count: 5 };
  await assertSucceeds(joiner.ref(base).update(join));
  await assertFails(database("second").ref(base).update({
    "players/second": { ...normalizeName("TAYLOR"), joined_at: serverTimestamp() }, "names/taylor": "second", player_count: 6,
  }));
  await assertFails(joiner.ref(`${base}/players/joiner/name`).set("Other name"));
  await assertFails(joiner.ref(`${base}/players/joiner/role`).set("owner"));
  await assertFails(joiner.ref(`${base}/control/guest_ids`).set(["joiner", "member"]));
  await assertFails(joiner.ref(`${base}/names/unused`).set("joiner"));
});

test("rules: exactly two connected guests and valid owner-controlled transitions", async () => {
  const room = await seed();
  await assertFails(database("member").ref(`${base}/control`).set({ ...room.control, phase: "question", question_index: 0, started_at: serverTimestamp() }));
  await assertFails(database("owner").ref(`${base}/control/guest_ids`).set(["owner", "guest-two"]));
  await assertFails(database("owner").ref(`${base}/control/guest_ids`).set(["guest-one", "guest-one"]));
  await assertSucceeds(database("owner").ref(`${base}/control/guest_ids`).set(["guest-one"]));
  await assertFails(database("owner").ref(`${base}/control`).update({ phase: "question", question_index: 0, started_at: serverTimestamp() }));
  await assertSucceeds(database("owner").ref(`${base}/control/guest_ids`).set(["guest-one", "guest-two"]));
  await assertSucceeds(database("guest-two").ref(`${base}/presence/guest-two/device`).remove());
  await assertFails(database("owner").ref(`${base}/control`).update({ phase: "question", question_index: 0, started_at: serverTimestamp() }));
});

test("rules: private ballots, one vote per identity, fixed answer candidates", async () => {
  await begin();
  await assertSucceeds(castVote("guest-one", "option-002"));
  await assertSucceeds(castVote("guest-two", "option-001"));
  await assertFails(database("member").ref(`${base}/votes/${gameId}/0/guest-one`).once("value"));
  await assertFails(database("member").ref(`${base}/votes`).once("value"));
  await assertSucceeds(database("owner").ref(`${base}/votes`).once("value"));
  await assertSucceeds(database("guest-one").ref(`${base}/votes/${gameId}/0/guest-one`).once("value"));
  await assertFails(database("outsider").ref(`${base}/results`).once("value"));
  await assertFails(castVote("member", "guest-one"));
  await assertFails(castVote("outsider", "option-002"));
  await assertFails(castVote("member", "option-002", "1"));
  await assertFails(castVote("member", "option-002", "0", "older-game"));
  await assertFails(database("owner").ref(`${base}/votes/${gameId}/0/guest-one/candidate_id`).set("owner"));
  await assertFails(database("member").ref(`${base}/voted/${gameId}/0/member`).set(true));
  await assertSucceeds(castVote("guest-one", "option-001"));
  const ballots = (await database("owner").ref(`${base}/votes/${gameId}/0`).once("value")).val();
  assert.equal(Object.keys(ballots).length, 2);
  assert.equal(ballots["guest-one"].candidate_id, "option-001");
});

test("rules: the database deadline rejects late votes even before the owner reveals", async () => {
  const room = lobby();
  room.control = { ...room.control, phase: "question", question_index: 0, started_at: Date.now() - 20000 };
  await seed(room);
  await assertFails(castVote("member", "option-001"));
  await assertFails(database("owner").ref(`${base}/control/started_at`).set(serverTimestamp()));
  await assertFails(database("owner").ref(`${base}/control/round_seconds`).set(60));
});

test("rules: only the owner publishes results after expiry; results cannot be rewritten", async () => {
  const room = await begin();
  const result = roundResult(room.control, room.players);
  await assertFails(database("owner").ref(`${base}/results/${gameId}/0`).set(result));
  room.control.started_at = Date.now() - 20000;
  await seed(room);
  await assertFails(database("member").ref(`${base}/results/${gameId}/0`).set(result));
  await assertSucceeds(database("owner").ref(base).update({ [`results/${gameId}/0`]: result, "control/phase": "results" }));
  await assertFails(database("owner").ref(`${base}/results/${gameId}/0/total_votes`).set(10));
  await assertSucceeds(database("member").ref(`${base}/results`).once("value"));
  await assertFails(database("member").ref(`${base}/votes/${gameId}/0/guest-one`).once("value"));
  await assertSucceeds(database("owner").ref(`${base}/control`).set({ ...room.control, phase: "question", question_index: 1, started_at: serverTimestamp() }));
});

test("rules: removing a guest is atomic and invalidates their room access", async () => {
  await seed();
  await assertFails(database("owner").ref(`${base}/players/guest-one`).remove());
  await assertSucceeds(database("owner").ref(base).update({
    "players/guest-one": null, "names/guest-one": null, player_count: 3, "control/guest_ids": ["guest-two"],
  }));
  await assertFails(database("guest-one").ref(`${base}/results`).once("value"));
  await assertFails(database("guest-one").ref(`${base}/presence/guest-one/new`).set(true));
});

test("rules: late joining allows a current vote but never role changes or answer-list edits", async () => {
  const room = await begin();
  const late = database("late");
  await assertSucceeds(late.ref(base).update({
    "players/late": { ...normalizeName("Late player"), joined_at: serverTimestamp() },
    "names/late player": "late", player_count: 5,
  }));
  await assertSucceeds(castVote("late", "option-016"));
  await assertFails(late.ref(`${base}/control/guest_ids`).set(["late", "guest-one"]));
  await assertFails(late.ref(`${base}/control/answer_options/option-016`).set("Changed"));
  await assertFails(database("owner").ref(`${base}/control/answer_options/option-016`).set("Changed"));
  await assertFails(late.ref(`${base}/votes/${gameId}/0/guest-one`).once("value"));
  const control = (await database("owner").ref(`${base}/control`).once("value")).val();
  assert.deepEqual(control.answer_options, room.control.answer_options);
  assert.deepEqual(control.guest_ids, room.control.guest_ids);
});

test("rules: many questions and timers outside the old range are accepted only in the lobby", async () => {
  await seed();
  const owner = database("owner");
  const questions = Array.from({ length: 100 }, (unused, index) => `Question ${index + 1}?`);
  await assertSucceeds(owner.ref(`${base}/control`).update({ questions, round_seconds: 3600 }));
  await assertSucceeds(owner.ref(`${base}/control/round_seconds`).set(1));
  await assertFails(owner.ref(`${base}/control/round_seconds`).set(0));
  await assertFails(owner.ref(`${base}/control/round_seconds`).set(1.5));
  await assertSucceeds(owner.ref(`${base}/control/answer_options`).set(validateAnswerNames(["Not in room", "Another person"])));
});

test("transport: fixed answers, live late joins, original participation counts, reconnect and reset", { timeout: 25000 }, async () => {
  const modules = await Promise.all([import("firebase/app"), import("firebase/auth"), import("firebase/database")]);
  const clients = [];
  const failures = [];
  const watchers = [];
  const watch = async (client, credentials) => {
    let current;
    const waiting = new Set();
    const observer = {
      until(predicate) {
        if (current && predicate(current)) return Promise.resolve(current);
        return new Promise((resolve, reject) => {
          const entry = { predicate, resolve, timer: setTimeout(() => {
            waiting.delete(entry);
            reject(new Error(`State wait timed out: ${current?.phase || "no state"}`));
          }, 12000) };
          waiting.add(entry);
        });
      },
    };
    await client.subscribe(credentials, {
      onState(snapshot) {
        current = snapshot;
        for (const entry of waiting) {
          if (!entry.predicate(snapshot)) continue;
          clearTimeout(entry.timer);
          waiting.delete(entry);
          entry.resolve(snapshot);
        }
      },
      onError(error) { failures.push(error.message); },
    });
    watchers.push(waiting);
    return observer;
  };
  try {
    for (let index = 0; index < 6; index += 1) {
      clients.push(await createFirebaseClient({
        firebase: { apiKey: "demo-key", projectId: "demo-room-vote", appId: "demo-app",
          databaseURL: "https://demo-room-vote-default-rtdb.firebaseio.com" },
        emulators: true, appName: `client-${index}`,
      }, modules));
    }
    const credentials = await clients[0].join("Jamie", "host");
    const owner = await watch(clients[0], credentials);
    await owner.until((snapshot) => snapshot.players.some((player) => player.connected));
    const observations = [owner];
    const sessions = [credentials];
    for (let index = 1; index < 4; index += 1) {
      const session = await clients[index].join(["Jamie", "Noor", "Alex", "Sam"][index], "join", credentials.code);
      sessions.push(session);
      observations.push(await watch(clients[index], session));
    }
    await owner.until((snapshot) => snapshot.players.length === 4 && snapshot.players.every((player) => player.connected));
    await assert.rejects(clients[1].send("guests", { guest_ids: [clients[2].uid, clients[3].uid] }));
    await clients[0].send("guests", { guest_ids: [clients[2].uid, clients[3].uid] });
    await owner.until((snapshot) => snapshot.players.filter((player) => player.role === "member").length === 2);
    await clients[0].send("configure", { questions: ["Who is funniest?", "Who gives advice?"], round_seconds: 3,
      answer_names: Array.from({ length: 16 }, (unused, index) => `Answer ${index + 1}`) });
    await owner.until((snapshot) => snapshot.question_count === 2 && snapshot.round_seconds === 3);
    await clients[0].send("start");
    await Promise.all(observations.map((observation) => observation.until((snapshot) => snapshot.phase === "question")));
    const lateSession = await clients[4].join("Late player", "join", credentials.code);
    const lateObserver = await watch(clients[4], lateSession);
    observations.push(lateObserver);
    const lateState = await lateObserver.until((snapshot) => snapshot.phase === "question");
    assert.equal(lateState.players.find((player) => player.id === clients[4].uid).role, "player");
    assert.equal(lateState.answer_options.length, 16);
    await Promise.all(clients.slice(0, 5).map((client, index) => client.send("vote", {
      candidate_id: index === 3 ? "option-001" : "option-002", question_index: 0,
    })));
    const audit = await owner.until((snapshot) => snapshot.vote_count === 5 && snapshot.audit.every((row) => row.candidate_id));
    assert.equal(audit.audit.length, 5);
    const results = await Promise.all(observations.map((observation) => observation.until((snapshot) => snapshot.phase === "results")));
    assert.deepEqual(results[0].result.ranking.slice(0, 2).map((candidate) => candidate.count), [4, 1]);
    assert.equal(results[0].result.ranking.length, 16);
    assert.equal(results[0].result.guest_votes[0].score, 1);
    for (const snapshot of results.slice(1)) assert.equal("audit" in snapshot, false);
    const laterSession = await clients[5].join("After first question", "join", credentials.code);
    const laterObserver = await watch(clients[5], laterSession);
    const laterState = await laterObserver.until((snapshot) => snapshot.phase === "results");
    assert.equal(laterState.history[0].participant_count, 5);
    assert.equal(laterState.players.length, 6);
    await owner.until((snapshot) => snapshot.players.length === 6);
    await clients[0].send("advance");
    await owner.until((snapshot) => snapshot.phase === "question" && snapshot.question_index === 1);
    await owner.until((snapshot) => snapshot.phase === "results" && snapshot.question_index === 1);
    await clients[0].send("advance");
    await owner.until((snapshot) => snapshot.phase === "finished");
    const completed = await owner.until((snapshot) => snapshot.audit_history.length === 2);
    const report = completedRoundReport(completed);
    assert.equal(report.votes.length, 11);
    assert.equal(report.questions[0].missingVotes, 0);
    assert.equal(report.questions[1].missingVotes, 6);
    clients[2].stop();
    const reconnect = await watch(clients[2], sessions[2]);
    const resumed = await reconnect.until((snapshot) => snapshot.phase === "finished");
    assert.equal(resumed.players.find((player) => player.id === clients[2].uid).score, 1);
    await clients[0].send("reset");
    const reset = await owner.until((snapshot) => snapshot.phase === "lobby");
    assert.equal(reset.audit_history.length, 0);
    assert.equal(reset.players.find((player) => player.id === clients[2].uid).score, 0);
    assert.deepEqual(failures, []);
  } finally {
    for (const waiting of watchers) for (const entry of waiting) clearTimeout(entry.timer);
    await Promise.all(clients.map((client) => client.close()));
  }
});