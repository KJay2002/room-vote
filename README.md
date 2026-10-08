# Room Vote

A live, small-group party game with Players, exactly two Members, and a room owner.
Players only need a browser. Choose one of two modes:

- **GitHub Pages + Firebase:** the webpage runs on GitHub Pages; Firebase Authentication and Realtime Database provide shared rooms and private votes. No Python hosting or Render service is required.
- **Local Python:** the original standard-library server remains available for local play. No Python package installation is required.

This checkout uses `backend: "firebase"` in [web/config.js](web/config.js) for GitHub Pages + Firebase. For local Python play, select `backend: "python"` and leave `apiBase` empty. For GitHub Pages + Render, use Python mode and set `apiBase` to the deployed Python service's HTTPS address. Do not publish a local test configuration over the production Firebase settings.

## Rules

1. Everyone enters a name before joining. The person creating a room is its owner.
2. Everyone starts as a **Player**. Before starting, the owner checks **Member** beside exactly two other participants. These are the two people whose predictions earn points; the owner remains a Player.
3. Everyone votes for a name from the **fixed answer list**, not the lobby roster. **Game setup > Player names / answer options** starts with 16 editable placeholders. Replace them with your own names, one per line. A listed person does not need to join the room, and a participant's name does not become an answer automatically. The same list is used for every question and cannot change during the game.
4. Each question lasts **10 seconds** by default. Players may change their vote until the backend's deadline. Only their most recent accepted vote counts. In Firebase mode the database enforces that deadline, and the owner's open tab publishes results afterward.
5. The answer with the **unique highest vote count** wins that question. This is a plurality, not necessarily more than 50% of all votes. Votes from the owner, Players, and both Members all count.
6. Each Member whose pick matches that answer receives **one point**. Both Members can score in the same question. Ties for first place, no votes, and missing Member votes award no points.
7. Results show every answer in a highest-to-lowest horizontal bar chart, including zero-vote answers, plus both Members' picks and scores.
8. The owner advances to the next question after viewing the results. After the final question, **Final scores** shows the Member leaderboard, question history, and the owner's export. Equal positive scores produce a shared victory.
9. New people can join during a question or between questions as Players. They can vote on the current question only before its deadline. The two Members and the fixed answer list stay unchanged. Past results keep their original participant counts, so late arrivals are not counted as missed votes for earlier questions.

The owner can see individual ballots live and inspect prior questions under **Ballot audit**. Other participants receive only their own current pick; aggregate results and Member picks are revealed after voting closes.

At least three participants are needed: one owner/Player and two Members. The room supports up to 40 participants. There is no 30-question cap or 5-to-60-second timer restriction: use at least one question and a positive whole number of seconds. Question text remains limited to 180 printable characters and answer names to 48 characters; normal browser, request-size, and Firebase quotas still apply.

### Live Scoreboard And Excel Export

The live scoreboard updates for everyone after each completed question. Each bar counts the questions where an answer received the maximum votes, including tied leads. Select a bar to see the specific question numbers, text, vote counts, and whether the lead was tied. Zero-vote questions are not counted as leads. This summary does not reveal a question's votes before its deadline.

After the owner selects **Final scores** at the end of the entire set, **Export to Excel** downloads one Excel-compatible `.xml` workbook. The export is not offered between questions or to non-owners. It contains six worksheets: **Round**, **Questions**, **Scoreboard**, **Top questions**, **Vote details**, and **Member scores**. Historical vote details include only the people who participated in that question.

The workbook uses SpreadsheetML XML, not `.xlsx`, and can be opened in Excel. All text is escaped and stored as literal string cells; there are no macros, executable formulas, remote links, or spreadsheet-library downloads. The clickable chart is in the live game; the workbook contains the corresponding tables. The file is generated locally in the owner's browser from their authorized ballot history and is not uploaded to another service. Browser or Office security policies may still display their normal download/protected-view notices.

## Run On Your Computer

Requires Python 3.11 or newer. Tested with Python 3.13.7. No package installation is needed.

1. Open a terminal in the `room-vote` project folder.
2. Run:

   ```powershell
   py -3 server.py --local-only
   ```

   On a system where the Python launcher is unavailable, use `python server.py --local-only` instead. This mode serves a temporary Python configuration and blocks external page resources without editing the saved Firebase settings. It is loopback-only; remote fonts and icons are not loaded.

3. Open **http://127.0.0.1:8000**.
4. Enter your name and choose **Create room**. You are now the owner.
5. Select **Invite friends** to obtain the room link. A link created at `127.0.0.1` works only on this computer, not on your friends' computers.
6. For a local test, open that link in separate tabs and enter different names. A normal new tab has its own session; duplicating an existing tab can copy its session instead. Keep same-browser local tests to a few tabs, or use separate browser profiles, because browsers limit simultaneous HTTP/1.1 connections to one origin.
7. Assign exactly two Members in the roster. Both must be connected. **Game setup** lets you edit the questions, set a positive whole-number timer, and supply the fixed answer names.
8. Select **Start game**. Everyone votes, results arrive automatically at the deadline, and the owner selects **Next question**.

If port 8000 is already occupied, run `py -3 server.py --local-only --port 8001` and open http://127.0.0.1:8001.

### Test From Phones On The Same Wi-Fi

For this separate LAN mode, select `backend: "python"` and empty `apiBase` in the frontend configuration first. Do not publish that change over the production Firebase configuration. The `--local-only` flag is not used for LAN access.

1. Stop the previous server with Ctrl+C. Stopping the server clears its rooms.
2. Run:

   ```powershell
   py -3 server.py --host 0.0.0.0 --port 8000
   ```

3. Run `ipconfig` and find the IPv4 address of your active Wi-Fi adapter, for example `192.168.1.25`.
4. Open `http://192.168.1.25:8000` on the hosting computer and create a new room there. Invitations will then contain the LAN address instead of localhost.
5. Other devices on the same network can open the invitation. Windows Firewall must permit the server on the **actual active network profile**; a Private-profile exception does not apply to a managed Domain network. Ask IT before changing managed firewall settings. Guest Wi-Fi client isolation or corporate network policies can block device-to-device access.

Do not use router port forwarding to expose this development server directly to the internet. Use an HTTPS hosting service instead.

## GitHub Pages + Firebase

This is the selected deployment for a `github.io` invitation without hosting Python. It uses the owner's Firebase project, not either example site's database or credentials.

### 1. Confirm Publication Permission

Use a GitHub account that is allowed to create the repository and publish Pages. The current enterprise-managed account was marked **disabled by policy** in the repository Owner menu. This code change cannot override that policy. Use an authorized personal account only if external publication is approved, or ask the enterprise administrator for an approved internal deployment.

Publishing this game does not require changing the account used for Copilot in VS Code. The approved repository is `KJay2002/room-vote`; the configured Firebase project is `room-vote`.

### 2. Create Your Firebase Project

1. Open the official Firebase console at `https://console.firebase.google.com/` yourself after checking that the address is correct.
2. Create a project for this game. The **Spark** plan can run this version without Cloud Functions; review the console's current usage limits. Analytics is not required.
3. In the project overview, add a **Web app** and give it a name such as `Room Vote`. Do not enable Firebase Hosting; the webpage will be on GitHub Pages.
4. Under **Build > Authentication > Sign-in method**, enable **Anonymous** sign-in. This is what lets players enter only a display name while Firebase assigns each player an authenticated identity.
5. Under **Build > Realtime Database**, create a database and select **locked mode**, not open test mode. Choose a region suitable for your players. This app uses Realtime Database, not Cloud Firestore.
6. Open the database's **Rules** tab. Replace its contents with [database.rules.json](database.rules.json), then select **Publish**. Do not substitute open `.read: true` or `.write: true` rules.
7. Under **Authentication > Settings > Authorized domains**, add `YOUR_USERNAME.github.io` without a protocol or path. For local Firebase testing, add `localhost` and `127.0.0.1` if needed. A custom domain must be listed separately.

### 3. Configure The Web App

In **Project settings > General > Your apps**, find the web app's Firebase configuration. Enter your own project's values in [web/config.js](web/config.js):

```javascript
window.ROOM_VOTE_CONFIG = {
   backend: "firebase",
   apiBase: "",
   firebase: {
      apiKey: "YOUR_FIREBASE_WEB_API_KEY",
      authDomain: "YOUR_PROJECT.firebaseapp.com",
      databaseURL: "YOUR_EXACT_REALTIME_DATABASE_URL",
      projectId: "YOUR_PROJECT_ID",
      appId: "YOUR_WEB_APP_ID",
   },
};
```

Use the exact database URL from the console. Regional databases may use `firebasedatabase.app` instead of `firebaseio.com`; do not guess or edit that hostname. The Firebase web configuration is public client configuration, not an admin credential. Never include a service-account key, private key, password, or authentication token in the frontend or repository.

No `ALLOWED_ORIGINS`, Render URL, local IP address, or Python backend is needed in Firebase mode. The production configuration must not contain `emulators: true`.

### 4. Publish On GitHub Pages

1. Create a public repository named `room-vote` under your authorized GitHub account, or use another approved repository name.
2. Publish only this project folder. Include the hidden `.github` directory so the existing [Pages workflow](.github/workflows/pages.yml) is included. Do not upload your Desktop, `node_modules`, environments, emulator logs, or credentials.
3. Keep the project contents at the repository root and use a `main` branch. If you choose a different branch, update the workflow's branch filter.
4. Open **Settings > Pages** and select **GitHub Actions** as the source.
5. Open **Actions > Deploy game frontend > Run workflow**, select `main`, and run it. The workflow publishes only the [web/](web/) directory; it does not publish the test tooling or deploy database rules.
6. When deployment succeeds, open the URL shown under **Settings > Pages**, normally `https://YOUR_USERNAME.github.io/room-vote/`. If you chose `Team-Activity` as the repository name, the path is `/Team-Activity/` instead.
7. Create a new room from that public address and share **Invite friends > Copy link**. Players can join from different networks. Local Python rooms do not transfer to Firebase.

GitHub uploads and Firebase Rules publishing are separate steps. Changing a local rules file does not change the live database's rules until you publish them in Firebase.

**Updating an older deployment:** the fixed answer list, late joining, participant snapshots, and expanded setup limits require the matching database rules and frontend together. Do not publish only the UI. Keep existing stored data, finish any active games before the update, and create a new room afterward; old rooms and old browser tabs use the previous candidate-ID format and are not automatically migrated. The internal `guest_ids` / `guest_votes` keys remain for storage compatibility, but the visible role is now Member.

### 5. Verify Your Deployment

1. Join one room from at least three independent browser sessions: one owner/Player and two Members.
2. Configure the fixed answer names, confirm all participants appear, assign exactly two connected Members, and start a question.
3. Vote from each device. The owner can open **Ballot audit**; other players must not have it.
4. At the deadline, the descending chart and both Members' picks should appear on every connected device. A matching Member gains one point; ties do not score.
5. Join from another session while the next question is running. Verify the newcomer is a Player and sees the same fixed answer list.
6. Select a live-scoreboard bar to inspect that answer's completed questions. Finish all questions and check the owner's Excel export, including original participation counts before the late join.
7. Refresh a participant tab to check reconnection, then return to the lobby for another game.

The Python `/health` endpoint does not apply to Firebase mode. Permission-denied errors usually mean the rules were not published, the Firebase project/database values do not match, or the room state no longer permits the action. An `auth/operation-not-allowed` error means Anonymous sign-in needs to be enabled. If an organization blocks Firebase, ask IT for an approved hosting approach rather than bypassing the network policy.

### Firebase Behavior And Limits

- **Keep the owner tab open and active.** Firebase enforces the vote cutoff using its own server time, but the owner's browser calculates and publishes results. If that browser disconnects, sleeps, or throttles timers, results wait for it to resume. A banner warns players when the owner disconnects. There is no background Cloud Function or autonomous timer service in this version.
- **The owner is trusted.** Database rules prevent ordinary players from assigning roles, reading others' ballots, submitting another player's vote, changing the timer, or writing results. They do not independently recalculate the owner's aggregate scores. A malicious owner could publish an incorrect aggregate. Trusted server-side scoring would require an additional backend or Cloud Function.
- **Private votes stay in private database paths.** Ordinary participants read only their own ballots; the owner can read every ballot. Results publish totals and the two Members' picks, not all individual Player votes. This is enforced in database rules, not just by hiding UI controls.
- **Display names are not verified identities.** Anonymous Authentication gives each session an ID, not proof of a unique person. Someone could create another session under a different name. Names are case-insensitively unique per room and cannot contain `. # $ [ ] /` in this Firebase version.
- **Owner access is session-based.** Refreshing the same tab retains the anonymous login and room session. Closing it, clearing browser storage, or changing devices can lose the owner's access. A new tab may create a separate player; duplicating a tab may copy its session.
- **Rooms and ballots persist in Firebase.** Unlike Python's in-memory rooms, Firebase data survives webpage redeployment. **Play again** starts a new game ID and resets the displayed scores; old database records remain stored. There is no automatic expiry or deletion job. Delete stale rooms under `rooms` in your Firebase console when appropriate, and tell participants your retention policy.
- **Free-tier quotas still apply.** Monitor database storage, traffic, concurrent connections, and anonymous authentication limits. Multiple rooms and tabs share the same project's quota. This is a small-group prototype, not a hardened public service; consider approved abuse protection and stronger identity controls before unrestricted use.

### External Resources

The hosted Firebase mode uses Google's Firebase JavaScript SDK from `www.gstatic.com` and connects to the Authentication service and the Realtime Database instance specified in your own configuration. The UI also references Google Fonts (`fonts.googleapis.com` and `fonts.gstatic.com`) and Lucide icons on `unpkg.com`.

These resources are disclosed so you can approve them against your network and organizational policies. They are not the example game's services. Local automated tests use installed packages and loopback emulators instead of downloading or executing code from those websites. A localhost webpage is not automatically offline if its HTML still references external resources.

### Local Firebase Tests

The test tools are development-only. With an approved Node 22+ and Java 21+ installation, install the pinned development packages with `npm ci`, then run:

```powershell
npm test
npm run test:rules
```

The first command tests scoring and snapshot generation. The second starts local Authentication and Realtime Database emulators under the non-production `demo-room-vote` project, then tests permissions and a four-player timed game. It may download Google's emulator on first use; do not run it on a restricted network without approval. Existing installed packages and an already-running local emulator can instead be used without downloads.

The default application is not automatically switched to the emulator by these commands. An explicitly local test configuration uses `backend: "firebase"`, a `demo-` project ID, dummy web configuration values, and `emulators: true`. The client rejects emulator mode outside `localhost` or `127.0.0.1`. Never publish that local test configuration.

## Why GitHub Pages Alone Is Not Enough

GitHub Pages publishes HTML, CSS, and JavaScript. It does **not** execute Python or maintain shared game state. Uploading a `.py` file does not make it a multiplayer server.

This project can use either Firebase or Python for shared state:

| Part | Purpose | Location |
| --- | --- | --- |
| Browser frontend | Name dialog, lobby, ballots, charts, owner controls | [web/](web/) |
| Firebase client and model | Authentication, live subscriptions, owner-published results | [web/firebase-client.mjs](web/firebase-client.mjs), [web/firebase-model.mjs](web/firebase-model.mjs) |
| Firebase database rules | Read/write permissions and voting deadlines | [database.rules.json](database.rules.json) |
| Python game engine | Permissions, votes, timer, scoring, private snapshots | [game.py](game.py) |
| Python HTTP server | Rooms, authenticated actions, live updates, static hosting | [server.py](server.py) |

In **Python mode**, the frontend sends votes with authenticated HTTP requests. Its live connection is a **long poll**: the server holds a state request open until something changes, then immediately notifies waiting players. This is not a page refresh or a 20-second update interval. Idle requests return after 20 seconds and reconnect. Each room's timer runs independently on the server.

The following Render options are alternatives for retaining the Python backend. They are not required for the Firebase setup above. Set `backend: "python"` and leave Firebase configuration empty when using them.

## Option A: Host Everything On Render

### 1. Put The Project On GitHub

Create a repository named `room-vote`. A public repository is the simplest choice if you also plan to use free GitHub Pages.

From this project folder, run the following commands yourself, replacing the repository URL with yours:

```powershell
git init -b main
git add .
git commit -m "Add Room Vote game"
git remote add origin https://github.com/YOUR_USERNAME/room-vote.git
git push -u origin main
```

These commands are for the new project folder, not your entire Desktop. Alternatively, use GitHub Desktop to publish that folder. The included [.gitignore](.gitignore) excludes local environments, caches, and environment files.

### 2. Create A Render Web Service

1. Sign in at https://render.com and connect your GitHub account.
2. Choose **New > Web Service**, then select the `room-vote` repository.
3. Use these settings:

   | Setting | Value |
   | --- | --- |
   | Language / runtime | Python 3 |
   | Branch | `main` |
   | Root directory | Leave blank if the project files are at the repository root |
   | Build command | `python -m compileall -q game.py server.py` |
   | Start command | `python server.py --host 0.0.0.0 --port $PORT` |
   | Health check path | `/health` |
   | Instances / workers | One |

4. Choose a compute plan. A free service is suitable for trying the game; review the limitations below before relying on it for an event.
5. Deploy and wait for the service to become live. Render provides a URL similar to `https://room-vote-example.onrender.com`.

If you uploaded a containing folder instead of its contents, set the root directory to that folder, such as `room-vote`.

The included [render.yaml](render.yaml) provides the same setup for Render's **New > Blueprint** workflow. You only need one deployment method.

### 3. Play Through The Public Link

1. Open your Render HTTPS URL. It serves the actual game, not just an API.
2. Create a room with your name.
3. Invite friends using the generated link, for example `https://room-vote-example.onrender.com/?room=ABC123`.
4. Assign two connected Members, configure the answer names, and start.

Select `backend: "python"` in [web/config.js](web/config.js) for this option. An empty `apiBase` means "use the same server as the webpage."

## Option B: Use A github.io Link

Keep the Python service from Option A running. GitHub Pages will host only the frontend.

### 1. Point The Frontend At Python

In [web/config.js](web/config.js), set your actual Render service URL, without a trailing slash:

```javascript
window.ROOM_VOTE_CONFIG = {
  apiBase: "https://YOUR_SERVICE.onrender.com",
};
```

This is a public server address, not an API key. Never put credentials or owner session tokens in this file.

### 2. Allow Your GitHub Pages Origin

In the Render dashboard, open the service's **Environment** settings and add:

```text
ALLOWED_ORIGINS=https://YOUR_USERNAME.github.io
```

Use only the scheme and host, **not** `/room-vote` and not a trailing slash. For a custom domain, use that domain's origin instead. Multiple origins can be comma-separated. Do not use `*`.

Apply the environment change. Render restarts/redeploys the server, which clears existing rooms.

### 3. Enable GitHub Pages

1. Commit and push the frontend configuration change.
2. In your GitHub repository, open **Settings > Pages**.
3. Under **Build and deployment > Source**, select **GitHub Actions**.
4. Open **Actions > Deploy game frontend > Run workflow**, using the `main` branch. The included [.github/workflows/pages.yml](.github/workflows/pages.yml) uploads only the [web/](web/) directory.
5. Wait for the deployment to succeed. Your frontend URL will normally be `https://YOUR_USERNAME.github.io/room-vote/`.
6. Open that URL, create a room, and share its generated invitation. Friends will use a `github.io` link while Python continues running on Render.

Later pushes that change the frontend trigger another Pages deployment. If your repository uses a branch other than `main`, update the workflow's branch filter.

### 4. Check The Deployment

- Open `https://YOUR_SERVICE.onrender.com/health`; it should return `{"status": "ok"}`.
- Open the Pages frontend on two different devices or browser profiles and join the same room.
- Confirm that participant names, fixed answer options, and Member assignments update on both screens.
- Run a round and confirm that the chart, Member picks, and scores agree.
- Confirm that the ballot audit appears only for the owner.
- A CORS error usually means `ALLOWED_ORIGINS` does not exactly match the frontend's origin.
- A mixed-content error means an HTTPS frontend is trying to contact an HTTP backend. Use the Render **HTTPS** URL.
- A connection error after a server restart usually means the old room no longer exists. Create a new room and share its new link.

## Important Limits

The following limits refer to the **Python backend**. Firebase-specific limits are documented above.

- **This is a small-group prototype, not a hardened large public service.** It uses Python's standard-library HTTP server behind the hosting provider's HTTPS proxy. For an untrusted, high-traffic deployment, use a production ASGI server/framework, stronger abuse controls, and shared persistent storage.
- **Rooms are in memory.** Restarting, redeploying, or stopping the Python process loses names, roles, scores, ballots, and owner sessions. Inactive rooms expire after two hours. The instance limits rooms to 30 and each room to 40 players.
- **Run one process and one instance.** Multiple independent workers will not share rooms. Scaling requires a shared database or Redis-backed state and cross-process notifications.
- **Keep the owner's browser tab.** Refreshing reconnects with the private session stored in that tab. Closing the tab, clearing session storage, or switching devices can lose owner access. There is no global root password or automatic owner transfer. Create a new room if that session is lost.
- **Names are display names, not verified accounts.** Anyone with the invitation can join, including during an active game. Duplicate names are rejected, but a person could join under another name. The owner can remove unwanted participants in the lobby. Role changes and answer-list edits are blocked once the game begins; late joiners become Players and existing sessions can reconnect.
- **Privacy:** individual votes are intentionally owner-visible. Other participants see totals and the Members' revealed picks after the deadline. Do not share session storage, authorization headers, or developer-tool dumps.
- **Presence is approximate.** A disconnected player is marked as reconnecting after about 45 seconds. An absent vote is not counted; the round still ends on time.
- **Free Render instances have limitations.** Current documentation says they can spin down after 15 minutes without inbound traffic, can take about a minute to wake, have monthly usage limits, and may restart. An active game sends requests, but that is not an uptime guarantee. Choose an appropriate paid service for a scheduled event; RAM-only rooms can still be lost on any restart.
- The interface loads Google Fonts and Lucide icons from public CDNs. Core gameplay does not depend on those services, but restricted/offline networks can lose the custom fonts or icons. The ballot illustration is local.

## Adapt Your Existing Python Game

Keep the game rules in Python, but separate them from terminal `input()`, `print()`, or desktop GUI calls. Use [game.py](game.py) as the model for shared state and per-player views. Handle actions in [server.py](server.py), and render the game in [web/app.js](web/app.js). The server must decide permissions, timing, accepted actions, and scores; browsers should only submit actions and display the resulting state.

## Tests

From this project folder:

```powershell
py -3 -m unittest discover -s . -p "test_*.py" -v
```

[test_game.py](test_game.py) covers scoring, ties, missing votes, changed votes, deadlines, roles, privacy, and reset behavior. [test_server.py](test_server.py) exercises real HTTP clients, live notifications, server-owned timers, room isolation, invalid sessions, static assets, and cross-origin access.

## Hosting References

- [GitHub Pages is static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Render web services](https://render.com/docs/web-services)
- [Render free-service limits](https://render.com/docs/free)

The approved public repository is [KJay2002/room-vote](https://github.com/KJay2002/room-vote). The game is publicly playable only after the backend is deployed, its address is configured, and GitHub Pages reports a successful deployment. Account verification and any hosting-provider authorization must be completed by the account owner.