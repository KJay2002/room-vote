import {
  answerOptions, createControl, guestIds, isConnected, normalizeName, roomSnapshot, roundResult, validateGuests, validateSettings,
} from "./firebase-model.mjs";

const SDK_VERSION = "12.19.0";

function errorMessage(error) {
  const messages = {
    "auth/operation-not-allowed": "Enable Anonymous sign-in in Firebase Authentication.",
    "auth/invalid-api-key": "Check the Firebase web configuration.",
    "auth/unauthorized-domain": "Add this website to Firebase Authentication's authorized domains.",
    "auth/network-request-failed": "Cannot reach Firebase. Check your connection.",
    "auth/too-many-requests": "Firebase is limiting sign-ins. Please try again later.",
    "PERMISSION_DENIED": "Firebase rejected this action. Check the room state and the published database rules.",
    "permission-denied": "Firebase rejected this action. Check the room state and the published database rules.",
  };
  const wrapped = new Error(messages[error.code] || error.message || "Could not connect to Firebase.");
  wrapped.code = error.code;
  return wrapped;
}

function sessionError(message, status = 401) {
  return Object.assign(new Error(message), { status });
}

function randomKey(length = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function createFirebaseClient(settings, suppliedModules) {
  const config = settings.firebase;
  if (!config?.apiKey || !config.projectId || !config.databaseURL || !config.appId) {
    throw new Error("Firebase is not configured. Add your Firebase web app settings to the game configuration.");
  }
  const modules = suppliedModules || await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-database.js`),
  ]);
  const [appSdk, authSdk, databaseSdk] = modules;
  const app = appSdk.initializeApp(config, settings.appName || "room-vote");
  try {
    const auth = authSdk.initializeAuth(app, {
      persistence: typeof window === "undefined" ? authSdk.inMemoryPersistence : authSdk.browserSessionPersistence,
    });
    const database = databaseSdk.getDatabase(app);
    if (settings.emulators) {
      if (!config.projectId.startsWith("demo-") || (typeof location !== "undefined"
          && !["localhost", "127.0.0.1"].includes(location.hostname))) {
        throw new Error("Emulators are restricted to localhost and a demo Firebase project.");
      }
      authSdk.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      databaseSdk.connectDatabaseEmulator(database, "127.0.0.1", 9000);
    }
    await auth.authStateReady();
    if (!auth.currentUser) await authSdk.signInAnonymously(auth);
    return new FirebaseRoomClient(app, auth.currentUser.uid, database, databaseSdk, appSdk);
  } catch (error) {
    await appSdk.deleteApp(app);
    throw errorMessage(error);
  }
}

class FirebaseRoomClient {
  constructor(app, uid, database, sdk, appSdk) {
    this.app = app;
    this.uid = uid;
    this.database = database;
    this.sdk = sdk;
    this.appSdk = appSdk;
    this.offset = 0;
    this.stop = null;
    this.active = null;
  }

  reference(path) {
    return this.sdk.ref(this.database, path);
  }

  now() {
    return Date.now() + this.offset;
  }

  async join(name, mode, requestedCode) {
    const profile = { ...normalizeName(name), joined_at: this.sdk.serverTimestamp() };
    if (mode === "host") {
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (value) => alphabet[value % alphabet.length]).join("");
        const path = `rooms/${code}`;
        if ((await this.sdk.get(this.reference(`${path}/meta`))).exists()) continue;
        await this.sdk.update(this.reference(path), {
          meta: { owner_id: this.uid, created_at: this.sdk.serverTimestamp() },
          control: createControl(randomKey()), player_count: 1,
          [`players/${this.uid}`]: profile, [`names/${profile.name_key}`]: this.uid,
        }).catch((error) => { throw errorMessage(error); });
        return { code, uid: this.uid, backend: "firebase" };
      }
      throw new Error("Could not reserve a room code. Please try again.");
    }
    const code = String(requestedCode || "").trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error("Enter a valid six-character room code.");
    const path = `rooms/${code}`;
    if (!(await this.sdk.get(this.reference(`${path}/meta`))).exists()) {
      throw sessionError("This room does not exist. Ask the owner for the invitation link.", 404);
    }
    let control;
    let players;
    try {
      [control, players] = await Promise.all([
        this.sdk.get(this.reference(`${path}/control`)), this.sdk.get(this.reference(`${path}/players`)),
      ]);
    } catch {
      throw new Error("Could not read this room. Check the invitation and database permissions.");
    }
    const roster = players.val() || {};
    if (roster[this.uid]) return { code, uid: this.uid, backend: "firebase" };
    if (!control.val()?.answer_options) throw new Error("This room uses an older game version. Ask the owner to create a new room.");
    if (Object.values(roster).some((player) => player.name_key === profile.name_key)) {
      throw new Error("That name is already in this room.");
    }
    if (Object.keys(roster).length >= 40) throw new Error("This room is full (40 players).");
    try {
      await this.sdk.update(this.reference(path), {
        [`players/${this.uid}`]: profile, [`names/${profile.name_key}`]: this.uid,
        player_count: this.sdk.increment(1),
      });
    } catch (error) {
      throw new Error(`Could not join. The name may have been taken or the room may be full. ${errorMessage(error).message}`);
    }
    return { code, uid: this.uid, backend: "firebase" };
  }

  async subscribe(credentials, callbacks) {
    this.stop?.();
    if (credentials.uid !== this.uid) throw sessionError("Your saved Firebase session has expired. Join again.");
    const path = `rooms/${credentials.code}`;
    const metadata = await this.sdk.get(this.reference(`${path}/meta`));
    if (!metadata.exists()) throw sessionError("This room no longer exists. Create a new room.", 404);
    const owner = metadata.val().owner_id === this.uid;
    const room = { meta: metadata.val() };
    const ready = new Set();
    const expected = owner ? 7 : 6;
    const subscriptions = [];
    let stopped = false;
    let online = false;
    let voteReady = owner;
    let voteKey = "";
    let unsubscribeVote = null;
    let roundTimer = null;
    let settling = false;
    let version = 0;
    let connectionRef = null;
    let presenceGeneration = 0;
    const active = { room, path, owner, online: false };
    this.active = active;

    const report = (error, fatal = false) => {
      if (stopped) return;
      callbacks.onError?.(fatal ? sessionError("Your room access has expired or the owner removed you.") : errorMessage(error));
    };
    const schedule = () => {
      clearTimeout(roundTimer);
      if (stopped || !online || !owner || settling || ready.size < expected || room.control?.phase !== "question") return;
      const remaining = room.control.started_at + room.control.round_seconds * 1000 - this.now();
      roundTimer = setTimeout(finish, Math.min(2147483647, Math.max(80, remaining + 150)));
    };
    const emit = () => {
      if (stopped || ready.size < expected || !voteReady || !online) return;
      if (!room.players?.[this.uid]) {
        report(new Error("Removed from the room"), true);
        return;
      }
      const snapshot = roomSnapshot(room, this.uid, credentials.code, this.now(), ++version);
      if (snapshot) callbacks.onState(snapshot);
      schedule();
    };
    const finish = async () => {
      if (stopped || settling || !online) return;
      settling = true;
      try {
        const control = (await this.sdk.get(this.reference(`${path}/control`))).val();
        if (!control || control.phase !== "question") return;
        if (this.now() < control.started_at + control.round_seconds * 1000) return;
        const [players, votes, results] = await Promise.all([
          this.sdk.get(this.reference(`${path}/players`)),
          this.sdk.get(this.reference(`${path}/votes/${control.game_id}/${control.question_index}`)),
          this.sdk.get(this.reference(`${path}/results/${control.game_id}`)),
        ]);
        if (stopped || !online) return;
        const result = roundResult(control, players.val() || {}, votes.val() || {}, results.val() || {});
        await this.sdk.update(this.reference(path), {
          [`results/${control.game_id}/${control.question_index}`]: result, "control/phase": "results",
        });
      } catch (error) {
        if (online && room.control?.phase === "question") report(error);
      } finally {
        settling = false;
        if (!stopped && online && room.control?.phase === "question") roundTimer = setTimeout(finish, 1000);
      }
    };
    const watchOwnVote = (control) => {
      if (owner) return;
      const key = `${control.game_id}/${control.question_index}`;
      if (key === voteKey) return;
      voteKey = key;
      unsubscribeVote?.();
      room.votes = {};
      voteReady = control.question_index < 0;
      if (voteReady) return;
      unsubscribeVote = this.sdk.onValue(this.reference(`${path}/votes/${key}/${this.uid}`), (snapshot) => {
        if (stopped || key !== voteKey) return;
        room.votes = { [control.game_id]: { [control.question_index]: { [this.uid]: snapshot.val() } } };
        voteReady = true;
        emit();
      }, (error) => report(error, true));
    };
    for (const field of ["meta", "control", "players", "presence", "results", "voted", ...(owner ? ["votes"] : [])]) {
      subscriptions.push(this.sdk.onValue(this.reference(`${path}/${field}`), (snapshot) => {
        if (stopped) return;
        room[field] = snapshot.val() || {};
        ready.add(field);
        if (field === "control" && room.control.game_id) watchOwnVote(room.control);
        emit();
      }, (error) => report(error, true)));
    }
    subscriptions.push(this.sdk.onValue(this.reference(".info/serverTimeOffset"), (snapshot) => {
      this.offset = snapshot.val() || 0;
      emit();
    }));
    subscriptions.push(this.sdk.onValue(this.reference(".info/connected"), async (snapshot) => {
      if (stopped) return;
      online = snapshot.val() === true;
      active.online = online;
      callbacks.onConnection?.(online);
      const generation = ++presenceGeneration;
      if (!online) {
        clearTimeout(roundTimer);
        return;
      }
      try {
        const nextRef = this.sdk.push(this.reference(`${path}/presence/${this.uid}`));
        await this.sdk.onDisconnect(nextRef).remove();
        if (stopped || generation !== presenceGeneration) {
          await this.sdk.onDisconnect(nextRef).cancel();
          return;
        }
        connectionRef = nextRef;
        await this.sdk.set(nextRef, true);
        if (stopped) await this.sdk.remove(nextRef);
        emit();
      } catch (error) {
        report(error, true);
      }
    }));
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(roundTimer);
      subscriptions.forEach((unsubscribe) => unsubscribe());
      unsubscribeVote?.();
      if (connectionRef) this.sdk.remove(connectionRef).catch(() => {});
      if (this.active === active) this.active = null;
    };
    this.stop = stop;
    return stop;
  }

  async send(action, values = {}) {
    const active = this.active;
    if (!active?.online || !active.room.control?.game_id) throw new Error("Wait for the Firebase connection to recover.");
    const { room, path, owner } = active;
    const { control, players = {}, presence = {} } = room;
    if (action !== "vote" && !owner) throw new Error("Only the room owner can do that.");
    try {
      if (action === "vote") {
        if (control.phase !== "question" || control.question_index !== values.question_index
            || this.now() >= control.started_at + control.round_seconds * 1000) throw new Error("Voting is closed for this question.");
        if (!answerOptions(control).some((option) => option.id === values.candidate_id)) throw new Error("Choose a name from the answer options.");
        await this.sdk.update(this.reference(path), {
          [`votes/${control.game_id}/${control.question_index}/${this.uid}`]: {
            candidate_id: values.candidate_id, submitted_at: this.sdk.serverTimestamp(),
          },
          [`voted/${control.game_id}/${control.question_index}/${this.uid}`]: true,
        });
      } else if (action === "guests") {
        const selected = validateGuests(control, players, this.uid, values.guest_ids);
        await this.sdk.set(this.reference(`${path}/control/guest_ids`), selected.length ? selected : null);
      } else if (action === "configure") {
        if (control.phase !== "lobby") throw new Error("Game setup can only be changed in the lobby.");
        await this.sdk.update(this.reference(`${path}/control`), validateSettings(values.questions, values.round_seconds, values.answer_names));
      } else if (action === "start" || action === "advance") {
        if ((action === "start" && control.phase !== "lobby") || (action === "advance" && control.phase !== "results")) {
          throw new Error("Wait for the current question to finish.");
        }
        if (action === "advance" && control.question_index + 1 === control.questions.length) {
          await this.sdk.update(this.reference(`${path}/control`), { phase: "finished" });
          return;
        }
        const guests = guestIds(control);
        if (guests.length !== 2 || guests.some((identifier) => !isConnected(presence[identifier]))) {
          throw new Error("Assign exactly two connected members before starting.");
        }
        await this.sdk.update(this.reference(`${path}/control`), {
          phase: "question", question_index: action === "start" ? 0 : control.question_index + 1,
          started_at: this.sdk.serverTimestamp(),
        });
      } else if (action === "reset") {
        if (!["results", "finished"].includes(control.phase)) throw new Error("Wait for the current question to finish.");
        await this.sdk.set(this.reference(`${path}/control`), {
          ...control, game_id: randomKey(), phase: "lobby", question_index: -1, started_at: 0,
        });
      } else if (action === "remove") {
        const target = values.player_id;
        if (control.phase !== "lobby" || target === this.uid || !players[target]) throw new Error("Choose another player in the lobby.");
        const selected = guestIds(control).filter((identifier) => identifier !== target);
        await this.sdk.update(this.reference(path), {
          [`players/${target}`]: null, [`names/${players[target].name_key}`]: null,
          player_count: this.sdk.increment(-1), "control/guest_ids": selected.length ? selected : null,
        });
      } else throw new Error("Unknown room action.");
    } catch (error) {
      throw errorMessage(error);
    }
  }

  async close() {
    this.stop?.();
    this.sdk.goOffline(this.database);
    await this.appSdk.deleteApp(this.app);
  }
}