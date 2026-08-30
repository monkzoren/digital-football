# Digital Football — plan

A spiritual sibling of Digital Football: a Virtua-Striker-flavored arcade
soccer game for the browser, living in its own repo
(`monkzoren/digital-football`), built on the same bones — SpacetimeDB is the
entire backend, a scheduled tick reducer runs the authoritative simulation,
and a Vite + TypeScript Three.js client renders it with a TV camera. This
document is the plan; nothing here ships into digital-football.

> **Status: M0–M3 landed.** The module and client below are built: pitch,
> ball physics, dribbling, charged kicks, chips, slide tackles, sprint and
> stamina, keeper and outfield bots, goals, the match clock with halves and
> golden goal, every restart, plus the whole inherited meta layer (rooms,
> accounts, reconnect, tournaments, betting, spectating). Still open, and
> still described below as future work: the shooting-gallery minigame, an
> audio pass, and the deferred list at the bottom.

## Vision

Small-sided, fast, physical arcade football. Each human controls **one
footballer** (like haxball or the on-the-sticks player in FIFA, not a whole
team), teams of 1–3 humans with server-side bots filling the rest of a
5-a-side lineup plus an automated goalkeeper. Matches are short and loud:
two 3-minute halves (or first-to-N goals in casual rooms), golden-goal
overtime, crowd, replays-free instant restarts. Everything social that made
Digital Football fun carries over wholesale: lobby codes and public lobby
browser, spectating, tournaments with brackets and bot fill-ins, tournament
betting, accounts/XP/MMR, chat and emotes.

## What transfers vs. what's new

Digital Football was deliberately built as "rooms + matches + a scheduled
tick"; almost all of the meta layer is sport-agnostic. Honest split:

**Transfers nearly verbatim (copy, rename, keep):**

- Repo skeleton: `spacetimedb/` single-file module + `client/` Vite app,
  `spacetime.json`, `publish.sh` (with the `ALLOW_CLEAR=1` guard),
  binding-regeneration workflow.
- Deployment: `docker-compose.yml` three-service stack (server, publisher,
  nginx client with the same-origin `/v1` proxy), Coolify notes, the
  deterministic publisher-identity scheme.
- Accounts: Firebase anonymous auth + Google link (`client/src/auth.ts`),
  the `account` / `match_log` / `session` tables, XP/level curve, Elo MMR,
  the append-only-columns rule ("`account` is the only persistent table").
- Rooms & matchmaking: `lobby` (code, host, public flag, settings),
  `join_lobby` by code/link, public lobby browser, spectator flag,
  reconnect-grace / halt / claim-win / forfeit machinery
  (`grace_timer`, `reap_timer`).
- Tournaments: registration, single/double elimination, bot fill instead of
  byes, concurrent courts→pitches, auto-played all-bot matches,
  `advanceTournament`.
- Betting: `wallet` / `bet` / `book` + `place_bet`, odds from tournament
  performance corrected by money, market open at pairing / closed at
  kickoff. Only the "performance" input changes (goal share instead of
  point share).
- Client chrome: connection/UI state machine in `main.ts`, chat, emotes,
  graphics options panel + presets (`graphics.ts`), fullscreen, touch
  controls (`touch.ts`), gamepad, audio framework (`audio.ts`),
  update-check.
- Conventions: geometry/progression constants duplicated between module and
  `client/src/config.ts`, kept in sync by hand; module entrypoint exports
  only SpacetimeDB constructs.

**New or rewritten (the actual game):**

- Pitch geometry, goals, ball physics with rolling/friction/curl, and a
  **possession model** (dribbling) — tennis has no equivalent.
- Player actions: kick/pass/shoot/chip with the same timing-window
  philosophy as tennis swings, plus tackle/slide and sprint.
- Continuous play + restarts: kickoff, goals, ball-out (kick-ins, corners,
  goal kicks), halftime, the match clock. Tennis's point/serve state
  machine is replaced by a clock + set-piece state machine.
- Goalkeeper AI (always a bot) and outfield bot AI (teammate fill +
  practice opponents, EASY/NORMAL/HARD).
- Renderer content: pitch, goals with nets, football, footballer animations
  (run, kick, slide, keeper dives), goal celebration. The camera, crowd,
  stadium, shadow/quality plumbing all reuse.
- Scoring/stats: goals + assists per player (feeds XP), match result by
  goals.

## Core gameplay design

### Format

- **5-a-side** on a small pitch. 1v1 / 2v2 / 3v3 human seats per team
  (mirroring tennis's MATCH TYPE picker); remaining outfielders and the
  keeper are server bots. A 1v1 room is one human + 3 bot outfielders + bot
  keeper per side.
- Default match: **two halves × 3 minutes** of game clock (clock runs only
  during live play), draw → **golden goal** overtime with a 2-minute cap →
  penalty-shootout minigame (stretch; ship sudden-death goal first, add
  shootout later). Casual/custom rooms can pick "first to N goals" instead.
- Human switching between teammates: **out of scope for v1.** One human =
  one footballer, always. This keeps input, camera, and MMR semantics
  identical to tennis and sidesteps the hardest part of football games.

### Controls (mirror the tennis muscle memory)

- **WASD / arrows / left stick** — move. Direction held at kick contact
  aims the kick (exactly the tennis placement rule).
- **Space / J / A** — kick: context-sensitive **shoot** near goal /
  **pass** otherwise; hold to charge power, release timing sets accuracy
  (the tennis "perfect" window, reusing `swing` + `swing_release`).
- **K / Shift / B** — **chip/lob**: crosses, chips over the keeper — the
  lob button, same slot.
- **L / Ctrl / X** — **slide tackle** (new, replaces nothing): commits you
  to a lunge with a recovery stun; wins the ball on contact, gives a free
  kick if you clip the player first (fouls simplified: no cards in v1,
  just the restart).
- **Sprint** on double-tap direction or a shoulder button — drains a small
  stamina bar (visible under the nameplate).

### Ball & possession

- One ball row keyed by `matchId`, same as tennis. Physics is mostly 2D +
  height: gravity for chips/clearances, rolling friction, wall-less pitch
  (ball out of bounds triggers restarts rather than bouncing).
- **Dribbling:** the ball loosely sticks to the last touch — inside a small
  control radius, the ball is nudged ahead of the runner's movement
  direction (touch spacing scales with speed, so sprinting invites
  tackles). An opponent entering the control radius with a standing
  challenge contest rolls off a stat check + facing; a slide beats a
  dribble it reaches cleanly.
- **Kick resolution** is server-side at contact, like tennis: charge time →
  power, release timing → accuracy cone, held direction → target, body
  position (ball in front vs. behind, like the tennis footwork rules) →
  first-time shots are harder, a ball out in front hits cleaner.

### Bots

- **Keeper bot** (always present, never human in v1): positions on the
  ball-to-goal line, narrows angles, dives with a reaction delay scaled by
  difficulty, distributes to the nearest safe teammate.
- **Outfield bots** fill empty seats in every mode (same philosophy as
  tournament bot fill): simple role assignment (defender/mid/striker by
  seat), chase/mark/support behaviors, pass to open humans preferentially
  so human players stay on the ball. EASY/NORMAL/HARD scale speed,
  reaction, pass accuracy, and tackle timing — the tennis
  bot-difficulty dial, re-tuned.
- **Practice vs Bot** = instant match vs. an all-bot team, inside the same
  tick (no extra process), exactly like ACE BOT.

### Modes at launch parity

- Quick match (private code / public), practice vs bot, tournaments
  (single/double elim, concurrency, betting, spectating with N/B keys),
  and one skill minigame in the beer-pong/target-practice slot:
  **🎯 Shooting gallery** — 20 balls fed to the edge of the box, hit the
  target zones in the goal past a keeper bot; feed speed follows
  difficulty. (Penalty shootout practice can be the second minigame later.)
- Custom rules sliders: ball weight, friction, kick power, bounciness +
  MOON BALL / CANNON / BALLOON presets carry straight over.

## Architecture

Identical shape to digital-football, new sport plugged into the middle:

```
client/  (Vite + TS, Three.js)           spacetimedb/  (TypeScript module)
┌──────────────────────────────┐         ┌─────────────────────────────────┐
│ send inputs:                 │ ──────► │ tables: lobby, match, player,   │
│   set_input(dirX, dirY,      │reducers │   ball, chat, team, wallet/bet/ │
│             sprint)          │         │   book, account/match_log/…     │
│   kick(kind) / kick_release  │         │ reducers: create/join/leave,    │
│   tackle()                   │         │   set_input, kick, tackle, …    │
│ render from subscriptions    │ ◄────── │ game_tick (scheduled, 30 Hz):   │
│ + client-side extrapolation  │  subs   │   movement, dribble, kicks,     │
└──────────────────────────────┘         │   keeper AI, goals, clock,      │
                                         │   restarts, match completion    │
                                         └─────────────────────────────────┘
```

### Module (`spacetimedb/src/index.ts`, single file like tennis)

Tables, mapped from tennis:

| Tennis | Football | Change |
|---|---|---|
| `lobby` | `lobby` | settings gain half length / first-to-N, lose court surface → pitch style (grass day/night/street) |
| `match` | `match` | phase machine becomes: KICKOFF, LIVE, RESTART(kind, side, spot), HALFTIME, OVERTIME, DONE; score = goals; clock fields (half, secondsLeft) |
| `player` | `player` | + stamina, + role (seat position), + hasBall flag; keeps input, teamSlot, spectator, character |
| `ball` | `ball` | + lastTouchPlayerId (for out-of-bounds restarts, assists, own-goal credit), + spin |
| `target` | `goal_event` | new: scorer, assister, minute — drives the score banner, match_log detail, betting settlement |
| `team`, `chat`, `chat_guard` | same | unchanged |
| `wallet`, `bet`, `book` | same | odds seeded from goal share × win rate |
| `account`, `match_log`, `session` | same | match_log gains goals/assists columns (append-only rule applies from day one) |
| `tick_timer`, `grace_timer`, `reap_timer` | same | unchanged |

Reducers: `set_input` gains a sprint bit; `swing`/`swing_release` become
`kick`/`kick_release` (kind: shoot-pass vs chip); new `tackle`. Everything
else (`create_lobby`, `join_lobby`, `create_tournament`, `start_tournament`,
`place_bet`, `forfeit`, `claim_win`, `rematch`, `send_chat`, `send_emote`,
lifecycle, `grace_expired`, `reap_lobby`) keeps its name and most of its
body. `game_tick` stays the one scheduled 30 Hz reducer per live match;
`finishMatch` keeps the tennis rule that progression is awarded **before**
`endMatchCleanup` zeroes `matchId`.

Progression: XP per match (half rate with bots on the pitch — which in
football means *bot teammates beyond the fill are fine, but XP halves
whenever the opposing humans < team size*; simplest faithful port: half XP
unless both sides' human seats are full), MMR moves only when both sides'
human seats are all-human-filled at the chosen match type. Goals/assists
grant small XP bonuses.

### Client

- `config.ts` — pitch geometry, tick rate, progression mirrors (same
  keep-in-sync convention, documented in CLAUDE.md).
- `render.ts` — fork of the tennis renderer: keep camera rig, stadium,
  crowd, lighting, quality plumbing; replace court with pitch + goals +
  nets, add ball-rolling, kick/slide/keeper animations. The tennis
  characters' unique 3D bodies can be reused as the roster (see below).
- `main.ts` — same state machine; scoreboard becomes clock + goals, the
  serve indicator becomes a kickoff/possession indicator, BETS panel and
  courtside bar unchanged.
- `touch.ts` — stick + KICK / CHIP / TACKLE buttons.

### Roster

Launch with the same 18-character concept — 6 "pros" + the wacky dozen.
Cheapest path: port the existing bodies/stat framework, re-skin kits, remap
stats to football (speed, kick power, accuracy, tackling, stamina). PEELS
the banana man sliding into a tackle is the marketing screenshot. A shared
roster also leaves the door open to cross-game identity later.

## Repo bootstrap strategy

**Copy, don't fork-and-track.** Create `monkzoren/digital-football` as a
fresh repo seeded from a copy of digital-football at a known commit, then
diverge freely:

1. New GitHub repo `digital-football` (no fork relationship — the games
   will diverge fast and PRs across them make no sense).
2. Copy the tree; global rename `digital-football` → `digital-football`
   (`spacetime.json`, `docker-compose.yml`, `config.ts` DB name, docs,
   localStorage keys `dt_*` → `df_*`).
3. Delete tennis-only content up front (beer pong, target practice, tennis
   scoring, serve logic, court rendering) rather than letting it rot —
   commit 1 should *build and publish* a walking skeleton: lobby → join →
   two capsules on a green rectangle pushing a ball, no rules.
4. Record the seed commit hash of digital-football in the new README, so
   later fixes there (e.g., to the reconnect or publisher-identity
   machinery) can be cherry-picked by hand.
5. Port CLAUDE.md with the football table above so the same guardrails
   (append-only `account`, award-before-cleanup, constants sync,
   entrypoint-exports rule) exist from day one.

## Milestones

Each milestone ends playable and deployable (the compose stack works from
M1 on).

- **M0 — Skeleton (repo bootstrap).** Copy + rename per above; module
  publishes, bindings generate, client connects; lobby create/join/leave
  and chat work; pitch renders with two movable players and a pushable
  ball. No rules yet.
- **M1 — A goal is a goal.** Ball physics (roll, friction, height),
  dribble-stick, basic kick (instant, no charge), goal detection,
  kickoff/out-of-bounds restarts, clock + halves, match completion +
  rematch. 1v1, no bots. This is the "is it fun to kick a ball" gate —
  budget tuning time here, it decides everything downstream.
- **M2 — Feel.** Charged kicks with the timing window, chip, slide tackle
  + simplified free kicks, sprint/stamina, keeper bot, body-position kick
  modifiers. Camera/animation polish. Custom-rules sliders.
- **M3 — Bots & formats.** Outfield bot AI + difficulty tiers, practice
  mode, 2v2/3v3 human seats with bot fill, public lobby browser,
  spectating, reconnect-halt/claim-win/forfeit wired to football state
  (halt freezes clock and ball; return restarts from a neutral drop ball).
- **M4 — Meta parity.** Accounts/XP/MMR/match history, tournaments
  (bracket, bot fill, auto-played all-bot matches, concurrency), betting
  with goal-share odds, goal_event-driven banners and match_log detail.
- **M5 — Polish & launch.** Full roster with football stats/kits, shooting
  gallery minigame, audio pass (crowd swells on attacks, goal roar,
  chants), touch/gamepad pass, graphics presets re-validated, README +
  self-hosting docs, deploy to Maincloud + a Coolify reference deploy.

Deliberately deferred past launch: penalty shootouts, offside, cards/fouls
beyond the tackle free kick, human goalkeepers, teammate switching, wider
pitch for 3v3, cross-game shared accounts.

## Risks

- **Continuous play is harsher on latency than tennis.** Tennis hides
  round-trips behind ball flight; football has contested 50/50s every
  second. Mitigations: same client-side extrapolation for ball and remote
  players, generous server-side contest radii, keep the pitch small and
  the tick at 30 Hz. Validate with an artificial-latency test in M1.
- **Dribble/tackle tuning is the fun.** M1/M2 are gated on feel, not
  features; timebox rule-completeness (restarts etc.) to protect tuning
  time.
- **Bot AI is bigger than tennis's.** ACE BOT solves one ball and one
  opponent; football bots need positioning off the ball. Keep roles dumb
  (zones + chase-if-nearest) and lean on the keeper bot to keep scores
  sane.
- **Single-file module size.** Tennis's module is ~4k lines and football
  adds AI for 8+ bots; if it strains, split by the schema.ts/index.ts
  pattern the SpacetimeDB rules already bless — but start single-file for
  consistency.
