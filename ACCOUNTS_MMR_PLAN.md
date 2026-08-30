# Player Accounts, XP & MMR — Implementation Plan

Persistent **player accounts** (Firebase Auth), **XP** from every match you
finish (bots included), and an **MMR** that only moves when you play another
human. Because a rating you can lose to a dead router is not a rating, this
also lands the two things that make it fair: **reconnect** — a dropped player
gets their match back — and an explicit **forfeit** for when you actually
want out.

> **Status: built.** Shipped across three commits (module, client, fixes).
> Two deltas from the plan below, both found while building:
> `match_log` gained a `matchId` column so the post-match reveal matches on
> the match instead of a time window, and `leaveCurrentLobby` had to finish
> the match *before* clearing the player's seat — it cleared first, which left
> the quitter off the roster the payout reads and let them walk away from the
> MMR loss entirely. The rest is as specified.

Five slices, in the order they should be built:

1. **Sessions** — presence that survives two tabs and a reconnect race.
2. **Accounts** — a persistent profile row per identity.
3. **Firebase Auth** — a *stable* identity, which is what makes 1–2 mean anything.
4. **XP + MMR** — awarded at the one choke point every match already passes through.
5. **Reconnect + forfeit** — the halt state machine, the grace timers, the room reaper.

---

## 1. Product rules (the spec, made precise)

| Rule | Decision |
|---|---|
| Who has an account | Every identity that connects. Anonymous Firebase sign-in happens automatically on load, so there is no wall in front of the game and no "create account" step. |
| Signing in | Optional, and it *links* — `linkWithPopup` keeps the same Firebase uid, so the SpacetimeDB identity, XP, MMR and history all survive the upgrade. Signing in is how progress escapes one browser. |
| XP | Every finished match pays out, in every mode: tennis, beer pong, target practice, quick, tournament, vs bots. |
| XP vs bots | Half rate (`XP_BOT_MUL = 50%`). Bot grinding levels you, slowly; it never touches MMR. |
| MMR | Elo, seeded at 1000. Moves **only** when every seat on both sides is a human, the ruleset is tennis, and it isn't a practice room. One bot filler on court makes the match casual. |
| Team matches | Ranked. Each player is rated against the **opposing team's average** MMR; every member of a side takes their own delta. |
| Losing on court vs losing by walking | Identical for MMR. A forfeit and a disconnect-timeout are full-weight losses — otherwise quitting is free. XP differs: a quitter banks participation XP only. |
| Disconnect | The match **halts** — clock, ball and physics stop — and the dropped player has **5 minutes** (quick) or **2 minutes** (tournament) to come back. |
| Coming back | Reconnect within the window and the match resumes with the score intact and the point **replayed** from a fresh serve, behind a 3‑2‑1. Nobody eats a serve they never saw. |
| Waiting it out | The player still on court gets the win automatically when the grace expires, and may press **CLAIM WIN** early — but not for the first **60 seconds**, so a router blip is always survivable. |
| Both players drop | The match is abandoned: no winner, no XP, no MMR. The room is reaped a minute later. |
| Forfeit | An explicit button behind a confirm (ESC → match menu). Ends the match immediately, full MMR loss, and in a tournament it eliminates you exactly like a loss on court. |
| Leaving vs dropping | Pressing **Exit To Menu** is a *decision* — it forfeits on the spot, as it does today. Only an involuntary socket close buys the grace window. |
| Identity | `player.identity` stays the primary key of everything. Nothing about rooms, matches, brackets or betting changes shape. |

**Called-out design choices** (defaults chosen; each is one constant to flip):

1. **Anonymous-first.** The game's whole pitch is "click a link, play tennis".
   Firebase anonymous auth gives a stable uid persisted in IndexedDB, which is
   all reconnect and progression need — sign-in only buys *portability*. The
   cost is that clearing site data orphans a guest account, which is exactly
   the nudge that sells signing in.
2. **Guests are ranked.** MMR is display-only in v1 — no matchmaking reads it,
   so a smurf costs nobody a match. When matchmaking arrives, gate ranked on
   `provider === PROV_LINKED` (one condition in `isRanked`).
3. **Claim-win unlocks at 60 s.** Five minutes staring at a frozen court
   because someone alt-F4'd is a bad experience for the player who *didn't*
   quit. Sixty seconds is longer than any real blip.
4. **Tournaments get 2 minutes.** Rounds run as waves — a 5-minute stall on
   one dropped player stalls everyone else in the bracket too.
5. **The halted match keeps its tick timer deleted.** The grace window is one
   scheduled reducer firing once, not 9 000 no-op ticks (§6.3).
6. **Accounts are the first persistent data this database has ever held.**
   That changes the deployment contract — see §10.3, which is the highest-risk
   item in this plan.

---

## 2. Auth: Firebase → SpacetimeDB identity

SpacetimeDB derives an identity by hashing the `iss` + `sub` claims of the
presented JWT and validates the signature against the JWKS it fetches from
`{iss}/.well-known/openid-configuration`. Firebase serves exactly that
document, so **no server configuration is required** — a Firebase ID token is
accepted out of the box:

```
$ curl -s https://securetoken.google.com/<project-id>/.well-known/openid-configuration
{ "issuer": "https://securetoken.google.com/<project-id>",
  "jwks_uri": "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  "id_token_signing_alg_values_supported": ["RS256"] }
```

Three consequences worth stating plainly:

- **The identity is now stable by construction.** Today's identity comes from
  a SpacetimeDB-issued token kept in `sessionStorage` — a tab close loses it,
  and a server re-key invalidates it. A Firebase identity is `hash(iss|sub)`
  and survives both. All the stale-token recovery in `onConnectError`
  (`client/src/main.ts:279`) becomes dead weight.
- **The server needs outbound HTTPS** to `securetoken.google.com` and
  `www.googleapis.com` to fetch signing keys. Locked-down hosts must allow it.
- **The Firebase Auth emulator will not work**, because its tokens are signed
  with a fake key that no JWKS will verify. Local development uses either a
  real Firebase project or the no-Firebase fallback (§9.1).

### 2.1 Claims the module reads

`ctx.senderAuth.jwt` exposes `issuer`, `subject`, `audience` and
`fullPayload`. A Firebase ID token carries:

| Claim | Value | Used for |
|---|---|---|
| `iss` | `https://securetoken.google.com/<project-id>` | provider detection |
| `sub` | the Firebase uid | `account.uid`, support/debug |
| `aud` | `<project-id>` | sanity check |
| `firebase.sign_in_provider` | `anonymous` / `google.com` / `password` | guest vs linked |
| `name`, `email`, `picture` | present once linked | prefilling the display name |

```ts
// Set once, when the Firebase project is created. The module runs in a wasm
// sandbox with no env access, so this is a source constant by necessity.
const FIREBASE_PROJECT = 'digital-tennis';
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT}`;

const PROV_NONE = 0;   // raw SpacetimeDB token (local dev, legacy client)
const PROV_ANON = 1;   // Firebase anonymous
const PROV_LINKED = 2; // Firebase + a real provider
const PROV_OTHER = 3;  // some other issuer — accepted, flagged

function providerOf(ctx: Ctx): { provider: number; uid: string; name: string } {
  const jwt = ctx.senderAuth?.jwt ?? null;
  if (!jwt) return { provider: PROV_NONE, uid: '', name: '' };
  if (jwt.issuer !== FIREBASE_ISSUER) return { provider: PROV_OTHER, uid: jwt.subject, name: '' };
  const fb = jwt.fullPayload['firebase'] as { sign_in_provider?: string } | undefined;
  const anon = fb?.sign_in_provider === 'anonymous';
  const name = typeof jwt.fullPayload['name'] === 'string' ? jwt.fullPayload['name'] : '';
  return { provider: anon ? PROV_ANON : PROV_LINKED, uid: jwt.subject, name };
}
```

**We do not reject non-Firebase issuers in v1.** A hard check
(`if (jwt?.issuer !== FIREBASE_ISSUER) throw new SenderError(...)` in
`clientConnected`) would break local development and any cached client mid-deploy.
The provider is *recorded* instead, which leaves the strict version a
three-line change once the Firebase rollout has settled.

---

## 3. Data model

Four new tables and a handful of appended columns. Module conventions apply:
lowercase table names, `accessor:` camelCase indexes, **append-only columns
with defaults** (inserting mid-table breaks SpacetimeDB's automatic
migration — see the `NOTE:` in `Lobby`).

### 3.1 `account` — the persistent profile

```ts
// The first table in this database that OUTLIVES a room. Everything else —
// lobby, match, player, ball, wallet — dies with the game it belongs to.
// Keep it small and cold: it is written twice per match, never per tick.
const Account = table(
  {
    name: 'account',
    public: true,
    indexes: [{ accessor: 'byMmr', algorithm: 'btree', columns: ['mmr'] }],
  },
  {
    identity: t.identity().primaryKey(),
    uid: t.string(),          // Firebase uid ('' for a raw token)
    provider: t.u8(),         // 0 none · 1 firebase anon · 2 linked · 3 other
    displayName: t.string(),  // source of truth; player.name is the session copy
    characterId: t.u8(),      // last pick, restored on any device
    xp: t.u32(),
    level: t.u16(),           // derived from xp, stored so the client can't drift
    mmr: t.u16(),
    peakMmr: t.u16(),
    ranked: t.u16(),          // ranked matches finished (drives the K-factor)
    rankedWins: t.u16(),
    casual: t.u16(),          // bot / non-tennis matches finished
    casualWins: t.u16(),
    streak: t.i16(),          // + wins in a row, - losses in a row
    bestStreak: t.u16(),
    quits: t.u16(),           // forfeits + disconnect timeouts, on your record
    createdAt: t.timestamp(),
    lastSeen: t.timestamp(),
  }
);
```

`byMmr` is free here and is the whole leaderboard when it gets built.

**Why not columns on `player`?** `player` rows are rewritten by `game_tick`
at 30 Hz and broadcast to every subscriber. Anything parked on that row is
re-sent thirty times a second forever. Progression belongs on a cold row.

### 3.2 `match_log` — one row per participant per match

```ts
// Written once per human per finished match. Powers the post-match XP/MMR
// reveal (the client reads its own newest row rather than diffing a
// snapshot that a reconnect would have thrown away), and is the only
// record of a result that cannot be reconstructed later.
const MatchLog = table(
  {
    name: 'match_log',
    indexes: [{ accessor: 'byAccount', algorithm: 'btree', columns: ['identity'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity(),
    opponentName: t.string(),
    won: t.bool(),
    ranked: t.bool(),
    mmrBefore: t.u16(),
    mmrAfter: t.u16(),
    xpBefore: t.u32(),
    xpGained: t.u32(),
    levelAfter: t.u16(),
    gamesFor: t.u8(),
    gamesAgainst: t.u8(),
    endedBy: t.u8(),          // 0 played out · 1 forfeit · 2 disconnect timeout
    playedAt: t.timestamp(),
  }
);
```

Pruned to the newest `LOG_KEEP = 20` rows per account on insert, the same way
`insertChat` prunes chat. Private table + a per-sender view (§9.4).

> **Flagged decision.** The history *screen* was cut from v1 scope, but the
> table is in — the post-match reveal needs it, it is ~15 lines of write path,
> and unrecorded history is the one thing in this plan that cannot be
> backfilled later. Dropping it means the reveal falls back to diffing a
> client-side snapshot, which a mid-match reconnect loses.

### 3.3 `session` — presence that can count

```ts
// One row per live websocket. An identity can hold several at once (two
// tabs, or a reconnect that races the old socket's close), so presence is
// "has at least one session" — never "the last disconnect wins".
const Session = table(
  {
    name: 'session',
    indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identity'] }],
  },
  {
    connectionId: t.connectionId().primaryKey(),
    identity: t.identity(),
    startedAt: t.timestamp(),
  }
);
```

This table is why reconnect is safe. Without it, a Firebase identity shared by
two tabs would halt a live match every time one of them closed, and a
reconnect that beats the old socket's close event would immediately re-halt
the match it just resumed.

> **Verify at build time:** that `t.connectionId()` exists in the installed
> SDK (`spacetimedb@^2.0.2`). `ctx.connectionId!` in both lifecycle reducers is
> documented; the *column* type is inferred from the documented sessions
> example. If it is missing, store `t.u128()` and convert.

### 3.4 The two scheduled timers

```ts
// Fires once, when a halted match's grace window expires.
const GraceTimer = table(
  { name: 'grace_timer', scheduled: () => grace_expired },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), matchId: t.u64() }
);

// Fires once, when a room whose humans have all gone dark should be torn
// down. Without this, reconnect leaks rooms: a disconnected player still
// "occupies" their lobby, so nobody is left to trigger today's teardown.
const ReapTimer = table(
  { name: 'reap_timer', scheduled: () => reap_lobby },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), lobbyId: t.u64() }
);
```

### 3.5 Appended columns on `match`

```ts
// --- reconnect (appended; see the NOTE in Lobby) ---
haltMask: t.u8().default(0),      // bit 0 = side 0 is short a player, bit 1 = side 1
haltedAt: t.u64().default(0n),    // micros since epoch when the halt began
haltUntil: t.u64().default(0n),   // micros when the grace expires (0 = not halted)
haltName: t.string().default(''), // who we are waiting for, for the banner
```

An **absolute deadline instead of a tick counter** is what keeps a halted
match free: the countdown needs no per-tick write, the client renders it from
wall clock the same way it already extrapolates the ball, and the match row is
written exactly twice — once on halt, once on resume.

> **Verify at build time:** `t.u64().default(0n)` accepts a BigInt default. If
> not, use `halted: t.bool().default(false)` plus two `t.timestamp()` columns.

### 3.6 Schema registration

```ts
const spacetimedb = schema({
  lobby: Lobby, match: Match, player: Player, ball: Ball, chat: Chat,
  chatGuard: ChatGuard, tickTimer: TickTimer, target: Target, team: Team,
  wallet: Wallet, bet: Bet, book: Book,
  account: Account, matchLog: MatchLog, session: Session,
  graceTimer: GraceTimer, reapTimer: ReapTimer,
});
```

---

## 4. XP and the level curve

```ts
const XP_PLAY = 50;       // finishing a match at all
const XP_PER_GAME = 25;   // per game won
const XP_WIN = 100;       // winner's bonus
const XP_BOT_MUL = 50;    // percent, applied to any casual (unranked) match
const LEVEL_BASE = 200;   // xp for level 2
const LEVEL_STEP = 100;   // each level costs this much more than the last
const LEVEL_MAX = 99;
```

A ranked match is worth 150–200 XP; the same match against a bot is worth
75–100.

**The curve.** Level *L* → *L+1* costs `LEVEL_BASE + LEVEL_STEP·(L−1)`, so the
total XP to *reach* level `L` closes to `50·(L−1)·(L+2)`:

| Level | 2 | 5 | 10 | 25 | 50 | 99 |
|---|---|---|---|---|---|---|
| Total XP | 200 | 1 400 | 5 400 | 32 400 | 127 400 | 494 900 |

Integer arithmetic only, and bounded — no floats, no drift between the module
and the client mirror:

```ts
// Server (spacetimedb/src/index.ts)
function levelFor(xp: number): number {
  let lvl = 1;
  while (lvl < LEVEL_MAX && 50 * lvl * (lvl + 3) <= xp) lvl++;
  return lvl;
}
// Client (client/src/config.ts) — mirror, keep in sync like the court geometry
export const totalXpFor = (level: number) => 50 * (level - 1) * (level + 2);
```

**Payout**, per human seat, computed from the roster captured before cleanup:

```ts
const games = p.side === 0 ? match.p0Games : match.p1Games;
let xp = XP_PLAY + games * XP_PER_GAME + (won ? XP_WIN : 0);
if (!ranked) xp = Math.round((xp * XP_BOT_MUL) / 100);
// A quitter banks participation only — no game credit, no win bonus.
if (!won && endedBy !== END_PLAYED) xp = XP_PLAY;
```

---

## 5. MMR

Standard Elo, K-factor by experience so new accounts find their level fast
and settled ones stop swinging.

```ts
const MMR_START = 1000;
const MMR_FLOOR = 100;
const MMR_CEIL = 4000;
const K_PLACEMENT = 48;      // first 10 ranked matches
const K_EARLY = 32;          // matches 10–30
const K_SETTLED = 24;        // thereafter
const PLACEMENT_MATCHES = 10;
const SETTLED_MATCHES = 30;

function kFactor(ranked: number): number {
  if (ranked < PLACEMENT_MATCHES) return K_PLACEMENT;
  if (ranked < SETTLED_MATCHES) return K_EARLY;
  return K_SETTLED;
}

// Rounded away from zero: a win is never worth +0, a loss never costs -0.
function eloDelta(mine: number, theirs: number, won: boolean, ranked: number): number {
  const expected = 1 / (1 + Math.pow(10, (theirs - mine) / 400));
  const raw = kFactor(ranked) * ((won ? 1 : 0) - expected);
  return raw >= 0 ? Math.max(1, Math.round(raw)) : Math.min(-1, Math.round(raw));
}
```

`Math.pow` is fine inside a reducer: determinism only requires that the same
inputs give the same output on the machine that runs it, and the result is
*stored*, never recomputed. The client displays `account.mmr`; it never
re-derives it.

**Eligibility.** Ranked means: a real pairing, tennis, no bots, not a practice
room, and at least one point actually played.

```ts
const END_PLAYED = 0, END_FORFEIT = 1, END_TIMEOUT = 2;

function isRanked(lobby: LobbyRow | null | undefined, match: MatchRow, seats: PlayerRow[]): boolean {
  if (!lobby || !match.hasP1) return false;
  if (lobby.ruleset !== RULES_TENNIS) return false;   // beer pong / targets are their own games
  if (lobby.vsBot) return false;                       // practice
  const humans = seats.filter(p => !p.isBot && !p.spectator);
  if (humans.length !== seats.filter(p => !p.spectator).length) return false; // any bot filler → casual
  return [0, 1].every(s => humans.some(p => p.side === s));
}
```

Note the consequence for tournaments: a bracket seat filled by `insertBot`
makes that match casual. That is the correct call — the bot is a placeholder,
not an opponent.

**Team matches.** Each side's rating is the mean of its members' MMR
(integer mean, computed *before* anything is written so both sides are rated
against the same snapshot); every member then takes their own delta against
the opposing average, using their own K-factor.

**Forfeits and timeouts move MMR at full weight.** Anything less makes
quitting a rating-management tool.

---

## 6. Reconnect: the halt state machine

### 6.1 What changes

Today, `onDisconnect` (`spacetimedb/src/index.ts:2276`) calls
`leaveCurrentLobby`, which forfeits any live match on the spot and can tear
the whole room down. That is the single behaviour this section replaces.

The client needs almost nothing: `frame()` (`client/src/main.ts:3411`) already
derives the entire screen state from `player.lobbyId` / `player.matchId`. Stop
clearing those fields on disconnect and a returning client resumes into its
match on its own.

### 6.2 Presence rules, by where you were standing

| Where you were when the socket died | What happens |
|---|---|
| In a **live match** | The match halts. Grace window starts. Your seat, score and bracket position are held. |
| In a **tournament room**, bracket running, waiting for your round | Seat held. Your next match halts the moment `goLive` seats you offline. |
| In a **tournament room**, still in registration | Removed, as today. You were never in the draw. |
| In a **quick-match lobby**, no live match (filling up, or on the game-over screen) | Removed, as today. There is no match to protect and a ghost seat blocks a real joiner. |
| **Spectating** | Removed. Watchers hold nothing. |

### 6.3 Halting

```ts
const GRACE_QUICK   = 300_000_000n; // 5 min
const GRACE_TOURNEY = 120_000_000n; // 2 min — rounds run as waves; see §1
const CLAIM_UNLOCK  =  60_000_000n; // opponent may end it early after 1 min
const REAP_AFTER    =  60_000_000n; // room teardown, after the longest grace

function haltMatch(ctx: Ctx, match: MatchRow, p: PlayerRow) {
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const grace = lobby?.mode === MODE_TOURNAMENT ? GRACE_TOURNEY : GRACE_QUICK;
  // A second drop never extends the first one's clock.
  const until = match.haltUntil === 0n ? now + grace : match.haltUntil;

  deleteTickTimers(ctx, match.id);                    // the world stops
  if (match.haltUntil === 0n) {
    ctx.db.graceTimer.insert({
      scheduledId: 0n, scheduledAt: ScheduleAt.time(until), matchId: match.id,
    });
  }
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false });
  ctx.db.match.id.update({
    ...match,
    haltMask: match.haltMask | (1 << p.side),
    haltedAt: match.haltedAt === 0n ? now : match.haltedAt,
    haltUntil: until,
    haltName: p.name || 'PLAYER',
    pointMsg: `WAITING FOR ${p.name || 'PLAYER'}…`,
  });
}
```

**Deleting the tick timer is the point.** A halted match costs exactly one
scheduled reducer call — the one that fires when the grace expires — instead
of 9 000 no-op ticks over five minutes. `game_tick` keeps a cheap guard
anyway (`if (match.haltMask !== 0) return;`) so a timer that outlives its
match by a tick can't run the world.

### 6.4 Resuming

```ts
function resumeMatch(ctx: Ctx, match: MatchRow) {
  for (const g of ctx.db.graceTimer.iter()) {
    if (g.matchId === match.id) ctx.db.graceTimer.scheduledId.delete(g.scheduledId);
  }
  // Replay the point: same score, same server, fresh serve behind a 3-2-1.
  // Resuming mid-flight would hand somebody a ball they never saw.
  const live = setupServe(ctx, {
    ...match, haltMask: 0, haltedAt: 0n, haltUntil: 0n, haltName: '',
  });
  ctx.db.match.id.update({
    ...live,
    startTicks: COUNTDOWN_TICKS,
    pointMsg: 'RECONNECTED — REPLAYING THE POINT',
  });
  startTicking(ctx, match.id);   // factored out of goLive
}
```

A side is only back when **all** of its seats are back — in doubles, one
returning player does not resume the match for a partner who is still gone.

### 6.5 Expiry

```ts
export const grace_expired = spacetimedb.reducer(
  { onSchedule: GraceTimer }, { arg: GraceTimer.rowType },
  (ctx, { arg }) => {
    const match = ctx.db.match.id.find(arg.matchId);
    if (!match || match.state !== M_LIVE || match.haltMask === 0) return; // resumed already
    const missing0 = (match.haltMask & 1) !== 0;
    const missing1 = (match.haltMask & 2) !== 0;
    if (missing0 && missing1) return abandonMatch(ctx, match);   // nobody left to award
    const winnerSide = missing0 ? 1 : 0;
    const seats = matchPlayers(ctx, match.id);
    const humanWins = seats.some(p => p.side === winnerSide && !p.isBot);
    const lobby = ctx.db.lobby.id.find(match.lobbyId);
    // A bot "beating" an absent human is only meaningful inside a bracket,
    // where somebody has to advance. In a practice room it is just litter.
    if (!humanWins && lobby?.mode !== MODE_TOURNAMENT) return abandonMatch(ctx, match);
    finishMatch(ctx, match, winnerSide,
      `${match.haltName} DIDN'T COME BACK — ${teamName(seats, winnerSide)} WINS`,
      END_TIMEOUT);
  }
);
```

`abandonMatch` finishes the row with `winnerSide = NO_WINNER`, awards nothing,
runs `endMatchCleanup`, and leaves the room to the reaper.

### 6.6 Claiming early

```ts
export const claim_win = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  const match = player.matchId === 0n ? null : ctx.db.match.id.find(player.matchId);
  if (!match || match.state !== M_LIVE || match.haltMask === 0) throw new SenderError('Nothing to claim');
  if ((match.haltMask & (1 << player.side)) !== 0) throw new SenderError('Your own side is short a player');
  const waited = ctx.timestamp.microsSinceUnixEpoch - match.haltedAt;
  if (waited < CLAIM_UNLOCK) {
    throw new SenderError(`Give them a moment — ${Number((CLAIM_UNLOCK - waited) / 1_000_000n)}s`);
  }
  finishMatch(ctx, match, player.side,
    `${match.haltName} DIDN'T COME BACK — ${teamName(matchPlayers(ctx, match.id), player.side)} WINS`,
    END_TIMEOUT);
});
```

### 6.7 The room reaper

Reconnect creates a leak that did not exist before: a disconnected player
still occupies their lobby, so the "last human left, tear it down" path in
`leaveCurrentLobby` never fires for a room where everyone dropped.

- **Arm** on any disconnect: if no human in the lobby has a session left,
  insert a `ReapTimer` at `now + GRACE_QUICK + REAP_AFTER` (comfortably after
  any grace timer for that room).
- **Disarm** on any connect that lands in that lobby.
- **Fire**: if a human is online again, do nothing. Otherwise run the full
  teardown — the block currently inlined in `leaveCurrentLobby`, factored out
  as `destroyLobby(ctx, lobby)` and called from both places.

---

## 7. Forfeit

```ts
export const forfeit = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  const match = player.matchId === 0n ? null : ctx.db.match.id.find(player.matchId);
  if (!match || match.state !== M_LIVE) throw new SenderError('No live match to forfeit');
  const winnerSide = 1 - player.side;
  finishMatch(ctx, match, winnerSide,
    `${player.name || 'PLAYER'} FORFEITS — ${teamName(matchPlayers(ctx, match.id), winnerSide)} WINS`,
    END_FORFEIT);
});
```

Forfeiting ends the *match*, not your membership: you stay in the room for the
rematch vote or the bracket screen. In a tournament it routes through the
existing `eliminateLoser`, so it eliminates exactly like a loss on court. In
doubles it forfeits for the team, matching what leaving already does.

---

## 8. Server changes, hook by hook

### 8.1 `finishMatch` — the one choke point

Every result in the game already funnels through it: a match won on court, a
walkover from `leaveCurrentLobby`, a forfeit, a disconnect timeout. Adding a
fifth parameter and one call is the whole progression integration.

```ts
function finishMatch(ctx, match, winnerSide, msg, endedBy = END_PLAYED) {
  // Capture the roster FIRST: endMatchCleanup sets matchId = 0 on every
  // player, after which matchPlayers(match.id) returns nothing.
  const seats = matchPlayers(ctx, match.id);
  const done = { ...match, state: M_DONE, phase: PHASE_GAME_OVER, winnerSide, pointMsg: msg,
                 haltMask: 0, haltedAt: 0n, haltUntil: 0n, haltName: '' };
  ctx.db.match.id.update(done);
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  awardProgression(ctx, lobby, done, seats, winnerSide, endedBy);   // ← new, before cleanup
  endMatchCleanup(ctx, done);
  if (lobby?.mode === MODE_TOURNAMENT) { settleBets(...); eliminateLoser(...); advanceTournament(...); }
}
```

That ordering bug — awarding after `endMatchCleanup` — would silently pay out
nothing, on every match, forever. It is the single easiest way to get this
wrong.

### 8.2 `awardProgression`

```ts
function awardProgression(ctx, lobby, match, seats, winnerSide, endedBy) {
  if (winnerSide === NO_WINNER) return;                       // abandoned
  if (match.p0PtsTotal + match.p1PtsTotal === 0 && endedBy === END_PLAYED) return; // nothing happened
  const humans = seats.filter(p => !p.isBot && !p.spectator);
  if (humans.length === 0) return;
  const ranked = isRanked(lobby, match, seats);
  // Snapshot both sides' ratings BEFORE writing, so the two deltas are
  // computed against the same numbers.
  const before = new Map(humans.map(p => [p.identity.toHexString(), accountOf(ctx, p.identity)]));
  const avg = (side: number) => { /* integer mean of that side's MMR, MMR_START for bots */ };
  for (const p of humans) { /* xp, elo, streak, counters, match_log row, prune */ }
}
```

### 8.3 Every other hook

| Function | Change |
|---|---|
| `onConnect` (`:2248`) | Insert the `session` row. `ensureAccount`. Restore `displayName` / `characterId` onto the player row. Clear the caller's halt bit and `resumeMatch` when their side is whole. Disarm the lobby's reaper. |
| `onDisconnect` (`:2276`) | Delete the `session` row; **return early if the identity still has one**. Otherwise `online = false`, then branch on the §6.2 table: `haltMatch`, hold the seat, or `leaveCurrentLobby` as today. Arm the reaper. |
| `goLive` (`:1007`) | Factor the tick-timer insert into `startTicking`. After seating, if any seated human has no session, halt immediately — a tournament must not start a match into an empty chair and wait a tick to notice. |
| `leaveCurrentLobby` (`:2168`) | Pass `END_FORFEIT` to `finishMatch`. Factor the teardown block into `destroyLobby`. |
| `game_tick` (`:2842`) | One guard at the top: `if (match.haltMask !== 0) { deleteTickTimers(...); return; }`. |
| `set_name` (`:2286`) | Write through to `account.displayName`. |
| `set_character` (`:2293`) | Write through to `account.characterId`. |
| `start_tournament` (`:2511`) | Drop entrants with no session before drawing the bracket. |
| `simulateBotMatch` (`:1419`) | Unchanged — no humans on court, nothing to award. |

### 8.4 The view for a player's own log

```ts
spacetimedb.view(
  { name: 'my_match_log', public: true },
  t.array(MatchLog.rowType),
  ctx => [...ctx.db.matchLog.byAccount.filter(ctx.sender)]   // index lookup, never .iter()
);
```

---

## 9. Client changes

### 9.1 `client/src/auth.ts` (new)

```ts
initAuth()            // firebase/app + firebase/auth from VITE_FIREBASE_*
ensureUser()          // onAuthStateChanged → signInAnonymously() if none
getToken(force?)      // user.getIdToken() — refreshes itself past the 1h expiry
signIn(provider)      // linkWithPopup(user, provider) — SAME uid, progress kept
signOut()             // signOut + signInAnonymously → a NEW guest identity
onChange(cb)          // identity changed → reconnect the SpacetimeDB socket
```

`signIn` handles the one genuinely awkward case: `linkWithPopup` throws
`auth/credential-already-in-use` when that Google account is already a
Digital Tennis account. Fall back to `signInWithPopup` (switch to the existing
account) behind a dialog that says plainly that the guest progress on this
device stays with the guest profile. Merging two accounts is a non-goal (§13).

**No-Firebase fallback.** If `VITE_FIREBASE_PROJECT_ID` is unset, keep today's
anonymous SpacetimeDB token — but move it from `sessionStorage` to
`localStorage`, or reconnect cannot work at all. To preserve the two-tab local
QA flow that shared storage would break, namespace the key by a `?seat=N`
URL param: `dt_token` / `dt_token:2`.

### 9.2 Connection (`client/src/main.ts:241`)

- `connect()` becomes async: `.withToken(await getToken())`.
- **Stop persisting the token returned by `onConnect`.** Firebase is the source
  of truth; a stale SpacetimeDB token would fight it.
- Delete the stale-token recovery in `onConnectError` — impossible now that the
  identity comes from `iss|sub`.
- **Add `.onDisconnect(...)`, which does not exist today.** A mid-session drop
  currently leaves the client staring at a frozen court forever. Show
  `RECONNECTING…` and retry with backoff (2 s, 4 s, 8 s, capped at 8 s) for as
  long as the tab is open — the server is holding a seat for five minutes;
  the client should spend them trying.
- Subscriptions: `+ SELECT * FROM account`, `+ SELECT * FROM my_match_log`.

### 9.3 UI surfaces (v1 scope)

| Surface | Where |
|---|---|
| **Profile card** — LEVEL, XP bar to next level, MMR, W‑L, streak | `#menu` card, under the PLAYING AS row (`client/index.html:3099`) |
| **Account chip** — `GUEST · SIGN IN TO SAVE PROGRESS`, or the linked email + SIGN OUT | next to the name chip |
| **Post-match reveal** — `+150 XP` bar fill, `MMR 1000 → 1018 (+18)`, a LEVEL UP flourish | `#gameover` (`client/index.html:3272`), read from the newest `my_match_log` row |
| **MMR on nameplates** — lobby chips, match intro cards, over-the-head tags | `updateRoster`, `maybeShowMatchIntro`, `#name-tag-*` |
| **Halt overlay** — `WAITING FOR BLAZE — 4:32`, CLAIM WIN (disabled until 60 s) | new `#halt-overlay`, driven off `match.haltUntil` / `haltedAt` |
| **Match menu** — Resume · Settings · **Forfeit Match** (confirm) | new `#match-menu`, opened by ESC in a live match |

Countdowns render from wall clock against `haltUntil`, exactly like the ball
extrapolation — no per-second server writes.

### 9.4 Config mirror

`client/src/config.ts` gains `totalXpFor`, `MMR_START`, `CLAIM_UNLOCK_SECS`
and the grace constants, under the same "keep in sync" note the court geometry
already carries.

---

## 10. Ops

### 10.1 Firebase project setup

1. Create the project; enable **Anonymous** and **Google** sign-in.
2. Add every domain the game is served from to **Authorized domains**.
3. Copy the web config into build-time env (`VITE_FIREBASE_API_KEY`,
   `_AUTH_DOMAIN`, `_PROJECT_ID`, `_APP_ID`) — public values by design.
4. Set `FIREBASE_PROJECT` in `spacetimedb/src/index.ts` to the same project id.

### 10.2 Compose / env

`docker-compose.yml` passes the four `VITE_FIREBASE_*` values as client build
args; `.env.example` documents them as optional (absent ⇒ the §9.1 fallback).
The SpacetimeDB container needs egress to `securetoken.google.com` and
`www.googleapis.com`.

### 10.3 The migration hazard — read this one

`spacetimedb/publish.sh` currently ends with:

```sh
echo "Publish rejected (breaking schema change?) — clearing database and retrying..."
try_publish --clear-database || publish_failed
```

That is a sensible default for a database whose contents die with every room.
It is **data loss** the moment `account` exists — one breaking schema change
and every player's XP, MMR and history are gone, silently, on deploy.

Required changes, before the account table ships:

1. Gate the auto-clear behind an explicit `ALLOW_CLEAR=1`. Without it, print
   what broke and exit non-zero.
2. Document the append-only rule for `account` in `CLAUDE.md`, next to the
   existing court-geometry note.
3. Ship a backup one-liner in the README and run it before risky publishes:
   `spacetime sql digital-tennis "SELECT * FROM account" > accounts.bak`

---

## 11. Edge cases & abuse checklist

| Case | Handling |
|---|---|
| Two tabs, one identity | `session` rows are counted; closing one tab never halts a match. Inputs from both tabs hit the same player row — last write wins. Known quirk, harmless. |
| Reconnect races the old socket's close | New connect clears the halt; the late disconnect finds a live session and does nothing. Order-independent by construction. |
| Player returns after the award | `endMatchCleanup` already cleared `matchId`, so they land on the game-over screen. |
| Both sides drop | `abandonMatch` — no winner, no XP, no MMR. Reaper collects the room. |
| Drop during the pre-serve countdown or the between-points pause | The match is `M_LIVE`, so it halts; resume replays the serve. |
| Drop in a tournament between rounds | Seat held; the next `goLive` halts immediately rather than starting into an empty chair. |
| Bot "wins" a timeout | Awarded only inside a bracket, where someone must advance. Elsewhere the match is abandoned. |
| Forfeit while the opponent is halted | Legal, and you lose. Odd, but it is what the button says. |
| MMR farming with an alt | Real, unaddressed in v1: MMR gates nothing yet. When matchmaking lands, add a per-pair repeat-match damper and require `PROV_LINKED`. |
| XP farming vs bots | Halved. If it becomes a problem, add `botXpToday` + `botXpDay` columns and a daily soft cap. |
| Clearing browser data as a guest | The account is orphaned. This is the reason the SIGN IN chip exists, and the dialog says so. |
| Renaming | `account.displayName` is authoritative; `player.name` is the per-room copy. |
| Betting interaction | Untouched. A forfeit or timeout settles the book on the bracket result, exactly as a walkover does today. |

---

## 12. QA plan

**Two identities now needs two browser profiles** (or one normal + one
incognito window) — a Firebase anonymous user is per-profile, so two tabs are
one player. The README's "two tabs = two identities" instruction must be
updated. Without Firebase configured, `?seat=2` restores the old flow.

1. **Reconnect, fast** — kill the network mid-rally, restore within 30 s.
   Match resumes, score intact, point replayed behind a 3‑2‑1.
2. **Reconnect, slow** — return at 4:30. Same result.
3. **Claim win** — button disabled at 30 s, enabled at 61 s, ends the match.
4. **Auto win** — walk away. Award lands at 5:00 on the dot with `END_TIMEOUT`.
5. **Tournament grace** — same, 2:00, and the bracket advances afterwards.
6. **Both drop** — no winner recorded, room gone within ~6 minutes.
7. **Doubles** — one partner drops: match halts; they return: match resumes.
   Partner never returns: the whole team takes the loss.
8. **Forfeit** — ESC → Forfeit → confirm. Opponent sees the win; MMR moves
   both ways; a tournament forfeit eliminates.
9. **Two tabs** — close one mid-match; nothing halts.
10. **XP** — a bot match pays half a ranked one; the loser of a forfeit gets
    `XP_PLAY` and nothing else.
11. **MMR symmetry** — winner's gain and loser's loss are equal and opposite
    at equal ratings; a placement account swings roughly twice as far.
12. **Link** — play as a guest, earn XP, sign in with Google: same identity,
    XP intact. Sign out: a fresh guest account, old one untouched.
13. **Publish safety** — a breaking schema change fails loudly instead of
    clearing the database.

---

## 13. Build order

Each step publishes on its own and leaves the game playable.

| # | Step | Touches |
|---|---|---|
| 1 | `session` table + presence counting (no behaviour change) | module |
| 2 | `account` table, `ensureAccount`, name/character write-through, subscription, read-only profile card | module + client |
| 3 | Firebase auth: `auth.ts`, async connect, fallback, env, README | client + ops |
| 4 | XP + level + `awardProgression` + `match_log` + post-match reveal | module + client |
| 5 | MMR + `isRanked` + nameplate ratings | module + client |
| 6 | Halt / resume / grace timers / `claim_win` / reaper / halt overlay | module + client |
| 7 | `forfeit` reducer + ESC match menu | module + client |
| 8 | `publish.sh` clear-guard, `CLAUDE.md` + README updates, roadmap | ops + docs |

Step 6 is the largest and depends on 1; steps 4–5 depend on 2. Step 8 must
land **before** step 2 reaches production, not after.

Rough size: ~450 lines in `spacetimedb/src/index.ts`, ~350 in
`client/src/main.ts`, a new ~120-line `client/src/auth.ts`, plus markup, CSS
and docs.

---

## 14. Non-goals (v1)

- **Account merging.** Two identities cannot be combined; signing into an
  existing account keeps that account and leaves the guest one alone.
- **Leaderboard screen** and **match history screen** — the data and the
  `byMmr` index are in place; only the UI is deferred.
- **MMR-based matchmaking.** Rooms are still joined by code or from the
  browser. MMR is a number you wear, not a queue you enter.
- **Seasons, resets, decay, divisions, cosmetic level rewards.**
- **Anti-smurf enforcement**, per-pair damping, daily XP caps.
- **Cross-device concurrent play** on one account — allowed, undefined.
- **Server-side rate limiting on `forfeit` / `claim_win`** beyond the existing
  state checks.
