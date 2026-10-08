export const DEFAULT_QUESTIONS = [
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
];

export function normalizeName(value) {
  if (typeof value !== "string") throw new Error("Enter a name between 1 and 24 characters.");
  const name = value.trim().replace(/\s+/gu, " ");
  if (!name || Array.from(name).length > 24 || /\p{C}/u.test(name)) {
    throw new Error("Enter a name between 1 and 24 printable characters.");
  }
  if (/[.#$\[\]\/]/u.test(name)) throw new Error("Names cannot contain . # $ [ ] or / in Firebase rooms.");
  return { name, name_key: name.toLowerCase() };
}

export function validateSettings(questions, roundSeconds) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 30) {
    throw new Error("Use between 1 and 30 questions.");
  }
  if (questions.some((question) => typeof question !== "string" || !question.trim()
      || question.trim().length > 180 || /\p{C}/u.test(question.trim()))) {
    throw new Error("Each question must have 1 to 180 printable characters.");
  }
  if (!Number.isInteger(roundSeconds) || roundSeconds < 5 || roundSeconds > 60) {
    throw new Error("The timer must be between 5 and 60 seconds.");
  }
  return { questions: questions.map((question) => question.trim()), round_seconds: roundSeconds };
}

export function createControl(gameId) {
  return {
    game_id: gameId, phase: "lobby", question_index: -1,
    round_seconds: 10, questions: [...DEFAULT_QUESTIONS], started_at: 0,
  };
}

export function guestIds(control) {
  return Object.values(control.guest_ids || {});
}

export function validateGuests(control, players, ownerId, selected) {
  if (control.phase !== "lobby") throw new Error("Guests can only be assigned in the lobby.");
  if (!Array.isArray(selected) || selected.length > 2 || new Set(selected).size !== selected.length
      || selected.some((identifier) => typeof identifier !== "string" || !players[identifier] || identifier === ownerId)) {
    throw new Error("Choose up to two different guests other than the owner.");
  }
  return selected;
}

export function isConnected(connections) {
  return Object.values(connections || {}).some((connection) => connection === true);
}

export function orderedResults(results = {}) {
  return Object.entries(results).sort(([left], [right]) => Number(left) - Number(right)).map((entry) => entry[1]);
}

export function guestScores(results = {}) {
  const scores = {};
  for (const result of orderedResults(results)) {
    for (const guest of Object.values(result.guest_votes || {})) {
      scores[guest.id] = (scores[guest.id] || 0) + Number(guest.matched === true);
    }
  }
  return scores;
}

export function roundResult(control, players, votes = {}, previousResults = {}) {
  const guests = guestIds(control);
  const memberIds = Object.keys(players).filter((identifier) => !guests.includes(identifier));
  const accepted = Object.entries(votes).filter(([identifier, vote]) => players[identifier]
    && memberIds.includes(vote.candidate_id));
  const counts = new Map(memberIds.map((identifier) => [identifier, 0]));
  for (const [, vote] of accepted) counts.set(vote.candidate_id, counts.get(vote.candidate_id) + 1);
  const ranking = memberIds.map((identifier) => ({ id: identifier, name: players[identifier].name, count: counts.get(identifier) }))
    .sort((left, right) => right.count - left.count
      || left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || left.id.localeCompare(right.id));
  const highest = ranking[0]?.count || 0;
  const leaders = highest ? ranking.filter((candidate) => candidate.count === highest) : [];
  const winnerId = leaders.length === 1 ? leaders[0].id : null;
  const scores = guestScores(Object.fromEntries(Object.entries(previousResults)
    .filter(([index]) => Number(index) < control.question_index)));
  return {
    question: control.questions[control.question_index], ranking, winner_id: winnerId,
    tied: leaders.length > 1, total_votes: accepted.length,
    guest_votes: guests.map((identifier) => {
      const choice = votes[identifier]?.candidate_id || null;
      const matched = winnerId !== null && choice === winnerId;
      return {
        id: identifier, name: players[identifier].name, candidate_id: choice,
        candidate_name: choice ? players[choice]?.name || null : null,
        matched, score: (scores[identifier] || 0) + Number(matched),
      };
    }),
  };
}

export function roomSnapshot(room, viewerId, code, now = Date.now(), version = 0) {
  const { meta, control, players = {}, presence = {} } = room;
  if (!meta || !control || !players[viewerId]) return null;
  const results = room.results?.[control.game_id] || {};
  const result = results[control.question_index] || null;
  if ((control.phase === "results" || control.phase === "finished") && !result) return null;
  const guests = guestIds(control);
  const allVotes = room.votes?.[control.game_id] || {};
  const votes = allVotes[control.question_index] || {};
  const voted = room.voted?.[control.game_id]?.[control.question_index] || {};
  const scores = guestScores(results);
  const roster = Object.entries(players).sort(([leftId, left], [rightId, right]) => left.joined_at - right.joined_at
    || leftId.localeCompare(rightId)).map(([identifier, player]) => ({
    id: identifier, name: player.name, role: guests.includes(identifier) ? "guest" : "member",
    score: scores[identifier] || 0, connected: isConnected(presence[identifier]), has_voted: voted[identifier] === true,
  }));
  const snapshot = {
    type: "state", version, code, owner_id: meta.owner_id, self_id: viewerId, phase: control.phase,
    players: roster, question_index: control.question_index, question_count: control.questions.length,
    question: control.question_index >= 0 ? control.questions[control.question_index] : null,
    round_seconds: control.round_seconds,
    remaining_ms: control.phase === "question" ? Math.max(0, control.started_at + control.round_seconds * 1000 - now) : 0,
    own_vote: votes[viewerId]?.candidate_id || null,
    vote_count: Object.values(voted).filter((value) => value === true).length,
    result: ["results", "finished"].includes(control.phase) ? result : null,
    history: control.phase === "finished" ? orderedResults(results) : [],
    host_required: true,
  };
  if (viewerId === meta.owner_id) {
    const ballots = (roundVotes) => roster.map((player) => ({
      id: player.id, name: player.name, role: player.role,
      candidate_id: roundVotes[player.id]?.candidate_id || null,
      candidate_name: players[roundVotes[player.id]?.candidate_id]?.name || null,
    }));
    snapshot.questions = [...control.questions];
    snapshot.audit = ballots(votes);
    snapshot.audit_history = Object.keys(results).sort((left, right) => Number(left) - Number(right))
      .map((index) => ({ question: control.questions[index], votes: ballots(allVotes[index] || {}) }));
  }
  return snapshot;
}