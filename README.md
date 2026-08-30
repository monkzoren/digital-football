# Digital Football

A Virtua-Striker-flavored arcade football game for the browser — the
spiritual sibling of [digital-tennis](https://github.com/monkzoren/digital-tennis),
seeded from it at commit `5ef728b18f84a9aef045292112daf51d92b72722` and then
rewritten for a different sport. The design and the milestones live in
[`DIGITAL_FOOTBALL_PLAN.md`](DIGITAL_FOOTBALL_PLAN.md).

SpacetimeDB is the entire backend — lobbies, matchmaking-by-code, bots, and
the authoritative 30 Hz simulation all run inside a SpacetimeDB module. The
client is a Vite + TypeScript Three.js renderer with a high broadcast camera,
a stadium crowd, and fullscreen support.

## How it works

```
client/  (Vite + TS, Three.js)           spacetimedb/  (TypeScript module)
┌──────────────────────────────┐         ┌─────────────────────────────────┐
│ send inputs:                 │ ──────► │ tables: lobby, match, player,   │
│   set_input(dirX,dirY,sprint)│reducers │   ball, goal_event, chat, team, │
│   kick(kind) / kick_release  │         │   wallet/bet/book, account/…    │
│   tackle()                   │         │ reducers: create/join/leave,    │
│ render from subscriptions    │ ◄────── │   set_input, kick, tackle, …    │
│ + client-side extrapolation  │  subs   │ game_tick (scheduled, 30 Hz):   │
└──────────────────────────────┘         │   movement, dribble, kicks,     │
                                         │   keeper AI, goals, clock,      │
                                         │   restarts, match completion    │
                                         └─────────────────────────────────┘
```

- **Server-authoritative:** clients only send a held direction, a sprint bit,
  and kick/tackle presses. The scheduled `game_tick` reducer simulates the
  ball, dribbling, kicks, the keeper, goals, the match clock and every
  restart. No client can cheat.
- **One human, one footballer.** Like haxball or the player on the sticks in
  FIFA, you control a single outfielder. Every side also gets a **bot
  goalkeeper**, and in team modes bots fill any empty outfield seat.
- **The match:** two **3-minute halves** of game clock (it runs only while
  the ball is live), and a draw goes to **golden goal** — the next goal wins,
  with a 2-minute cap after which it plays on as sudden death.
- **Controls:** **WASD / arrows / left stick** move · **Space / J / Ⓐ** kick
  (hold to charge — release time sets power) · **K / RShift / Ⓑ** chip ·
  **L / Ctrl / Ⓧ** slide tackle · **LShift / right trigger** sprint, which
  drains a stamina bar under your nameplate.
- **Shooting:** a stick is eight directions and a goal is fourteen feet
  wide, so inside shooting range a forward kick becomes a **shot on target**
  — the held direction picks which part of the goal you attack, and nothing
  held goes down the middle. Outside that range the stick means exactly what
  it says and the kick is a pass.
- **Dribbling:** the ball sticks to the feet of whoever last controlled it,
  knocked a touch ahead of their run — and further ahead when sprinting, so
  running flat out invites a tackle. An opponent standing in your control
  radius can poke it loose; a slide that reaches it cleanly wins it outright.
  A struck ball is locked away from the boot that struck it for a beat, so a
  shot always gets away.
- **Restarts:** kickoffs (the conceding side restarts), kick-ins, corners and
  goal kicks, half-time and the golden-goal restart, each with a short window
  where only the awarded side may play the ball.
- **Goalkeepers** are always bots: they hold the line between ball and goal,
  commit late to a shot they can see coming (later and looser on EASY), and
  punt what they catch back upfield. Beating one is about placement.
- **2v2 & 3v3:** a quick-match lobby can be created as **1v1, 2v2 or 3v3** —
  pick MATCH TYPE on the pitch screen. Seats fill alternately, and the
  scoreboard reads "ALPHA & CHARLIE".
- **Public lobby browser:** quick matches and tournaments can be created as
  *public* and show up live on the menu with host, pitch and player count.
  Private lobbies stay invite-only via code/link.
- **Spectating:** every match in a public room is listed under "Live Now"
  with players, pitch and live score — one click puts you in the stands with
  nameplates, room chat and emotes, **N** to hop between concurrent
  pitches and **B** for the bracket.
- **Lobbies / join from link:** `create_lobby` allocates a 5-letter code; the
  client shows `http://<host>/?lobby=CODE`, which auto-joins on load.
- **Accounts, XP and MMR:** everyone is signed in automatically (Firebase
  anonymous auth), so there is no wall in front of the game — but the
  identity is *stable*, which is what lets progress persist. Every finished
  match pays **XP** (half rate with bots on the pitch), plus a bonus per goal
  scored; **MMR** is Elo and only moves when every outfielder is human, so
  bots level you up but never move your rating. **SIGN IN** links your guest
  account to Google, keeping everything on it.
- **Reconnect, forfeit:** losing your connection mid-match no longer hands
  the other side a win. The match **halts** — clock, ball and physics stop —
  and you have **5 minutes** (2 in a tournament) to get back; return in time
  and play restarts from a neutral drop ball with the score and clock intact.
  The player still on the pitch can wait it out for an automatic win or press
  **CLAIM WIN** once a minute has passed. **ESC → Forfeit Match** counts as a
  real loss.
- **Character select:** 18 players — six pros (BLAZE, VOLT, KAI, ROSA, VIPER,
  LUNA) plus a wacky dozen (PEELS the banana man, BISCUIT the two-legged
  corgi, SERVO the robot, ZORP the alien, SMASHULA, PLANK, YETI, GRANNY,
  DISCO, INKY the octopus, PRICKLES the cactus, MYSTO) — each with its own
  stats (speed, power, stamina, curl, accuracy, tackling) and a fully unique
  3D body. Full list in `ROSTER.md`.
- **Pitch select:** grass by day, grass under floodlights, and a street cage
  — each with its own rolling friction and bounce.
- **Practice mode:** "Practice" starts an instant match against a server-side
  outfield bot (ACE BOT) that chases, carries, passes and shoots — it runs
  inside the same authoritative 30 Hz tick, so no extra process is needed.
- **Bot difficulty:** EASY / NORMAL / HARD scales bot speed, how well they
  read the ball, how accurately they shoot, how often they tackle — and how
  late and how loosely the keeper commits to a save.
- **Custom rules:** every lobby can tweak ball physics — weight (gravity),
  rolling friction, kick power and bounciness — via sliders or the MOON BALL
  / CANNON / BEACH BALL presets.
- **Tournament mode:** one lobby code, up to 16 players, **single or double
  elimination**, 1–4 matches at once, with **every empty seat in the draw
  filled by a bot instead of a bye**. An all-bot match is settled on the spot
  and marked AUTO-PLAYED. Rounds advance automatically as matches finish.
- **🪙 Tournament betting:** everyone in a tournament room gets **1500
  credits** and stakes them on the matches they are watching. Odds open from
  each side's **tournament performance** (goal share weighted by win rate)
  and are then **corrected by the money**: every bet shortens the price on
  the side it backs, while each slip keeps the odds it was written at. A
  market opens when a pairing is drawn and closes at kickoff. You can never
  bet on a match you (or a teammate) are playing in. A tournament therefore
  ends with **two winners**: the champion, and the **bet winner**.
- **Real 3D:** Three.js/WebGL renderer with a high broadcast camera,
  shadow-mapped players, goals with real netting, and a stadium crowd.
- **Graphics options:** press **G** or the ⚙ button for quality switches —
  render resolution, shadows, anti-aliasing, particles, ball trail, crowd
  detail, the film grade, the retro VHS filter and an FPS limit — with a live
  FPS readout and HIGH / MEDIUM / LOW presets. The choice is remembered.
- **Fullscreen:** press **F** or the ⛶ button. Gamepads are supported.

## Prerequisites

- Node.js 20+
- [SpacetimeDB CLI](https://spacetimedb.com/install) **2.8.x** (`spacetime version upgrade`)

## Run locally

```bash
# 1. Start the local SpacetimeDB server
spacetime start

# 2. Publish the module (from the repo root; uses spacetime.json)
spacetime publish -y

# 3. Regenerate client bindings after any module change
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb -y

# 4. Run the client
cd client && npm install && npm run dev
```

Open http://localhost:5173 to play. **Two players on one machine needs two
*identities*, and two tabs no longer are one:** a player is now an account,
and both a Firebase session and the fallback token live in browser-wide
storage, so two tabs share a player. Use two browser profiles (or one normal
window and one private/incognito) — or, when running without Firebase, add
`?seat=2` to the second tab, which namespaces its fallback token.

Controls: **WASD / arrows** move · **Space / J** kick (hold to charge) ·
**K** chip · **L** slide tackle · **LShift** sprint.

On a touch device the game shows a floating stick (drag anywhere in the lower
left) plus **KICK**, **CHIP**, **SLIDE**, a **SPRINT** latch and chat buttons;
holding KICK still charges the shot, and landscape gives you a much bigger
pitch. Emotes stay keyboard-only.

If the game runs slow, press **G** (or tap **⚙ Graphics**) and drop the
quality — the panel opens mid-match and the FPS readout shows what each
switch bought you. Like the fullscreen button, ⚙ Graphics hides while the
touch controls are up, so on a phone set it from the menu; the settings
persist. Defaults start at MEDIUM (which keeps all the effects and only
softens the pixel-pushing knobs) unless the machine is clearly beefy, and
presets cap rendering at 120 FPS (30 on LOW) — the server ticks at 30 Hz,
so ever-higher frame rates only cost GPU and battery; the FPS LIMIT switch
offers MAX / 120 / 60 / 30.

## Configuration

- `client/src/config.ts` reads `VITE_SPACETIMEDB_URI` and
  `VITE_DATABASE_NAME` (defaults: `ws://localhost:3000`, `digital-football`).
- **Accounts are optional.** Set `FIREBASE_*` in `.env` (see `.env.example`)
  and `FIREBASE_PROJECT` in `spacetimedb/src/index.ts` to the same project id.
  SpacetimeDB validates Firebase ID tokens with no server configuration at
  all: it derives the identity from the token's `iss`+`sub` and fetches the
  signing keys from the issuer's `/.well-known/openid-configuration`, which
  Firebase serves. The SpacetimeDB container does need outbound HTTPS to
  `securetoken.google.com` and `www.googleapis.com` to fetch them.
- Progression dials (XP per match, the level curve, Elo K-factors, the
  reconnect grace windows) are constants at the top of
  `spacetimedb/src/index.ts`; `client/src/config.ts` mirrors the level curve
  and the claim-win delay for display only — keep the two in sync.
- **The `account` table is the only persistent data in this database** —
  everything else dies with the room that owns it. Its columns are
  append-only (SpacetimeDB auto-migrates added columns with defaults, nothing
  else), and `spacetimedb/publish.sh` refuses to clear the database unless
  `ALLOW_CLEAR=1` is set. Back up before risky publishes:
  `spacetime sql digital-football "SELECT * FROM account" > accounts.bak`
- Pitch geometry constants exist in both `spacetimedb/src/index.ts` (the
  source of truth) and `client/src/config.ts` — keep them in sync.
- Match length: two halves of `HALF_SECONDS` (180) of game clock, then
  `OT_SECONDS` (120) of golden goal if it is level. The clock only runs while
  the ball is live. All three constants live in `spacetimedb/src/index.ts`
  and are mirrored in `client/src/config.ts` for the scoreboard.
- Graphics presets and defaults live in `client/src/graphics.ts`; `render.ts`
  applies the WebGL side of them and `main.ts` owns the options panel.

## Self-hosting with Docker Compose

### Quick start

```bash
git clone https://github.com/monkzoren/digital-football.git
cd digital-football
cp .env.example .env
# edit .env — at minimum set PUBLIC_SPACETIMEDB_URI (see table below)
docker compose up -d --build
```

Open `http://your-server:8080` — create a lobby, send the join link to a
friend, play. Three services come up:

| Service            | What it does                                                |
|--------------------|-------------------------------------------------------------|
| `spacetimedb`      | SpacetimeDB standalone server (persists to a named volume)  |
| `module-publisher` | Builds + publishes the game module, then idles              |
| `client`           | nginx serving the built web client                          |

### One domain, one port — same-origin by default

The client's nginx **proxies the game socket** (`/v1`) to SpacetimeDB
inside the compose network, and the client connects same-origin. So a
single domain (or a single host port) serves everything, `wss://` works
automatically behind any TLS proxy, and SpacetimeDB is not exposed on the
host at all.

### Environment variables (.env) — all optional

| Variable                 | Default          | What it controls |
|--------------------------|------------------|------------------|
| `DATABASE_NAME`          | `digital-football` | The SpacetimeDB database (module) name. |
| `CLIENT_PORT`            | `8080`           | Host port for the web client (irrelevant behind Coolify/Traefik domains). |
| `SPACETIMEDB_PORT`       | `3000`           | Only used if you uncomment the `spacetimedb` ports in docker-compose.yml for direct access. |

### Deploying with Coolify

1. New Application → your GitHub repo → Build Pack: **Docker Compose**.
2. Set **Docker Compose Location** to `/docker-compose.yml` (the default
   `.yaml` guess won't find the file).
3. Domain: `client` service → `https://football.your-domain.com` (port 80).
   That's it — one domain; the game socket rides the same origin, and
   Coolify's Traefik provides TLS. No env vars needed.
4. Deploy. The `module-publisher` service publishes the game module and then
   idles (it stays up so Coolify sees the stack as healthy).
5. Updates: hit Redeploy — that's all. Coolify recreates every container on
   each deploy, and the stack is built for that: the server's token-signing
   keys persist in the data volume, and the publisher derives its identity
   deterministically from them, so it is the database owner on every deploy.
   If the module schema changed, the publisher detects the rejected publish
   and automatically re-publishes with `--clear-database` (all lobbies
   reset — there is no persistent player data, so this is safe). No manual
   volume wiping needed.

**Upgrading a deployment created before token-key persistence** (publish
logs showed `401 InvalidSignature` / `403 not authorized` on redeploys):
one final reset is needed, because the old database's owner identity died
with an old server re-key. Delete the `spacetimedb-data` volume (Coolify:
Storages → delete; compose CLI: `docker compose down -v`) and redeploy.
After that, redeploys are stable.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Permission denied (os error 13) at path "/stdb/..."`, DB restarts | The data volume mountpoint is root-owned and the image's user can't write it. The compose file pins `user: "0:0"` on `spacetimedb` to fix this — make sure you're on a build that includes it. |
| Site shows Traefik's `404 page not found` | Domain not routed yet: set it on the **client** service only, save, and redeploy (routes are applied when containers are created). Coolify also serves this 404 while a deploy is still coming up. |
| nginx logs `host not found in upstream "spacetimedb"` | Old build. Current nginx resolves the upstream at request time; redeploy. |
| Game stuck on "CONNECTING TO SERVER..." | The `/v1` proxy can't reach SpacetimeDB — check the `spacetimedb` container is running (not crash-looping). |
| Remote players see `WebSocket connection to 'ws://localhost:3000' failed` | A stale `PUBLIC_SPACETIMEDB_URI` was baked into the client build. That variable no longer exists (same-origin is automatic); redeploy from a current build. Any leftover Coolify entry is ignored, and the client also refuses localhost addresses when the page isn't served from localhost. |
| `403 ... is not authorized to perform action on database ...: update database` | The database was created by an identity this publisher can no longer become — typically a DB created before key persistence + deterministic publisher identity (its owner died with an old server re-key). Publish as the owner if you have its token (`SPACETIME_TOKEN=<owner token>`, printed by `spacetime login show --token` on a host that owns it), or do a one-time reset: delete the `spacetimedb-data` volume and redeploy (`docker compose down -v && docker compose up -d --build`). Current builds never hit this on normal redeploys: the publisher mints its owner identity from the server's persisted signing key. |
| `401 ... Invalid token: InvalidSignature` when publishing | The publisher presented a token signed by a key the server no longer uses. Current builds recover automatically (the token is re-minted from the server's current key, same identity). If it persists, the `spacetimedb` service is missing the `--jwt-priv-key-path`/`--jwt-pub-key-path` flags in its compose command — update to the current `docker-compose.yml`. |
| Game says `CONNECTION FAILED` and nginx logs `POST /v1/identity/websocket-token ... 401` | The browser is holding a token from a previous server instance — recreating the SpacetimeDB volume regenerates the signing key and invalidates every issued token. The client now drops a rejected token and reconnects anonymously; on an older build, close the tab or run `sessionStorage.removeItem('df_token')` in the console. |
| Players disconnect after ~100s idle behind Cloudflare | Cloudflare's idle WebSocket timeout; the 30 Hz game traffic normally prevents it. |

### Updating a running server

```bash
git pull
docker compose up -d --build            # rebuilds everything that changed
```

- **Module (game rules) changed:** `docker compose up --build module-publisher`
  re-publishes in place. The publisher mints the database-owner identity from
  the server's signing key (persisted in the `spacetimedb-data` volume), so
  re-publishing works from any rebuild — no credentials to preserve unless
  you deliberately pin ownership with `SPACETIME_TOKEN`. If the table schema
  changed, the publisher clears and re-publishes automatically (all lobbies
  reset).
- **Client or `PUBLIC_SPACETIMEDB_URI` changed:** `docker compose up -d --build client`.
- Match data lives in the `spacetimedb-data` volume; `docker compose down`
  (without `-v`) keeps it.

## Deploying to Maincloud instead

Publish the module to SpacetimeDB Maincloud (free):

```bash
spacetime login
spacetime publish -y --server maincloud
```

Then build the client (`npm run build` in `client/`) with
`VITE_SPACETIMEDB_URI=wss://maincloud.spacetimedb.com` and your database
name, and host the static output anywhere.

## Architecture: rooms, matches, tournaments

A **lobby is a room** (code, host, mode, settings) and a **`match` row owns
each game** (phase, goals, clock, the pending restart); the ball is keyed by
`matchId` and the 30 Hz tick is scheduled per live match — which is what lets several matches run concurrently in
one room. Quick matches and practice are simply rooms with a single
match. Tournament rooms register up to 16 players, shuffle round-1
pairings, fill any empty seat with a bot player row (`insertBot`, so a
filler runs, kicks and holds a bracket seat like anyone else), and a
scheduler (`advanceTournament`) resolves all-bot matches without playing
them (`simulateBotMatch`), starts the rest up to the concurrency setting,
creates the next round when all of a round's matches finish, and crowns
the champion. Spectating
is free: all match state is public via subscriptions, so clients without
a `matchId` render a live match in their room (the one picked from the
menu's Live Now list, else the first; N cycles through them). A `player.spectator` flag marks
room members who joined to watch — they hold no match slot, never count
toward a room being full or a bracket, and can't keep a dead room alive.

## Roadmap

Deliberately deferred (see `DIGITAL_FOOTBALL_PLAN.md`): penalty shootouts,
offside, cards and fouls beyond the tackle, human goalkeepers, switching
between teammates, and a shooting-gallery minigame.

- **Accounts, next steps:** merging two accounts, a global leaderboard and a
  match-history screen (the `byMmr` index and the `match_log` rows are
  already there), MMR-based matchmaking, and seasons.
- **Team play:** letting friends pick their own side instead of the
  join-order / shuffled draw.
- Assists (the `goal_event` table has room for them) and per-player match
  stats.
- Bracket overview screen for spectators — a tournament wall showing all
  pitches and results.
