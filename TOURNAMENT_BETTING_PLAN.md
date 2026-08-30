# Tournament Spectator Betting — Implementation Plan

Idle players in a running tournament bet **tournament credits** on matches.
Everyone gets **1500 credits** when the tournament starts; odds open from
**tournament performance** and are then **corrected by the bets themselves**.
Only **idle, non-playing** players can bet — never the players on court.
The tournament ends with **two winners**: the game champion on the court,
and the **bet winner** — whoever grew their credits the most in the stands.

This plan covers the full slice: SpacetimeDB schema + reducers, odds math,
match-lifecycle hooks, client subscriptions, and every UI surface, in the
order it should be built.

---

## 1. Product rules (the spec, made precise)

| Rule | Decision |
|---|---|
| Who gets credits | Every human in a tournament room: entrants get a wallet at `start_tournament`; anyone who joins a *running* tournament as a spectator gets one on join. 1500 each, per tournament. |
| Who can bet | Anyone in the room with a wallet whose `player.matchId === 0n` at placement time (waiting for a round, eliminated, or a pure spectator). |
| Who cannot bet | Players currently in any live match, and — on a given match — anyone scheduled to play in it (their whole team, in 2v2/3v3). You never bet on your own match. |
| What you bet on | Real tournament matches (`hasP1 = true`) in your own room. Byes have no book. Quick matches / practice have no betting at all. |
| When bets open | The moment the match row is created (round creation — so pending matches behind the concurrency limit are open the whole wait). |
| When bets close | When the pre-serve countdown reaches zero. Tournament matches with at least one eligible bettor in the room get an extended countdown (**12 s betting window + the 3‑2‑1**) so even instantly-live matches have a real window. No bettors → normal 3 s start. |
| Bet shape | One bet per player per match: pick a side, stake 10 ≤ n ≤ balance. No cancels, no edits (prevents odds manipulation by place-and-withdraw). |
| Odds | Decimal odds, **locked at placement**. Opening line comes from tournament performance; every accepted bet moves the line for the *next* bettor (seeded pari-mutuel market, §3). |
| Settlement | At `finishMatch`: winners receive `round(stake × odds)` (stake included), losers already paid at placement. Forfeits settle normally — the bracket result is the result. |
| **Two winners** | When the champion is crowned, the tournament also crowns a **BET WINNER**: the highest wallet balance among players who placed at least one bet (ties share the title, names joined `A & B`). Non-bettors sitting on their untouched 1500 don't qualify. Both crowns show on the tournament-over screen. |
| Lifetime | Wallets, bets, and books live exactly as long as the room; the champion screen shows the bet winner + a top-bettors list. Nothing persists across tournaments (matches the game's no-persistent-data philosophy). |

**Called-out design choices** (defaults chosen; easy to flip if wanted):

1. **Spectators get wallets too.** They are the archetypal "idle non-playing
   players". Leave/rejoin refill abuse is blocked by keeping wallet rows keyed
   `(lobbyId, identity)` alive until the room dies — rejoining reuses your
   old balance.
2. **No betting on your own match** even while it's still pending — a player
   who can profit from tanking breaks the bracket. (The prompt's "idle
   non-playing players" reads naturally as *not a player of that match*.)
3. **Fixed odds at placement**, not pure pari-mutuel. It's the natural
   reading of "odds… corrected by other player bets" (each bet visibly moves
   the line), and bettors see exactly what they'll win. Cost: payouts aren't
   zero-sum — credits get minted on wins. That's fine for fun-money and keeps
   the leaderboard exciting; noted, not a bug.
4. **No live in-play betting** in v1. The book locks at first serve. (Future
   work: re-open with score-adjusted odds between sets.)

---

## 2. Data model (SpacetimeDB, `spacetimedb/src/index.ts`)

Three new tables + two appended `match` columns. Follow the module's existing
conventions: lowercase table names, `accessor:` camelCase indexes
(`byLobby` / `byMatch` are already reused across tables in this module —
proven safe on spacetimedb 2.0.2), and **append-only columns with defaults**
(the `NOTE:` in the `Lobby` table: inserting mid-table breaks automatic
migration).

```ts
// Per-tournament betting wallet — one row per human per tournament room.
// Rows survive leave/rejoin (no fresh-1500 exploit) and die with the room.
const Wallet = table(
  { name: 'wallet', public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }] },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    identity: t.identity(),
    balance: t.u32(),   // spendable credits
    staked: t.u32(),    // locked in open bets (display: "1,150 + 200 in play")
    won: t.u32(),       // settled winnings   (leaderboard flavor)
    lost: t.u32(),      // settled losses
  }
);

// One bet: side + stake + the decimal odds locked when it was placed.
const Bet = table(
  { name: 'bet', public: true,
    indexes: [{ accessor: 'byMatch', algorithm: 'btree', columns: ['matchId'] }] },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    matchId: t.u64(),
    bettor: t.identity(),
    bettorName: t.string(), // denormalized — readable even if they leave
    side: t.u8(),           // 0 = p0/captain0's side, 1 = p1's
    stake: t.u32(),
    oddsMilli: t.u32(),     // decimal odds ×1000, locked at placement (1850 = 1.85×)
    state: t.u8(),          // 0 open · 1 won · 2 lost
    payout: t.u32(),        // stake×odds on a win, else 0 — set at settlement
    placedAt: t.timestamp(),
  }
);

// The market for one match. Server-authoritative odds: the client only
// renders this row, and place_bet locks odds from it — zero drift.
const Book = table(
  { name: 'book', public: true },
  {
    matchId: t.u64().primaryKey(),
    lobbyId: t.u64(),
    open: t.bool(),
    priorMilli: t.u32(),               // performance-implied P(side 0) ×1000
    seed0: t.u32(), seed1: t.u32(),    // virtual seed pools (from the prior)
    pool0: t.u32(), pool1: t.u32(),    // real credits staked per side
    odds0Milli: t.u32(), odds1Milli: t.u32(), // CURRENT decimal odds ×1000
  }
);
```

Register them: `schema({ …existing, wallet: Wallet, bet: Bet, book: Book })`.

**`Lobby` — two appended columns** (the bet winner is decided server-side at
crown time and stored beside `championName`, so every client renders the same
authoritative result):

```ts
    // NOTE: appended columns — the betting crown, set with the champion
    betWinnerName: t.string().default(''),  // '' = nobody placed a bet
    betWinnerCredits: t.u32().default(0),
```

**`Match` — two appended columns** (defaults, at the very end of the column
list, per the migration rule):

```ts
    // NOTE: appended columns — whole-match points won, for betting priors
    // (p0Points/p1Points reset every game and games reset every set, so the
    // finished row otherwise retains no performance signal beyond sets)
    p0PtsTotal: t.u16().default(0),
    p1PtsTotal: t.u16().default(0),
```

Incremented in `awardPoint()` (~line 1176) right where `p0Points++ /
p1Points++` happens. Tournaments are tennis-only (`create_tournament`
hard-codes `RULES_TENNIS`), so `awardPoint` is the only scoring path that
matters.

New constants block (near the other tunables, **not exported** — the module
entrypoint may only export SpacetimeDB constructs):

```ts
// Tournament betting
const BET_STARTING_CREDITS = 1500;
const BET_MIN_STAKE = 10;
const BET_WINDOW_TICKS = ticks(12);  // extra pre-serve time when bettors exist
const BET_SEED_TOTAL = 1000;         // virtual credits backing the opening line
const BET_PRIOR_MIN = 0.15;          // prior clamp → opening odds stay ~1.18×–6.7×
const BET_ODDS_MIN_MILLI = 1050;     // 1.05× floor …
const BET_ODDS_MAX_MILLI = 20000;    // … 20× ceiling
const B_OPEN = 0, B_WON = 1, B_LOST = 2;
```

---

## 3. Odds model

### 3.1 Performance prior (the opening line)

Computed once, when the match row is created. A bracket unit is a **captain**
(same convention as the bracket itself — works unchanged for 2v2/3v3). Only
**finished real matches** (`state === M_DONE && hasP1`) of this tournament
count; byes carry no information.

```
per unit u:
  wins, losses          — real matches won / lost so far
  ptsW, ptsT            — points won / points contested (from p*PtsTotal)

pointShare(u) = (ptsW + 12) / (ptsT + 24)        // smoothed toward 0.5
winRate(u)    = (wins + 1) / (wins + losses + 2) // smoothed toward 0.5
strength(u)   = pointShare(u)^1.5 × winRate(u)

pPrior(side0) = clamp(s0 / (s0 + s1), 0.15, 0.85)
```

Round 1: no data → everyone 0.5 → both sides open at 2.00×. Floats are fine
(reducers already do heavy float physics; deterministic in the wasm runtime).
The exponents are the tuning dials — raise `pointShare`'s to sharpen how much
a 2‑0 sweep separates from a scrappy 2‑1.

### 3.2 Market correction (bets move the line)

Seeded pari-mutuel state, fixed-odds payouts:

```
seed0 = round(BET_SEED_TOTAL × pPrior)      seed1 = BET_SEED_TOTAL − seed0
tot   = seed0 + seed1 + pool0 + pool1
p0    = (seed0 + pool0) / tot
odds0Milli = clamp(round(1000 × tot / (seed0 + pool0)), 1050, 20000)   // = 1/p0
odds1Milli = clamp(round(1000 × tot / (seed1 + pool1)), 1050, 20000)
```

`BET_SEED_TOTAL` sets market stiffness: with 1000 virtual credits behind the
opening line, a 300-credit bet moves it noticeably but one bettor can't peg
the odds. All integer inputs stay far below 2^53 — exact JS math,
deterministic.

**Worked example.** Semifinal: BLAZE swept round 1 (sets 2‑0, points 32‑18),
KAI survived 2‑1 (points 40‑36).

- BLAZE: pointShare = 44/74 = .595, winRate = .667 → strength .306
- KAI: pointShare = 52/100 = .520, winRate = .667 → strength .250
- pPrior(BLAZE) = .550 → seeds 550/450 → opens **1.82× / 2.22×**
- VOLT bets 300 on BLAZE, ROSA bets 100 on KAI → tot 1400 →
  line moves to **1.65× / 2.55×**. ROSA's slip still says 2.22× — locked.
- KAI wins: ROSA collects `round(100 × 2.22)` = 222 (her 100 back + 122).

### 3.3 Locking & settlement

- Lock: when `startTicks` hits 0 in `game_tick` → `book.open = false`.
- Settle in `finishMatch`: every bet on the match →
  win: `payout = round(stake × oddsMilli / 1000)`, credit wallet,
  `state = B_WON`; loss: `state = B_LOST` (stake left the wallet at
  placement). Update `staked/won/lost` tallies; close the book if a forfeit
  ended the match mid-window.
- No refund path is needed in v1: a bet's match always resolves (leaving a
  live match forfeits it), and room teardown deletes the whole economy anyway.

---

## 4. Server changes, hook by hook

All in `spacetimedb/src/index.ts` (single-file module).

### New helpers (near the tournament scheduler)

```ts
function walletOf(ctx, lobbyId, id): WalletRow | undefined
  // scan wallet.byLobby.filter(lobbyId) for sameId(identity) — ≤ ~32 rows

function grantWallet(ctx, lobbyId, id)
  // no-op if a row exists (rejoin keeps balance), else insert 1500

function unitPerf(ctx, lobbyId, captainId): { wins, losses, ptsW, ptsT }
  // fold over lobbyMatches() where state===M_DONE && hasP1 and the captain
  // is p0Id or p1Id, summing p*PtsTotal by side

function openBook(ctx, lobby, match)
  // gate: lobby.mode === MODE_TOURNAMENT && match.hasP1
  // compute prior (§3.1), seeds, opening odds; insert book row (open: true)

function recomputeOdds(book): BookRow          // §3.2, returns updated row

function closeBook(ctx, matchId)
  // find by PK; if open, set open=false (idempotent)

function settleBets(ctx, match, winnerSide)
  // for bet.byMatch.filter(match.id) with state===B_OPEN: pay winners into
  // their wallet (walletOf — works even if the bettor left the room),
  // set state/payout, adjust wallet staked/won/lost; then closeBook()

function hasIdleBettor(ctx, lobbyId): boolean
  // any human, non-bot player in the lobby with matchId === 0n and a wallet

function betWinner(ctx, lobbyId): { name: string; credits: number } | null
  // over wallet.byLobby: keep wallets that placed ≥1 bet (won+lost+staked>0),
  // take max balance; ties join names with ' & ' (winVerb() already handles
  // plural labels). null if nobody ever bet.
```

### Hook points (existing functions)

| Where | Change |
|---|---|
| `createMatch()` (~line 816) | After inserting the row: `openBook(ctx, lobby, row)` when the lobby is a tournament and `p1Id !== null`. Single choke point — covers round 1 (`start_tournament`), later rounds and the grand final (`advanceTournament`). |
| `goLive()` (~line 850) | Where `startTicks: COUNTDOWN_TICKS` is set: for tournament lobbies, `COUNTDOWN_TICKS + (hasIdleBettor(...) ? BET_WINDOW_TICKS : 0)`. Compute *after* players are assigned so the seated players don't count as idle. |
| `game_tick` countdown block (~line 2277) | When the decrement lands on 0, `closeBook(ctx, match.id)`. One indexed find at one tick per match — no per-tick cost otherwise. **Nothing else in the 30 Hz loop touches betting tables** (broadcast volume is the binding constraint; books change only on bets). |
| `awardPoint()` (~line 1176) | `p0PtsTotal`/`p1PtsTotal` increments alongside the point increment. |
| `finishMatch()` (~line 1019) | After marking `M_DONE`, before `advanceTournament`: `settleBets(ctx, done, winnerSide)` for tournament lobbies. (Next-round books then price in this result via `unitPerf`.) |
| `crownChampion()` (~line 1055) | Alongside `championName`: compute `betWinner()` and store `betWinnerName`/`betWinnerCredits` on the lobby. All bets are settled by now — the final settles in `finishMatch` before `advanceTournament` reaches the crown, and rounds are waves, so no other match can still be open. |
| `start_tournament` (~line 2022) | After flipping to `L_RUNNING`: `grantWallet` for every non-bot human in the room. |
| `joinAsSpectator()` (~line 1985) | If the lobby is a tournament and `status === L_RUNNING`: `grantWallet`. Covers both spectator entry paths (`join_lobby` on a started tournament, `spectate_match` from the menu). |
| `leaveCurrentLobby()` teardown branch (~line 1703) | In the per-match cleanup loop: delete the match's book and its bets (`bet.byMatch`); after the loop: delete `wallet.byLobby` rows. |

### The one new reducer

```ts
export const place_bet = spacetimedb.reducer(
  { matchId: t.u64(), side: t.u8(), stake: t.u32() },
  (ctx, { matchId, side, stake }) => { ... }
);
```

Validation, in order (each failure → `SenderError` with a friendly message):

1. `getPlayer` → in a lobby; lobby exists, `mode === MODE_TOURNAMENT`,
   `status === L_RUNNING`.
2. **Idle:** `player.matchId === 0n` — "You can't bet while you're playing".
3. Match exists, `match.lobbyId === player.lobbyId`, `hasP1`.
4. Book exists and `open` — "Betting is closed for this match".
5. **Not my match:** neither captain is me, and (team play) no
   `team` row of either captain lists me — "You can't bet on your own match".
6. `side <= 1`; `stake >= BET_MIN_STAKE`; wallet exists;
   `stake <= wallet.balance`.
7. One bet per match: no existing `bet.byMatch` row with my identity —
   "You already have a bet on this match".

Then, atomically (it's a reducer): deduct stake (`balance -= stake`,
`staked += stake`), insert the bet with `oddsMilli` = the book's **current**
odds for that side, add stake to the side's pool, `recomputeOdds`, update the
book.

### Deploy

```bash
spacetime publish -y
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb -y
```

New tables + appended defaulted columns migrate automatically. The Docker
publisher falls back to `--clear-database` on its own if a local dev DB
predates the change. Generated bindings gain `wallet_table.ts`,
`bet_table.ts`, `book_table.ts`, `place_bet_reducer.ts` — never hand-edit.

---

## 5. Client changes

`client/src/main.ts`, `client/index.html` (styles live in its `<style>`).
Follow the feature checklist: subscribe → call the reducer → render the rows.

### 5.1 Plumbing

- Mirror constants (same block as the other mirrors): `B_OPEN/B_WON/B_LOST`,
  `BET_MIN_STAKE`, `COUNTDOWN_SECS = 3` (to split betting window from 3‑2‑1),
  stake presets `[50, 100, 250, 500]`.
- Subscriptions (~line 243): add `'SELECT * FROM wallet'`,
  `'SELECT * FROM bet'`, `'SELECT * FROM book'`.
- Accessors beside the existing ones (~line 330): `myWallet(lobbyId)`,
  `bookOf(matchId)`, `betsFor(matchId)`, `myBetOn(matchId)`,
  `myOpenBooks(room)` (books whose match I'm not in), all via the same
  `.iter()` pattern used everywhere else.
- `fmtOdds(m) = (m/1000).toFixed(2) + '×'`, `fmtCr(n)` with thousands
  separators.
- Register `conn.db.bet.onUpdate` at connect time: my bet flipping
  `B_OPEN → B_WON/B_LOST` fires a toast (`showToast('💰 BET WON +510',
  gold)` / red for a loss) + `playDing()`.

### 5.2 UI surfaces

**A. "BETS" sidebar panel** — new `<section id="bet-panel" class="side-panel">`
in `#waiting-side` (index.html ~line 2968), between roster and tournament
updates; rendered from `updateWaitingOverlay()` (~line 2842) for running
tournaments when I have a wallet.

```
┌ BETS ────────────── 🪙 1,350 ┐
│ SEMIFINAL · LIVE ON COURT 1  │
│  [BLAZE 1.65×] [KAI 2.55×]  │   ← odds buttons (disabled if not idle)
│  closes in 8s                │
│ SEMIFINAL · up next          │
│  [ROSA 1.90×] [LUNA 1.90×]  │
│ ── MY BETS ──                │
│  200 on KAI @2.22× → 444    │   ← open: projected payout
│  100 on VOLT — LOST          │   ← settled, dimmed
└──────────────────────────────┘
```

- Header shows balance (`+ N in play` when staked > 0).
- One row per open book, labeled with the existing `matchLabel()` +
  live-court number; my own upcoming match shows a `YOUR MATCH` badge
  instead of buttons.
- Tapping an odds button expands an inline stake row: preset chips
  `50 100 250 500 MAX` (capped at balance, disabled below `BET_MIN_STAKE`) +
  `PLACE`. Place → `conn.reducers.placeBet({ matchId, side, stake })`,
  wrapped in the same optimistic-free pattern as everything else — the
  subscription update re-renders the panel; reducer errors surface via the
  existing `onReducer` error toast path (`setStatus`/`showToast`).
- If I'm currently *playing*, the whole panel renders read-only (odds shown,
  buttons disabled with a "you're playing" hint) — matches the server rule.

**B. Spectator quick-bet bar** — while watching a live court whose book is
open (betting window running), a bottom-center bar in the match view
(`frame()` spectating block, ~line 3245):

`🪙 1,350 · [BLAZE 1.65×] [KAI 2.55×] · closes in 8s`

Same stake-chip expansion. After lock (or after betting), it collapses to a
pill under the spectate chip: `YOU: 200 ON KAI @2.22×`. Spectators have no
touch controls (hidden while spectating), so the bottom band is free on
mobile.

**C. Countdown rendering** — `frame()` (~line 3165) currently turns
`startTicks` into a giant number + beep every second, which would now start
at 15. Change: `secs = ceil(cdTicks / TICK_HZ)`; when `secs > 3` show a
`BETS OPEN · MATCH IN 12s` chip (no beeps); at `secs <= 3` fall through to
the exact current 3‑2‑1 + GO behavior.

**D. Match intro card** — add an odds row (`mi-odds`) between the two sides
in `maybeShowMatchIntro()` (~line 2770): `1.82× — 2.22×`, favorite tinted
gold. Card timing/behavior unchanged.

**E. Tournament updates feed** — in `updateTourneyFeed()` (~line 2673),
when a match flips to `M_DONE` and it had bets: push one line, e.g.
`💰 3 bets on KAI pay out 890 credits` (or `💸 nobody backed KAI` when all
bets lost). Data comes from that match's bet rows at transition time — same
diff-on-state pattern the feed already uses.

**F. Tournament-over screen: two crowns** — the `L_FINISHED` gameover
overlay (~line 3060) currently shows one banner. It becomes a double podium,
rendered straight off the lobby row:

```
🏆 GAME WINNER            💰 BET WINNER
   ROSA                      KAI · 4,120 CREDITS
```

- If *my* name is in `betWinnerName`, the title line celebrates it
  (`💰 BETTING CHAMPION!`), same as the existing `iAmChampion` check; being
  both game and bet winner stacks both banners.
- `betWinnerName === ''` (nobody bet) → the bet column is omitted entirely.
- Under the podium: top-3 bettors by balance (`🥇 KAI 4,120 · 🥈 VOLT 1,610 ·
  🥉 ROSA 950`), a pure render of wallet rows filtered to actual bettors.
- The updates feed also gets a closing line right after the champion line:
  `💰 KAI takes the betting crown with 4,120 credits`.

### 5.3 CSS

Reuse the design system: `.side-panel` frame, `.setting-btn` look for odds
buttons (selected state = my pick), `.tu-line` styling for feed lines,
existing toast/chip classes for the HUD bar. New styles: `#bet-panel`
internals, `.bet-row`, `.stake-chips`, `#bet-bar` (fixed bottom-center,
`z-index` under overlays), `.bet-pill`. Respect the existing
`prefers-reduced-motion` block. Phone media query: cap `#bet-panel`
height ~180px like the updates feed.

---

## 6. Edge cases & abuse checklist

- **Playing players**: UI disables, server rejects (`matchId !== 0n`). The
  reducer check is the authority — never trust the client.
- **Own match** (incl. teammates via `team` rows): rejected at placement.
  Bets placed on *other* courts remain valid if your own match starts —
  you can't influence those outcomes.
- **Leave/rejoin**: wallet rows persist per `(lobby, identity)` → no fresh
  1500. Open bets of a departed player still settle into their wallet;
  `bettorName` keeps the feed readable.
- **Forfeit mid-window**: `finishMatch` settles + closes the book even if
  `open` was still true.
- **Byes**: `openBook` skips `hasP1 === false` — nothing to bet on, and
  `advanceTournament`'s recursive round creation stays cheap.
- **No bettors in the room**: `goLive` adds no delay — 2-player tournaments
  and full-participation rounds keep today's 3 s start.
- **Nobody bet**: settlement no-ops; seeds are virtual and never paid out.
- **Integer safety**: max meaningful stake ~10⁵–10⁶ range; `stake ×
  oddsMilli ≤ ~10¹⁰` — exact in JS doubles, stored back into u32 well under
  cap. All math deterministic (no `Math.random`, no wall clock).
- **Tick budget**: betting adds zero writes to the steady-state 30 Hz loop;
  book rows update only on `place_bet` and at lock/settle transitions.
- **Odds sanity**: prior clamp `[0.15, 0.85]` + odds clamp `[1.05×, 20×]`
  bound every line even after lopsided betting.

---

## 7. QA plan (two browser tabs = two identities, per README)

1. **4-player single elim, concurrent 1.** Start → both round-1 books exist;
   match A live with 15 s window, match B pending and open. The two idle
   entrants bet opposite sides of A; odds move after each bet; slips show
   locked odds. A finishes → settlement toast, feed line, balances correct
   (`stake × odds` rounding included). Final: only the two finalists are
   blocked from its book; eliminated players can bet.
2. **Prior sanity.** After a 2‑0 sweep vs a 2‑1 scrape, the round-2 opening
   line favors the sweeper (~1.8×/2.2× with the default tuning).
3. **Restrictions.** Playing player: panel read-only + reducer rejects a
   forged call. Own pending match: `YOUR MATCH` badge + reducer rejects.
   Double bet on one match rejected. Stake > balance / < 10 rejected.
4. **Spectators.** Menu → Live Now → spectate a running tournament → wallet
   appears (1500), quick-bet bar works during a window; B-key bracket view
   shows the sidebar panel. Leave → rejoin → same balance.
5. **Formats.** Double elim (losers-bracket + grand-final books) and a 2v2
   tournament (captain units: team bets, teammate exclusion, `unitLabel`
   names on buttons).
6. **Two crowns.** Play a tournament to the end: the over screen shows the
   game winner AND the bet winner with their credits; a player who never bet
   can't take the betting crown even with all bettors below 1500; two
   bettors tied on balance share the title (`A & B`); with zero bets the
   bet column is absent. Winning both crowns shows both banners.
7. **Lifecycle.** Forfeit during the betting window settles + closes. Last
   competitor leaves → room teardown deletes wallet/bet/book rows (verify
   via `spacetime logs digital-football` — no orphan errors).
8. **Regression.** Quick match, practice, beer pong, targets: no books, no
   panel, no extra countdown; non-tournament countdown still 3‑2‑1.

---

## 8. Build order & size

| Step | Scope | Est. |
|---|---|---|
| 1 | Server: constants, 3 tables, `Lobby`/`Match` appended columns, schema registration | ~95 lines |
| 2 | Server: helpers (`unitPerf`, odds, wallet, settle, `betWinner`) | ~125 lines |
| 3 | Server: hooks (`createMatch`, `goLive`, tick, `awardPoint`, `finishMatch`, `crownChampion`, `start_tournament`, `joinAsSpectator`, teardown) + `place_bet` | ~130 lines |
| 4 | Publish + regenerate bindings | commands above |
| 5 | Client: constants, subscriptions, accessors, bet toasts | ~80 lines |
| 6 | Client: sidebar BETS panel (HTML/CSS/render) | ~180 lines |
| 7 | Client: countdown chip, spectator bet bar + pill, intro-card odds | ~120 lines |
| 8 | Client: feed settlement lines, two-crown over screen + top bettors | ~90 lines |
| 9 | QA matrix (§7), README feature bullet | — |

Steps 1–4 ship a working (server-verifiable) economy; 5–8 are pure
presentation on top. Roughly 350 server + 470 client lines total.

## 9. Non-goals (v1)

Bet cancellation/edits · in-play betting after lock · betting in quick
matches · cross-tournament credit persistence · house margin/vig ·
keyboard/gamepad bindings for the bet UI (pointer/touch only, like chat).
