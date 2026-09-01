# Digital Football — project notes

Arcade 5-a-side football (design + milestones in DIGITAL_FOOTBALL_PLAN.md).
Seeded from digital-tennis and then rewritten for the sport: the tennis
gameplay is gone, the sport-agnostic meta layer (rooms, accounts, reconnect,
tournaments, betting, chat, graphics) carried over. Key facts:

- `spacetimedb/src/index.ts` — schema + the META layer (accounts, lobbies,
  betting, tournaments, chat, reconnect) and thin reducer shells.
- `spacetimedb/src/football.ts` — THE FOOTBALL, all of it: the 30 Hz tick,
  physics, possession, the laws, the keeper, both team brains, the action
  contexts. Rewritten clean in one pass; index.ts calls in through
  `tickFootball`/`footballAction`/`switchPilot` and a small MetaHooks object,
  and football.ts takes only `import type` from index.ts — value flow is one
  direction. Team behaviour is ONE PLAN PER SIDE PER TICK (`teamPlan`): every
  off-ball job is assigned in one place, then structural rules (second-man,
  support spacing, separation) are applied over whatever it decided.
- Two lessons the rewrite itself paid for: never LEAD a pass toward the
  receiver's own goal (a retreating defender gets it at his FEET — the
  overshot lead sails past a keeper the back-pass law forbids from catching,
  straight into his own net), and a ball at shot pace is only BLOCKED by a
  body genuinely in the way (~1.4 units) — full control radius on hot balls
  turns a packed defence into a wall that swallows every shot.
- `client/` — Vite + TS app. `src/render.ts` is the Three.js renderer;
  `src/main.ts` owns connection, input, and UI state.
- After editing the module: `spacetime publish -y` then regenerate bindings:
  `spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb -y`
- Pitch geometry constants are duplicated in `spacetimedb/src/index.ts` and
  `client/src/config.ts` — keep in sync. Same for the match format
  (HALF_SECONDS / OT_SECONDS), the phase and restart-kind enums, and the
  progression curve.
- **The football, specifically:**
  - It is 5-a-side: every side fields `OUTFIELD_PER_SIDE` (4) outfielders in a
    1-2-1 diamond plus a keeper. Human seats take teamSlot 0..teamSize-1 and
    bot FILLERS take the rest. `lobby.teamSize` is HUMAN seats (1-3), not
    players on the pitch — a 1v1 room is still ten bodies.
  - Keepers and fillers are `matchBot: true`: spawned in `goLive`, deleted in
    `endMatchCleanup`. That predicate must key on `matchBot`, NOT `isBot` —
    `create_practice` seats a LOBBY bot as p1Id and `rematch` reuses it.
  - **Control is a token on the BODY, not on the person.** `player.ctrlSeat`
    holds the teamSlot of the human driving that body (255 = AI), so "two
    humans driving one footballer" is unrepresentable rather than merely
    forbidden. `getPlayer` returns the PERSON; `controlledBody` returns the
    body their stick moves. The four input reducers go through the latter,
    and the tick's AI gate asks `ctrlSeat === CTRL_NONE`, never `isBot`.
    `bindPilot` is the only writer of the token.
  - `isBot` now means only "this row is not a person". Anything counting
    HUMAN SEATS (isRanked, sideMmr, teamName) must say so explicitly, or a
    pitch full of fillers silently makes every match unranked.
  - Bots steer on `mvX/mvY` FLOATS; `dirX/dirY` stay as the rendered facing.
    Signing a heading into the i8 stick is what made them zig-zag.
  - Movement is INSTANT — the stick IS the velocity. Do not add acceleration
    to make it look smoother: that reads as input lag, and smoothness is the
    renderer's job (animation blending, not physics).
  - Anything that asks "which body carries my seat" must consider EVERY body,
    keeper included. Filtering that lookup to outfielders made the token
    invisible once control reached the keeper, so the tick's self-heal
    stamped a SECOND claimant onto the player's old body.
  - Input is three context-sensitive buttons through one `action({button})`
    reducer, resolved server-side: on the ball pass/lob/shoot, chasing
    tackle/slide/switch, keeper throw/long ball/put-ball-down, plus the
    set-piece variants. Every action is a single press — nothing is charged
    or timed. Passing is ASSISTED: the stick picks a direction and
    `pickPassTarget` finds the man, because aiming a pass at raw eight-way
    degrees is what made passing feel awful.
  - The client mirrors PLAYER_SPEED and SPRINT_MUL in `client/src/config.ts`
    and dead-reckons with them. They have drifted out of sync three times,
    and every time the symptom was "the game feels jittery" — check them
    whenever a speed changes, and never declare a second copy anywhere else
    (SPRINT_MUL drifted precisely because it lived in `main.ts`, where the
    config.ts warning was not looking).
  - The render smoother in `renderPosition` exists to hide the 30 Hz step in
    OTHER people's rows. On the body your own stick drives it is pure added
    latency — that is why it runs at rate 34 there and 11 elsewhere. Raising
    the shared rate to "smooth things out" makes the controls feel floaty.
  - Exactly one player per side may approach the ball: the elected presser
    (`match.presser0/1`, with hysteresis). Everyone else is pushed out of
    `AI_PRESS_BUBBLE`. That rule is what prevents the under-8s huddle.
  - Possession is a TOUCH CYCLE, not a magnet. The owner knocks the ball
    ahead only when he has caught up to it (`gap < TOUCH_TRIGGER`); between
    touches nothing writes the ball's position — it rolls under the
    integrator and is genuinely loose, which is what lets a defender reach
    it and what makes a heavy touch run out of play. Do NOT go back to
    pinning it to an offset: that kills the risk, and a velocity-less ball
    cannot be interpolated by the client either, so it strobes.
    `CONTROL_KEEP_RADIUS` must stay comfortably beyond the knock distance —
    chasing your own touch IS dribbling. Ball deceleration is
    quadratic AIR DRAG (`BALL_DRAG`) plus constant rolling resistance —
    rolling resistance alone is right for a slow ball and sends a struck one
    750 units down a 132-unit pitch. A struck ball sets
    `ball.lockTicks`, which locks out `ball.lastTouchId` — WITHOUT that the
    kicker's own control radius swallows the shot on the next tick and
    nothing ever leaves a boot. Any other player's touch clears the lock.
  - Out-of-play is judged AFTER possession, on where the ball IS
    (`resolveOutOfPlay`), not only on the tick it crosses a line — otherwise
    a dribbler simply walks it out of the world.
  - A forward kick inside `SHOOT_RANGE` is re-aimed at the goal mouth
    (`executeKick`'s `shootAssist`). Without it, eight-way aim cannot hit a
    fourteen-foot goal from an angle and the game is unplayable.
  - The keeper commits to a save only inside its level's `react` window and
    with an `err` offset. A ball in free flight crosses the line at
    `x + vx*t` no matter when you compute it, so the keeper's prediction is
    EXACT and `err` is the only thing making it beatable — it must exceed the
    gap between `KEEPER_CLEAR_RADIUS` and the corner of the goal.
  - A kickoff nobody takes freezes the match forever, so after
    `KICKOFF_AUTO` a team-mate steps in and takes it.
  - **Laws.** Bots slide AT THE TOUCH, not at the man: the lunge is only
    rolled while the carrier's gap to the ball is open (`> TOUCH_TRIGGER`),
    because a jockeying presser rolling the dice every tick produced a free
    kick every twenty seconds. A slide that reaches a man without having
    taken the ball is a foul (ball first — a tackle that won it is fair however many it caught):
    free kick, or a penalty inside the offender's own area, taken with the
    box cleared. A caution is only for fouling a player who ACTUALLY HAD the
    ball; two is a red. A sent-off body must be excluded from every list
    that says who is on the pitch — AI shape, press election, possession
    `eligible`, pass targets, switch candidates, restart taker — and
    `controlledBody` must hand the seat a different body, or the stick
    drives a man on the touchline for the rest of the match.
  - **The back-pass law** rides on `ball.fromKick`: set in `executeKick`
    (outfielders only) and explicitly cleared at EVERY other touch, because a
    `{...ball}` spread would otherwise carry it forward forever. The keeper's
    catch is gated on it. He can still play it with his feet — that is the
    point of the law.
  - **Locomotion is a blend tree, not one animation.** `runPose` blends jog →
    sprint on MEASURED ground speed, and the stride CADENCE is derived from
    the stride LENGTH (`strideRateFor`) — fix the cadence instead and the
    feet skate. `moving` means covering ground, not holding the stick.
  - **The camera is a long lens from well back** (19° FOV, boom ≥ 1.63 ×
    PITCH_HALF_LEN). A close wide camera cannot aim at the far side without
    the gantry standing on the pitch, so the aim gets pinned to its own
    touchline and every body piles into the top of the frame. Boom limits are
    set from what a player must SEE, not from how the rig looks.
- Betting lives in the same two files: the `wallet`/`bet`/`book` tables +
  `place_bet` in the module, the BETS panel and pitchside bar in
  `client/src/main.ts`. Odds are server-authoritative — the client only
  renders `book` rows and locks its price from them. The odds prior reads
  goal share.
- Player accounts live in those two files plus `client/src/auth.ts`
  (Firebase). `account` is the ONLY persistent table here — everything else
  dies with its room — so its columns are append-only and `publish.sh`
  refuses `--clear-database` without `ALLOW_CLEAR=1`. A column added to any
  other table still needs a `.default(...)` or the publish is rejected as a
  breaking change.
- Progression is awarded in `finishMatch`, which captures the roster BEFORE
  `endMatchCleanup` zeroes `matchId`. Award after it and every match silently
  pays out nothing.
- Two browser tabs are ONE player (shared Firebase/localStorage session).
  For local 2-player testing use two browser profiles, or `?seat=2` on the
  no-Firebase fallback path.
- Local server is `spacetime start` (CLI 2.8.x); DB name `digital-football`.
- The module entrypoint may ONLY export SpacetimeDB constructs (reducers,
  schema default) — exporting plain constants breaks publish.

# SpacetimeDB Rules (All Languages)

## Migrating from 1.0 to 2.0?

**If you are migrating existing SpacetimeDB 1.0 code to 2.0, apply `spacetimedb-migration-2.0.mdc` first.** It documents breaking changes (reducer callbacks → event tables, `name`→`accessor`, `sender()` method, etc.) and should be considered before other rules.

---

## Language-Specific Rules

| Language | Rule File |
|----------|-----------|
| **TypeScript/React** | `spacetimedb-typescript.mdc` (MANDATORY) |
| **Rust** | `spacetimedb-rust.mdc` (MANDATORY) |
| **C#** | `spacetimedb-csharp.mdc` (MANDATORY) |
| **Migrating 1.0 → 2.0** | `spacetimedb-migration-2.0.mdc` |

---

## Core Concepts

1. **Reducers are transactional** — they do not return data to callers
2. **Reducers must be deterministic** — no filesystem, network, timers, or random
3. **Read data via tables/subscriptions** — not reducer return values
4. **Auto-increment IDs are not sequential** — gaps are normal, don't use for ordering
5. **`ctx.sender` is the authenticated principal** — never trust identity args

---

## Feature Implementation Checklist

When implementing a feature that spans backend and client:

1. **Backend:** Define table(s) to store the data
2. **Backend:** Define reducer(s) to mutate the data
3. **Client:** Subscribe to the table(s)
4. **Client:** Call the reducer(s) from UI — **don't forget this step!**
5. **Client:** Render the data from the table(s)

**Common mistake:** Building backend tables/reducers but forgetting to wire up the client to call them.

---

## Index System

SpacetimeDB automatically creates indexes for:
- Primary key columns
- Columns marked as unique

You can add explicit indexes on non-unique columns for query performance.

**Index names must be unique across your entire module (all tables).** If two tables have indexes with the same declared name → conflict error.

**Schema ↔ Code coupling:**
- Your query code references indexes by name
- If you add/remove/rename an index in the schema, update all code that uses it
- Removing an index without updating queries causes runtime errors

---

## Commands

```bash
# Login to allow remote database deployment e.g. to maincloud
spacetime login

# Start local SpacetimeDB
spacetime start

# Publish module
spacetime publish <db-name> --module-path <module-path>

# Clear and republish
spacetime publish <db-name> --clear-database -y --module-path <module-path>

# Generate client bindings
spacetime generate --lang <lang> --out-dir <out> --module-path <module-path>

# View logs
spacetime logs <db-name>
```

---

## Deployment

- Maincloud is the spacetimedb hosted cloud and the default location for module publishing
- The default server marked by *** in `spacetime server list` should be used when publishing
- If the default server is maincloud you should publish to maincloud
- Publishing to maincloud is free of charge
- When publishing to maincloud the database dashboard will be at the url: https://spacetimedb.com/@<username>/<database-name>
- The database owner can view utilization and performance metrics on the dashboard

---

## Debugging Checklist

1. Is SpacetimeDB server running? (`spacetime start`)
2. Is the module published? (`spacetime publish`)
3. Are client bindings generated? (`spacetime generate`)
4. Check server logs for errors (`spacetime logs <db-name>`)
5. **Is the reducer actually being called from the client?**

---

## Editing Behavior

- Make the smallest change necessary
- Do NOT touch unrelated files, configs, or dependencies
- Do NOT invent new SpacetimeDB APIs — use only what exists in docs or this repo
- Do NOT add restrictions the prompt didn't ask for — if "users can do X", implement X for all users




# SpacetimeDB TypeScript SDK

## ⛔ HALLUCINATED APIs — DO NOT USE

**These APIs DO NOT EXIST. LLMs frequently hallucinate them.**

```typescript
// ❌ WRONG PACKAGE — does not exist
import { SpacetimeDBClient } from "@clockworklabs/spacetimedb-sdk";

// ❌ WRONG — these methods don't exist
SpacetimeDBClient.connect(...);
SpacetimeDBClient.call("reducer_name", [...]);
connection.call("reducer_name", [arg1, arg2]);

// ❌ WRONG — positional reducer arguments
conn.reducers.doSomething("value");  // WRONG!

// ❌ WRONG — static methods on generated types don't exist
User.filterByName('alice');
Message.findById(123n);
tables.user.filter(u => u.name === 'alice');  // No .filter() on tables object!
```

### ✅ CORRECT PATTERNS:

```typescript
// ✅ CORRECT IMPORTS
import { DbConnection, tables } from './module_bindings';  // Generated!
import { SpacetimeDBProvider, useTable, Identity } from 'spacetimedb/react';

// ✅ CORRECT REDUCER CALLS — object syntax, not positional!
conn.reducers.doSomething({ value: 'test' });
conn.reducers.updateItem({ itemId: 1n, newValue: 42 });

// ✅ CORRECT DATA ACCESS — useTable returns [rows, isLoading]
const [items, isLoading] = useTable(tables.item);
```

### ⛔ DO NOT:
- **Invent hooks** like `useItems()`, `useData()` — use `useTable(tables.tableName)`
- **Import from fake packages** — only `spacetimedb`, `spacetimedb/react`, `./module_bindings`

---

## 1) Common Mistakes Table

### Server-side errors

| Wrong | Right | Error |
|-------|-------|-------|
| Missing `package.json` | Create `package.json` | "could not detect language" |
| Missing `tsconfig.json` | Create `tsconfig.json` | "TsconfigNotFound" |
| Entrypoint not at `src/index.ts` | Use `src/index.ts` | Module won't bundle |
| `indexes` in COLUMNS (2nd arg) | `indexes` in OPTIONS (1st arg) | "reading 'tag'" error |
| Index without `algorithm` | `algorithm: 'btree'` | "reading 'tag'" error |
| `filter({ ownerId })` | `filter(ownerId)` | "does not exist in type 'Range'" |
| `.filter()` on unique column | `.find()` on unique column | TypeError |
| `insert({ ...without id })` | `insert({ id: 0n, ... })` | "Property 'id' is missing" |
| `const id = table.insert(...)` | `const row = table.insert(...)` | `.insert()` returns ROW, not ID |
| `.unique()` + explicit index | Just use `.unique()` | "name is used for multiple entities" |
| Index on `.primaryKey()` column | Don't — already indexed | "name is used for multiple entities" |
| Same index name in multiple tables | Prefix with table name | "name is used for multiple entities" |
| `.indexName.filter()` after removing index | Use `.iter()` + manual filter | "Cannot read properties of undefined" |
| Import spacetimedb from index.ts | Import from schema.ts | "Cannot access before initialization" |
| Multi-column index `.filter()` | **⚠️ BROKEN** — use single-column | PANIC or silent empty results |
| `JSON.stringify({ id: row.id })` | Convert BigInt first: `{ id: row.id.toString() }` | "Do not know how to serialize a BigInt" |
| `ScheduleAt.Time(timestamp)` | `ScheduleAt.time(timestamp)` (lowercase) | "ScheduleAt.Time is not a function" |
| `ctx.db.foo.myIndexName.filter()` | Use exact name: `ctx.db.foo.my_index_name.filter()` | "Cannot read properties of undefined" |
| `.iter()` in views | Use index lookups | Severe performance issues (re-evaluates on any change) |
| `ctx.db` in procedures | `ctx.withTx(tx => tx.db...)` | Procedures need explicit transactions |
| `ctx.myTable` in procedure tx | `tx.db.myTable` | Wrong context variable |

### Client-side errors

| Wrong | Right | Error |
|-------|-------|-------|
| `@spacetimedb/sdk` | `spacetimedb` | 404 / missing subpath |
| `conn.reducers.foo("val")` | `conn.reducers.foo({ param: "val" })` | Wrong reducer syntax |
| Inline `connectionBuilder` | `useMemo(() => ..., [])` | Reconnects every render |
| `const rows = useTable(table)` | `const [rows, isLoading] = useTable(table)` | Tuple destructuring |
| Optimistic UI updates | Let subscriptions drive state | Desync issues |
| `<SpacetimeDBProvider builder={...}>` | `connectionBuilder={...}` | Wrong prop name |

---

## 2) Table Definition (CRITICAL)

**`table()` takes TWO arguments: `table(OPTIONS, COLUMNS)`**

```typescript
import { schema, table, t } from 'spacetimedb/server';

// ❌ WRONG — indexes in COLUMNS causes "reading 'tag'" error
export const Task = table({ name: 'task' }, {
  id: t.u64().primaryKey().autoInc(),
  ownerId: t.identity(),
  indexes: [{ name: 'by_owner', algorithm: 'btree', columns: ['ownerId'] }]  // ❌ WRONG!
});

// ✅ RIGHT — indexes in OPTIONS (first argument)
export const Task = table({ 
  name: 'task',
  public: true,
  indexes: [{ name: 'by_owner', algorithm: 'btree', columns: ['ownerId'] }]
}, {
  id: t.u64().primaryKey().autoInc(),
  ownerId: t.identity(),
  title: t.string(),
  createdAt: t.timestamp(),
});
```

### Column types
```typescript
t.identity()           // User identity (primary key for per-user tables)
t.u64()                // Unsigned 64-bit integer (use for IDs)
t.string()             // Text
t.bool()               // Boolean
t.timestamp()          // Timestamp (use ctx.timestamp for current time)
t.scheduleAt()         // For scheduled tables only

// Product types (nested objects) — use t.object, NOT t.struct
const Point = t.object('Point', { x: t.i32(), y: t.i32() });

// Sum types (tagged unions) — use t.enum, NOT t.sum
const Shape = t.enum('Shape', { circle: t.i32(), rectangle: Point });
// Values use { tag: 'circle', value: 10 } or { tag: 'rectangle', value: { x: 1, y: 2 } }

// Modifiers
t.string().optional()           // Nullable
t.u64().primaryKey()            // Primary key
t.u64().primaryKey().autoInc()  // Auto-increment primary key
```

> ⚠️ **BIGINT SYNTAX:** All `u64`, `i64`, and ID fields use JavaScript BigInt.
> - Literals: `0n`, `1n`, `100n` (NOT `0`, `1`, `100`)
> - Comparisons: `row.id === 5n` (NOT `row.id === 5`)
> - Arithmetic: `row.count + 1n` (NOT `row.count + 1`)

### Auto-increment placeholder
```typescript
// ✅ MUST provide 0n placeholder for auto-inc fields
ctx.db.task.insert({ id: 0n, ownerId: ctx.sender, title: 'New', createdAt: ctx.timestamp });
```

### Insert returns ROW, not ID
```typescript
// ❌ WRONG
const id = ctx.db.task.insert({ ... });

// ✅ RIGHT
const row = ctx.db.task.insert({ ... });
const newId = row.id;  // Extract .id from returned row
```

### Schema export (CRITICAL)
```typescript
// At end of schema.ts — schema() takes exactly ONE argument: an object
const spacetimedb = schema({ table1, table2, table3 });
export default spacetimedb;

// ❌ WRONG — never pass tables directly or as multiple args
schema(myTable);      // WRONG!
schema(t1, t2, t3);   // WRONG!
```

---

## 3) Index Access

### TypeScript Query Patterns

```typescript
// 1. PRIMARY KEY — use .pkColumn.find()
const user = ctx.db.user.identity.find(ctx.sender);
const msg = ctx.db.message.id.find(messageId);

// 2. EXPLICIT INDEX — use .indexName.filter(value)
const msgs = [...ctx.db.message.message_room_id.filter(roomId)];

// 3. NO INDEX — use .iter() + manual filter
for (const m of ctx.db.roomMember.iter()) {
  if (m.roomId === roomId) { /* ... */ }
}
```

### Index Definition Syntax

```typescript
// In table OPTIONS (first argument), not columns
export const Message = table({ 
  name: 'message',
  public: true,
  indexes: [{ name: 'message_room_id', algorithm: 'btree', columns: ['roomId'] }]
}, {
  id: t.u64().primaryKey().autoInc(),
  roomId: t.u64(),
  // ...
});
```

### Naming conventions

**Table names — automatic transformation:**
- Schema: `table({ name: 'my_messages' })` 
- Access: `ctx.db.myMessages` (automatic snake_case → camelCase)

**Index names — NO transformation, use EXACTLY as defined:**
```typescript
// Schema definition
indexes: [{ name: 'canvas_member_canvas_id', algorithm: 'btree', columns: ['canvasId'] }]

// ❌ WRONG — don't assume camelCase transformation
ctx.db.canvasMember.canvasMember_canvas_id.filter(...)  // WRONG!
ctx.db.canvasMember.canvasMemberCanvasId.filter(...)    // WRONG!

// ✅ RIGHT — use exact name from schema
ctx.db.canvasMember.canvas_member_canvas_id.filter(...)
```

> ⚠️ **Index names are used VERBATIM** — pick a convention (snake_case or camelCase) and stick with it.

**Index naming pattern — use `{tableName}_{columnName}`:**
```typescript
// ✅ GOOD — unique names across entire module
indexes: [{ name: 'message_room_id', algorithm: 'btree', columns: ['roomId'] }]
indexes: [{ name: 'reaction_message_id', algorithm: 'btree', columns: ['messageId'] }]

// ❌ BAD — will collide if multiple tables use same index name
indexes: [{ name: 'by_owner', ... }]  // in Task table
indexes: [{ name: 'by_owner', ... }]  // in Note table — CONFLICT!
```

**Client-side table names:**
- Check generated `module_bindings/index.ts` for exact export names
- Usage: `useTable(tables.MyMessages)` or `tables.myMessages` (varies by SDK version)

### Filter vs Find
```typescript
// Filter takes VALUE directly, not object — returns iterator
const rows = [...ctx.db.task.by_owner.filter(ownerId)];

// Unique columns use .find() — returns single row or undefined
const row = ctx.db.player.identity.find(ctx.sender);
```

### ⚠️ Multi-column indexes are BROKEN
```typescript
// ❌ DON'T — causes PANIC
ctx.db.scores.by_player_level.filter(playerId);

// ✅ DO — use single-column index + manual filter
for (const row of ctx.db.scores.by_player.filter(playerId)) {
  if (row.level === targetLevel) { /* ... */ }
}
```

---

## 4) Reducers

### Definition syntax (CRITICAL)
**Reducer name comes from the export — NOT from a string argument.** Use `reducer(params, fn)` or `reducer(fn)`.

```typescript
import spacetimedb from './schema';
import { t, SenderError } from 'spacetimedb/server';

// ✅ CORRECT — export const name = spacetimedb.reducer(params, fn)
export const reducer_name = spacetimedb.reducer({ param1: t.string(), param2: t.u64() }, (ctx, { param1, param2 }) => {
  // Validation
  if (!param1) throw new SenderError('param1 required');
  
  // Access tables via ctx.db
  const row = ctx.db.myTable.primaryKey.find(param2);
  
  // Mutations
  ctx.db.myTable.insert({ ... });
  ctx.db.myTable.primaryKey.update({ ...row, newField: value });
  ctx.db.myTable.primaryKey.delete(param2);
});

// No params: export const init = spacetimedb.reducer((ctx) => { ... });
```

```typescript
// ❌ WRONG — reducer('name', params, fn) does NOT exist
spacetimedb.reducer('reducer_name', { param1: t.string() }, (ctx, { param1 }) => { ... });
```

### Update pattern (CRITICAL)
```typescript
// ✅ CORRECT — spread existing row, override specific fields
const existing = ctx.db.task.id.find(taskId);
if (!existing) throw new SenderError('Task not found');
ctx.db.task.id.update({ ...existing, title: newTitle, updatedAt: ctx.timestamp });

// ❌ WRONG — partial update nulls out other fields!
ctx.db.task.id.update({ id: taskId, title: newTitle });
```

### Delete pattern
```typescript
// Delete by primary key VALUE (not row object)
ctx.db.task.id.delete(taskId);          // taskId is the u64 value
ctx.db.player.identity.delete(ctx.sender);  // delete by identity
```

### Lifecycle hooks
```typescript
spacetimedb.clientConnected((ctx) => {
  // ctx.sender is the connecting identity
  // Create/update user record, set online status, etc.
});

spacetimedb.clientDisconnected((ctx) => {
  // Clean up: set offline status, remove ephemeral data, etc.
});
```

### Snake_case to camelCase conversion
- Server: `export const do_something = spacetimedb.reducer(...)` — name from export
- Client: `conn.reducers.doSomething({ ... })`

### Object syntax required
```typescript
// ❌ WRONG - positional
conn.reducers.doSomething('value');

// ✅ RIGHT - object
conn.reducers.doSomething({ param: 'value' });
```

---

## 5) Scheduled Tables

```typescript
// 1. Define table first (scheduled: () => reducer — pass the exported reducer)
export const CleanupJob = table({ 
  name: 'cleanup_job', 
  scheduled: () => run_cleanup  // reducer defined below
}, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  targetId: t.u64(),  // Your custom data
});

// 2. Define scheduled reducer (receives full row as arg)
export const run_cleanup = spacetimedb.reducer({ arg: CleanupJob.rowType }, (ctx, { arg }) => {
  // arg.scheduledId, arg.targetId available
  // Row is auto-deleted after reducer completes
});

// Schedule a job
import { ScheduleAt } from 'spacetimedb';
const futureTime = ctx.timestamp.microsSinceUnixEpoch + 60_000_000n; // 60 seconds
ctx.db.cleanupJob.insert({ 
  scheduledId: 0n, 
  scheduledAt: ScheduleAt.time(futureTime),
  targetId: someId 
});

// Cancel a job by deleting the row
ctx.db.cleanupJob.scheduledId.delete(jobId);
```

---

## 6) Timestamps

### Server-side
```typescript
import { Timestamp, ScheduleAt } from 'spacetimedb';

// Current time
ctx.db.item.insert({ id: 0n, createdAt: ctx.timestamp });

// Future time (add microseconds)
const future = ctx.timestamp.microsSinceUnixEpoch + 300_000_000n;  // 5 minutes
```

### Client-side (CRITICAL)
**Timestamps are objects, not numbers:**
```typescript
// ❌ WRONG
const date = new Date(row.createdAt);
const date = new Date(Number(row.createdAt / 1000n));

// ✅ RIGHT
const date = new Date(Number(row.createdAt.microsSinceUnixEpoch / 1000n));
```

### ScheduleAt on client
```typescript
// ScheduleAt is a tagged union
if (scheduleAt.tag === 'Time') {
  const date = new Date(Number(scheduleAt.value.microsSinceUnixEpoch / 1000n));
}
```

---

## 7) Data Visibility & Subscriptions

**`public: true` exposes ALL rows to ALL clients.**

| Scenario | Pattern |
|----------|---------|
| Everyone sees all rows | `public: true` |
| Users see only their data | Private table + filtered subscription |

### Subscription patterns (client-side)
```typescript
// Subscribe to ALL public tables (simplest)
conn.subscriptionBuilder().subscribeToAll();

// Subscribe to specific tables with SQL
conn.subscriptionBuilder().subscribe([
  'SELECT * FROM message',
  'SELECT * FROM room WHERE is_public = true',
]);

// Handle subscription lifecycle
conn.subscriptionBuilder()
  .onApplied(() => console.log('Initial data loaded'))
  .onError((e) => console.error('Subscription failed:', e))
  .subscribeToAll();
```

### Private table + view pattern (RECOMMENDED)

**Views are the recommended approach** for controlling data visibility. They provide:
- Server-side filtering (reduces network traffic)
- Real-time updates when underlying data changes
- Full control over what data clients can access

> ⚠️ **Do NOT use Row Level Security (RLS)** — it is deprecated.

> ⚠️ **CRITICAL:** Procedural views (views that compute results in code) can ONLY access data via index lookups, NOT `.iter()`.
> If you need a view that scans/filters across many rows (including the entire table), return a **query** built with the query builder (`ctx.from...`).

```typescript
// Private table with index on ownerId
export const PrivateData = table(
  { name: 'private_data',
    indexes: [{ name: 'by_owner', algorithm: 'btree', columns: ['ownerId'] }]
  },
  {
    id: t.u64().primaryKey().autoInc(),
    ownerId: t.identity(),
    secret: t.string()
  }
);

// ❌ BAD — .iter() causes performance issues (re-evaluates on ANY row change)
spacetimedb.view(
  { name: 'my_data_slow', public: true },
  t.array(PrivateData.rowType),
  (ctx) => [...ctx.db.privateData.iter()]  // Works but VERY slow at scale
);

// ✅ GOOD — index lookup enables targeted invalidation
spacetimedb.view(
  { name: 'my_data', public: true },
  t.array(PrivateData.rowType),
  (ctx) => [...ctx.db.privateData.by_owner.filter(ctx.sender)]
);
```

### Query builder view pattern (can scan)

```typescript
// Query-builder views return a query; the SQL engine maintains the result incrementally.
// This can scan the whole table if needed (e.g. leaderboard-style queries).
spacetimedb.anonymousView(
  { name: 'top_players', public: true },
  t.array(Player.rowType),
  (ctx) =>
    ctx.from.player
      .where(p => p.score.gt(1000))
);
```

### ViewContext vs AnonymousViewContext
```typescript
// ViewContext — has ctx.sender, result varies per user (computed per-subscriber)
spacetimedb.view({ name: 'my_items', public: true }, t.array(Item.rowType), (ctx) => {
  return [...ctx.db.item.by_owner.filter(ctx.sender)];
});

// AnonymousViewContext — no ctx.sender, same result for everyone (shared, better perf)
spacetimedb.anonymousView({ name: 'leaderboard', public: true }, t.array(LeaderboardRow), (ctx) => {
  return [...ctx.db.player.by_score.filter(/* top scores */)];
});
```

**Views require explicit subscription:**
```typescript
conn.subscriptionBuilder().subscribe([
  'SELECT * FROM public_table',
  'SELECT * FROM my_data',  // Views need explicit SQL!
]);
```

---

## 8) React Integration

### Key patterns
```typescript
// Memoize connectionBuilder to prevent reconnects on re-render
const builder = useMemo(() => 
  DbConnection.builder()
    .withUri(SPACETIMEDB_URI)
    .withDatabaseName(MODULE_NAME)
    .withToken(localStorage.getItem('auth_token') || undefined)
    .onConnect(onConnect)
    .onConnectError(onConnectError),
  []  // Empty deps - only create once
);

// useTable returns tuple [rows, isLoading]
const [rows, isLoading] = useTable(tables.myTable);

// Compare identities using toHexString()
const isOwner = row.ownerId.toHexString() === myIdentity.toHexString();
```

---

## 9) Procedures (Beta)

**Procedures are for side effects (HTTP requests, etc.) that reducers can't do.**

⚠️ Procedures are currently in beta. API may change.

### Defining a procedure
**Procedure name comes from the export — NOT from a string argument.** Use `procedure(params, ret, fn)` or `procedure(ret, fn)`.

```typescript
// ✅ CORRECT — export const name = spacetimedb.procedure(params, ret, fn)
export const fetch_external_data = spacetimedb.procedure(
  { url: t.string() },
  t.string(),  // return type
  (ctx, { url }) => {
    const response = ctx.http.fetch(url);
    return response.text();
  }
);
```

### Database access in procedures

⚠️ **CRITICAL: Procedures don't have `ctx.db`. Use `ctx.withTx()` for database access.**

```typescript
spacetimedb.procedure({ url: t.string() }, t.unit(), (ctx, { url }) => {
  // Fetch external data (outside transaction)
  const response = ctx.http.fetch(url);
  const data = response.text();

  // ❌ WRONG — ctx.db doesn't exist in procedures
  ctx.db.myTable.insert({ ... });

  // ✅ RIGHT — use ctx.withTx() for database access
  ctx.withTx(tx => {
    tx.db.myTable.insert({
      id: 0n,
      content: data,
      fetchedAt: tx.timestamp,
      fetchedBy: tx.sender,
    });
  });

  return {};
});
```

### Key differences from reducers
| Reducers | Procedures |
|----------|------------|
| `ctx.db` available directly | Must use `ctx.withTx(tx => tx.db...)` |
| Automatic transaction | Manual transaction management |
| No HTTP/network | `ctx.http.fetch()` available |
| No return values to caller | Can return data to caller |

---

## 10) Project Structure

### Server (`backend/spacetimedb/`)
```
src/schema.ts   → Tables, export spacetimedb
src/index.ts    → Reducers, lifecycle, import schema
package.json    → { "type": "module", "dependencies": { "spacetimedb": "^1.11.0" } }
tsconfig.json   → Standard config
```

### Avoiding circular imports
```
schema.ts → defines tables AND exports spacetimedb
index.ts  → imports spacetimedb from ./schema, defines reducers
```

### Client (`client/`)
```
src/module_bindings/ → Generated (spacetime generate)
src/main.tsx         → Provider, connection setup
src/App.tsx          → UI components
src/config.ts        → MODULE_NAME, SPACETIMEDB_URI
```

---

## 11) Commands

```bash
# Start local server
spacetime start

# Publish module
spacetime publish <module-name> --module-path <backend-dir>

# Clear database and republish
spacetime publish <module-name> --clear-database -y --module-path <backend-dir>

# Generate bindings
spacetime generate --lang typescript --out-dir <client>/src/module_bindings --module-path <backend-dir>

# View logs
spacetime logs <module-name>
```

---

## 12) Hard Requirements

**TypeScript-specific:**

1. **`schema({ table })`** — takes exactly one object; never `schema(table)` or `schema(t1, t2, t3)`
2. **Reducer/procedure names from exports** — `export const name = spacetimedb.reducer(params, fn)`; never `reducer('name', ...)`
3. **Reducer calls use object syntax** — `{ param: 'value' }` not positional args
4. **Import `DbConnection` from `./module_bindings`** — not from `spacetimedb`
5. **DO NOT edit generated bindings** — regenerate with `spacetime generate`
6. **Indexes go in OPTIONS (1st arg)** — not in COLUMNS (2nd arg) of `table()`
7. **Use BigInt for u64/i64 fields** — `0n`, `1n`, not `0`, `1`
8. **Reducers are transactional** — they do not return data
9. **Reducers must be deterministic** — no filesystem, network, timers, random
10. **Views should use index lookups** — `.iter()` causes severe performance issues
11. **Procedures need `ctx.withTx()`** — `ctx.db` doesn't exist in procedures
12. **Sum type values** — use `{ tag: 'variant', value: payload }` not `{ variant: payload }`
