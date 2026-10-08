"use strict";

const settings = window.ROOM_VOTE_CONFIG || {};
const apiBase = (settings.apiBase || "").replace(/\/$/, "");
const firebaseMode = settings.backend === "firebase" || (settings.backend !== "python"
  && (Boolean(settings.firebase?.projectId) || (!apiBase && location.hostname.endsWith("github.io"))));
const byId = (identifier) => document.getElementById(identifier);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const icon = (name, className = "") => `<i data-lucide="${name}" class="${className}" aria-hidden="true"></i>`;
const colors = ["#d4e8da", "#f8dfac", "#d5ddf8", "#f2d2df", "#d5eae9", "#e3dfc4"];
let state = null;
let session = null;
let online = false;
let busy = false;
let mode = "host";
let pollGeneration = 0;
let pollController = null;
let deadline = 0;
let toastTimer = null;
let renderedPhase = "";
let firebaseClientPromise = null;
let unsubscribeFirebase = null;

function sessionKey(code) {
  return `room-vote:${firebaseMode ? `firebase:${settings.firebase?.projectId || "unconfigured"}:` : ""}${code}`;
}

async function firebaseClient() {
  if (!firebaseClientPromise) {
    firebaseClientPromise = import("./firebase-client.mjs")
      .then((module) => module.createFirebaseClient(settings))
      .catch((error) => { firebaseClientPromise = null; throw error; });
  }
  return firebaseClientPromise;
}

function refreshIcons() {
  window.lucide?.createIcons();
}

function avatar(player, extraClass = "") {
  const parts = player.name.split(/\s+/);
  const initials = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0]
    : Array.from(player.name).slice(0, 2).join("")).toUpperCase();
  const colorIndex = Array.from(player.id).reduce((total, character) => total + character.charCodeAt(0), 0) % colors.length;
  return `<span class="avatar ${extraClass}" style="--avatar-color:${colors[colorIndex]}" aria-hidden="true">${escapeHtml(initials)}</span>`;
}

function isOwner() {
  return state && state.self_id === state.owner_id;
}

function selfPlayer() {
  return state?.players.find((player) => player.id === state.self_id);
}

function toast(message) {
  clearTimeout(toastTimer);
  byId("toast").textContent = message;
  byId("toast").hidden = false;
  toastTimer = setTimeout(() => { byId("toast").hidden = true; }, 4500);
}

function formError(identifier, message = "") {
  byId(identifier).textContent = message;
  byId(identifier).hidden = !message;
}

function savedSession(code) {
  try { return JSON.parse(sessionStorage.getItem(sessionKey(code)) || "null"); }
  catch { return null; }
}

function rememberSession(value) {
  try { sessionStorage.setItem(sessionKey(value.code), JSON.stringify(value)); }
  catch { toast("Session storage is unavailable. Keep this page open."); }
}

function forgetSession() {
  if (!session) return;
  try { sessionStorage.removeItem(sessionKey(session.code)); }
  catch {}
}

function showJoinError(error) {
  stopPolling();
  forgetSession();
  session = null;
  state = null;
  setConnection("idle");
  byId("host-banner").hidden = true;
  byId("join-submit").disabled = false;
  byId("join-submit-label").textContent = mode === "host" ? "Create room" : "Join room";
  if (!byId("join-dialog").open) byId("join-dialog").showModal();
  formError("join-error", error.message);
}

function receiveState(snapshot) {
  const changed = !online || snapshot.version !== state?.version;
  state = snapshot;
  deadline = performance.now() + snapshot.remaining_ms;
  setConnection("live");
  byId("join-dialog").close();
  byId("join-submit").disabled = false;
  if (changed) render();
  else updateTimer();
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { Accept: "application/json", ...options.headers },
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("Cannot reach the game server. Check your connection or try again shortly.");
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("The game server is unavailable or waking up. Try again shortly."); }
  if (!response.ok) {
    const error = new Error(payload.error || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setConnection(value) {
  online = value === "live";
  byId("connection").dataset.state = value;
  byId("connection-label").textContent = ({ live: "Live", connecting: "Connecting", offline: "Reconnecting" })[value] || "Not joined";
  byId("connection-banner").hidden = !state || value !== "offline";
}

function setMode(value) {
  mode = value;
  byId("host-mode").setAttribute("aria-pressed", String(mode === "host"));
  byId("join-mode").setAttribute("aria-pressed", String(mode === "join"));
  byId("room-code-field").hidden = mode !== "join";
  byId("join-code").required = mode === "join";
  byId("join-submit-label").textContent = mode === "host" ? "Create room" : "Join room";
  formError("join-error");
}

function stopPolling() {
  pollGeneration += 1;
  pollController?.abort();
  unsubscribeFirebase?.();
  unsubscribeFirebase = null;
}

async function pollRoom() {
  stopPolling();
  const generation = pollGeneration;
  let version = -1;
  let retryDelay = 1000;
  setConnection("connecting");
  if (firebaseMode) {
    try {
      const client = await firebaseClient();
      if (generation !== pollGeneration) return;
      const stop = await client.subscribe(session, {
        onState(snapshot) {
          if (generation === pollGeneration) receiveState(snapshot);
        },
        onConnection(connected) {
          if (generation !== pollGeneration) return;
          setConnection(connected ? "live" : "offline");
          if (state) render();
        },
        onError(error) {
          if (generation !== pollGeneration) return;
          if (error.status === 401 || error.status === 404) showJoinError(error);
          else toast(error.message);
        },
      });
      if (generation === pollGeneration) unsubscribeFirebase = stop;
      else stop();
    } catch (error) {
      if (generation === pollGeneration) showJoinError(error);
    }
    return;
  }
  while (session && generation === pollGeneration) {
    pollController = new AbortController();
    const timeout = setTimeout(() => pollController?.abort(), 32000);
    try {
      const snapshot = await api(`/api/rooms/${session.code}/state?version=${version}`, {
        headers: { Authorization: `Bearer ${session.token}` }, signal: pollController.signal,
      });
      if (generation !== pollGeneration) return;
      version = snapshot.version;
      retryDelay = 1000;
      receiveState(snapshot);
    } catch (error) {
      if (generation !== pollGeneration) return;
      if (error.status === 401 || error.status === 404) {
        showJoinError(error);
        return;
      }
      setConnection("offline");
      if (state) render();
      else formError("join-error", "Waiting for the server. Reconnecting...");
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 10000);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function sendAction(action, values = {}, quiet = false) {
  if (!session || !online || busy) return false;
  busy = true;
  let succeeded = false;
  try {
    if (firebaseMode) {
      const client = await firebaseClient();
      await client.send(action, values);
    } else {
      await api(`/api/rooms/${session.code}/action`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action, ...values }), signal: AbortSignal.timeout(15000),
      });
    }
    succeeded = true;
    return true;
  } catch (error) {
    if (quiet) throw error;
    toast(error.message);
    return false;
  } finally {
    busy = false;
    if (!succeeded && state) render();
  }
}

function renderLobby() {
  const guests = state.players.filter((player) => player.role === "guest");
  const members = state.players.length - guests.length;
  const ready = guests.length === 2 && guests.every((player) => player.connected);
  return `<div class="lobby-stage"><div class="lobby-copy"><span class="tag"><span class="status-dot"></span>LOBBY OPEN</span>
    <h2>Who's in<br>the room?</h2><p class="lobby-count">${members} ${members === 1 ? "member" : "members"} &middot; ${guests.length} ${guests.length === 1 ? "guest" : "guests"}</p></div>
    <img class="ballot-art" src="./ballots.svg" width="350" height="280" alt="Colorful party ballots and a voting chart"></div>
    <div class="stage-actions">${isOwner()
      ? `<button class="button button-outline" type="button" data-command="settings" ${online ? "" : "disabled"}>${icon("sliders-horizontal")}Game setup</button>
        <button class="button button-primary" type="button" data-command="start" ${ready && online ? "" : "disabled"} title="${ready ? "Start the first question" : "Exactly two connected guests are required"}">${icon("play")}Start game</button>`
      : `<span class="waiting-status">${icon("hourglass")}Waiting for the owner to start</span><span class="muted">${guests.length}/2 guests assigned</span>`}</div>`;
}

function renderQuestion() {
  const members = state.players.filter((player) => player.role === "member");
  const guest = selfPlayer()?.role === "guest";
  const ownChoice = state.players.find((player) => player.id === state.own_vote);
  return `<div class="question-top"><span class="question-tag ${guest ? "guest" : ""}">${icon(guest ? "sparkles" : "vote")}${guest ? "YOUR GUEST PICK" : "YOUR VOTE"}</span>
    <div class="timer" id="timer" role="timer" aria-label="Time remaining">${icon("timer")}<span class="timer-number" id="timer-number">10</span><span>sec</span></div></div>
    <h2 class="question-title">${escapeHtml(state.question)}</h2><div class="timer-track" aria-hidden="true"><div id="timer-progress"></div></div>
    <fieldset class="ballot-grid"><legend class="sr-only">Vote for a member</legend>${members.map((player) => `<label class="ballot" for="vote-${player.id}">${avatar(player)}<strong>${escapeHtml(player.name)}</strong>
      <input type="radio" name="vote" id="vote-${player.id}" value="${player.id}" data-focus-key="vote-${player.id}" aria-label="Vote for ${escapeHtml(player.name)}" ${state.own_vote === player.id ? "checked" : ""} ${online ? "" : "disabled"}></label>`).join("")}</fieldset>
    <div class="vote-status"><span id="own-vote-status">${icon(ownChoice ? "circle-check" : "circle")}${ownChoice ? `Voted for ${escapeHtml(ownChoice.name)}` : "No vote submitted"}</span><span>${state.vote_count} / ${state.players.length} voted</span></div>`;
}

function chart(result) {
  const highest = Math.max(1, ...result.ranking.map((row) => row.count));
  return `<ol class="chart" aria-label="Votes, highest to lowest">${result.ranking.map((row) => `<li class="chart-row" aria-label="${escapeHtml(row.name)}: ${row.count} ${row.count === 1 ? "vote" : "votes"}">
    <span class="chart-name">${row.id === result.winner_id ? icon("crown") : ""}${escapeHtml(row.name)}</span>
    <div class="chart-track" aria-hidden="true"><div class="chart-bar" style="width:${row.count / highest * 100}%"></div></div><span class="chart-value">${row.count}</span></li>`).join("")}</ol>
    <p class="chart-caption">${result.total_votes} ${result.total_votes === 1 ? "vote" : "votes"} cast &middot; ${state.players.length - result.total_votes} did not vote</p>`;
}

function renderResults() {
  const result = state.result;
  const winner = result.ranking.find((row) => row.id === result.winner_id);
  const title = winner ? `${escapeHtml(winner.name)} takes the vote.` : result.tied ? "It's a tie." : "No votes this time.";
  const last = state.question_index + 1 === state.question_count;
  return `<div class="question-top"><span class="question-tag">${icon("chart-no-axes-combined")}THE RESULTS</span><span class="muted">Voting closed</span></div>
    <h2 class="results-title">${title}</h2><p class="results-question">${escapeHtml(state.question)}</p>${chart(result)}
    <div class="stage-actions">${isOwner()
      ? `<button class="button button-outline" type="button" data-command="reset" ${online ? "" : "disabled"}>${icon("rotate-ccw")}Back to lobby</button><button class="button button-primary" type="button" data-command="advance" ${online ? "" : "disabled"}>${last ? "Final scores" : "Next question"}${icon("arrow-right")}</button>`
      : `<span class="waiting-status">${icon("hourglass")}Waiting for the next ${last ? "screen" : "question"}</span>`}</div>`;
}

function renderFinished() {
  const guests = state.players.filter((player) => player.role === "guest");
  const highest = Math.max(...guests.map((player) => player.score));
  const winners = guests.filter((player) => player.score === highest);
  const title = highest === 0 ? "No matches this time." : winners.length > 1 ? "A shared victory." : `${escapeHtml(winners[0].name)} wins!`;
  return `<div class="final-heading"><span>${icon("trophy")}</span><h2 class="results-title">${title}</h2></div><p class="results-question">${state.question_count} questions. Final guest scores.</p>
    <div class="scoreboard">${guests.map((player) => `<div class="score-card ${highest > 0 && player.score === highest ? "winner" : ""}">${avatar(player)}<h3>${escapeHtml(player.name)}</h3><div class="big-score">${player.score} <small>/ ${state.question_count} points</small></div></div>`).join("")}</div>
    <div class="stage-actions">${isOwner() ? `<button class="button button-primary" type="button" data-command="reset" ${online ? "" : "disabled"}>${icon("rotate-ccw")}Play again</button>` : `<span class="waiting-status">${icon("hourglass")}Waiting for the owner</span>`}</div>
    <div class="history-list">${state.history.map((result, index) => `<details class="history-round"><summary>${index + 1}. ${escapeHtml(result.question)}</summary><div>${chart(result)}<p class="history-guests">${result.guest_votes.map((guest) => `${escapeHtml(guest.name)}: ${escapeHtml(guest.candidate_name || "No vote")} (${guest.matched ? "+1" : "+0"})`).join("<br>")}</p></div></details>`).join("")}</div>`;
}

function renderGuests() {
  const guests = state.players.filter((player) => player.role === "guest");
  byId("guest-meta").textContent = state.phase === "lobby" ? `${guests.length} / 2 assigned` : "1 point per match";
  byId("guest-grid").innerHTML = Array.from({ length: 2 }, (unused, index) => {
    const guest = guests[index];
    if (!guest) return `<div class="guest-card empty-guest"><span class="avatar avatar-empty">${icon("user-round")}</span><div><strong>Guest 0${index + 1}</strong><span>Not assigned</span></div>${icon("plus")}</div>`;
    const result = state.result?.guest_votes.find((vote) => vote.id === guest.id);
    let caption = state.phase === "lobby" ? "Ready for round one" : guest.has_voted ? "Vote submitted" : "No vote yet";
    if (state.phase === "finished") caption = "Final score";
    else if (result) caption = `<span class="guest-pick">${escapeHtml(result.candidate_name || "No vote")}</span><br><span class="${result.matched ? "match-text" : ""}">${result.matched ? "Matched! +1 point" : !result.candidate_id ? "Missed this round" : state.result.tied ? "Tie. No points" : "No match"}</span>`;
    return `<div class="guest-card">${avatar(guest)}<div><strong>${escapeHtml(guest.name)}</strong><span>${caption}</span></div><span class="guest-score">${guest.score}<small>pts</small></span></div>`;
  }).join("");
}

function renderPlayers() {
  const guests = state.players.filter((player) => player.role === "guest");
  byId("player-count").textContent = String(state.players.length);
  byId("roster-status").textContent = state.phase === "lobby" ? "LOBBY" : `${state.vote_count} VOTED`;
  byId("player-list").innerHTML = state.players.map((player) => {
    const owner = player.id === state.owner_id;
    const canAssign = isOwner() && state.phase === "lobby" && !owner;
    const status = !player.connected ? "Reconnecting" : owner ? "Room owner" : player.role === "guest" ? "Guest" : "Member";
    return `<li class="player-row">${avatar(player)}<div class="player-info"><span class="player-name">${escapeHtml(player.name)}${player.id === state.self_id ? " <span class='muted'>(you)</span>" : ""}</span><span class="player-sub ${player.connected ? "" : "offline"}">${status}</span></div>
      ${canAssign ? `<div class="role-tools"><label class="guest-toggle" title="Assign ${escapeHtml(player.name)} as a guest"><input type="checkbox" data-guest="${player.id}" data-focus-key="guest-${player.id}" aria-label="Make ${escapeHtml(player.name)} a guest" ${player.role === "guest" ? "checked" : ""} ${online && (guests.length < 2 || player.role === "guest") ? "" : "disabled"}>Guest</label><button class="icon-button small" type="button" data-remove="${player.id}" title="Remove ${escapeHtml(player.name)}" aria-label="Remove ${escapeHtml(player.name)}" ${online ? "" : "disabled"}>${icon("x")}</button></div>`
        : state.phase === "question" && player.has_voted ? `<span title="Vote submitted">${icon("circle-check", "voted-icon")}</span>` : `<span class="player-badge ${player.role === "guest" ? "guest" : ""}">${owner ? "OWNER" : player.role.toUpperCase()}</span>`}</li>`;
  }).join("");
  byId("question-count").textContent = String(state.question_count);
  byId("timer-setting").textContent = `${state.round_seconds} sec`;
  byId("self-label").textContent = `${selfPlayer().name} / ${isOwner() ? "Owner" : selfPlayer().role === "guest" ? "Guest" : "Member"}`;
}

function renderAudit() {
  byId("owner-audit").hidden = !isOwner();
  if (!isOwner()) return;
  const selection = byId("audit-round").value;
  byId("audit-round").innerHTML = `<option value="current">Current question</option>${state.audit_history.map((round, index) => `<option value="${index}">Question ${index + 1}</option>`).join("")}`;
  if (selection === "current" || Number(selection) < state.audit_history.length) byId("audit-round").value = selection;
  const selected = byId("audit-round").value;
  const rows = selected === "current" ? state.audit : state.audit_history[Number(selected)].votes;
  byId("audit-rows").innerHTML = rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${row.role === "guest" ? "Guest" : "Member"}</td><td>${escapeHtml(row.candidate_name || "Not voted")}</td></tr>`).join("");
}

function render() {
  if (!state) return;
  const focusKey = document.activeElement?.dataset.focusKey;
  const phaseKey = `${state.phase}:${state.question_index}`;
  byId("room-code").textContent = state.code;
  byId("invite-button").hidden = false;
  byId("leave-button").hidden = false;
  const labels = { lobby: "THE LOBBY", question: "MAKE YOUR PICK", results: "THE ROOM HAS SPOKEN", finished: "THAT'S A WRAP" };
  byId("phase-label").textContent = labels[state.phase];
  byId("footer-phase").textContent = labels[state.phase];
  byId("round-meta").textContent = state.phase === "lobby" ? `${state.question_count} ${state.question_count === 1 ? "question" : "questions"} / ${state.round_seconds} seconds each` : `ROUND ${String(state.question_index + 1).padStart(2, "0")} / ${String(state.question_count).padStart(2, "0")}`;
  byId("stage").innerHTML = ({ lobby: renderLobby, question: renderQuestion, results: renderResults, finished: renderFinished })[state.phase]();
  if (renderedPhase !== phaseKey) {
    byId("stage").classList.remove("phase-enter");
    void byId("stage").offsetWidth;
    byId("stage").classList.add("phase-enter");
    byId("announcer").textContent = state.phase === "question" ? `Question ${state.question_index + 1}. ${state.question}` : labels[state.phase];
    renderedPhase = phaseKey;
  }
  renderGuests();
  renderPlayers();
  renderAudit();
  refreshIcons();
  updateTimer();
  if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function updateTimer() {
  const ownerOffline = firebaseMode && state && !state.players.find((player) => player.id === state.owner_id)?.connected;
  const waitingForResults = firebaseMode && state?.phase === "question" && performance.now() >= deadline;
  byId("host-banner").hidden = !ownerOffline && !waitingForResults;
  byId("host-banner").textContent = waitingForResults
    ? "Voting closed. Waiting for the owner to publish results."
    : "The owner is offline. Waiting for them to reconnect.";
  if (!state || state.phase !== "question") return;
  const remaining = Math.max(0, deadline - performance.now());
  const seconds = Math.ceil(remaining / 1000);
  if (byId("timer-number")) byId("timer-number").textContent = String(seconds).padStart(2, "0");
  byId("timer")?.classList.toggle("urgent", seconds <= 3);
  byId("timer-progress")?.style.setProperty("--progress", String(Math.min(1, remaining / (state.round_seconds * 1000))));
  document.querySelectorAll('input[name="vote"]').forEach((input) => { input.disabled = remaining <= 0 || !online; });
  if (remaining <= 0 && byId("own-vote-status")) byId("own-vote-status").textContent = "Closing votes...";
}

byId("host-mode").addEventListener("click", () => setMode("host"));
byId("join-mode").addEventListener("click", () => setMode("join"));
byId("join-dialog").addEventListener("cancel", (event) => event.preventDefault());
byId("join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (byId("join-submit").disabled) return;
  const name = byId("player-name").value.trim();
  const code = byId("join-code").value.trim().toUpperCase();
  formError("join-error");
  byId("join-submit").disabled = true;
  byId("join-submit-label").textContent = "Joining...";
  try {
    if (firebaseMode) {
      const client = await firebaseClient();
      session = await client.join(name, mode, code);
    } else {
      if (!apiBase && location.hostname.endsWith("github.io")) throw new Error("The hosted game server URL has not been configured yet.");
      session = await api(mode === "host" ? "/api/rooms" : `/api/rooms/${code}/join`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }), signal: AbortSignal.timeout(75000),
      });
    }
    rememberSession(session);
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("room", session.code);
    history.replaceState(null, "", url);
    pollRoom();
  } catch (error) {
    byId("join-submit").disabled = false;
    byId("join-submit-label").textContent = mode === "host" ? "Create room" : "Join room";
    formError("join-error", error.message);
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.matches('input[name="vote"]')) {
    await sendAction("vote", { candidate_id: target.value, question_index: state.question_index });
  } else if (target.dataset.guest) {
    const guestIds = state.players.filter((player) => player.role === "guest").map((player) => player.id);
    const changed = target.checked ? [...guestIds, target.dataset.guest] : guestIds.filter((identifier) => identifier !== target.dataset.guest);
    await sendAction("guests", { guest_ids: changed });
  } else if (target.id === "audit-round") renderAudit();
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.close) byId(button.dataset.close).close();
  if (button.dataset.remove) {
    const player = state.players.find((candidate) => candidate.id === button.dataset.remove);
    if (confirm(`Remove ${player.name} from the room?`)) await sendAction("remove", { player_id: player.id });
  }
  const command = button.dataset.command;
  if (command === "settings") {
    byId("round-seconds").value = String(state.round_seconds);
    byId("questions-input").value = state.questions.join("\n");
    formError("settings-error");
    byId("settings-dialog").showModal();
  } else if (command === "reset") {
    if (confirm("Return to the lobby and clear scores and ballot history?")) await sendAction("reset");
  } else if (command === "start" || command === "advance") await sendAction(command);
});

byId("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("settings-error");
  byId("save-settings").disabled = true;
  try {
    const questions = byId("questions-input").value.split(/\r?\n/).map((question) => question.trim()).filter(Boolean);
    const saved = await sendAction("configure", { questions, round_seconds: Number(byId("round-seconds").value) }, true);
    if (saved) byId("settings-dialog").close();
  } catch (error) { formError("settings-error", error.message); }
  finally { byId("save-settings").disabled = false; }
});

function inviteUrl() {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("room", session.code);
  url.hash = "";
  return url.href;
}

byId("invite-button").addEventListener("click", () => {
  byId("invite-url").value = inviteUrl();
  byId("copy-status").textContent = "";
  byId("invite-dialog").showModal();
  byId("invite-url").select();
});

byId("copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    byId("copy-status").textContent = "Room link copied.";
  } catch {
    byId("invite-url").focus();
    byId("invite-url").select();
    byId("copy-status").textContent = "Copy the selected room link.";
  }
});

byId("leave-button").addEventListener("click", () => {
  const message = isOwner() ? "Leave this room? Keep this tab to recover owner access with the room link." : "Leave this room?";
  if (!confirm(message)) return;
  stopPolling();
  if (!isOwner()) forgetSession();
  location.href = location.pathname;
});

const initialCode = new URL(location.href).searchParams.get("room")?.trim().toUpperCase();
if (initialCode) {
  byId("join-code").value = initialCode;
  setMode("join");
  session = savedSession(initialCode);
}
byId("join-dialog").showModal();
refreshIcons();
setInterval(updateTimer, 100);
if ((firebaseMode ? session?.uid : session?.token) && session.code === initialCode) {
  byId("join-submit").disabled = true;
  byId("join-submit-label").textContent = "Rejoining...";
  pollRoom();
}