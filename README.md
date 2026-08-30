# Digital Football

A Virtua-Striker-flavored arcade football game for the browser — the
spiritual sibling of [digital-tennis](https://github.com/monkzoren/digital-tennis).

> **Status: M0 seed.** This repo was seeded from `monkzoren/digital-tennis`
> at commit `5ef728b18f84a9aef045292112daf51d92b72722` and rebranded; the
> gameplay below is still **tennis** until milestone M1 lands. The design,
> the tennis→football mapping, and the milestones live in
> [`DIGITAL_FOOTBALL_PLAN.md`](DIGITAL_FOOTBALL_PLAN.md). Fixes to the
> sport-agnostic machinery (deployment, accounts, reconnect, tournaments,
> betting) made in digital-tennis after that commit can be cherry-picked
> by hand.

The rest of this README still describes the inherited tennis build.
SpacetimeDB is the
entire backend — lobbies, matchmaking-by-code, a practice bot, and the
authoritative 20 Hz game simulation all run inside a SpacetimeDB module. The
client is a Vite + TypeScript canvas renderer with a pseudo-3D
behind-the-baseline camera, stadium crowd, and fullscreen support.

## How it works

```
client/  (Vite + TS, Canvas 2D)          spacetimedb/  (TypeScript module)
┌──────────────────────────────┐         ┌─────────────────────────────────┐
│ send inputs:                 │ ──────► │ tables: lobby, player, ball     │
│   set_input(dirX, dirY)      │reducers │ reducers: create/join/leave,    │
│   swing()                    │         │   set_input, swing, rematch     │
│ render from subscriptions:   │ ◄────── │ game_tick (scheduled, 20 Hz):   │
│   lobby / player / ball rows │  subs   │   movement, ball physics,       │
│ + client-side extrapolation  │         │   bounce/net/out rules, scoring │
└──────────────────────────────┘         └─────────────────────────────────┘
```

- **Server-authoritative:** clients only send held movement direction and
  swing presses. The scheduled `game_tick` reducer simulates the ball, hit
  detection, tennis scoring (15/30/40, deuce/advantage, games), serve
  alternation, and match completion. No client can cheat.
- **2v2 doubles & 3v3 triples:** a quick-match lobby can be created as
  **1v1, 2v2 or 3v3** — pick MATCH TYPE on the court screen. A team room
  waits until every seat is filled (seats alternate team A, team B, …),
  then runs real team rules: serves rotate through all four/six players
  game by game (teammates take turns), the active server and receiver
  hold the baseline diagonal while their teammates start up at the
  service line (in 3v3 they cover both alleys), any teammate can take
  any return (but a team can't hit twice), one player leaving forfeits
  for the team, and the scoreboard/point calls read "ALPHA & CHARLIE &
  ECHO". **Tournaments support teams too:** the host picks 1v1/2v2/3v3
  when creating (changeable from the registration screen); at start the
  entrants are shuffled and drawn into teams, the bracket pairs teams
  (byes advance a whole team, a loss eliminates the whole team), the
  bracket cards and champion banner show the joined team names, and
  starting needs a player count divisible by the team size.
- **Public lobby browser:** quick matches and tournaments can be created as
  *public* — they show up live in a "Public Lobbies" list on the menu with
  host, court, and player count, and anyone can join with one click. Private
  lobbies stay invite-only via code/link.
- **Spectating:** every match running in a public room is listed in a "Live
  Now" section on the menu — players, court, and live score — and one click
  puts you in the stands: nameplates over the players, a WATCHING LIVE bug,
  room chat and emotes, and (in tournaments) the bracket on **B**. Watching
  never takes a player slot, and joining a full or in-progress match by
  code/link seats you as a spectator too.
- **Lobbies / join from link:** `create_lobby` allocates a 5-letter code;
  the client shows `http://<host>/?lobby=CODE`, which auto-joins on load.
  No sign-up screen ever — see accounts below.
- **Accounts, XP and MMR:** everyone is signed in automatically (Firebase
  anonymous auth), so there is still no wall in front of the game — but the
  identity is now *stable*, which is what lets progress persist. Every
  finished match pays **XP** (half rate when a bot is on court); **MMR** is
  Elo and only moves when both sides are all-human tennis, so bots level you
  up but never move your rating. Level, XP bar, rating and record show on the
  menu card, ratings show on roster chips and nameplates, and the game-over
  screen reveals what the match was worth. **SIGN IN** links your guest
  account to Google, keeping the same identity and everything on it; without
  it, progress lives in that one browser. Running without a Firebase project
  is fine — players fall back to anonymous SpacetimeDB identities in
  `localStorage`.
- **Reconnect, forfeit:** losing your connection mid-match no longer hands
  the other side a win. The match **halts** — clock, ball and physics stop —
  and you have **5 minutes** (2 in a tournament) to get back; return in time
  and the point is replayed from a fresh serve with the score intact. The
  player still on court can wait it out for an automatic win or press **CLAIM
  WIN** once a minute has passed. To quit deliberately there is **ESC → Forfeit
  Match**, which counts as a real loss and moves MMR like any other.
- **Virtua Tennis-style shots:** dedicated **Hit** (Space/J, gamepad A) and
  **Lob** (K/Shift, gamepad B) buttons. Timing is critical: the delay
  between your press and ball contact decides shot power — press just as
  the ball arrives for a *perfect* (fast, deep, accurate); early presses
  get weak, drifting shots. High balls + flat swing = overhead smash. The
  direction held at contact (WASD/arrows or analog stick) aims placement.
- **Footwork matters:** where your body is relative to the ball shapes the
  shot. Contact off to one side lets you swing *with* the ball for a
  sharper angle — pulling it back across your body closes the angle and
  drifts. Stepping into the ball (contact out in front) hits on the rise:
  faster and deeper. Low balls get dug up slow and short; shoulder-high
  balls float; contact behind your body is a weak defensive flick.
- **Two-press serve:** press Hit to toss the ball, press again at the top
  of the toss for a perfect serve. Let it drop to re-toss.
- **Character select:** 18 players — six pros (BLAZE, VOLT, KAI, ROSA,
  VIPER, LUNA) plus a wacky dozen (PEELS the banana man, BISCUIT the
  two-legged corgi, SERVO the robot, ZORP the alien, SMASHULA, PLANK,
  YETI, GRANNY, DISCO, INKY the octopus, PRICKLES the cactus, MYSTO) —
  each with its own stats and a fully unique 3D body, shown as a live
  animated render on the select screen. Full list in `ROSTER.md`; the
  wacky roster is designed to become unlockables later.
- **Court select:** grass (fast/low), hard (balanced), clay (slow/high) —
  each with its own bounce physics and looks.
- **Practice mode:** "Practice vs Bot" starts an instant match against a
  server-side AI (ACE BOT) that chases, rallies, lobs, and serves — it runs
  inside the same authoritative 30 Hz tick, so no extra process is needed.
- **Bot difficulty:** EASY / NORMAL / HARD. Easier bots move slower, reach
  less, never dive, mis-read the ball's landing spot, sometimes whiff
  entirely, and strike their serve toss late.
- **🍺 Beer pong:** literal beer pong rules on a tennis court — no rallies.
  Each side has a triangle of 6 cups; players alternate lofted throws
  (toss, then time the strike — timing sets accuracy, the stick picks which
  part of the rack to attack). First bounce in a cup sinks it; clear all 6
  to win. Vs a friend by link, or vs the bot at any difficulty.
- **🎯 Target practice:** solo precision drill. A ball machine feeds 20
  balls; land returns on the 8 bullseyes painted on the far court. Feed
  speed follows the bot difficulty.
- **Custom rules:** every lobby (including tournaments) can tweak ball
  physics — weight (gravity), air drag, shot power, and bounciness — via
  sliders or the MOON BALL / CANNON / BALLOON presets.
- **Tournament mode:** one lobby code, up to 16 players. The host picks the
  format — **single or double elimination** (losers bracket + grand final) —
  and how many matches run at once (1–4), and can change both from the
  registration screen, which also **previews the projected bracket** as
  players join. Pairings are shuffled server-side, and **every empty seat in
  the draw is filled by a normal bot instead of a bye** — a short team gets
  bot partners and the bracket is padded to a power of two — so no entrant
  is ever handed a walkover and everyone plays round 1. A later-round match
  that ends up with bots on both sides is settled on the spot instead of
  being played out — nobody is on the sticks for it, and the bracket would
  otherwise wait on two identical AIs — and the bracket marks it
  AUTO-PLAYED. Rounds advance automatically as matches finish (leaving
  mid-match forfeits it).
  Tournament matches run the same best-of-3 games as quick matches, so
  brackets move fast. Players not currently scheduled **spectate a live
  match** — with nameplates, the broadcast bug, room-wide chat and emotes,
  **N** to hop between concurrent courts and **B** for the bracket — and late
  joiners enter as spectators.
- **🪙 Tournament betting:** everyone in a tournament room gets **1500
  credits** — entrants and anyone who tunes in to watch — and the players
  who aren't on court stake them on the matches they're watching. Odds open
  from each side's **tournament performance** (point share weighted by win
  rate over their finished matches) and are then **corrected by the money**:
  every bet shortens the price on the side it backs, while each slip keeps
  the odds it was written at. A market opens the moment a pairing is drawn
  — so a match waiting for a free court takes bets the whole time — and
  closes at first serve; a match somebody can bet on gets a 12-second
  betting window in front of its 3-2-1. You can never bet on a match you
  (or a teammate) are playing in. Bet from the **BETS** panel on the
  bracket screen or from the courtside bar while watching. A tournament
  therefore ends with **two winners**: the champion on court, and the **bet
  winner** — the biggest stack among everyone who actually had a wager.
- **Real 3D:** Three.js/WebGL renderer with the classic high TV camera,
  shadow-mapped players, stadium crowd, and per-court surfaces.
- **Graphics options:** press **G** or the ⚙ button for a panel of quality
  switches — render resolution, shadows, anti-aliasing, particles, ball
  trail, crowd detail, the film grade, the retro VHS filter (off unless you
  turn it on) and an FPS limit — with a live FPS readout. HIGH / MEDIUM /
  LOW presets set the lot in one click, everything applies instantly (no
  reload), and the choice is remembered per browser.
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

Controls: **WASD / arrows** move · **Space / J / Enter** swing · hold
**back + swing** for a lob.

On a touch device the game shows a floating stick (drag anywhere in the lower
left) plus **HIT**, **LOB** and chat buttons; holding HIT still charges the
shot, and landscape gives you a much bigger court. Emotes stay keyboard-only.

If the game runs slow, press **G** (or tap **⚙ Graphics**) and drop the
quality — the panel opens mid-rally and the FPS readout shows what each
switch bought you. Like the fullscreen button, ⚙ Graphics hides while the
touch controls are up, so on a phone set it from the menu; the settings
persist. Defaults start at MEDIUM (which keeps all the effects and only
softens the pixel-pushing knobs) unless the machine is clearly beefy, and
presets cap rendering at 120 FPS (30 on LOW) — the server ticks at 20 Hz,
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
- Court geometry constants exist in both `spacetimedb/src/index.ts` (the
  source of truth) and `client/src/config.ts` — keep them in sync.
- Match length: a match is a single set — best of 3 games. The first side to
  `GAMES_TO_WIN` (2) games takes it outright, with no 2-game margin, so 2-1
  ends the match and 3 games is the ceiling. Games are still won on tennis
  points (15/30/40, deuce/advantage). The constant lives in
  `spacetimedb/src/index.ts`; the client mirrors it as `QUICK_GAMES_TO_WIN` /
  `TOURNEY_GAMES_TO_WIN` in `client/src/main.ts`.
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
3. Domain: `client` service → `https://tennis.your-domain.com` (port 80).
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

Since the tournament build, a **lobby is a room** (code, host, mode,
settings) and a **`match` row owns each game** (phase, score, serving
side); the ball is keyed by `matchId` and the 30 Hz tick is scheduled
per live match — which is what lets several matches run concurrently in
one room. Quick matches and practice are simply rooms with a single
match. Tournament rooms register up to 16 players, shuffle round-1
pairings, fill any empty seat with a bot player row (`insertBot`, so a
filler hits, serves and holds a bracket seat like anyone else), and a
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

- **Accounts, next steps:** merging two accounts (signing in with a provider
  that already has one keeps that account and leaves the guest behind), a
  global leaderboard and a match-history screen (the `byMmr` index and the
  `match_log` rows are already there), MMR-based matchmaking, and seasons.
- **Team play, phase 3:** quick matches and tournaments both run 2v2 and
  3v3 (`lobby.teamSize` + `player.teamSlot`; the `team` table maps
  bracket captains to members). Still open: the wider doubles alley, and
  letting friends pick their own partner instead of the join-order /
  shuffled draw.
- Bracket overview screen for spectators (current view shows one match;
  a tournament wall showing all courts + results would be great).
- Bot difficulty levels.
- Fault/double-fault serving, tiebreaks, best-of-3 sets.
