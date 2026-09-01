import { schema, table, t, SenderError, ScheduleAt, type ReducerCtx } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';
import {
  tickFootball, footballAction, switchPilot, controlledBody, bindPilot,
  setupKickoff, kickoffSpot, keeperSpot, posOf, positionName,
  PHASE_KICKOFF, PHASE_LIVE, PHASE_PAUSE, PHASE_OVER,
  RK_NONE, RK_KICKOFF, RK_THROWIN, RK_GOALKICK, RK_CORNER,
  RK_HALFTIME, RK_OVERTIME, RK_DROP, RK_FREEKICK, RK_PENALTY,
  ROLE_OUTFIELD, ROLE_KEEPER, CTRL_NONE,
  MAX_TEAM_SIZE, OUTFIELD_PER_SIDE, STAMINA_MAX,
  HALF_SECONDS, OT_SECONDS, COUNTDOWN_TICKS,
  BOT_LEVEL_COUNT, HALF_TICKS, MODULE_BUILD,
  type MetaHooks,
} from './football';

// ---------------------------------------------------------------------------
// Pitch geometry (world units ~ feet). Halfway line at y=0; side 0 defends
// the goal at y=-PITCH_HALF_LEN and attacks +y, side 1 the mirror image.
// Duplicated in client/src/config.ts — keep the two in sync.
// ---------------------------------------------------------------------------
const PITCH_HALF_LEN = 66;
const PITCH_HALF_WID = 34;
const GOAL_HALF_W = 6.5; // a 4 m 5-a-side goal — 19% of the pitch width
const GOAL_HEIGHT = 6.6; // crossbar — 2 m, and above a 5.54-unit player's head
const BOX_DEPTH = 20; // futsal's 6 m area; also the keeper's sweeping range
const BOX_HALF_W = 20;
const CENTER_CIRCLE_R = 10; // 3 m, 15% of the width
const BALL_RADIUS = 0.45; // 27 cm — a 22 cm ball, arcade-exaggerated

// Players may roam a touch past the lines (the ball going out is a restart,
// a body never is).
const P_BOUNDS_X = PITCH_HALF_WID + 2;
const P_BOUNDS_Y = PITCH_HALF_LEN + 2;

// Simulation rate. Every tick-counted constant below is derived from this via
// `ticks(seconds)`. NOTE: raising this multiplies row writes — and therefore
// broadcast traffic to every subscribed client — by the same factor.
const TICK_HZ = 30;
const TICK_MICROS = BigInt(Math.round(1_000_000 / TICK_HZ));
const DT = 1 / TICK_HZ;
const ticks = (seconds: number) => Math.max(1, Math.round(seconds * TICK_HZ));
const GRAVITY = -38; // 1.18 g — the read on a cross IS its hang time

// ---------------------------------------------------------------------------
// Custom-rules physics multiplier bounds (ball weight · friction · kick
// power · bounciness)
// ---------------------------------------------------------------------------
const PHYS_GRAVITY_RANGE = [0.3, 2.5];
const PHYS_FRICTION_RANGE = [0.2, 3.0];
const PHYS_POWER_RANGE = [0.5, 1.8];
const PHYS_BOUNCE_RANGE = [0.4, 1.6];

// Match lifecycle
const M_PENDING = 0;
const M_LIVE = 1;
const M_DONE = 2;

// Lobby modes / status
const MODE_QUICK = 0;
const MODE_TOURNAMENT = 1;
const L_OPEN = 0;
const L_RUNNING = 1;
const L_FINISHED = 2;

const NO_WINNER = 255;
const MAX_TOURNAMENT_PLAYERS = 16;
// MAX_TEAM_SIZE comes from football.ts — one source of truth
// Roster dressing (meta): pitch skins and the names bots wear. The playable
// roster's size mirrors the client's character list.
const CHAR_COUNT = 18;
const PITCHES = [
  { friction: 2.4, rest: 0.7 }, // 0 grass day — the standard carpet
  { friction: 2.1, rest: 0.72 }, // 1 grass night — a touch slicker
  { friction: 1.5, rest: 0.82 }, // 2 street — concrete runs faster and bounces higher
];

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------
const BOT_NAME = 'ACE BOT';
const BOT_CHAR = 4; // every bot plays VIPER, the all-rounder
const KEEPER_NAME = 'KEEPER';
const KEEPER_CHAR = 4;

// Tournament formats
const FORMAT_SINGLE = 0;
const FORMAT_DOUBLE = 1;
const BR_WINNERS = 0;
const BR_LOSERS = 1;
const BR_FINAL = 2;

// ---------------------------------------------------------------------------
// Tournament betting (unchanged machinery; odds prior reads goals now)
// ---------------------------------------------------------------------------
const BET_STARTING_CREDITS = 1500;
const BET_MIN_STAKE = 10;
const BET_WINDOW_TICKS = ticks(12);
const BET_SEED_TOTAL = 1000;
const BET_PRIOR_MIN = 0.15;
const BET_ODDS_MIN_MILLI = 1050;
const BET_ODDS_MAX_MILLI = 20000;
const B_OPEN = 0;
const B_WON = 1;
const B_LOST = 2;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
const FIREBASE_PROJECT = 'digital-football';
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT}`;

const PROV_NONE = 0;
const PROV_ANON = 1;
const PROV_LINKED = 2;
const PROV_OTHER = 3;

// XP: every finished match pays out. Casual matches (a bot on the pitch
// beyond the keepers) pay half.
const XP_PLAY = 50;
const XP_PER_GOAL = 25; // per team goal scored
const XP_WIN = 100;
const XP_CASUAL_MUL = 50; // percent
const LEVEL_BASE = 200;
const LEVEL_STEP = 100;
const LEVEL_MAX = 99;
const LOG_KEEP = 20;

const MMR_START = 1000;
const MMR_FLOOR = 100;
const MMR_CEIL = 4000;
const K_PLACEMENT = 48;
const K_EARLY = 32;
const K_SETTLED = 24;
const PLACEMENT_MATCHES = 10;
const SETTLED_MATCHES = 30;

const END_PLAYED = 0;
const END_FORFEIT = 1;
const END_TIMEOUT = 2;

// Reconnect: a dropped player's match HALTS instead of being forfeited.
const GRACE_QUICK = 300_000_000n; // 5 min
const GRACE_TOURNEY = 120_000_000n; // 2 min
const CLAIM_UNLOCK = 60_000_000n;
const REAP_AFTER = 60_000_000n;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const Lobby = table(
  { name: 'lobby', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().unique(),
    hostId: t.identity(),
    mode: t.u8(), // 0 quick match · 1 tournament
    status: t.u8(), // 0 open/registration · 1 running · 2 finished
    vsBot: t.bool(),
    pitch: t.u8(), // 0 grass day · 1 grass night · 2 street
    concurrent: t.u8(),
    championName: t.string(),
    createdAt: t.timestamp(),
    botLevel: t.u8().default(1), // 0 easy · 1 normal · 2 hard
    // Custom rules — ball physics multipliers (1 = standard)
    gravityMul: t.f32().default(1), // ball weight
    frictionMul: t.f32().default(1), // rolling friction
    powerMul: t.f32().default(1), // kick power
    bounceMul: t.f32().default(1), // bounciness
    // NOTE: new columns must be APPENDED — inserting mid-table breaks
    // SpacetimeDB's automatic migration (table reorder).
    isPublic: t.bool().default(false),
    format: t.u8().default(0), // tournament: 0 single elim · 1 double elim
    teamSize: t.u8().default(1), // human seats per side
    betWinnerName: t.string().default(''),
    betWinnerCredits: t.u32().default(0),
  }
);

const Match = table(
  {
    name: 'match',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    round: t.u8(),
    slot: t.u8(),
    state: t.u8(), // 0 pending · 1 live · 2 done
    p0Id: t.identity(),
    p1Id: t.identity(),
    hasP1: t.bool(),
    phase: t.u8(), // PHASE_*
    p0Goals: t.u8(),
    p1Goals: t.u8(),
    half: t.u8(), // 1 · 2 · 3 = golden-goal overtime
    clockTicks: t.u32(), // ticks left in the current half (counts down in LIVE)
    kickoffSide: t.u8(), // who takes the next/current kickoff
    restartKind: t.u8(), // what the current PAUSE resolves into (RK_*)
    restartSide: t.u8(), // who is awarded the restart / protected first touch
    restartX: t.f32(),
    restartY: t.f32(),
    graceTicks: t.u8(), // restart protection: only restartSide may play the ball
    pauseTicks: t.u16(),
    pointMsg: t.string(), // banner text (goals, restarts, full-time)
    winnerSide: t.u8(),
    rematchVotes: t.u8(),
    startTicks: t.u16().default(0), // match-start 3-2-1 countdown
    bracket: t.u8().default(0),
    // Reconnect: a dropped player HALTS the match instead of forfeiting it.
    haltMask: t.u8().default(0),
    haltedAt: t.u64().default(0n),
    haltUntil: t.u64().default(0n),
    haltName: t.string().default(''),
    // NOTE: appended — the teamSlot of each side's elected presser (255 =
    // none). Stored so the election has HYSTERESIS: recomputed from scratch
    // every tick it would flap between two equidistant players. A u8, not an
    // Identity, to keep toHexString out of the 30 Hz path.
    presser0: t.u8().default(255),
    presser1: t.u8().default(255),
    // NOTE: appended — TRANSITION MEMORY. Football's sharpest moments are the
    // seconds either side of a turnover: the side that just lost it swarms
    // the ball back, the side that just won it breaks. Neither is possible
    // without knowing that possession CHANGED, which needs a tick of memory.
    possSide: t.u8().default(255), // 255 = loose
    transTicks: t.u8().default(0), // counts down from a turnover
  }
);

const Player = table(
  {
    name: 'player',
    public: true,
    indexes: [
      { accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] },
      { accessor: 'byMatch', algorithm: 'btree', columns: ['matchId'] },
    ],
  },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    lobbyId: t.u64(),
    matchId: t.u64(),
    side: t.u8(),
    eliminated: t.bool(),
    x: t.f32(),
    y: t.f32(),
    dirX: t.i8(),
    dirY: t.i8(),
    sprinting: t.bool(),
    kickTicks: t.u8(), // charge counter, counts UP while kickHeld
    kickKind: t.u8(),
    kickHeld: t.bool(),
    slideTicks: t.u8(), // > SLIDE_ACTIVE_AFTER lunging · below: stun recovery
    slideDirX: t.f32(),
    slideDirY: t.f32(),
    stamina: t.u16(), // 0..1000, drains while sprinting
    role: t.u8(), // 0 outfield · 1 keeper (keepers are always bots)
    characterId: t.u8(),
    online: t.bool(),
    isBot: t.bool(),
    spectator: t.bool().default(false),
    teamSlot: t.u8().default(0),
    // NOTE: appended columns — CONTROL. A body is driven by whichever human
    // seat's stick holds its token: ctrlSeat is that seat's teamSlot, or
    // CTRL_NONE for AI. The token lives on the BODY, never on the person,
    // which is what makes "two humans driving one footballer" unrepresentable
    // rather than merely forbidden.
    ctrlSeat: t.u8().default(255),
    switchLock: t.u8().default(0), // ticks before this seat may switch again
    // Spawned for THIS match and deleted with it (keepers and lineup
    // fillers), as opposed to a lobby bot that outlives the match.
    matchBot: t.bool().default(false),
    // NOTE: appended AFTER matchBot on purpose — columns are append-only or
    // the publish is rejected as a table reorder. Cycle cursor for repeated
    // switch presses: a stateless "next nearest" would skip and repeat men,
    // because the ranking is by distance to a ball that moves 30 times a sec.
    switchIdx: t.u8().default(0),
    // ANALOG steering. dirX/dirY are i8 and also drive the rendered facing;
    // a bot asked to run 20 ahead and 3 across would sign() that to a 45
    // degree diagonal, overshoot, flip, and zig-zag its way across the pitch.
    // Movement integrates these instead; humans just copy their stick in.
    mvX: t.f32().default(0),
    mvY: t.f32().default(0),
    // NOTE: appended — ticks a keeper still has the ball IN ITS HANDS. While
    // this is non-zero the ball is pinned to the gloves and nobody can play
    // it; when it runs out the keeper distributes.
    holdTicks: t.u8().default(0),
    // NOTE: appended — CURRENT velocity as a fraction of top speed. Movement
    // used to be instantaneous: full pace on the first tick of a press and a
    // dead stop on release, which is what made everyone look like they were
    // teleporting between poses. This eases toward the wanted heading, so a
    // player leans into a run and settles out of it.
    velX: t.f32().default(0),
    velY: t.f32().default(0),
    // NOTE: appended — DISCIPLINE. cards counts cautions shown; a second one
    // is a sending-off. A sent-off body is walked to the touchline, skipped by
    // the AI and the integrator, and can never be bound to a stick again — the
    // offending side genuinely plays the rest of the match a man down.
    cards: t.u8().default(0),
    sentOff: t.bool().default(false),
    // NOTE: appended — THE DIVE. A keeper who only ever walks along his line
    // cannot reach a shot struck into the corner, and never looks like he
    // tried. While diveTicks is running he travels along diveDirX/Y far
    // faster than he can walk, reaches further, and can take a ball out of
    // the air — and the client draws him leaving the ground.
    diveTicks: t.u8().default(0),
    diveDirX: t.f32().default(0),
    diveDirY: t.f32().default(0),
  }
);

const Ball = table(
  { name: 'ball', public: true },
  {
    matchId: t.u64().primaryKey(),
    active: t.bool(),
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
    vx: t.f32(),
    vy: t.f32(),
    vz: t.f32(),
    lastTouchSide: t.u8(),
    lastTouchId: t.identity(), // scorer / own-goal / restart credit
    ownerId: t.identity(), // current dribbler (valid when hasOwner)
    hasOwner: t.bool(),
    // A ball that has just been struck must get away from the boot that
    // struck it: without this the kicker's own control radius swallows the
    // shot on the very next tick and nothing ever leaves their feet. The
    // player locked out is lastTouchId — whoever struck it is by definition
    // the last to have touched it.
    lockTicks: t.u8().default(0),
    // NOTE: appended — was the last touch a DELIBERATE KICK (or throw-in) by
    // an outfielder of lastTouchSide? That is the whole of the back-pass law:
    // a keeper may not handle a ball a team-mate has deliberately played to
    // him. A tackle, a deflection, a header or a keeper's own release are all
    // touches that clear it.
    fromKick: t.bool().default(false),
  }
);

// One row per goal: drives the score banner, match detail, betting settlement
// narrative. Dies with the room like every match row.
const GoalEvent = table(
  {
    name: 'goal_event',
    public: true,
    indexes: [{ accessor: 'byMatch', algorithm: 'btree', columns: ['matchId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64(),
    lobbyId: t.u64(),
    side: t.u8(), // who the goal counts FOR
    scorerName: t.string(),
    ownGoal: t.bool(),
    half: t.u8(),
    clockSecs: t.u16(), // seconds left in the half when it went in
    at: t.timestamp(),
  }
);

const Chat = table(
  {
    name: 'chat',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    senderSide: t.u8(),
    senderName: t.string(),
    emote: t.bool(),
    text: t.string(),
    sentAt: t.timestamp(),
  }
);

// Per-identity chat rate-limit state (private — never subscribed by clients).
const ChatGuard = table(
  { name: 'chat_guard' },
  {
    identity: t.identity().primaryKey(),
    windowStart: t.u64(),
    windowCount: t.u8(),
    lastAt: t.u64(),
    lastText: t.string(),
  }
);

// Team membership for team lobbies (2v2/3v3): one row per member.
const Team = table(
  {
    name: 'team',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    captainId: t.identity(),
    memberId: t.identity(),
    slot: t.u8(),
  }
);

const Wallet = table(
  {
    name: 'wallet',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    identity: t.identity(),
    balance: t.u32(),
    staked: t.u32(),
    won: t.u32(),
    lost: t.u32(),
  }
);

const Bet = table(
  {
    name: 'bet',
    public: true,
    indexes: [{ accessor: 'byMatch', algorithm: 'btree', columns: ['matchId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    matchId: t.u64(),
    bettor: t.identity(),
    bettorName: t.string(),
    side: t.u8(),
    stake: t.u32(),
    oddsMilli: t.u32(),
    state: t.u8(),
    payout: t.u32(),
    placedAt: t.timestamp(),
  }
);

const Book = table(
  { name: 'book', public: true },
  {
    matchId: t.u64().primaryKey(),
    lobbyId: t.u64(),
    open: t.bool(),
    priorMilli: t.u32(),
    seed0: t.u32(),
    seed1: t.u32(),
    pool0: t.u32(),
    pool1: t.u32(),
    odds0Milli: t.u32(),
    odds1Milli: t.u32(),
  }
);

// The ONLY table in this database that OUTLIVES a room. Columns are
// APPEND-ONLY and publish.sh refuses --clear-database without ALLOW_CLEAR=1.
const Account = table(
  {
    name: 'account',
    public: true,
    indexes: [{ accessor: 'byMmr', algorithm: 'btree', columns: ['mmr'] }],
  },
  {
    identity: t.identity().primaryKey(),
    uid: t.string(),
    provider: t.u8(),
    displayName: t.string(),
    characterId: t.u8(),
    xp: t.u32(),
    level: t.u16(),
    mmr: t.u16(),
    peakMmr: t.u16(),
    ranked: t.u16(),
    rankedWins: t.u16(),
    casual: t.u16(),
    casualWins: t.u16(),
    streak: t.i16(),
    bestStreak: t.u16(),
    quits: t.u16(),
    createdAt: t.timestamp(),
    lastSeen: t.timestamp(),
  }
);

const MatchLog = table(
  {
    name: 'match_log',
    indexes: [{ accessor: 'byAccount', algorithm: 'btree', columns: ['identity'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity(),
    matchId: t.u64(),
    opponentName: t.string(),
    won: t.bool(),
    ranked: t.bool(),
    mmrBefore: t.u16(),
    mmrAfter: t.u16(),
    xpBefore: t.u32(),
    xpGained: t.u32(),
    levelAfter: t.u16(),
    goalsFor: t.u8(),
    goalsAgainst: t.u8(),
    endedBy: t.u8(),
    playedAt: t.timestamp(),
  }
);

// One row per live websocket — presence is "has at least one session".
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

const TickTimer = table(
  { name: 'tick_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u64(),
  }
);

const GraceTimer = table(
  { name: 'grace_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u64(),
  }
);

const ReapTimer = table(
  { name: 'reap_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    lobbyId: t.u64(),
  }
);

// One public row naming the module build, refreshed on every connection so
// it is always the RUNNING module's stamp, not a stale publish's.
const BuildInfo = table(
  { name: 'build_info', public: true },
  { id: t.u64().primaryKey(), build: t.string() }
);

const spacetimedb = schema({
  buildInfo: BuildInfo,
  lobby: Lobby,
  match: Match,
  player: Player,
  ball: Ball,
  goalEvent: GoalEvent,
  chat: Chat,
  chatGuard: ChatGuard,
  tickTimer: TickTimer,
  team: Team,
  wallet: Wallet,
  bet: Bet,
  book: Book,
  account: Account,
  matchLog: MatchLog,
  session: Session,
  graceTimer: GraceTimer,
  reapTimer: ReapTimer,
});
export default spacetimedb;

export type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;
export type LobbyRow = typeof Lobby.rowType.type;
export type MatchRow = typeof Match.rowType.type;
export type PlayerRow = typeof Player.rowType.type;
export type BallRow = typeof Ball.rowType.type;
type WalletRow = typeof Wallet.rowType.type;
type BookRow = typeof Book.rowType.type;
type AccountRow = typeof Account.rowType.type;
type TeamRow = typeof Team.rowType.type;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Side 0 defends -y and attacks +y; sideSign is the sign of the DEFENDED end.
const sideSign = (side: number) => (side === 0 ? -1 : 1);
const attackSign = (side: number) => -sideSign(side);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sameId = (a: Identity, b: Identity) => a.toHexString() === b.toHexString();
const ZERO_ID = new Identity(0n);

// Deterministic pseudo-random in [0,1) — cheap per-tick noise.
const hash01 = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// Synthetic identity for one of a lobby's bots. Keeper bots use indexes
// derived from their match id so concurrent matches never collide.
const botIdentity = (lobbyId: bigint, index: bigint | number) =>
  new Identity(0xb07_00000000_00000000_00000000n + (BigInt(index) << 64n) + lobbyId);
// Synthetic-identity BANDS. botIdentity() shifts the index left 64 bits, and
// both insertKeeper and insertBot are find-then-update UPSERTS, so two bands
// that overlap silently corrupt a row instead of erroring. All three live
// here so a new one can be checked against the others at a glance:
//   lobby bots  small counters from start_tournament / create_practice (0..16)
//   keepers     [1e6, 1e6 + 2*2^32]        ~ up to 8.6e9
//   fillers     [2^46, 2^46 + 8*2^32]      ~ 7.0e13 .. 7.0e13 + 3.4e10
const keeperIndex = (matchId: bigint, side: number) =>
  1_000_000n + (matchId & 0xffffffffn) * 2n + BigInt(side);
const FILLER_BAND = 0x4000_0000_0000n;
const fillerIndex = (matchId: bigint, side: number, slot: number) =>
  FILLER_BAND + (matchId & 0xffffffffn) * 8n + BigInt(side) * 4n + BigInt(slot);

function lobbyPlayers(ctx: Ctx, lobbyId: bigint): PlayerRow[] {
  return [...ctx.db.player.byLobby.filter(lobbyId)];
}
function matchPlayers(ctx: Ctx, matchId: bigint): PlayerRow[] {
  return [...ctx.db.player.byMatch.filter(matchId)];
}
function lobbyMatches(ctx: Ctx, lobbyId: bigint): MatchRow[] {
  return [...ctx.db.match.byLobby.filter(lobbyId)];
}
function lobbyTeamSize(lobby: LobbyRow | null | undefined): number {
  return clamp(lobby?.teamSize ?? 1, 1, MAX_TEAM_SIZE);
}
function lobbyCompetitors(ctx: Ctx, lobbyId: bigint): PlayerRow[] {
  return lobbyPlayers(ctx, lobbyId).filter(p => !p.isBot && !p.spectator);
}

function deleteTeams(ctx: Ctx, lobbyId: bigint) {
  for (const row of ctx.db.team.byLobby.filter(lobbyId)) ctx.db.team.id.delete(row.id);
}
function insertTeam(ctx: Ctx, lobbyId: bigint, members: Identity[]) {
  members.forEach((memberId, slot) => {
    ctx.db.team.insert({ id: 0n, lobbyId, captainId: members[0], memberId, slot });
  });
}
function teamRowsOf(ctx: Ctx, lobbyId: bigint, captainId: Identity): TeamRow[] {
  return [...ctx.db.team.byLobby.filter(lobbyId)]
    .filter(r => sameId(r.captainId, captainId))
    .sort((a, b) => a.slot - b.slot);
}

// Bracket display / champion name for a captain-identified unit.
function unitName(ctx: Ctx, lobbyId: bigint, captainId: Identity): string {
  const rows = teamRowsOf(ctx, lobbyId, captainId);
  const ids = rows.length ? rows.map(r => r.memberId) : [captainId];
  return ids
    .map(id => ctx.db.player.identity.find(id)?.name || 'PLAYER')
    .join(' & ');
}

// Scoreboard name for a side: outfielders only — the keeper is furniture.
// Scoreboard / banner name for a side: the PEOPLE on it, never the lineup.
// Without the isBot filter every full-time line reads "ALICE & ACE BOT 2 &
// ACE BOT 3" once fillers are on the pitch — and winVerb's ' & ' test would
// pluralize a solo player's win. (isBot = this row is not a person.)
function teamName(players: PlayerRow[], side: number): string {
  const outfield = players
    .filter(p => p.side === side && p.role === ROLE_OUTFIELD)
    .sort((a, b) => a.teamSlot - b.teamSlot);
  // Humans if there are any; otherwise the named lobby bots (a practice
  // opponent, a bracket filler) so a bot side still reads as an opponent.
  // Never the per-match fillers: that is what gives "ALICE & ACE BOT 2".
  const named = outfield.filter(p => !p.isBot);
  const rows = named.length ? named : outfield.filter(p => !p.matchBot);
  const names = rows.map(p => p.name || 'PLAYER');
  return names.join(' & ') || `Side ${side + 1}`;
}

const winVerb = (name: string, caps = true) =>
  name.includes(' & ') ? (caps ? 'WIN' : 'win') : caps ? 'WINS' : 'wins';

function generateCode(ctx: Ctx): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 32; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += alphabet[Math.floor(ctx.random() * alphabet.length) % alphabet.length];
    }
    if (!ctx.db.lobby.code.find(code)) return code;
  }
  throw new SenderError('Could not allocate a lobby code, try again');
}

// The PERSON behind the caller: their account/session row. Everything about
// membership, names and progression wants this.
function getPlayer(ctx: Ctx): PlayerRow {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) throw new SenderError('No player record; reconnect and try again');
  return player;
}


function startTicking(ctx: Ctx, matchId: bigint) {
  deleteTickTimers(ctx, matchId);
  ctx.db.tickTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(TICK_MICROS),
    matchId,
  });
}
function deleteTickTimers(ctx: Ctx, matchId: bigint) {
  for (const timer of ctx.db.tickTimer.iter()) {
    if (timer.matchId === matchId) ctx.db.tickTimer.scheduledId.delete(timer.scheduledId);
  }
}
function deleteGoalEvents(ctx: Ctx, matchId: bigint) {
  for (const g of ctx.db.goalEvent.byMatch.filter(matchId)) ctx.db.goalEvent.id.delete(g.id);
}

// Custom-rules physics resolved from the lobby.
interface Phys {
  gravity: number;
  friction: number; // rolling deceleration factor per second
  power: number; // kick-speed multiplier
  bounce: number; // restitution multiplier on the pitch surface
}
function lobbyPhysics(lobby: LobbyRow | null | undefined): Phys {
  const pitch = PITCHES[lobby?.pitch ?? 0] ?? PITCHES[0];
  return {
    gravity: GRAVITY * (lobby?.gravityMul ?? 1),
    friction: pitch.friction * (lobby?.frictionMul ?? 1),
    power: lobby?.powerMul ?? 1,
    bounce: Math.min(0.95, pitch.rest * (lobby?.bounceMul ?? 1)),
  };
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------
// Create a match row (pending). A bye (no p1) resolves instantly.
function createMatch(
  ctx: Ctx,
  lobby: LobbyRow,
  round: number,
  slot: number,
  p0Id: Identity,
  p1Id: Identity | null,
  bracket = BR_WINNERS
): MatchRow {
  const row = ctx.db.match.insert({
    id: 0n,
    lobbyId: lobby.id,
    round,
    slot,
    bracket,
    state: p1Id ? M_PENDING : M_DONE,
    p0Id,
    p1Id: p1Id ?? p0Id,
    hasP1: p1Id !== null,
    phase: p1Id ? PHASE_KICKOFF : PHASE_OVER,
    p0Goals: 0,
    p1Goals: 0,
    half: 1,
    clockTicks: HALF_TICKS,
    kickoffSide: 0,
    restartKind: RK_NONE,
    restartSide: 0,
    restartX: 0,
    restartY: 0,
    graceTicks: 0,
    pauseTicks: 0,
    pointMsg: p1Id ? '' : 'BYE — advances automatically',
    winnerSide: p1Id ? NO_WINNER : 0,
    rematchVotes: 0,
    startTicks: 0,
    haltMask: 0,
    haltedAt: 0n,
    haltUntil: 0n,
    haltName: '',
    presser0: 255,
    presser1: 255,
    possSide: 255,
    transTicks: 0,
  });
  openBook(ctx, lobby, row);
  return row;
}

// Seat a keeper bot for one side of a match. Keepers are ordinary bot player
// rows (so they render and subscribe like anyone else) that the tick drives;
// they are spawned with the match and deleted with it.
function insertKeeper(ctx: Ctx, lobbyId: bigint, match: MatchRow, side: number) {
  const identity = botIdentity(lobbyId, keeperIndex(match.id, side));
  const row = {
    identity,
    name: KEEPER_NAME,
    lobbyId,
    matchId: match.id,
    side,
    eliminated: false,
    x: 0,
    y: keeperSpot(side).y,
    dirX: 0 as number,
    dirY: 0 as number,
    sprinting: false,
    kickTicks: 0,
    kickKind: 0,
    kickHeld: false,
    slideTicks: 0,
    slideDirX: 0,
    slideDirY: 0,
    stamina: STAMINA_MAX,
    role: ROLE_KEEPER,
    characterId: KEEPER_CHAR,
    online: true,
    isBot: true,
    spectator: false,
    teamSlot: 0,
    ctrlSeat: CTRL_NONE,
    switchLock: 0,
    switchIdx: 0,
    matchBot: true,
    mvX: 0,
    mvY: 0,
    holdTicks: 0,
    velX: 0,
    velY: 0, // spawned with this match, deleted with it
    cards: 0,
    sentOff: false,
    diveTicks: 0,
    diveDirX: 0,
    diveDirY: 0,
  };
  if (ctx.db.player.identity.find(identity)) ctx.db.player.identity.update(row);
  else ctx.db.player.insert(row);
}

// Seat a bot outfielder to complete a 5-a-side lineup. Like keepers, fillers
// belong to ONE match: spawned in goLive, deleted in endMatchCleanup. They
// are never lobby members in their own right — matchBot is what tells the
// cleanup which bots to collect.
function insertFiller(ctx: Ctx, lobbyId: bigint, match: MatchRow, side: number, slot: number) {
  const identity = botIdentity(lobbyId, fillerIndex(match.id, side, slot));
  const spot = kickoffSpot(side, posOf(slot), match.kickoffSide);
  const row = {
    identity,
    name: `${positionName(slot)} BOT`,
    lobbyId,
    matchId: match.id,
    side,
    eliminated: false,
    x: spot.x,
    y: spot.y,
    dirX: 0 as number,
    dirY: 0 as number,
    sprinting: false,
    kickTicks: 0,
    kickKind: 0,
    kickHeld: false,
    slideTicks: 0,
    slideDirX: 0,
    slideDirY: 0,
    stamina: STAMINA_MAX,
    role: ROLE_OUTFIELD,
    characterId: BOT_CHAR,
    online: true,
    isBot: true,
    spectator: false,
    teamSlot: slot,
    ctrlSeat: CTRL_NONE,
    switchLock: 0,
    switchIdx: 0,
    matchBot: true,
    mvX: 0,
    mvY: 0,
    holdTicks: 0,
    velX: 0,
    velY: 0,
    cards: 0,
    sentOff: false,
    diveTicks: 0,
    diveDirX: 0,
    diveDirY: 0,
  };
  if (ctx.db.player.identity.find(identity)) ctx.db.player.identity.update(row);
  else ctx.db.player.insert(row);
}

// Take a pending match live: assign players, spawn keepers + ball + tick.
function goLive(ctx: Ctx, match: MatchRow) {
  const liveLobby = ctx.db.lobby.id.find(match.lobbyId);
  const assign = (id: Identity, side: number, teamSlot: number) => {
    const p = ctx.db.player.identity.find(id);
    if (p) {
      ctx.db.player.identity.update({
        ...p,
        matchId: match.id,
        side,
        teamSlot,
        stamina: STAMINA_MAX,
        slideTicks: 0,
        kickTicks: 0,
        kickHeld: false,
        // The isBot guard is load-bearing: create_practice seats a lobby bot
        // as p1Id, and handing it a control token would tell the tick a human
        // is driving it — freezing the practice opponent for the whole match.
        ctrlSeat: p.isBot ? CTRL_NONE : teamSlot,
        switchLock: 0,
      });
    }
  };
  if (lobbyTeamSize(liveLobby) >= 2) {
    for (const side of [0, 1]) {
      const captainId = side === 0 ? match.p0Id : match.p1Id;
      const rows = teamRowsOf(ctx, match.lobbyId, captainId);
      if (rows.length) for (const r of rows) assign(r.memberId, side, r.slot);
      else assign(captainId, side, 0);
    }
  } else {
    assign(match.p0Id, 0, 0);
    assign(match.p1Id, 1, 0);
  }
  // Complete both lineups: human seats fill teamSlot 0..teamSize-1, bot
  // fillers take the rest, and every side gets a keeper. A 1v1 room is
  // therefore one human + 3 fillers + a keeper per side, not two lone men.
  const humanSeats = lobbyTeamSize(liveLobby);
  for (const side of [0, 1]) {
    for (let slot = humanSeats; slot < OUTFIELD_PER_SIDE; slot++) {
      insertFiller(ctx, match.lobbyId, match, side, slot);
    }
    insertKeeper(ctx, match.lobbyId, match, side);
  }
  if (!ctx.db.ball.matchId.find(match.id)) {
    ctx.db.ball.insert({
      matchId: match.id,
      fromKick: false,
      active: false,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      lastTouchSide: 0,
      lastTouchId: ZERO_ID,
      ownerId: ZERO_ID,
      hasOwner: false,
      lockTicks: 0,
    });
  }
  startTicking(ctx, match.id);
  const modeLobby = ctx.db.lobby.id.find(match.lobbyId);
  const live = setupKickoff(ctx, {
    ...match,
    state: M_LIVE,
    winnerSide: NO_WINNER,
    half: 1,
    clockTicks: HALF_TICKS,
    kickoffSide: 0,
  }, 'KICKOFF');
  const bettable =
    modeLobby?.mode === MODE_TOURNAMENT &&
    match.hasP1 &&
    hasIdleBettor(ctx, match.lobbyId);
  ctx.db.match.id.update({
    ...live,
    startTicks: COUNTDOWN_TICKS + (bettable ? BET_WINDOW_TICKS : 0),
  });
  // A tournament can draw a round while one of its entrants is mid-drop.
  const away = matchPlayers(ctx, match.id).find(
    p => !p.isBot && !p.spectator && !hasSession(ctx, p.identity)
  );
  if (away) syncPresence(ctx, match.id, away.name);
}

function endMatchCleanup(ctx: Ctx, match: MatchRow) {
  deleteTickTimers(ctx, match.id);
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
  for (const p of matchPlayers(ctx, match.id)) {
    // Keepers and lineup fillers exist only for their match. This must key on
    // matchBot, NOT on isBot: create_practice seats a LOBBY bot as p1Id and
    // rematch reuses that row, so collecting every bot here would delete the
    // practice opponent and break the rematch button.
    if (p.matchBot) ctx.db.player.identity.delete(p.identity);
    else ctx.db.player.identity.update({
      ...p, matchId: 0n, dirX: 0, dirY: 0, ctrlSeat: CTRL_NONE, switchLock: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Reconnect: a dropped player halts their match instead of forfeiting it.
// ---------------------------------------------------------------------------
function hasSession(ctx: Ctx, id: Identity): boolean {
  for (const _ of ctx.db.session.byIdentity.filter(id)) return true;
  return false;
}
function deleteGraceTimers(ctx: Ctx, matchId: bigint) {
  for (const g of ctx.db.graceTimer.iter()) {
    if (g.matchId === matchId) ctx.db.graceTimer.scheduledId.delete(g.scheduledId);
  }
}
function missingMask(ctx: Ctx, matchId: bigint): number {
  let mask = 0;
  for (const p of matchPlayers(ctx, matchId)) {
    if (p.isBot || p.spectator) continue;
    if (!hasSession(ctx, p.identity)) mask |= 1 << p.side;
  }
  return mask;
}

function haltMatch(ctx: Ctx, match: MatchRow, awayName: string) {
  const mask = missingMask(ctx, match.id);
  if (mask === 0) return;
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const grace = lobby?.mode === MODE_TOURNAMENT ? GRACE_TOURNEY : GRACE_QUICK;
  const first = match.haltUntil === 0n;
  const until = first ? now + grace : match.haltUntil;

  deleteTickTimers(ctx, match.id);
  if (first) {
    ctx.db.graceTimer.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(until),
      matchId: match.id,
    });
  }
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
  const name = awayName || match.haltName || 'PLAYER';
  ctx.db.match.id.update({
    ...match,
    haltMask: mask,
    haltedAt: first ? now : match.haltedAt,
    haltUntil: until,
    haltName: name,
    pointMsg: `WAITING FOR ${name}…`,
  });
}

// Everyone is back: restart from a neutral drop ball at the center — score
// and clock stand, but nobody inherits a ball they never saw.
function resumeMatch(ctx: Ctx, match: MatchRow) {
  deleteGraceTimers(ctx, match.id);
  const live = setupKickoff(ctx, {
    ...match,
    haltMask: 0,
    haltedAt: 0n,
    haltUntil: 0n,
    haltName: '',
  }, 'RECONNECTED — DROP BALL');
  ctx.db.match.id.update({
    ...live,
    startTicks: COUNTDOWN_TICKS,
  });
  startTicking(ctx, match.id);
}

function abandonMatch(ctx: Ctx, match: MatchRow) {
  deleteGraceTimers(ctx, match.id);
  const done = {
    ...match,
    state: M_DONE,
    phase: PHASE_OVER,
    winnerSide: NO_WINNER,
    pointMsg: 'MATCH ABANDONED — NOBODY CAME BACK',
    haltMask: 0,
    haltedAt: 0n,
    haltUntil: 0n,
    haltName: '',
  };
  ctx.db.match.id.update(done);
  endMatchCleanup(ctx, done);
}

function syncPresence(ctx: Ctx, matchId: bigint, awayName = '') {
  const match = ctx.db.match.id.find(matchId);
  if (!match || match.state !== M_LIVE) return;
  const mask = missingMask(ctx, matchId);
  if (mask === 0) {
    if (match.haltMask !== 0) resumeMatch(ctx, match);
  } else if (mask !== match.haltMask || match.haltUntil === 0n) {
    haltMatch(ctx, match, awayName);
  }
}

export const grace_expired = spacetimedb.reducer(
  { onSchedule: GraceTimer },
  { arg: GraceTimer.rowType },
  (ctx, { arg }) => {
    const match = ctx.db.match.id.find(arg.matchId);
    if (!match || match.state !== M_LIVE || match.haltMask === 0) return;
    const missing0 = (match.haltMask & 1) !== 0;
    const missing1 = (match.haltMask & 2) !== 0;
    if (missing0 && missing1) {
      abandonMatch(ctx, match);
      return;
    }
    const winnerSide = missing0 ? 1 : 0;
    const seats = matchPlayers(ctx, match.id);
    const humanWins = seats.some(p => p.side === winnerSide && !p.isBot && !p.spectator);
    const lobby = ctx.db.lobby.id.find(match.lobbyId);
    if (!humanWins && lobby?.mode !== MODE_TOURNAMENT) {
      abandonMatch(ctx, match);
      return;
    }
    const winner = teamName(seats, winnerSide);
    finishMatch(
      ctx,
      match,
      winnerSide,
      `${match.haltName || 'OPPONENT'} DIDN'T COME BACK — ${winner} ${winVerb(winner, false)}!`,
      END_TIMEOUT
    );
  }
);

// ---------------------------------------------------------------------------
// Room reaper
// ---------------------------------------------------------------------------
function lobbyHasPresence(ctx: Ctx, lobbyId: bigint): boolean {
  for (const p of lobbyPlayers(ctx, lobbyId)) {
    if (!p.isBot && hasSession(ctx, p.identity)) return true;
  }
  return false;
}
function disarmReaper(ctx: Ctx, lobbyId: bigint) {
  for (const r of ctx.db.reapTimer.iter()) {
    if (r.lobbyId === lobbyId) ctx.db.reapTimer.scheduledId.delete(r.scheduledId);
  }
}
function armReaper(ctx: Ctx, lobbyId: bigint) {
  if (lobbyId === 0n) return;
  if (!ctx.db.lobby.id.find(lobbyId)) return;
  if (lobbyHasPresence(ctx, lobbyId)) return;
  disarmReaper(ctx, lobbyId);
  const at = ctx.timestamp.microsSinceUnixEpoch + GRACE_QUICK + REAP_AFTER;
  ctx.db.reapTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(at),
    lobbyId,
  });
}

export const reap_lobby = spacetimedb.reducer(
  { onSchedule: ReapTimer },
  { arg: ReapTimer.rowType },
  (ctx, { arg }) => {
    const lobby = ctx.db.lobby.id.find(arg.lobbyId);
    if (!lobby) return;
    if (lobbyHasPresence(ctx, arg.lobbyId)) return;
    destroyLobby(ctx, lobby);
  }
);

// A finished match reports here: record winner, pay out, then advance the
// room. Every result funnels through this — which is why it is the only
// place progression is awarded.
function finishMatch(
  ctx: Ctx,
  match: MatchRow,
  winnerSide: number,
  msg: string,
  endedBy = END_PLAYED
) {
  // Capture the roster FIRST: endMatchCleanup below sets matchId = 0 on every
  // player, after which matchPlayers(match.id) returns nothing.
  const seats = matchPlayers(ctx, match.id);
  const done = {
    ...match,
    state: M_DONE,
    phase: PHASE_OVER,
    winnerSide,
    pointMsg: msg,
    haltMask: 0,
    haltedAt: 0n,
    haltUntil: 0n,
    haltName: '',
  };
  ctx.db.match.id.update(done);
  deleteGraceTimers(ctx, match.id);
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  awardProgression(ctx, lobby, done, seats, winnerSide, endedBy);
  endMatchCleanup(ctx, done);
  if (!lobby) return;
  if (lobby.mode === MODE_TOURNAMENT) {
    settleBets(ctx, done, winnerSide);
    eliminateLoser(ctx, lobby, done);
    advanceTournament(ctx, lobby);
  }
}

function eliminateLoser(ctx: Ctx, lobby: LobbyRow, done: MatchRow) {
  const dropsOut = lobby.format !== FORMAT_DOUBLE || done.bracket !== BR_WINNERS;
  const winnerId = done.winnerSide === 0 ? done.p0Id : done.p1Id;
  const loserId = done.winnerSide === 0 ? done.p1Id : done.p0Id;
  if (!dropsOut || sameId(loserId, winnerId)) return;
  const rows = teamRowsOf(ctx, lobby.id, loserId);
  const outIds = rows.length ? rows.map(r => r.memberId) : [loserId];
  for (const id of outIds) {
    const loser = ctx.db.player.identity.find(id);
    if (loser && loser.lobbyId === lobby.id) {
      ctx.db.player.identity.update({ ...loser, eliminated: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Accounts, XP and MMR
// ---------------------------------------------------------------------------
function providerOf(ctx: Ctx): { provider: number; uid: string; name: string } {
  const jwt = ctx.senderAuth.jwt;
  if (!jwt) return { provider: PROV_NONE, uid: '', name: '' };
  if (jwt.issuer !== FIREBASE_ISSUER) {
    return { provider: PROV_OTHER, uid: jwt.subject, name: '' };
  }
  const fb = jwt.fullPayload['firebase'];
  const signIn =
    fb && typeof fb === 'object' && !Array.isArray(fb) ? fb['sign_in_provider'] : null;
  const claimed = jwt.fullPayload['name'];
  return {
    provider: signIn === 'anonymous' ? PROV_ANON : PROV_LINKED,
    uid: jwt.subject,
    name: typeof claimed === 'string' ? claimed.trim().slice(0, 16) : '',
  };
}

function ensureAccount(ctx: Ctx): AccountRow {
  const { provider, uid, name } = providerOf(ctx);
  const existing = ctx.db.account.identity.find(ctx.sender);
  if (existing) {
    return ctx.db.account.identity.update({
      ...existing,
      uid: uid || existing.uid,
      provider,
      lastSeen: ctx.timestamp,
    });
  }
  return ctx.db.account.insert({
    identity: ctx.sender,
    uid,
    provider,
    displayName: name,
    characterId: 0,
    xp: 0,
    level: 1,
    mmr: MMR_START,
    peakMmr: MMR_START,
    ranked: 0,
    rankedWins: 0,
    casual: 0,
    casualWins: 0,
    streak: 0,
    bestStreak: 0,
    quits: 0,
    createdAt: ctx.timestamp,
    lastSeen: ctx.timestamp,
  });
}

function accountOf(ctx: Ctx, id: Identity): AccountRow | undefined {
  return ctx.db.account.identity.find(id) ?? undefined;
}

// Total XP needed to REACH a level. Mirrored in client/src/config.ts.
function totalXpFor(level: number): number {
  return ((level - 1) * (2 * LEVEL_BASE + LEVEL_STEP * (level - 2))) / 2;
}
function levelFor(xp: number): number {
  let lvl = 1;
  while (lvl < LEVEL_MAX && totalXpFor(lvl + 1) <= xp) lvl++;
  return lvl;
}
function kFactor(ranked: number): number {
  if (ranked < PLACEMENT_MATCHES) return K_PLACEMENT;
  if (ranked < SETTLED_MATCHES) return K_EARLY;
  return K_SETTLED;
}
function eloDelta(mine: number, theirs: number, won: boolean, ranked: number): number {
  const expected = 1 / (1 + Math.pow(10, (theirs - mine) / 400));
  const raw = kFactor(ranked) * ((won ? 1 : 0) - expected);
  return raw >= 0 ? Math.max(1, Math.round(raw)) : Math.min(-1, Math.round(raw));
}

// Ranked means: a real pairing, no OUTFIELD bots on the pitch, not practice.
// Keepers are always bots and don't count against it.
function isRanked(
  lobby: LobbyRow | null | undefined,
  match: MatchRow,
  seats: PlayerRow[]
): boolean {
  if (!lobby || !match.hasP1) return false;
  if (lobby.vsBot) return false;
  // Ranked means every HUMAN SEAT is filled by a human — NOT "every body on
  // the pitch is human". A 5-a-side lineup is mostly fillers by design, so
  // the old "no bots on the pitch" test would make every match unranked and
  // silently freeze MMR. Here isBot means "this row is not a person".
  const humansOn = (side: number) =>
    seats.filter(
      p => p.side === side && !p.spectator && !p.sentOff && p.role === ROLE_OUTFIELD && !p.isBot
    ).length;
  const seatsPerSide = lobbyTeamSize(lobby);
  return humansOn(0) === seatsPerSide && humansOn(1) === seatsPerSide;
}

function sideMmr(
  seats: PlayerRow[],
  side: number,
  before: Map<string, AccountRow | undefined>
): number {
  // Humans only: a filler bot holds no account row, so counting one would
  // pull a strong side's average back toward MMR_START. (isBot = not a person.)
  const rows = seats.filter(
    p => p.side === side && !p.spectator && !p.sentOff && p.role === ROLE_OUTFIELD && !p.isBot
  );
  if (rows.length === 0) return MMR_START;
  let total = 0;
  for (const p of rows) {
    total += before.get(p.identity.toHexString())?.mmr ?? MMR_START;
  }
  return Math.round(total / rows.length);
}

// Pay out a finished match. MUST be called from finishMatch BEFORE
// endMatchCleanup, which zeroes matchId on every player.
function awardProgression(
  ctx: Ctx,
  lobby: LobbyRow | null | undefined,
  match: MatchRow,
  seats: PlayerRow[],
  winnerSide: number,
  endedBy: number
) {
  if (winnerSide === NO_WINNER) return;
  // A match that ended before a single goal AND before a played result (a
  // bye, a collapsed pairing) is not a result. A forfeit always is.
  if (endedBy === END_PLAYED && match.phase === PHASE_OVER && match.half === 1 &&
      match.p0Goals + match.p1Goals === 0 && match.clockTicks === HALF_TICKS) {
    return;
  }
  const humans = seats.filter(p => !p.isBot && !p.spectator);
  if (humans.length === 0) return;
  const ranked = isRanked(lobby, match, seats);

  const before = new Map<string, AccountRow | undefined>();
  for (const p of seats) {
    if (!p.spectator) before.set(p.identity.toHexString(), accountOf(ctx, p.identity));
  }
  const avg = [sideMmr(seats, 0, before), sideMmr(seats, 1, before)];

  for (const p of humans) {
    const acc = before.get(p.identity.toHexString());
    if (!acc) continue;
    const won = p.side === winnerSide;
    const goalsFor = p.side === 0 ? match.p0Goals : match.p1Goals;
    const goalsAgainst = p.side === 0 ? match.p1Goals : match.p0Goals;

    let xp = XP_PLAY + goalsFor * XP_PER_GOAL + (won ? XP_WIN : 0);
    if (!ranked) xp = Math.round((xp * XP_CASUAL_MUL) / 100);
    if (!won && endedBy !== END_PLAYED) xp = XP_PLAY;

    let mmr = acc.mmr;
    if (ranked) {
      const delta = eloDelta(acc.mmr, avg[1 - p.side], won, acc.ranked);
      mmr = clamp(acc.mmr + delta, MMR_FLOOR, MMR_CEIL);
    }
    const newXp = acc.xp + xp;
    const streak = won ? Math.max(1, acc.streak + 1) : Math.min(-1, acc.streak - 1);
    ctx.db.account.identity.update({
      ...acc,
      xp: newXp,
      level: levelFor(newXp),
      mmr,
      peakMmr: Math.max(acc.peakMmr, mmr),
      ranked: acc.ranked + (ranked ? 1 : 0),
      rankedWins: acc.rankedWins + (ranked && won ? 1 : 0),
      casual: acc.casual + (ranked ? 0 : 1),
      casualWins: acc.casualWins + (!ranked && won ? 1 : 0),
      streak,
      bestStreak: Math.max(acc.bestStreak, streak > 0 ? streak : 0),
      quits: acc.quits + (!won && endedBy !== END_PLAYED ? 1 : 0),
      lastSeen: ctx.timestamp,
    });
    ctx.db.matchLog.insert({
      id: 0n,
      identity: p.identity,
      matchId: match.id,
      opponentName: teamName(seats, 1 - p.side),
      won,
      ranked,
      mmrBefore: acc.mmr,
      mmrAfter: mmr,
      xpBefore: acc.xp,
      xpGained: xp,
      levelAfter: levelFor(newXp),
      goalsFor,
      goalsAgainst,
      endedBy,
      playedAt: ctx.timestamp,
    });
    pruneMatchLog(ctx, p.identity);
  }
}

function pruneMatchLog(ctx: Ctx, id: Identity) {
  const rows = [...ctx.db.matchLog.byAccount.filter(id)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  for (let i = 0; i < rows.length - LOG_KEEP; i++) {
    ctx.db.matchLog.id.delete(rows[i].id);
  }
}

export const my_match_log = spacetimedb.view(
  { name: 'my_match_log', public: true },
  t.array(MatchLog.rowType),
  ctx => [...ctx.db.matchLog.byAccount.filter(ctx.sender)]
);

// ---------------------------------------------------------------------------
// Tournament betting
// ---------------------------------------------------------------------------
function walletOf(ctx: Ctx, lobbyId: bigint, id: Identity): WalletRow | undefined {
  for (const w of ctx.db.wallet.byLobby.filter(lobbyId)) {
    if (sameId(w.identity, id)) return w;
  }
  return undefined;
}

function grantWallet(ctx: Ctx, lobbyId: bigint, id: Identity) {
  if (walletOf(ctx, lobbyId, id)) return;
  ctx.db.wallet.insert({
    id: 0n,
    lobbyId,
    identity: id,
    balance: BET_STARTING_CREDITS,
    staked: 0,
    won: 0,
    lost: 0,
  });
}

// How a bracket unit has actually played this tournament — goal share
// weighted by win rate, smoothed so one result can't produce a runaway price.
function unitPerf(
  ctx: Ctx,
  lobbyId: bigint,
  captainId: Identity
): { wins: number; losses: number; gF: number; gT: number } {
  let wins = 0;
  let losses = 0;
  let gF = 0;
  let gT = 0;
  for (const m of ctx.db.match.byLobby.filter(lobbyId)) {
    if (m.state !== M_DONE || !m.hasP1) continue;
    const isP0 = sameId(m.p0Id, captainId);
    const isP1 = sameId(m.p1Id, captainId);
    if (!isP0 && !isP1) continue;
    const mine = isP0 ? m.p0Goals : m.p1Goals;
    const theirs = isP0 ? m.p1Goals : m.p0Goals;
    gF += mine;
    gT += mine + theirs;
    if (m.winnerSide === (isP0 ? 0 : 1)) wins++;
    else losses++;
  }
  return { wins, losses, gF, gT };
}

function unitStrength(perf: { wins: number; losses: number; gF: number; gT: number }): number {
  const goalShare = (perf.gF + 2) / (perf.gT + 4);
  const winRate = (perf.wins + 1) / (perf.wins + perf.losses + 2);
  return Math.pow(goalShare, 1.5) * winRate;
}

function oddsFor(total: number, sideMoney: number): number {
  if (sideMoney <= 0) return BET_ODDS_MAX_MILLI;
  return clamp(
    Math.round((1000 * total) / sideMoney),
    BET_ODDS_MIN_MILLI,
    BET_ODDS_MAX_MILLI
  );
}

function recomputeOdds(book: BookRow): BookRow {
  const m0 = book.seed0 + book.pool0;
  const m1 = book.seed1 + book.pool1;
  const total = m0 + m1;
  return { ...book, odds0Milli: oddsFor(total, m0), odds1Milli: oddsFor(total, m1) };
}

function openBook(ctx: Ctx, lobby: LobbyRow, match: MatchRow) {
  if (lobby.mode !== MODE_TOURNAMENT || !match.hasP1) return;
  if (ctx.db.book.matchId.find(match.id)) return;
  const s0 = unitStrength(unitPerf(ctx, lobby.id, match.p0Id));
  const s1 = unitStrength(unitPerf(ctx, lobby.id, match.p1Id));
  const prior = clamp(s0 / (s0 + s1), BET_PRIOR_MIN, 1 - BET_PRIOR_MIN);
  const seed0 = Math.round(BET_SEED_TOTAL * prior);
  ctx.db.book.insert(
    recomputeOdds({
      matchId: match.id,
      lobbyId: lobby.id,
      open: true,
      priorMilli: Math.round(prior * 1000),
      seed0,
      seed1: BET_SEED_TOTAL - seed0,
      pool0: 0,
      pool1: 0,
      odds0Milli: 0,
      odds1Milli: 0,
    })
  );
}

function closeBook(ctx: Ctx, matchId: bigint) {
  const book = ctx.db.book.matchId.find(matchId);
  if (book && book.open) ctx.db.book.matchId.update({ ...book, open: false });
}

function hasIdleBettor(ctx: Ctx, lobbyId: bigint): boolean {
  for (const p of ctx.db.player.byLobby.filter(lobbyId)) {
    if (!p.isBot && p.matchId === 0n && walletOf(ctx, lobbyId, p.identity)) return true;
  }
  return false;
}

function settleBets(ctx: Ctx, match: MatchRow, winnerSide: number) {
  closeBook(ctx, match.id);
  for (const bet of ctx.db.bet.byMatch.filter(match.id)) {
    if (bet.state !== B_OPEN) continue;
    const won = bet.side === winnerSide;
    const payout = won ? Math.round((bet.stake * bet.oddsMilli) / 1000) : 0;
    ctx.db.bet.id.update({ ...bet, state: won ? B_WON : B_LOST, payout });
    const w = walletOf(ctx, match.lobbyId, bet.bettor);
    if (!w) continue;
    ctx.db.wallet.id.update({
      ...w,
      balance: w.balance + payout,
      staked: Math.max(0, w.staked - bet.stake),
      won: won ? w.won + payout : w.won,
      lost: won ? w.lost : w.lost + bet.stake,
    });
  }
}

function betWinner(ctx: Ctx, lobbyId: bigint): { name: string; credits: number } | null {
  let best = -1;
  const names: string[] = [];
  for (const w of ctx.db.wallet.byLobby.filter(lobbyId)) {
    if (w.won === 0 && w.lost === 0 && w.staked === 0) continue;
    if (w.balance > best) {
      best = w.balance;
      names.length = 0;
    }
    if (w.balance === best) {
      names.push(ctx.db.player.identity.find(w.identity)?.name || 'PLAYER');
    }
  }
  if (best < 0) return null;
  return { name: names.join(' & '), credits: best };
}

function deleteBetting(ctx: Ctx, lobbyId: bigint) {
  for (const m of ctx.db.match.byLobby.filter(lobbyId)) {
    if (ctx.db.book.matchId.find(m.id)) ctx.db.book.matchId.delete(m.id);
    for (const b of ctx.db.bet.byMatch.filter(m.id)) ctx.db.bet.id.delete(b.id);
  }
  for (const w of ctx.db.wallet.byLobby.filter(lobbyId)) ctx.db.wallet.id.delete(w.id);
}

// ---------------------------------------------------------------------------
// Tournament bracket scheduler
// ---------------------------------------------------------------------------
function crownChampion(ctx: Ctx, lobby: LobbyRow, champId: Identity) {
  const bettor = betWinner(ctx, lobby.id);
  ctx.db.lobby.id.update({
    ...lobby,
    status: L_FINISHED,
    championName: unitName(ctx, lobby.id, champId) || 'CHAMPION',
    betWinnerName: bettor?.name ?? '',
    betWinnerCredits: bettor?.credits ?? 0,
  });
}

function unitIsAllBots(ctx: Ctx, lobbyId: bigint, captainId: Identity): boolean {
  const rows = teamRowsOf(ctx, lobbyId, captainId);
  const ids = rows.length ? rows.map(r => r.memberId) : [captainId];
  return ids.every(id => ctx.db.player.identity.find(id)?.isBot ?? false);
}

// A match with a bot on every seat is decided on the spot: nobody is on the
// sticks and the bracket would be waiting on two identical AIs.
function simulateBotMatch(ctx: Ctx, lobby: LobbyRow, match: MatchRow) {
  const winnerSide = ctx.random() < 0.5 ? 0 : 1;
  const wGoals = 1 + Math.floor(ctx.random() * 3);
  const lGoals = Math.floor(ctx.random() * wGoals);
  const winnerName = unitName(ctx, lobby.id, winnerSide === 0 ? match.p0Id : match.p1Id);
  const done = {
    ...match,
    state: M_DONE,
    phase: PHASE_OVER,
    winnerSide,
    p0Goals: winnerSide === 0 ? wGoals : lGoals,
    p1Goals: winnerSide === 1 ? wGoals : lGoals,
    pointMsg: `${winnerName} ${winVerb(winnerName)} — BOT MATCH, AUTO-PLAYED`,
  };
  ctx.db.match.id.update(done);
  settleBets(ctx, done, winnerSide);
  eliminateLoser(ctx, lobby, done);
}

// Rounds are waves: every match of round R finishes before round R+1 exists.
function advanceTournament(ctx: Ctx, lobby: LobbyRow) {
  const matches = lobbyMatches(ctx, lobby.id);
  if (matches.length === 0) return;
  const maxRound = Math.max(...matches.map(m => m.round));
  const roundMatches = matches
    .filter(m => m.round === maxRound)
    .sort((a, b) => a.bracket - b.bracket || a.slot - b.slot);
  let simulated = false;
  for (const m of roundMatches) {
    if (
      m.state === M_PENDING &&
      m.hasP1 &&
      unitIsAllBots(ctx, lobby.id, m.p0Id) &&
      unitIsAllBots(ctx, lobby.id, m.p1Id)
    ) {
      simulateBotMatch(ctx, lobby, m);
      simulated = true;
    }
  }
  if (simulated) {
    advanceTournament(ctx, lobby);
    return;
  }
  let live = roundMatches.filter(m => m.state === M_LIVE).length;

  for (const m of roundMatches) {
    if (live >= lobby.concurrent) break;
    if (m.state === M_PENDING) {
      goLive(ctx, m);
      live++;
    }
  }
  if (roundMatches.some(m => m.state !== M_DONE)) return;

  const winnersOf = (ms: MatchRow[]) => ms.map(m => (m.winnerSide === 0 ? m.p0Id : m.p1Id));
  const losersOf = (ms: MatchRow[]) =>
    ms.filter(m => m.hasP1).map(m => (m.winnerSide === 0 ? m.p1Id : m.p0Id));

  if (lobby.format === FORMAT_DOUBLE) {
    const gf = roundMatches.find(m => m.bracket === BR_FINAL);
    if (gf) {
      crownChampion(ctx, lobby, gf.winnerSide === 0 ? gf.p0Id : gf.p1Id);
      return;
    }
    const wb = roundMatches.filter(m => m.bracket === BR_WINNERS);
    const lb = roundMatches.filter(m => m.bracket === BR_LOSERS);
    const priorRounds = (bracket: number) =>
      matches.filter(m => m.bracket === bracket && m.round < maxRound);
    const lastRoundWinners = (bracket: number): Identity[] => {
      const rows = priorRounds(bracket);
      if (!rows.length) return [];
      const r = Math.max(...rows.map(m => m.round));
      return winnersOf(rows.filter(m => m.round === r).sort((a, b) => a.slot - b.slot));
    };
    const wbWinners = wb.length ? winnersOf(wb) : lastRoundWinners(BR_WINNERS);
    const wbLosers = losersOf(wb);
    const lbWinners = winnersOf(lb);
    const lbPool: Identity[] = [];
    for (let i = 0; i < Math.max(lbWinners.length, wbLosers.length); i++) {
      if (i < lbWinners.length) lbPool.push(lbWinners[i]);
      if (i < wbLosers.length) lbPool.push(wbLosers[i]);
    }
    if (lbPool.length > 1 && lbPool.length % 2 === 1) {
      const byeCount = (id: Identity) =>
        matches.filter(m => !m.hasP1 && sameId(m.p0Id, id)).length;
      let bi = 0;
      for (let i = 1; i < lbPool.length; i++) {
        if (byeCount(lbPool[i]) < byeCount(lbPool[bi])) bi = i;
      }
      lbPool.push(lbPool.splice(bi, 1)[0]);
    }
    if (wbWinners.length === 1 && lbPool.length === 1) {
      createMatch(ctx, lobby, maxRound + 1, 0, wbWinners[0], lbPool[0], BR_FINAL);
    } else {
      if (wbWinners.length > 1) {
        for (let i = 0, slot = 0; i < wbWinners.length; i += 2, slot++) {
          const p1 = i + 1 < wbWinners.length ? wbWinners[i + 1] : null;
          createMatch(ctx, lobby, maxRound + 1, slot, wbWinners[i], p1, BR_WINNERS);
        }
      }
      for (let i = 0, slot = 0; i < lbPool.length; i += 2, slot++) {
        const p1 = i + 1 < lbPool.length ? lbPool[i + 1] : null;
        createMatch(ctx, lobby, maxRound + 1, slot, lbPool[i], p1, BR_LOSERS);
      }
    }
    advanceTournament(ctx, lobby);
    return;
  }

  const winners = winnersOf(roundMatches);
  if (winners.length === 1) {
    crownChampion(ctx, lobby, winners[0]);
    return;
  }
  for (let i = 0, slot = 0; i < winners.length; i += 2, slot++) {
    const p1 = i + 1 < winners.length ? winners[i + 1] : null;
    createMatch(ctx, lobby, maxRound + 1, slot, winners[i], p1);
  }
  advanceTournament(ctx, lobby);
}

// ---------------------------------------------------------------------------
// Rooms (lobbies)
// ---------------------------------------------------------------------------
const physArgs = {
  gravityMul: t.f32(),
  frictionMul: t.f32(),
  powerMul: t.f32(),
  bounceMul: t.f32(),
};
interface PhysArgs {
  gravityMul: number;
  frictionMul: number;
  powerMul: number;
  bounceMul: number;
}
function clampPhys(v: PhysArgs): PhysArgs {
  const safe = (n: number, def: number) => (Number.isFinite(n) && n > 0 ? n : def);
  return {
    gravityMul: clamp(safe(v.gravityMul, 1), PHYS_GRAVITY_RANGE[0], PHYS_GRAVITY_RANGE[1]),
    frictionMul: clamp(safe(v.frictionMul, 1), PHYS_FRICTION_RANGE[0], PHYS_FRICTION_RANGE[1]),
    powerMul: clamp(safe(v.powerMul, 1), PHYS_POWER_RANGE[0], PHYS_POWER_RANGE[1]),
    bounceMul: clamp(safe(v.bounceMul, 1), PHYS_BOUNCE_RANGE[0], PHYS_BOUNCE_RANGE[1]),
  };
}

function insertLobby(
  ctx: Ctx,
  mode: number,
  vsBot: boolean,
  pitch: number,
  concurrent: number,
  botLevel: number,
  phys: PhysArgs,
  isPublic: boolean,
  teamSize = 1
): LobbyRow {
  const p = clampPhys(phys);
  return ctx.db.lobby.insert({
    id: 0n,
    code: generateCode(ctx),
    hostId: ctx.sender,
    mode,
    status: L_OPEN,
    vsBot,
    isPublic,
    format: FORMAT_SINGLE,
    teamSize: clamp(teamSize, 1, MAX_TEAM_SIZE),
    pitch: pitch < PITCHES.length ? pitch : 0,
    concurrent: clamp(concurrent, 1, 4),
    championName: '',
    betWinnerName: '',
    betWinnerCredits: 0,
    createdAt: ctx.timestamp,
    botLevel: clamp(botLevel, 0, BOT_LEVEL_COUNT - 1),
    gravityMul: p.gravityMul,
    frictionMul: p.frictionMul,
    powerMul: p.powerMul,
    bounceMul: p.bounceMul,
  });
}

// Seat an outfield bot in a room (practice opponent / bracket filler).
function insertBot(ctx: Ctx, lobbyId: bigint, index: number, side: number): Identity {
  const identity = botIdentity(lobbyId, index);
  const row = {
    identity,
    name: index === 0 ? BOT_NAME : `${BOT_NAME} ${index + 1}`,
    lobbyId,
    matchId: 0n,
    side,
    eliminated: false,
    x: 0,
    y: sideSign(side) * 20,
    dirX: 0 as number,
    dirY: 0 as number,
    sprinting: false,
    kickTicks: 0,
    kickKind: 0,
    kickHeld: false,
    slideTicks: 0,
    slideDirX: 0,
    slideDirY: 0,
    stamina: STAMINA_MAX,
    role: ROLE_OUTFIELD,
    characterId: BOT_CHAR,
    online: true,
    isBot: true,
    spectator: false,
    teamSlot: 0,
    ctrlSeat: CTRL_NONE,
    switchLock: 0,
    switchIdx: 0,
    // A LOBBY bot: it holds a room/bracket seat and outlives any one match,
    // so endMatchCleanup must not collect it (rematch reuses this row).
    matchBot: false,
    mvX: 0,
    mvY: 0,
    holdTicks: 0,
    velX: 0,
    velY: 0,
    cards: 0,
    sentOff: false,
    diveTicks: 0,
    diveDirX: 0,
    diveDirY: 0,
  };
  if (ctx.db.player.identity.find(identity)) ctx.db.player.identity.update(row);
  else ctx.db.player.insert(row);
  return identity;
}

function destroyLobby(ctx: Ctx, lobby: LobbyRow) {
  disarmReaper(ctx, lobby.id);
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    if (p.isBot) ctx.db.player.identity.delete(p.identity);
    else releaseSpectator(ctx, p);
  }
  deleteBetting(ctx, lobby.id);
  for (const m of lobbyMatches(ctx, lobby.id)) {
    deleteTickTimers(ctx, m.id);
    deleteGraceTimers(ctx, m.id);
    deleteGoalEvents(ctx, m.id);
    if (ctx.db.ball.matchId.find(m.id)) ctx.db.ball.matchId.delete(m.id);
    ctx.db.match.id.delete(m.id);
  }
  for (const msg of ctx.db.chat.byLobby.filter(lobby.id)) {
    ctx.db.chat.id.delete(msg.id);
  }
  deleteTeams(ctx, lobby.id);
  ctx.db.lobby.id.delete(lobby.id);
}

function leaveCurrentLobby(ctx: Ctx, player: PlayerRow) {
  if (player.lobbyId === 0n) return;
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  const myMatchId = player.matchId;

  // Walking out of a live match is a DECISION: forfeit on the spot. Runs
  // BEFORE the seat is cleared, so finishMatch still sees the roster.
  if (lobby && myMatchId !== 0n) {
    const match = ctx.db.match.id.find(myMatchId);
    if (match && match.state === M_LIVE) {
      const winnerSide = 1 - player.side;
      const winnerName = teamName(matchPlayers(ctx, match.id), winnerSide);
      finishMatch(
        ctx, match, winnerSide,
        `${player.name || 'Opponent'} left — ${winnerName} ${winVerb(winnerName, false)}!`,
        END_FORFEIT
      );
    }
  }
  const cleared = ctx.db.player.identity.find(player.identity) ?? player;
  ctx.db.player.identity.update({
    ...cleared,
    lobbyId: 0n,
    matchId: 0n,
    eliminated: false,
    spectator: false,
    dirX: 0, dirY: 0,
    kickTicks: 0,
    kickHeld: false,
    slideTicks: 0,
  });
  if (!lobby) return;

  const remaining = lobbyPlayers(ctx, lobby.id).filter(
    p => !sameId(p.identity, player.identity)
  );
  const remainingPlayers = remaining.filter(p => !p.isBot && !p.spectator);
  if (remainingPlayers.length === 0) {
    destroyLobby(ctx, lobby);
    return;
  }
  const cur = ctx.db.lobby.id.find(lobby.id);
  if (cur && !sameId(cur.hostId, remainingPlayers[0].identity)) {
    ctx.db.lobby.id.update({ ...cur, hostId: remainingPlayers[0].identity });
  }
}

function releaseSpectator(ctx: Ctx, p: PlayerRow) {
  ctx.db.player.identity.update({
    ...p,
    lobbyId: 0n,
    matchId: 0n,
    spectator: false,
    eliminated: false,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle reducers
// ---------------------------------------------------------------------------
export const onConnect = spacetimedb.clientConnected(ctx => {
  const existingBuild = ctx.db.buildInfo.id.find(0n);
  if (!existingBuild) ctx.db.buildInfo.insert({ id: 0n, build: MODULE_BUILD });
  else if (existingBuild.build !== MODULE_BUILD) {
    ctx.db.buildInfo.id.update({ id: 0n, build: MODULE_BUILD });
  }
  const connId = ctx.connectionId;
  if (connId) {
    ctx.db.session.insert({
      connectionId: connId,
      identity: ctx.sender,
      startedAt: ctx.timestamp,
    });
  }
  const account = ensureAccount(ctx);
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (!existing) {
    ctx.db.player.insert({
      identity: ctx.sender,
      name: account.displayName,
      lobbyId: 0n,
      matchId: 0n,
      side: 0,
      eliminated: false,
      x: 0, y: 0,
      dirX: 0, dirY: 0,
      sprinting: false,
      kickTicks: 0,
      kickKind: 0,
      kickHeld: false,
      slideTicks: 0,
      slideDirX: 0,
      slideDirY: 0,
      stamina: STAMINA_MAX,
      role: ROLE_OUTFIELD,
      characterId: account.characterId,
      online: true,
      isBot: false,
      spectator: false,
      teamSlot: 0,
      ctrlSeat: CTRL_NONE,
      switchLock: 0,
      switchIdx: 0,
      matchBot: false,
      mvX: 0,
      mvY: 0,
      holdTicks: 0,
      velX: 0,
      velY: 0,
      cards: 0,
      sentOff: false,
      diveTicks: 0,
      diveDirX: 0,
      diveDirY: 0,
    });
    return;
  }
  ctx.db.player.identity.update({
    ...existing,
    online: true,
    name: existing.name || account.displayName,
  });
  if (existing.lobbyId !== 0n) disarmReaper(ctx, existing.lobbyId);
  if (existing.matchId !== 0n) syncPresence(ctx, existing.matchId);
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const connId = ctx.connectionId;
  if (connId) ctx.db.session.connectionId.delete(connId);
  if (hasSession(ctx, ctx.sender)) return;

  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) return;
  const offline = { ...player, online: false };
  ctx.db.player.identity.update(offline);
  if (player.lobbyId === 0n) return;

  const match = player.matchId === 0n ? null : ctx.db.match.id.find(player.matchId);
  if (match && match.state === M_LIVE) {
    haltMatch(ctx, match, player.name);
    armReaper(ctx, player.lobbyId);
    return;
  }
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  const holdsSeat =
    !!lobby &&
    lobby.mode === MODE_TOURNAMENT &&
    lobby.status === L_RUNNING &&
    !player.spectator &&
    !player.eliminated;
  if (holdsSeat) {
    armReaper(ctx, player.lobbyId);
    return;
  }
  const lobbyId = player.lobbyId;
  leaveCurrentLobby(ctx, offline);
  armReaper(ctx, lobbyId);
});

// ---------------------------------------------------------------------------
// Room reducers
// ---------------------------------------------------------------------------
export const set_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const trimmed = name.trim().slice(0, 16);
  if (!trimmed) throw new SenderError('Name cannot be empty');
  const player = getPlayer(ctx);
  ctx.db.player.identity.update({ ...player, name: trimmed });
  const acc = accountOf(ctx, ctx.sender);
  if (acc) ctx.db.account.identity.update({ ...acc, displayName: trimmed });
});

export const set_character = spacetimedb.reducer(
  { characterId: t.u8() },
  (ctx, { characterId }) => {
    if (characterId >= CHAR_COUNT) throw new SenderError('Unknown character');
    const player = getPlayer(ctx);
    ctx.db.player.identity.update({ ...player, characterId });
    const acc = accountOf(ctx, ctx.sender);
    if (acc) ctx.db.account.identity.update({ ...acc, characterId });
  }
);

export const create_lobby = spacetimedb.reducer(
  { pitch: t.u8(), isPublic: t.bool(), teamSize: t.u8(), ...physArgs },
  (ctx, { pitch, isPublic, teamSize, gravityMul, frictionMul, powerMul, bounceMul }) => {
    const size = clamp(teamSize, 1, MAX_TEAM_SIZE);
    const player = getPlayer(ctx);
    leaveCurrentLobby(ctx, player);
    const lobby = insertLobby(ctx, MODE_QUICK, false, pitch, 1, 1, {
      gravityMul, frictionMul, powerMul, bounceMul,
    }, isPublic, size);
    const fresh = ctx.db.player.identity.find(ctx.sender)!;
    ctx.db.player.identity.update({
      ...fresh, lobbyId: lobby.id, side: 0, teamSlot: 0, x: 0, y: -20,
    });
  }
);

export const create_practice = spacetimedb.reducer(
  { pitch: t.u8(), botLevel: t.u8(), ...physArgs },
  (ctx, { pitch, botLevel, gravityMul, frictionMul, powerMul, bounceMul }) => {
    const player = getPlayer(ctx);
    leaveCurrentLobby(ctx, player);
    const lobby = insertLobby(ctx, MODE_QUICK, true, pitch, 1, botLevel, {
      gravityMul, frictionMul, powerMul, bounceMul,
    }, false);
    const fresh = ctx.db.player.identity.find(ctx.sender)!;
    ctx.db.player.identity.update({ ...fresh, lobbyId: lobby.id });
    const botId = insertBot(ctx, lobby.id, 0, 1);
    ctx.db.lobby.id.update({ ...lobby, status: L_RUNNING });
    const match = createMatch(ctx, lobby, 1, 0, ctx.sender, botId);
    goLive(ctx, match);
  }
);

export const create_tournament = spacetimedb.reducer(
  { pitch: t.u8(), concurrent: t.u8(), isPublic: t.bool(), format: t.u8(), teamSize: t.u8(), ...physArgs },
  (ctx, { pitch, concurrent, isPublic, format, teamSize, gravityMul, frictionMul, powerMul, bounceMul }) => {
    const player = getPlayer(ctx);
    leaveCurrentLobby(ctx, player);
    const lobby = insertLobby(ctx, MODE_TOURNAMENT, false, pitch, concurrent, 1, {
      gravityMul, frictionMul, powerMul, bounceMul,
    }, isPublic, clamp(teamSize, 1, MAX_TEAM_SIZE));
    ctx.db.lobby.id.update({
      ...lobby,
      format: format === FORMAT_DOUBLE ? FORMAT_DOUBLE : FORMAT_SINGLE,
    });
    const fresh = ctx.db.player.identity.find(ctx.sender)!;
    ctx.db.player.identity.update({ ...fresh, lobbyId: lobby.id });
  }
);

export const set_tournament_settings = spacetimedb.reducer(
  { format: t.u8(), concurrent: t.u8(), teamSize: t.u8() },
  (ctx, { format, concurrent, teamSize }) => {
    const player = getPlayer(ctx);
    if (player.lobbyId === 0n) throw new SenderError('Not in a lobby');
    const lobby = ctx.db.lobby.id.find(player.lobbyId);
    if (!lobby || lobby.mode !== MODE_TOURNAMENT) throw new SenderError('Not a tournament lobby');
    if (!sameId(lobby.hostId, ctx.sender)) throw new SenderError('Only the host can change settings');
    if (lobby.status !== L_OPEN) throw new SenderError('Tournament already started');
    ctx.db.lobby.id.update({
      ...lobby,
      format: format === FORMAT_DOUBLE ? FORMAT_DOUBLE : FORMAT_SINGLE,
      concurrent: clamp(concurrent, 1, 4),
      teamSize: clamp(teamSize, 1, MAX_TEAM_SIZE),
    });
  }
);

export const join_lobby = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const player = getPlayer(ctx);
  const lobby = ctx.db.lobby.code.find(code.trim().toUpperCase());
  if (!lobby) throw new SenderError('Lobby not found');
  const members = lobbyPlayers(ctx, lobby.id);
  if (members.some(m => sameId(m.identity, ctx.sender))) return;
  const competitors = members.filter(m => !m.spectator && m.role === ROLE_OUTFIELD && !m.isBot);

  if (lobby.mode === MODE_QUICK) {
    const capacity = lobbyTeamSize(lobby) * 2;
    if (competitors.length >= capacity || lobby.status !== L_OPEN) {
      const live = lobbyMatches(ctx, lobby.id).some(m => m.state === M_LIVE);
      if (!live) throw new SenderError('That match is over');
      joinAsSpectator(ctx, player, lobby);
      return;
    }
    leaveCurrentLobby(ctx, player);
    let side = 0;
    let teamSlot = 0;
    seatScan: for (let sl = 0; sl < lobbyTeamSize(lobby); sl++) {
      for (const s of [0, 1]) {
        if (!competitors.some(m => m.side === s && m.teamSlot === sl)) {
          side = s;
          teamSlot = sl;
          break seatScan;
        }
      }
    }
    const fresh = ctx.db.player.identity.find(ctx.sender)!;
    ctx.db.player.identity.update({
      ...fresh,
      lobbyId: lobby.id,
      spectator: false,
      side,
      teamSlot,
      x: kickoffSpot(side, posOf(teamSlot), side).x,
      y: kickoffSpot(side, posOf(teamSlot), side).y,
    });
    if (competitors.length + 1 < capacity) return;
    ctx.db.lobby.id.update({ ...lobby, status: L_RUNNING });
    const all = lobbyCompetitors(ctx, lobby.id);
    const cap0 = all.find(p => p.side === 0 && p.teamSlot === 0) ?? all[0];
    const cap1 =
      all.find(p => p.side === 1 && p.teamSlot === 0) ??
      all.find(p => !sameId(p.identity, cap0.identity))!;
    registerQuickTeams(ctx, lobby.id, all);
    const match = createMatch(ctx, lobby, 1, 0, cap0.identity, cap1.identity);
    goLive(ctx, match);
    return;
  }

  if (lobby.status !== L_OPEN) {
    joinAsSpectator(ctx, player, lobby);
    return;
  }
  if (competitors.length >= MAX_TOURNAMENT_PLAYERS) {
    throw new SenderError('Tournament is full');
  }
  leaveCurrentLobby(ctx, player);
  const fresh = ctx.db.player.identity.find(ctx.sender)!;
  ctx.db.player.identity.update({
    ...fresh,
    lobbyId: lobby.id,
    spectator: false,
    eliminated: false,
  });
});

function registerQuickTeams(ctx: Ctx, lobbyId: bigint, competitors: PlayerRow[]) {
  const lobby = ctx.db.lobby.id.find(lobbyId);
  if (lobbyTeamSize(lobby) < 2) return;
  deleteTeams(ctx, lobbyId);
  for (const side of [0, 1]) {
    const members = competitors
      .filter(p => p.side === side)
      .sort((a, b) => a.teamSlot - b.teamSlot)
      .map(p => p.identity);
    if (members.length) insertTeam(ctx, lobbyId, members);
  }
}

function joinAsSpectator(ctx: Ctx, player: PlayerRow, lobby: LobbyRow) {
  leaveCurrentLobby(ctx, player);
  const fresh = ctx.db.player.identity.find(ctx.sender)!;
  ctx.db.player.identity.update({
    ...fresh,
    lobbyId: lobby.id,
    matchId: 0n,
    side: 0,
    spectator: true,
    eliminated: true,
  });
  if (lobby.mode === MODE_TOURNAMENT && lobby.status === L_RUNNING) {
    grantWallet(ctx, lobby.id, ctx.sender);
  }
}

export const spectate_match = spacetimedb.reducer(
  { matchId: t.u64() },
  (ctx, { matchId }) => {
    const player = getPlayer(ctx);
    const match = ctx.db.match.id.find(matchId);
    if (!match || match.state !== M_LIVE) throw new SenderError('That match has finished');
    if (
      sameId(match.p0Id, ctx.sender) ||
      sameId(match.p1Id, ctx.sender) ||
      player.matchId === matchId
    ) {
      throw new SenderError("You're playing in that match");
    }
    const lobby = ctx.db.lobby.id.find(match.lobbyId);
    if (!lobby) throw new SenderError('That match has finished');
    if (!lobby.isPublic) throw new SenderError('That match is private — you need the code');
    if (player.lobbyId === lobby.id) return;
    joinAsSpectator(ctx, player, lobby);
  }
);

export const start_tournament = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a lobby');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby || lobby.mode !== MODE_TOURNAMENT) throw new SenderError('Not a tournament lobby');
  if (!sameId(lobby.hostId, ctx.sender)) throw new SenderError('Only the host can start');
  if (lobby.status !== L_OPEN) throw new SenderError('Already started');
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    if (!p.isBot && !p.spectator && !hasSession(ctx, p.identity)) {
      leaveCurrentLobby(ctx, p);
    }
  }
  const entrants = lobbyPlayers(ctx, lobby.id).filter(p => !p.isBot && !p.spectator);
  const teamSize = lobbyTeamSize(lobby);
  if (entrants.length < 2) throw new SenderError('Need at least 2 players');

  const order = entrants.map(p => p.identity);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1)) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  // Every empty seat in the draw is filled by a bot rather than a bye.
  let botCount = 0;
  const addBot = () => insertBot(ctx, lobby.id, botCount++, 1);
  deleteTeams(ctx, lobby.id);
  let units: Identity[];
  if (teamSize > 1) {
    units = [];
    for (let i = 0; i < order.length; i += teamSize) {
      const members = order.slice(i, i + teamSize);
      while (members.length < teamSize) members.push(addBot());
      insertTeam(ctx, lobby.id, members);
      units.push(members[0]);
    }
  } else {
    units = order;
  }
  const size = 1 << Math.ceil(Math.log2(Math.max(2, units.length)));
  while (units.length < size) {
    if (teamSize > 1) {
      const members: Identity[] = [];
      for (let i = 0; i < teamSize; i++) members.push(addBot());
      insertTeam(ctx, lobby.id, members);
      units.push(members[0]);
    } else {
      units.push(addBot());
    }
  }
  ctx.db.lobby.id.update({ ...lobby, status: L_RUNNING });
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    if (!p.isBot) grantWallet(ctx, lobby.id, p.identity);
  }
  for (let slot = 0; slot < size / 2; slot++) {
    const hi = size - 1 - slot;
    createMatch(ctx, { ...lobby, status: L_RUNNING }, 1, slot, units[slot], units[hi]);
  }
  advanceTournament(ctx, { ...lobby, status: L_RUNNING });
});

export const place_bet = spacetimedb.reducer(
  { matchId: t.u64(), side: t.u8(), stake: t.u32() },
  (ctx, { matchId, side, stake }) => {
    const player = getPlayer(ctx);
    if (player.lobbyId === 0n) throw new SenderError('Not in a lobby');
    const lobby = ctx.db.lobby.id.find(player.lobbyId);
    if (!lobby || lobby.mode !== MODE_TOURNAMENT) {
      throw new SenderError('Betting is for tournaments');
    }
    if (lobby.status !== L_RUNNING) throw new SenderError('The tournament is not running');
    if (player.matchId !== 0n) throw new SenderError("You can't bet while you're playing");

    const match = ctx.db.match.id.find(matchId);
    if (!match || match.lobbyId !== lobby.id) throw new SenderError('No such match');
    if (!match.hasP1) throw new SenderError('That match is a bye');
    const book = ctx.db.book.matchId.find(matchId);
    if (!book) throw new SenderError('No betting on that match');
    if (!book.open) throw new SenderError('Betting is closed for this match');

    const inUnit = (captainId: Identity) => {
      if (sameId(captainId, ctx.sender)) return true;
      return teamRowsOf(ctx, lobby.id, captainId).some(r => sameId(r.memberId, ctx.sender));
    };
    if (inUnit(match.p0Id) || inUnit(match.p1Id)) {
      throw new SenderError("You can't bet on your own match");
    }

    if (side > 1) throw new SenderError('Pick a side');
    if (stake < BET_MIN_STAKE) throw new SenderError(`Minimum stake is ${BET_MIN_STAKE}`);
    const wallet = walletOf(ctx, lobby.id, ctx.sender);
    if (!wallet) throw new SenderError('You have no betting credits');
    if (stake > wallet.balance) throw new SenderError('Not enough credits');
    for (const b of ctx.db.bet.byMatch.filter(matchId)) {
      if (sameId(b.bettor, ctx.sender)) {
        throw new SenderError('You already have a bet on this match');
      }
    }

    const oddsMilli = side === 0 ? book.odds0Milli : book.odds1Milli;
    ctx.db.bet.insert({
      id: 0n,
      lobbyId: lobby.id,
      matchId,
      bettor: ctx.sender,
      bettorName: player.name || 'PLAYER',
      side,
      stake,
      oddsMilli,
      state: B_OPEN,
      payout: 0,
      placedAt: ctx.timestamp,
    });
    ctx.db.wallet.id.update({
      ...wallet,
      balance: wallet.balance - stake,
      staked: wallet.staked + stake,
    });
    ctx.db.book.matchId.update(
      recomputeOdds({
        ...book,
        pool0: book.pool0 + (side === 0 ? stake : 0),
        pool1: book.pool1 + (side === 1 ? stake : 0),
      })
    );
  }
);

export const forfeit = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.matchId === 0n) throw new SenderError('Not in a match');
  const match = ctx.db.match.id.find(player.matchId);
  if (!match || match.state !== M_LIVE) throw new SenderError('No live match to forfeit');
  if (player.spectator) throw new SenderError('Watchers have nothing to forfeit');
  const winnerSide = 1 - player.side;
  const winnerName = teamName(matchPlayers(ctx, match.id), winnerSide);
  finishMatch(
    ctx,
    match,
    winnerSide,
    `${player.name || 'PLAYER'} FORFEITS — ${winnerName} ${winVerb(winnerName, false)}!`,
    END_FORFEIT
  );
});

export const claim_win = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.matchId === 0n) throw new SenderError('Not in a match');
  const match = ctx.db.match.id.find(player.matchId);
  if (!match || match.state !== M_LIVE || match.haltMask === 0) {
    throw new SenderError('Nothing to claim');
  }
  if ((match.haltMask & (1 << player.side)) !== 0) {
    throw new SenderError('Your own side is short a player');
  }
  const waited = ctx.timestamp.microsSinceUnixEpoch - match.haltedAt;
  if (waited < CLAIM_UNLOCK) {
    const left = Number((CLAIM_UNLOCK - waited + 999_999n) / 1_000_000n);
    throw new SenderError(`Give them a moment — ${left}s`);
  }
  const winnerName = teamName(matchPlayers(ctx, match.id), player.side);
  finishMatch(
    ctx,
    match,
    player.side,
    `${match.haltName || 'OPPONENT'} DIDN'T COME BACK — ${winnerName} ${winVerb(winnerName, false)}!`,
    END_TIMEOUT
  );
});

export const leave_lobby = spacetimedb.reducer(ctx => {
  leaveCurrentLobby(ctx, getPlayer(ctx));
});

export const rematch = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a lobby');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby || lobby.mode !== MODE_QUICK) throw new SenderError('Rematch is for quick matches');
  const matches = lobbyMatches(ctx, lobby.id);
  const last = matches.sort((a, b) => (a.id < b.id ? -1 : 1)).pop();
  if (!last || last.state !== M_DONE) throw new SenderError('No finished match to restart');
  const teamSize = lobbyTeamSize(lobby);
  const isP0 = sameId(last.p0Id, ctx.sender);
  const isP1 = sameId(last.p1Id, ctx.sender);
  if (!isP0 && !isP1 && (teamSize < 2 || player.spectator)) {
    throw new SenderError('Only the players can restart the match');
  }
  const mySide = isP0 ? 0 : isP1 ? 1 : player.side;
  const votes = last.rematchVotes | (1 << mySide);
  if (lobby.vsBot || votes === 0b11) {
    const all = lobbyCompetitors(ctx, lobby.id);
    if (teamSize >= 2 && all.length < teamSize * 2) {
      throw new SenderError(`Need all ${teamSize * 2} players for a rematch`);
    }
    for (const m of matches) {
      deleteTickTimers(ctx, m.id);
      deleteGoalEvents(ctx, m.id);
      if (ctx.db.ball.matchId.find(m.id)) ctx.db.ball.matchId.delete(m.id);
      ctx.db.match.id.delete(m.id);
    }
    const cap0 =
      teamSize >= 2
        ? (all.find(p => p.side === 0 && p.teamSlot === 0) ?? all[0]).identity
        : last.p0Id;
    const cap1 =
      teamSize >= 2
        ? (all.find(p => p.side === 1 && p.teamSlot === 0) ?? all[1]).identity
        : last.p1Id;
    registerQuickTeams(ctx, lobby.id, all);
    const match = createMatch(ctx, lobby, 1, 0, cap0, cap1);
    goLive(ctx, match);
  } else {
    ctx.db.match.id.update({ ...last, rematchVotes: votes });
  }
});

// ---------------------------------------------------------------------------
// Chat + emotes
// ---------------------------------------------------------------------------
const CHAT_KEEP = 30;
const EMOTES = ['👍', '😂', '🔥', '😭', '⚽', '❤️', '😡', '🤝'];

const CHAT_MIN_GAP = 800_000n;
const EMOTE_MIN_GAP = 400_000n;
const CHAT_WINDOW = 10_000_000n;
const CHAT_WINDOW_MAX = 8;
const CHAT_DUP_GAP = 5_000_000n;

function guardChat(ctx: Ctx, emote: boolean, text: string) {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const norm = emote ? '' : text.toLowerCase();
  const g = ctx.db.chatGuard.identity.find(ctx.sender);
  if (!g) {
    ctx.db.chatGuard.insert({
      identity: ctx.sender,
      windowStart: now,
      windowCount: 1,
      lastAt: now,
      lastText: norm,
    });
    return;
  }
  const gap = now - g.lastAt;
  if (gap < (emote ? EMOTE_MIN_GAP : CHAT_MIN_GAP))
    throw new SenderError('Sending too fast — slow down');
  if (!emote && norm === g.lastText && gap < CHAT_DUP_GAP)
    throw new SenderError('You just said that');
  const inWindow = now - g.windowStart < CHAT_WINDOW;
  if (inWindow && g.windowCount >= CHAT_WINDOW_MAX) {
    const wait = (g.windowStart + CHAT_WINDOW - now + 999_999n) / 1_000_000n;
    throw new SenderError(`Chat rate limit — wait ${wait}s`);
  }
  ctx.db.chatGuard.identity.update({
    ...g,
    windowStart: inWindow ? g.windowStart : now,
    windowCount: inWindow ? g.windowCount + 1 : 1,
    lastAt: now,
    lastText: emote ? g.lastText : norm,
  });
}

function insertChat(ctx: Ctx, player: PlayerRow, emote: boolean, text: string) {
  ctx.db.chat.insert({
    id: 0n,
    lobbyId: player.lobbyId,
    senderSide: player.side,
    senderName: player.name || 'PLAYER',
    emote,
    text,
    sentAt: ctx.timestamp,
  });
  const rows = [...ctx.db.chat.byLobby.filter(player.lobbyId)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  for (let i = 0; i < rows.length - CHAT_KEEP; i++) {
    ctx.db.chat.id.delete(rows[i].id);
  }
}

export const send_chat = spacetimedb.reducer({ text: t.string() }, (ctx, { text }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) return;
  const trimmed = text.trim().slice(0, 120);
  if (!trimmed) return;
  guardChat(ctx, false, trimmed);
  insertChat(ctx, player, false, trimmed);
});

export const send_emote = spacetimedb.reducer({ index: t.u8() }, (ctx, { index }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n || index >= EMOTES.length) return;
  guardChat(ctx, true, '');
  insertChat(ctx, player, true, EMOTES[index]);
});

// ---------------------------------------------------------------------------
// Gameplay reducers
// ---------------------------------------------------------------------------
export const set_input = spacetimedb.reducer(
  { dirX: t.i8(), dirY: t.i8(), sprint: t.bool() },
  (ctx, { dirX, dirY, sprint }) => {
    const me = getPlayer(ctx);
    if (me.matchId === 0n) return;
    const player = controlledBody(ctx, me);
    const dx = clamp(dirX, -1, 1);
    const dy = clamp(dirY, -1, 1);
    // mv mirrors the stick for a human: the movement integrator reads mv, and
    // a body just taken over from the AI would otherwise keep its heading.
    ctx.db.player.identity.update({
      ...player, dirX: dx, dirY: dy, mvX: dx, mvY: dy, sprinting: sprint,
    });
  }
);

// The 30 Hz heartbeat: lifecycle checks here, football in football.ts.
export const game_tick = spacetimedb.reducer(
  { onSchedule: TickTimer },
  { arg: TickTimer.rowType },
  (ctx, { arg }) => {
    const match = ctx.db.match.id.find(arg.matchId);
    if (!match || match.state !== M_LIVE || match.haltMask !== 0) {
      ctx.db.tickTimer.scheduledId.delete(arg.scheduledId);
      return;
    }
    const lobby = ctx.db.lobby.id.find(match.lobbyId);
    tickFootball(ctx, match, lobby, lobbyPhysics(lobby), metaHooks);
  }
);

// What the simulation needs from the meta layer, and nothing more.
const metaHooks: MetaHooks = {
  countdownDone: (ctx, match) => closeBook(ctx, match.id),
  teamName: (players, side) => teamName(players, side),
  winVerb: name => winVerb(name),
  matchWon: (ctx, match, winnerSide, msg) => finishMatch(ctx, match, winnerSide, msg),
};

// The three context buttons, resolved server-side in football.ts.
export const action = spacetimedb.reducer({ button: t.u8() }, (ctx, { button }) => {
  footballAction(ctx, getPlayer(ctx), button);
});

// The SWITCH key: hand my stick to the next team-mate out from the ball.
export const switch_player = spacetimedb.reducer(ctx => {
  const me = getPlayer(ctx);
  if (me.matchId === 0n || me.spectator) return;
  switchPilot(ctx, me);
});
