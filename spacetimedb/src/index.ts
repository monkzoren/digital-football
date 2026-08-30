import { schema, table, t, SenderError, ScheduleAt, type ReducerCtx } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Pitch geometry (world units ~ feet). Halfway line at y=0; side 0 defends
// the goal at y=-PITCH_HALF_LEN and attacks +y, side 1 the mirror image.
// Duplicated in client/src/config.ts — keep the two in sync.
// ---------------------------------------------------------------------------
const PITCH_HALF_LEN = 40;
const PITCH_HALF_WID = 24;
const GOAL_HALF_W = 7; // goal mouth: x in [-7, 7]
const GOAL_HEIGHT = 4.6; // crossbar
const BOX_DEPTH = 11; // penalty area depth from the goal line
const BOX_HALF_W = 13;
const CENTER_CIRCLE_R = 8;
const BALL_RADIUS = 0.55;

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
const GRAVITY = -60;

// ---------------------------------------------------------------------------
// Match format
// ---------------------------------------------------------------------------
const HALF_SECONDS = 180; // two 3-minute halves of game clock
const OT_SECONDS = 120; // golden-goal overtime; at 0 it runs on as sudden death
const HALF_TICKS = HALF_SECONDS * TICK_HZ;
const OT_TICKS = OT_SECONDS * TICK_HZ;

const GOAL_PAUSE = ticks(4.5); // celebration before the kickoff resets
const RESTART_PAUSE = ticks(1.4); // kick-in / corner / goal kick placement
const HALFTIME_PAUSE = ticks(5);
const COUNTDOWN_TICKS = ticks(3); // 3-2-1 before the first kickoff
const RESTART_GRACE = ticks(1.6); // only the awarded side may play the ball

// Restart kinds — what the pending pause resolves into.
const RK_NONE = 0;
const RK_KICKOFF = 1; // after a goal (kickoffSide concedes) and at half starts
const RK_KICKIN = 2; // ball over a sideline
const RK_GOALKICK = 3; // over the goal line off an attacker
const RK_CORNER = 4; // over the goal line off a defender
const RK_HALFTIME = 5;
const RK_OVERTIME = 6;
const RK_DROP = 7; // neutral drop after a reconnect halt

// ---------------------------------------------------------------------------
// Movement, dribbling, kicking
// ---------------------------------------------------------------------------
const PLAYER_SPEED = 24;
const SPRINT_MUL = 1.34;
const DRIBBLE_MUL = 0.88; // running with the ball is a touch slower
const STAMINA_MAX = 1000;
const SPRINT_DRAIN = 7; // per tick while sprinting and moving
const STAMINA_REGEN = 3; // per tick otherwise

const CONTROL_RADIUS = 2.6; // ball inside this sticks to your feet
const CONTROL_KEEP_RADIUS = 3.4; // an owner keeps the ball out to here
const CONTROL_MAX_SPEED = 34; // faster balls can only be trapped, not owned
const CONTROL_MAX_Z = 1.7;
const TRAP_DAMP = 0.3; // a trap kills most of the ball's pace
const TOUCH_AHEAD = 2.0; // dribble touch distance in front of the runner
const CONTEST_CHANCE = 0.05; // per tick, standing challenge inside the radius

// How long a struck ball is out of its kicker's reach (see Ball.lockTicks).
const KICK_LOCK = ticks(0.3);
const KICK_RANGE = 3.0; // release must happen with the ball this close
const KICK_MAX_Z = 2.2; // ...and on (or near) the ground; chips launch it
const KICK_CHARGE_TICKS = ticks(0.8); // full power after this long a hold
// Inside this range of the opponent goal a forward kick becomes a shot on
// target (see executeKick).
const SHOOT_RANGE = 34;
const KICK_MIN_SPEED = 20;
const KICK_MAX_SPEED = 64;
const CHIP_MIN_SPEED = 14;
const CHIP_MAX_SPEED = 40;

// Kick kinds (button pressed)
const KICK_NORMAL = 0; // tap = pass, hold = ripper; shoot by aiming at goal
const KICK_CHIP = 1; // lofted: crosses, chips over the keeper

// Slide tackle: a committed lunge, then a recovery stun.
const SLIDE_TOTAL = ticks(1.0); // full commitment, lunge + stun
const SLIDE_ACTIVE_AFTER = ticks(0.6); // slideTicks above this = still lunging
const SLIDE_SPEED = 38;
const SLIDE_REACH = 2.3; // ball within this during the lunge is won
const SLIDE_COST = 220; // stamina
const SLIDE_KNOCK = 30; // pace the won ball is knocked ahead with

// Characters: per-athlete stats, all multipliers around 1.0. Every edge is
// paid for elsewhere — the pip totals on the client's select screen all match
// (client/src/characters.ts mirrors this table as 1–5 pips, same order).
//   speed     run speed
//   power     kick pace (shots and long balls)
//   stamina   sprint tank drains slower
//   curl      unused in M1 (reserved: bend on crosses)
//   accuracy  aim: shrinks kick scatter
//   tackle    slide reach + control radius
const CHAR_STATS = [
  { speed: 1.0, power: 1.1, stamina: 1.16, curl: 0.9, accuracy: 0.92, tackle: 1.0 }, // BLAZE
  { speed: 0.94, power: 0.96, stamina: 1.0, curl: 1.0, accuracy: 1.08, tackle: 1.16 }, // VOLT
  { speed: 1.12, power: 0.9, stamina: 0.95, curl: 1.05, accuracy: 1.06, tackle: 0.96 }, // KAI
  { speed: 0.96, power: 1.07, stamina: 1.0, curl: 0.95, accuracy: 1.12, tackle: 0.96 }, // ROSA
  { speed: 1.03, power: 1.0, stamina: 1.02, curl: 1.0, accuracy: 1.0, tackle: 1.02 }, // VIPER
  { speed: 0.99, power: 0.93, stamina: 0.95, curl: 1.4, accuracy: 1.02, tackle: 1.0 }, // LUNA
  // -- wacky roster (ROSTER.md) — same pip economy --
  { speed: 0.96, power: 0.95, stamina: 1.0, curl: 1.4, accuracy: 1.0, tackle: 1.0 }, // PEELS
  { speed: 1.12, power: 0.95, stamina: 0.95, curl: 0.95, accuracy: 1.12, tackle: 0.96 }, // BISCUIT
  { speed: 0.96, power: 1.07, stamina: 1.16, curl: 0.9, accuracy: 1.06, tackle: 0.96 }, // SERVO
  { speed: 1.0, power: 0.95, stamina: 0.95, curl: 1.05, accuracy: 1.12, tackle: 0.96 }, // ZORP
  { speed: 1.0, power: 1.07, stamina: 1.08, curl: 1.0, accuracy: 0.96, tackle: 0.96 }, // SMASHULA
  { speed: 0.96, power: 1.1, stamina: 1.0, curl: 1.0, accuracy: 0.96, tackle: 1.0 }, // PLANK
  { speed: 0.94, power: 1.1, stamina: 1.0, curl: 0.95, accuracy: 0.96, tackle: 1.16 }, // YETI
  { speed: 0.94, power: 0.95, stamina: 1.0, curl: 1.05, accuracy: 1.12, tackle: 1.0 }, // GRANNY
  { speed: 1.06, power: 1.0, stamina: 0.95, curl: 1.0, accuracy: 1.0, tackle: 1.0 }, // DISCO
  { speed: 0.96, power: 0.95, stamina: 1.0, curl: 1.0, accuracy: 1.0, tackle: 1.16 }, // INKY
  { speed: 0.94, power: 1.0, stamina: 1.16, curl: 0.95, accuracy: 1.0, tackle: 1.08 }, // PRICKLES
  { speed: 0.96, power: 0.95, stamina: 1.0, curl: 1.4, accuracy: 1.06, tackle: 0.96 }, // MYSTO
];
const CHAR_COUNT = CHAR_STATS.length;
const charStat = (id: number) => CHAR_STATS[id] ?? CHAR_STATS[4];

// Pitch styles: rolling friction (per-second velocity keep) and bounce.
const PITCHES = [
  { friction: 1.1, rest: 0.55 }, // 0 grass day — the standard carpet
  { friction: 1.0, rest: 0.58 }, // 1 grass night — a touch slicker
  { friction: 1.5, rest: 0.66 }, // 2 street — grippy concrete, lively bounce
];

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------
const BOT_NAME = 'ACE BOT';
const BOT_CHAR = 4; // every bot plays VIPER, the all-rounder
const KEEPER_NAME = 'KEEPER';
const KEEPER_CHAR = 4;

const ROLE_OUTFIELD = 0;
const ROLE_KEEPER = 1;

// Keeper tuning: the keeper is always a bot, one per side, spawned with the
// match and deleted with it.
const KEEPER_SPEED = 21;
const KEEPER_LINE = 1.8; // how far off the goal line it holds
const KEEPER_MAX_X = GOAL_HALF_W + 2.5;
const KEEPER_RANGE_Y = BOX_DEPTH; // never strays past the box
// What the keeper can actually get a glove to. Wide enough to make shooting
// straight at them pointless, tight enough that the corners are open — the
// keeper has to be beaten by placement, not out-waited.
const KEEPER_CLEAR_RADIUS = 1.9;
const KEEPER_CLEAR_SPEED = 32;

// Outfield bot difficulty (0 easy · 1 normal · 2 hard):
//   speed        movement multiplier
//   reactErr     lateral error in its chase target (world units)
//   shootErr     extra kick scatter (radians)
//   shootChance  per-tick chance it pulls the trigger in range
//   tackleChance per-tick chance it slides when defending in range
const BOT_LEVELS = [
  { speed: 0.78, reactErr: 5.0, shootErr: 0.22, shootChance: 0.03, tackleChance: 0.01 },
  { speed: 0.9, reactErr: 2.4, shootErr: 0.1, shootChance: 0.06, tackleChance: 0.02 },
  { speed: 1.0, reactErr: 0.8, shootErr: 0.04, shootChance: 0.1, tackleChance: 0.04 },
];
// The keeper reads the same dial. `react` is how much of a shot's flight it
// gets to see before it commits to the save — a keeper that reads the whole
// flight is unbeatable from range, which is not a football game — and `err`
// is how far off the mark it commits.
const KEEPER_LEVELS = [
  { speed: 0.62, reach: 0.75, react: 0.2, err: 3.2 },
  { speed: 0.85, reach: 1.0, react: 0.34, err: 1.7 },
  { speed: 1.05, reach: 1.15, react: 0.5, err: 0.7 },
];

// ---------------------------------------------------------------------------
// Custom-rules physics multiplier bounds (ball weight · friction · kick
// power · bounciness)
// ---------------------------------------------------------------------------
const PHYS_GRAVITY_RANGE = [0.3, 2.5];
const PHYS_FRICTION_RANGE = [0.2, 3.0];
const PHYS_POWER_RANGE = [0.5, 1.8];
const PHYS_BOUNCE_RANGE = [0.4, 1.6];

// Match phases
const PHASE_KICKOFF = 1; // ball dead at the spot, kicking-off side starts play
const PHASE_LIVE = 2;
const PHASE_PAUSE = 3; // goal celebration / restart placement / half-time
const PHASE_OVER = 4;

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
const MAX_TEAM_SIZE = 3; // human seats per side (1v1 / 2v2 / 3v3)

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

const spacetimedb = schema({
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

type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;
type LobbyRow = typeof Lobby.rowType.type;
type MatchRow = typeof Match.rowType.type;
type PlayerRow = typeof Player.rowType.type;
type BallRow = typeof Ball.rowType.type;
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
const keeperIndex = (matchId: bigint, side: number) =>
  1_000_000n + (matchId & 0xffffffffn) * 2n + BigInt(side);

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
function teamName(players: PlayerRow[], side: number): string {
  const names = players
    .filter(p => p.side === side && p.role === ROLE_OUTFIELD)
    .sort((a, b) => a.teamSlot - b.teamSlot)
    .map(p => p.name || 'PLAYER');
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
// Formation lanes by team slot for 1–3 outfielders per side.
function laneX(teamSlot: number, teamSize: number): number {
  if (teamSize <= 1) return 0;
  if (teamSize === 2) return teamSlot === 0 ? -9 : 9;
  return teamSlot === 0 ? 0 : teamSlot === 1 ? -13 : 13;
}

// Reset everyone for a kickoff: outfielders in their own half, the kicking
// side's first player on the spot, keepers on their lines, ball centered.
function setupKickoff(ctx: Ctx, match: MatchRow, msg: string): MatchRow {
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  const teamSize = lobbyTeamSize(lobby);
  const seats = matchPlayers(ctx, match.id);
  for (const p of seats) {
    let x: number;
    let y: number;
    if (p.role === ROLE_KEEPER) {
      x = 0;
      y = sideSign(p.side) * (PITCH_HALF_LEN - KEEPER_LINE);
    } else if (p.side === match.kickoffSide && p.teamSlot === 0) {
      // the kickoff taker stands over the ball
      x = 0;
      y = sideSign(p.side) * 2.5;
    } else {
      x = laneX(p.teamSlot, teamSize);
      y = sideSign(p.side) * (p.side === match.kickoffSide ? 14 : 12);
      // non-kickoff side must respect the center circle
      if (p.side !== match.kickoffSide && Math.hypot(x, y) < CENTER_CIRCLE_R + 1) {
        y = sideSign(p.side) * (CENTER_CIRCLE_R + 2);
      }
    }
    ctx.db.player.identity.update({
      ...p, x, y, dirX: 0, dirY: 0,
      kickTicks: 0, kickHeld: false, slideTicks: 0,
    });
  }
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) {
    ctx.db.ball.matchId.update({
      ...ball, active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      hasOwner: false, ownerId: ZERO_ID,
    });
  }
  const updated = {
    ...match,
    phase: PHASE_KICKOFF,
    restartKind: RK_NONE,
    restartSide: match.kickoffSide,
    graceTicks: 0,
    pauseTicks: 0,
    pointMsg: msg,
  };
  ctx.db.match.id.update(updated);
  return updated;
}

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
    y: sideSign(side) * (PITCH_HALF_LEN - KEEPER_LINE),
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
  insertKeeper(ctx, match.lobbyId, match, 0);
  insertKeeper(ctx, match.lobbyId, match, 1);
  if (!ctx.db.ball.matchId.find(match.id)) {
    ctx.db.ball.insert({
      matchId: match.id,
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
    // keepers exist only for their match
    if (p.isBot && p.role === ROLE_KEEPER) ctx.db.player.identity.delete(p.identity);
    else ctx.db.player.identity.update({ ...p, matchId: 0n, dirX: 0, dirY: 0 });
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
  const competitors = seats.filter(p => !p.spectator && p.role === ROLE_OUTFIELD);
  const humans = competitors.filter(p => !p.isBot);
  if (humans.length !== competitors.length) return false;
  return [0, 1].every(s => humans.some(p => p.side === s));
}

function sideMmr(
  seats: PlayerRow[],
  side: number,
  before: Map<string, AccountRow | undefined>
): number {
  const rows = seats.filter(
    p => p.side === side && !p.spectator && p.role === ROLE_OUTFIELD
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
// Scoring: goals, restarts, the clock
// ---------------------------------------------------------------------------
const clockSecs = (m: MatchRow) => Math.ceil(m.clockTicks / TICK_HZ);

// A goal: crossedEnd is the side whose goal line the ball crossed, so the
// OTHER side scores. Golden goal (half 3) ends the match on the spot.
function awardGoal(ctx: Ctx, match: MatchRow, ball: BallRow, crossedEnd: number) {
  const scoringSide = 1 - crossedEnd;
  const seats = matchPlayers(ctx, match.id);
  const toucher = ctx.db.player.identity.find(ball.lastTouchId);
  const ownGoal = !!toucher && toucher.side === crossedEnd;
  const scorerName = toucher?.name || teamName(seats, scoringSide);
  const p0Goals = match.p0Goals + (scoringSide === 0 ? 1 : 0);
  const p1Goals = match.p1Goals + (scoringSide === 1 ? 1 : 0);

  ctx.db.goalEvent.insert({
    id: 0n,
    matchId: match.id,
    lobbyId: match.lobbyId,
    side: scoringSide,
    scorerName,
    ownGoal,
    half: match.half,
    clockSecs: clockSecs(match),
    at: ctx.timestamp,
  });
  ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });

  const scorerMsg = ownGoal
    ? `OWN GOAL by ${scorerName}!`
    : `GOOOAL! ${scorerName} SCORES!`;
  const scored = { ...match, p0Goals, p1Goals };

  if (match.half >= 3) {
    // golden goal — the match ends the moment it goes in
    const winnerName = teamName(seats, scoringSide);
    finishMatch(
      ctx, scored, scoringSide,
      `GOLDEN GOAL! ${winnerName} ${winVerb(winnerName)} ${p0Goals}–${p1Goals}!`
    );
    return;
  }
  ctx.db.match.id.update({
    ...scored,
    phase: PHASE_PAUSE,
    pauseTicks: GOAL_PAUSE,
    restartKind: RK_KICKOFF,
    kickoffSide: crossedEnd, // conceding side restarts
    pointMsg: scorerMsg,
  });
}

// Ball out of play: figure the restart, park the world for a beat.
function awardRestart(
  ctx: Ctx,
  match: MatchRow,
  ball: BallRow,
  kind: number,
  side: number,
  x: number,
  y: number,
  msg: string
) {
  ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
  ctx.db.match.id.update({
    ...match,
    phase: PHASE_PAUSE,
    pauseTicks: RESTART_PAUSE,
    restartKind: kind,
    restartSide: side,
    restartX: x,
    restartY: y,
    pointMsg: msg,
  });
}

// The half's clock ran out (called from the tick when clockTicks hits 0).
function endOfClock(ctx: Ctx, match: MatchRow) {
  const seats = matchPlayers(ctx, match.id);
  if (match.half === 1) {
    ctx.db.match.id.update({
      ...match,
      phase: PHASE_PAUSE,
      pauseTicks: HALFTIME_PAUSE,
      restartKind: RK_HALFTIME,
      pointMsg: 'HALF-TIME',
    });
    const ball = ctx.db.ball.matchId.find(match.id);
    if (ball) ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
    return;
  }
  if (match.half === 2) {
    if (match.p0Goals !== match.p1Goals) {
      const winnerSide = match.p0Goals > match.p1Goals ? 0 : 1;
      const winnerName = teamName(seats, winnerSide);
      finishMatch(
        ctx, match, winnerSide,
        `FULL TIME — ${winnerName} ${winVerb(winnerName)} ${match.p0Goals}–${match.p1Goals}!`
      );
      return;
    }
    ctx.db.match.id.update({
      ...match,
      phase: PHASE_PAUSE,
      pauseTicks: HALFTIME_PAUSE,
      restartKind: RK_OVERTIME,
      pointMsg: `${match.p0Goals}–${match.p1Goals} AT FULL TIME — GOLDEN GOAL!`,
    });
    const ball = ctx.db.ball.matchId.find(match.id);
    if (ball) ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
    return;
  }
  // Overtime clock expired with no goal: sudden death — play on at 0:00
  // until somebody scores. (Penalty shootouts are deferred past launch.)
  ctx.db.match.id.update({ ...match, pointMsg: 'NEXT GOAL WINS!' });
}

// ---------------------------------------------------------------------------
// Kicking
// ---------------------------------------------------------------------------
// Shared by humans (kick_release) and bots. power01 in [0,1]; aim is a world
// direction (need not be normalized). Scatter shrinks with the accuracy stat
// and grows with movement + power.
function executeKick(
  ctx: Ctx,
  match: MatchRow,
  ball: BallRow,
  kicker: PlayerRow,
  kind: number,
  power01: number,
  aimX: number,
  aimY: number,
  extraErr = 0,
  shootAssist = false
): void {
  const st = charStat(kicker.characterId);
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  const phys = lobbyPhysics(lobby);
  const atk = attackSign(kicker.side);
  let len = Math.hypot(aimX, aimY);
  let dx: number;
  let dy: number;
  if (len < 0.01) {
    dx = 0;
    dy = atk;
  } else {
    dx = aimX / len;
    dy = aimY / len;
  }
  // SHOOTING. A stick is eight directions, a goal is fourteen feet wide, and
  // an arcade game that makes you solve that geometry is not fun. Inside
  // shooting range, a forward kick is a SHOT: the held direction picks which
  // part of the goal you attack (nothing held = down the middle) and the aim
  // is re-solved onto that spot. Outside the range, or kicking backwards, the
  // stick still means exactly what it says and the kick is a pass.
  if (shootAssist && kind !== KICK_CHIP) {
    const goalY = atk * PITCH_HALF_LEN;
    const toGoal = Math.hypot(ball.x, goalY - ball.y);
    if (toGoal < SHOOT_RANGE && dy * atk > -0.1) {
      const spot = clamp(aimX, -1, 1) * (GOAL_HALF_W - 1.4);
      const sx = spot - ball.x;
      const sy = goalY - ball.y;
      const sl = Math.hypot(sx, sy) || 1;
      dx = sx / sl;
      dy = sy / sl;
    }
  }
  const moving = kicker.dirX !== 0 || kicker.dirY !== 0;
  const scatter =
    (0.025 + power01 * 0.05 + (moving ? 0.03 : 0) + extraErr) / st.accuracy;
  const ang = Math.atan2(dy, dx) + (ctx.random() - 0.5) * 2 * scatter;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  let speed: number;
  let vz: number;
  if (kind === KICK_CHIP) {
    speed = (CHIP_MIN_SPEED + power01 * (CHIP_MAX_SPEED - CHIP_MIN_SPEED)) * st.power;
    vz = 14 + power01 * 12;
  } else {
    speed = (KICK_MIN_SPEED + power01 * (KICK_MAX_SPEED - KICK_MIN_SPEED)) * st.power;
    vz = 1.5 + power01 * 7;
  }
  speed *= phys.power;
  ctx.db.ball.matchId.update({
    ...ball,
    active: true,
    z: Math.max(ball.z, 0),
    vx: cos * speed,
    vy: sin * speed,
    vz,
    lastTouchSide: kicker.side,
    lastTouchId: kicker.identity,
    hasOwner: false,
    ownerId: ZERO_ID,
    lockTicks: KICK_LOCK,
  });
}

// A touch by the protected side ends restart protection.
function clearGraceOnTouch(ctx: Ctx, match: MatchRow, side: number): MatchRow {
  if (match.graceTicks > 0 && side === match.restartSide) {
    const updated = { ...match, graceTicks: 0 };
    ctx.db.match.id.update(updated);
    return updated;
  }
  return match;
}

// May this player play the ball right now? (restart protection)
function mayTouch(match: MatchRow, side: number): boolean {
  return match.graceTicks === 0 || side === match.restartSide;
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
    botLevel: clamp(botLevel, 0, BOT_LEVELS.length - 1),
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
      x: laneX(teamSlot, lobbyTeamSize(lobby)),
      y: sideSign(side) * 20,
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
    const player = getPlayer(ctx);
    if (player.matchId === 0n) return;
    const dx = clamp(dirX, -1, 1);
    const dy = clamp(dirY, -1, 1);
    ctx.db.player.identity.update({ ...player, dirX: dx, dirY: dy, sprinting: sprint });
  }
);

// Press: start charging a kick. Power comes from how long the button is held
// (kickTicks counts up in the tick); the kick itself fires on kick_release.
export const kick = spacetimedb.reducer({ kind: t.u8() }, (ctx, { kind }) => {
  const player = getPlayer(ctx);
  if (player.matchId === 0n || player.spectator) return;
  if (player.slideTicks > 0) return; // committed to the slide
  const match = ctx.db.match.id.find(player.matchId);
  if (!match || match.state !== M_LIVE) return;
  if (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF) return;
  ctx.db.player.identity.update({
    ...player,
    kickHeld: true,
    kickTicks: 0,
    kickKind: kind === KICK_CHIP ? KICK_CHIP : KICK_NORMAL,
  });
});

// Release: if the ball is at your feet, it flies — held direction aims it,
// charge time powers it. A kickoff/restart first touch also goes through
// here.
export const kick_release = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.matchId === 0n || !player.kickHeld) return;
  const released = { ...player, kickHeld: false, kickTicks: 0 };
  const match = ctx.db.match.id.find(player.matchId);
  if (!match || match.state !== M_LIVE) {
    ctx.db.player.identity.update(released);
    return;
  }
  const ball = ctx.db.ball.matchId.find(match.id);
  if (!ball) {
    ctx.db.player.identity.update(released);
    return;
  }

  // Kickoff: any player of the kicking-off side standing at the spot may
  // strike the dead ball to start play.
  if (match.phase === PHASE_KICKOFF) {
    if (match.startTicks > 0 || player.side !== match.kickoffSide) {
      ctx.db.player.identity.update(released);
      return;
    }
    const dist = Math.hypot(ball.x - player.x, ball.y - player.y);
    if (dist > KICK_RANGE + 1.5) {
      ctx.db.player.identity.update(released);
      return;
    }
    const power01 = clamp(player.kickTicks / KICK_CHARGE_TICKS, 0.15, 1);
    executeKick(
      ctx, match, ball, player, player.kickKind, power01,
      player.dirX, player.dirY
    );
    ctx.db.match.id.update({
      ...match,
      phase: PHASE_LIVE,
      graceTicks: 0,
      pointMsg: '',
    });
    ctx.db.player.identity.update(released);
    return;
  }

  if (match.phase !== PHASE_LIVE) {
    ctx.db.player.identity.update(released);
    return;
  }
  if (!mayTouch(match, player.side)) {
    ctx.db.player.identity.update(released);
    return;
  }
  const dist = Math.hypot(ball.x - player.x, ball.y - player.y);
  if (!ball.active || dist > KICK_RANGE || ball.z > KICK_MAX_Z) {
    ctx.db.player.identity.update(released);
    return;
  }
  const power01 = clamp(player.kickTicks / KICK_CHARGE_TICKS, 0.12, 1);
  executeKick(
    ctx, match, ball, player, player.kickKind, power01,
    player.dirX, player.dirY, 0, true
  );
  clearGraceOnTouch(ctx, match, player.side);
  ctx.db.player.identity.update(released);
});

// Slide tackle: a committed lunge along your held direction, then a stun.
export const tackle = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.matchId === 0n || player.spectator) return;
  if (player.slideTicks > 0) return;
  if (player.stamina < SLIDE_COST) return;
  const match = ctx.db.match.id.find(player.matchId);
  if (!match || match.state !== M_LIVE || match.phase !== PHASE_LIVE) return;
  let dx = player.dirX;
  let dy = player.dirY;
  if (dx === 0 && dy === 0) {
    dy = attackSign(player.side);
    dx = 0;
  }
  const len = Math.hypot(dx, dy) || 1;
  ctx.db.player.identity.update({
    ...player,
    slideTicks: SLIDE_TOTAL,
    slideDirX: dx / len,
    slideDirY: dy / len,
    stamina: Math.max(0, player.stamina - SLIDE_COST),
    kickHeld: false,
    kickTicks: 0,
  });
});

// ---------------------------------------------------------------------------
// Bot brains
// ---------------------------------------------------------------------------
// Steer an outfield bot: chase / carry / support by whether its team has the
// ball. Writes dirX/dirY (like a human stick) and may kick via executeKick.
function botPlay(
  ctx: Ctx,
  match: MatchRow,
  lobby: LobbyRow | null | undefined,
  bot: PlayerRow,
  ball: BallRow,
  teammates: PlayerRow[],
  seed: number
): void {
  const lvl = BOT_LEVELS[clamp(lobby?.botLevel ?? 1, 0, BOT_LEVELS.length - 1)];
  const atk = attackSign(bot.side);
  const goalY = atk * PITCH_HALF_LEN;
  const iOwn = ball.hasOwner && sameId(ball.ownerId, bot.identity);
  const noise = (k: number) => (hash01(seed * 7.31 + k) - 0.5) * 2;

  let tx: number;
  let ty: number;
  if (iOwn) {
    // Carry toward goal, drifting off the sideline.
    tx = clamp(ball.x * 0.6, -PITCH_HALF_WID + 4, PITCH_HALF_WID - 4);
    ty = goalY;
    const distGoal = Math.hypot(ball.x, goalY - ball.y);
    const roll = hash01(seed * 3.7 + match.clockTicks * 0.13);
    if (distGoal < 30 && roll < lvl.shootChance) {
      // shoot: pick a corner
      const corner = (hash01(seed * 9.1 + match.clockTicks) < 0.5 ? -1 : 1) * (GOAL_HALF_W - 1.6);
      executeKick(
        ctx, match, ball, bot, KICK_NORMAL, 0.75 + roll * 2,
        corner - ball.x, goalY - ball.y, lvl.shootErr
      );
      return;
    }
    // pressured? pass to the most open teammate ahead
    const nearestOpp = Math.min(
      ...matchPlayers(ctx, match.id)
        .filter(o => o.side !== bot.side && o.role === ROLE_OUTFIELD)
        .map(o => Math.hypot(o.x - bot.x, o.y - bot.y)),
      99
    );
    if (nearestOpp < 5 && teammates.length > 0 && roll < 0.35) {
      const mate = teammates[Math.floor(hash01(seed * 5.3) * teammates.length) % teammates.length];
      const lead = 4 * atk;
      executeKick(
        ctx, match, ball, bot, KICK_NORMAL,
        clamp(Math.hypot(mate.x - bot.x, mate.y - bot.y) / 40, 0.25, 0.8),
        mate.x - ball.x, mate.y + lead - ball.y, lvl.shootErr * 0.7
      );
      return;
    }
  } else {
    const mineIsNearest = !teammates.some(
      m =>
        Math.hypot(m.x - ball.x, m.y - ball.y) <
        Math.hypot(bot.x - ball.x, bot.y - ball.y) - 0.5
    );
    if (mineIsNearest) {
      // chase a short prediction of the ball
      tx = ball.x + ball.vx * 0.25 + noise(1) * lvl.reactErr;
      ty = ball.y + ball.vy * 0.25 + noise(2) * lvl.reactErr;
      // defending slide: ball owned by an opponent right next to us
      const oppOwns = ball.hasOwner && !sameId(ball.ownerId, bot.identity);
      const dist = Math.hypot(ball.x - bot.x, ball.y - bot.y);
      if (
        oppOwns && dist < 5 && bot.slideTicks === 0 &&
        bot.stamina >= SLIDE_COST &&
        hash01(seed * 11.7 + match.clockTicks * 0.31) < lvl.tackleChance
      ) {
        const len = dist || 1;
        ctx.db.player.identity.update({
          ...bot,
          slideTicks: SLIDE_TOTAL,
          slideDirX: (ball.x - bot.x) / len,
          slideDirY: (ball.y - bot.y) / len,
          stamina: Math.max(0, bot.stamina - SLIDE_COST),
        });
        return;
      }
    } else {
      // hold shape: my lane, goal side of the ball when defending
      const teamSize = Math.max(1, teammates.length + 1);
      tx = laneX(bot.teamSlot, teamSize) + noise(3) * 2;
      const ballOurs = ball.hasOwner
        ? (ctx.db.player.identity.find(ball.ownerId)?.side ?? bot.side) === bot.side
        : ball.lastTouchSide === bot.side;
      ty = ballOurs
        ? clamp(ball.y + atk * 10, -PITCH_HALF_LEN + 6, PITCH_HALF_LEN - 6)
        : clamp(ball.y - atk * 8, -PITCH_HALF_LEN + 6, PITCH_HALF_LEN - 6);
    }
  }
  if (iOwn) {
    // recompute target for the carry case (falls through when no kick fired)
    tx = clamp(ball.x * 0.6, -PITCH_HALF_WID + 4, PITCH_HALF_WID - 4);
    ty = goalY;
  }
  const dx = tx! - bot.x;
  const dy = ty! - bot.y;
  const fresh = ctx.db.player.identity.find(bot.identity);
  if (!fresh) return;
  ctx.db.player.identity.update({
    ...fresh,
    dirX: Math.abs(dx) > 1 ? Math.sign(dx) : 0,
    dirY: Math.abs(dy) > 1 ? Math.sign(dy) : 0,
    sprinting: Math.hypot(dx, dy) > 14 && fresh.stamina > 250,
  });
}

// The keeper: hold the line between ball and goal, punt anything that comes
// close. Always a bot.
function keeperPlay(
  ctx: Ctx,
  match: MatchRow,
  lobby: LobbyRow | null | undefined,
  keeper: PlayerRow,
  ball: BallRow
): void {
  const lvl = KEEPER_LEVELS[clamp(lobby?.botLevel ?? 1, 0, KEEPER_LEVELS.length - 1)];
  const gs = sideSign(keeper.side); // sign of my goal line
  const lineY = gs * (PITCH_HALF_LEN - KEEPER_LINE);

  // Clear anything playable in reach — one-touch, upfield, toward a flank.
  const dist = Math.hypot(ball.x - keeper.x, ball.y - keeper.y);
  if (
    ball.active && dist < KEEPER_CLEAR_RADIUS * lvl.reach && ball.z < 5 &&
    mayTouch(match, keeper.side)
  ) {
    const flank = ball.x >= 0 ? 1 : -1;
    const st = charStat(keeper.characterId);
    ctx.db.ball.matchId.update({
      ...ball,
      active: true,
      vx: flank * 14 + (ctx.random() - 0.5) * 6,
      vy: -gs * KEEPER_CLEAR_SPEED * st.power,
      vz: 13,
      z: Math.max(ball.z, 0.5),
      lastTouchSide: keeper.side,
      lastTouchId: keeper.identity,
      hasOwner: false,
      ownerId: ZERO_ID,
      lockTicks: KICK_LOCK,
    });
    clearGraceOnTouch(ctx, match, keeper.side);
    return;
  }

  // Position: hold the ball-to-goal line until a shot is actually on its way,
  // then commit to where it will cross — late, and not quite exactly.
  let targetX = clamp(ball.x * 0.55, -KEEPER_MAX_X, KEEPER_MAX_X);
  const tToLine =
    ball.active && Math.abs(ball.vy) > 0.01 ? (lineY - ball.y) / ball.vy : -1;
  const incoming = ball.active && ball.vy * gs > 8 && tToLine > 0 && tToLine < lvl.react;
  if (incoming) {
    // one error roll per shot: seeded off the struck velocity, so the keeper
    // commits to a single (slightly wrong) spot instead of re-aiming each tick
    const err = (hash01(Math.round(ball.vx) * 3.7 + Math.round(ball.vy) * 1.9) - 0.5) * 2 * lvl.err;
    targetX = clamp(ball.x + ball.vx * tToLine + err, -KEEPER_MAX_X, KEEPER_MAX_X);
  }
  let targetY = lineY;
  // step out a little when the ball is loose in the box
  if (
    !ball.hasOwner && Math.abs(ball.x) < BOX_HALF_W &&
    Math.abs(ball.y - gs * PITCH_HALF_LEN) < KEEPER_RANGE_Y
  ) {
    targetY = gs * (PITCH_HALF_LEN - Math.min(KEEPER_RANGE_Y - 1, Math.abs(gs * PITCH_HALF_LEN - ball.y) * 0.5 + KEEPER_LINE));
  }
  const speed = KEEPER_SPEED * lvl.speed * (incoming ? 1.7 : 1);
  const dx = targetX - keeper.x;
  const dy = targetY - keeper.y;
  const len = Math.hypot(dx, dy);
  const step = Math.min(len, speed * DT);
  const nx = len > 0.01 ? keeper.x + (dx / len) * step : keeper.x;
  const ny = len > 0.01 ? keeper.y + (dy / len) * step : keeper.y;
  ctx.db.player.identity.update({
    ...keeper,
    x: clamp(nx, -KEEPER_MAX_X, KEEPER_MAX_X),
    y: gs > 0
      ? clamp(ny, PITCH_HALF_LEN - KEEPER_RANGE_Y, PITCH_HALF_LEN - 0.5)
      : clamp(ny, -(PITCH_HALF_LEN - 0.5), -(PITCH_HALF_LEN - KEEPER_RANGE_Y)),
    // expose intent so the client can lean/dive the model
    dirX: Math.abs(dx) > 0.7 ? Math.sign(dx) : 0,
    dirY: Math.abs(dy) > 0.7 ? Math.sign(dy) : 0,
  });
}

// Is the ball out of play — and if so, what happens next? Returns true when
// it resolved the situation (goal, restart, or a bounce off the frame), in
// which case the tick is over. Judged on where the ball IS, not only on the
// tick it crosses: a dribbler can walk it over a line, and that is a restart
// exactly like a shot that misses.
function resolveOutOfPlay(
  ctx: Ctx,
  match: MatchRow,
  ball: BallRow,
  prev: { x: number; y: number; z: number },
  players: PlayerRow[]
): boolean {
  if (Math.abs(ball.y) > PITCH_HALF_LEN) {
    const crossedEnd = ball.y < 0 ? 0 : 1;
    // interpolate the crossing when the ball was inside a tick ago (a shot);
    // otherwise judge it where it stands (a carried ball)
    const wasIn = Math.abs(prev.y) <= PITCH_HALF_LEN;
    const f = wasIn
      ? clamp(
          Math.abs((sideSign(crossedEnd) * PITCH_HALF_LEN - prev.y) / (ball.y - prev.y || 1)),
          0, 1
        )
      : 1;
    const xAt = wasIn ? prev.x + (ball.x - prev.x) * f : ball.x;
    const zAt = wasIn ? prev.z + (ball.z - prev.z) * f : ball.z;
    if (Math.abs(xAt) < GOAL_HALF_W - BALL_RADIUS * 0.5 && zAt < GOAL_HEIGHT) {
      awardGoal(ctx, match, ball, crossedEnd);
      return true;
    }
    // the frame: anything that clips a post or the bar comes back off it
    if (wasIn && Math.abs(xAt) < GOAL_HALF_W + 0.8 && zAt < GOAL_HEIGHT + 0.8) {
      ctx.db.ball.matchId.update({
        ...ball,
        y: sideSign(crossedEnd) * (PITCH_HALF_LEN - 0.2),
        vy: -ball.vy * 0.4,
        vx: ball.vx * 0.6,
        hasOwner: false,
        ownerId: ZERO_ID,
      });
      return true;
    }
    // over the goal line: a corner if a defender put it out, else a goal kick
    const attacker = 1 - crossedEnd;
    if (ball.lastTouchSide === crossedEnd) {
      awardRestart(
        ctx, match, ball, RK_CORNER, attacker,
        (xAt >= 0 ? 1 : -1) * (PITCH_HALF_WID - 1),
        sideSign(crossedEnd) * (PITCH_HALF_LEN - 1),
        `CORNER — ${teamName(players, attacker)}`
      );
    } else {
      awardRestart(
        ctx, match, ball, RK_GOALKICK, crossedEnd,
        (xAt >= 0 ? 1 : -1) * 6,
        sideSign(crossedEnd) * (PITCH_HALF_LEN - 6),
        'GOAL KICK'
      );
    }
    return true;
  }
  if (Math.abs(ball.x) > PITCH_HALF_WID) {
    const side = 1 - ball.lastTouchSide;
    awardRestart(
      ctx, match, ball, RK_KICKIN, side,
      (ball.x >= 0 ? 1 : -1) * (PITCH_HALF_WID - 0.5),
      clamp(ball.y, -PITCH_HALF_LEN + 2, PITCH_HALF_LEN - 2),
      `KICK-IN — ${teamName(players, side)}`
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Simulation tick (30 Hz per live match)
// ---------------------------------------------------------------------------
export const game_tick = spacetimedb.reducer(
  { onSchedule: TickTimer },
  { arg: TickTimer.rowType },
  (ctx, { arg }) => {
    let match = ctx.db.match.id.find(arg.matchId);
    if (!match || match.state !== M_LIVE) {
      ctx.db.tickTimer.scheduledId.delete(arg.scheduledId);
      return;
    }
    if (match.haltMask !== 0) {
      ctx.db.tickTimer.scheduledId.delete(arg.scheduledId);
      return;
    }
    const lobby = ctx.db.lobby.id.find(match.lobbyId);
    const phys = lobbyPhysics(lobby);

    // Match-start countdown: the world holds still until the 3-2-1 elapses.
    if (match.startTicks > 0) {
      const left = match.startTicks - 1;
      ctx.db.match.id.update({ ...match, startTicks: left });
      if (left === 0) closeBook(ctx, match.id);
      return;
    }

    // PAUSE: celebration / restart placement / half-time. When it elapses,
    // resolve the pending restart.
    if (match.phase === PHASE_PAUSE) {
      const remaining = match.pauseTicks - 1;
      if (remaining > 0) {
        ctx.db.match.id.update({ ...match, pauseTicks: remaining });
        return;
      }
      switch (match.restartKind) {
        case RK_KICKOFF:
          setupKickoff(ctx, match, 'KICKOFF');
          return;
        case RK_HALFTIME: {
          const next = setupKickoff(
            ctx,
            { ...match, half: 2, clockTicks: HALF_TICKS, kickoffSide: 1 },
            'SECOND HALF'
          );
          ctx.db.match.id.update(next);
          return;
        }
        case RK_OVERTIME: {
          const next = setupKickoff(
            ctx,
            { ...match, half: 3, clockTicks: OT_TICKS, kickoffSide: hash01(Number(match.id)) < 0.5 ? 0 : 1 },
            'GOLDEN GOAL — NEXT GOAL WINS'
          );
          ctx.db.match.id.update(next);
          return;
        }
        case RK_KICKIN:
        case RK_GOALKICK:
        case RK_CORNER:
        case RK_DROP: {
          const ball = ctx.db.ball.matchId.find(match.id);
          if (ball) {
            ctx.db.ball.matchId.update({
              ...ball,
              active: true,
              x: match.restartX,
              y: match.restartY,
              z: 0,
              vx: 0, vy: 0, vz: 0,
              hasOwner: false,
              ownerId: ZERO_ID,
              lastTouchSide: match.restartSide,
              lockTicks: 0,
            });
          }
          ctx.db.match.id.update({
            ...match,
            phase: PHASE_LIVE,
            pauseTicks: 0,
            graceTicks: match.restartKind === RK_DROP ? 0 : RESTART_GRACE,
            pointMsg: '',
          });
          return;
        }
        default:
          // nothing pending — resume play
          ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, pauseTicks: 0 });
          return;
      }
    }

    if (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF) return;

    let ball = ctx.db.ball.matchId.find(match.id);
    const players = matchPlayers(ctx, match.id);

    // ---- Movement (humans by stick, outfield bots by brain, keepers) ----
    for (const p of players) {
      if (p.spectator) continue;
      if (p.role === ROLE_KEEPER) continue; // keeperPlay moves them below
      let cur = ctx.db.player.identity.find(p.identity);
      if (!cur) continue;

      // Slide: a committed lunge, then a stun on the ground.
      if (cur.slideTicks > 0) {
        const t2 = cur.slideTicks - 1;
        if (cur.slideTicks > SLIDE_ACTIVE_AFTER) {
          const nx = clamp(cur.x + cur.slideDirX * SLIDE_SPEED * DT, -P_BOUNDS_X, P_BOUNDS_X);
          const ny = clamp(cur.y + cur.slideDirY * SLIDE_SPEED * DT, -P_BOUNDS_Y, P_BOUNDS_Y);
          ctx.db.player.identity.update({ ...cur, x: nx, y: ny, slideTicks: t2 });
          // ball win: knock it ahead along the slide
          if (
            ball && ball.active && match.phase === PHASE_LIVE &&
            mayTouch(match, cur.side) && ball.z < CONTROL_MAX_Z
          ) {
            const st = charStat(cur.characterId);
            const reach = SLIDE_REACH * st.tackle;
            if (Math.hypot(ball.x - nx, ball.y - ny) < reach) {
              ctx.db.ball.matchId.update({
                ...ball,
                vx: cur.slideDirX * SLIDE_KNOCK,
                vy: cur.slideDirY * SLIDE_KNOCK,
                vz: 3,
                lastTouchSide: cur.side,
                lastTouchId: cur.identity,
                hasOwner: false,
                ownerId: ZERO_ID,
                lockTicks: KICK_LOCK,
              });
              match = clearGraceOnTouch(ctx, match, cur.side);
              ball = ctx.db.ball.matchId.find(match.id);
            }
          }
        } else {
          ctx.db.player.identity.update({ ...cur, slideTicks: t2 });
        }
        continue;
      }

      // Outfield bot brain writes its stick (and may kick).
      if (cur.isBot && match.phase === PHASE_LIVE && ball) {
        const mates = players.filter(
          m =>
            m.side === cur!.side &&
            m.role === ROLE_OUTFIELD &&
            !m.spectator &&
            !sameId(m.identity, cur!.identity)
        );
        botPlay(
          ctx, match, lobby, cur, ball, mates,
          Number(match.id % 100000n) + cur.side * 31 + cur.teamSlot * 17
        );
        ball = ctx.db.ball.matchId.find(match.id);
        match = ctx.db.match.id.find(match.id)!;
        if (match.state !== M_LIVE || (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF)) return;
        cur = ctx.db.player.identity.find(p.identity);
        if (!cur || cur.slideTicks > 0) continue;
      } else if (cur.isBot && match.phase === PHASE_KICKOFF && ball) {
        // bot kickoff: walk to the spot and poke it to a teammate
        if (cur.side === match.kickoffSide && cur.teamSlot === 0 && match.startTicks === 0) {
          const d = Math.hypot(ball.x - cur.x, ball.y - cur.y);
          if (d < KICK_RANGE) {
            executeKick(ctx, match, ball, cur, KICK_NORMAL, 0.3, (hash01(Number(match.id)) - 0.5), sideSign(cur.side) * 0.8);
            ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, graceTicks: 0, pointMsg: '' });
            match = ctx.db.match.id.find(match.id)!;
            ball = ctx.db.ball.matchId.find(match.id);
            continue;
          }
          const len = d || 1;
          ctx.db.player.identity.update({
            ...cur,
            dirX: Math.abs(ball.x - cur.x) > 0.5 ? Math.sign(ball.x - cur.x) : 0,
            dirY: Math.abs(ball.y - cur.y) > 0.5 ? Math.sign(ball.y - cur.y) : 0,
          });
          cur = ctx.db.player.identity.find(p.identity)!;
        } else {
          ctx.db.player.identity.update({ ...cur, dirX: 0, dirY: 0 });
          continue;
        }
      }

      // Charge the held kick.
      let kickTicks = cur.kickTicks;
      if (cur.kickHeld && kickTicks < 255) kickTicks = Math.min(255, kickTicks + 1);

      // Stamina + speed.
      const moving = cur.dirX !== 0 || cur.dirY !== 0;
      const st = charStat(cur.characterId);
      const wantSprint = cur.sprinting && moving && cur.stamina > 0;
      const drain = wantSprint ? Math.round(SPRINT_DRAIN / st.stamina) : 0;
      const stamina = clamp(
        cur.stamina - drain + (wantSprint ? 0 : STAMINA_REGEN),
        0,
        STAMINA_MAX
      );
      if (!moving) {
        if (stamina !== cur.stamina || kickTicks !== cur.kickTicks) {
          ctx.db.player.identity.update({ ...cur, stamina, kickTicks });
        }
        continue;
      }
      const owns = !!ball && ball.hasOwner && sameId(ball.ownerId, cur.identity);
      let speed = PLAYER_SPEED * st.speed;
      if (wantSprint) speed *= SPRINT_MUL;
      if (owns) speed *= DRIBBLE_MUL;
      const len = Math.hypot(cur.dirX, cur.dirY) || 1;
      let x = clamp(cur.x + (cur.dirX / len) * speed * DT, -P_BOUNDS_X, P_BOUNDS_X);
      let y = clamp(cur.y + (cur.dirY / len) * speed * DT, -P_BOUNDS_Y, P_BOUNDS_Y);
      // Kickoff discipline: stay in your half; non-kickoff side out of the circle.
      if (match.phase === PHASE_KICKOFF) {
        y = sideSign(cur.side) > 0 ? Math.max(y, 0.5) : Math.min(y, -0.5);
        if (cur.side !== match.kickoffSide && Math.hypot(x, y) < CENTER_CIRCLE_R) {
          const norm = Math.hypot(x, y) || 1;
          x = (x / norm) * CENTER_CIRCLE_R;
          y = (y / norm) * CENTER_CIRCLE_R;
          y = sideSign(cur.side) > 0 ? Math.max(y, 0.5) : Math.min(y, -0.5);
        }
      }
      ctx.db.player.identity.update({ ...cur, x, y, stamina, kickTicks });
    }

    // Keepers.
    ball = ctx.db.ball.matchId.find(match.id);
    if (ball && match.phase === PHASE_LIVE) {
      for (const p of players) {
        if (p.role !== ROLE_KEEPER) continue;
        const cur = ctx.db.player.identity.find(p.identity);
        if (cur) keeperPlay(ctx, match, lobby, cur, ctx.db.ball.matchId.find(match.id)!);
      }
      match = ctx.db.match.id.find(match.id)!;
      if (match.state !== M_LIVE) return;
    }

    if (match.phase !== PHASE_LIVE) return;

    // ---- The clock runs only during live play ----
    if (match.clockTicks > 0) {
      const left = match.clockTicks - 1;
      match = { ...match, clockTicks: left };
      ctx.db.match.id.update(match);
      if (left === 0) {
        endOfClock(ctx, match);
        return;
      }
    }
    if (match.graceTicks > 0) {
      match = { ...match, graceTicks: match.graceTicks - 1 };
      ctx.db.match.id.update(match);
    }

    ball = ctx.db.ball.matchId.find(match.id);
    if (!ball || !ball.active) return;

    // ---- Ball physics ----
    const prevX = ball.x;
    const prevY = ball.y;
    const prevZ = ball.z;
    if (ball.z > 0.01 || ball.vz > 0.01) {
      // airborne
      ball = {
        ...ball,
        x: ball.x + ball.vx * DT,
        y: ball.y + ball.vy * DT,
        z: ball.z + ball.vz * DT + 0.5 * phys.gravity * DT * DT,
        vz: ball.vz + phys.gravity * DT,
      };
      if (ball.z <= 0 && ball.vz < 0) {
        // bounce
        const vz = -ball.vz * phys.bounce;
        ball = {
          ...ball,
          z: 0,
          vz: vz < 2.5 ? 0 : vz,
          vx: ball.vx * 0.9,
          vy: ball.vy * 0.9,
        };
      }
    } else {
      // rolling
      const keep = Math.exp(-phys.friction * DT);
      let vx = ball.vx * keep;
      let vy = ball.vy * keep;
      if (Math.hypot(vx, vy) < 0.6) {
        vx = 0;
        vy = 0;
      }
      ball = {
        ...ball,
        x: ball.x + vx * DT,
        y: ball.y + vy * DT,
        z: 0,
        vx,
        vy,
        vz: 0,
      };
    }

    // hard safety: never let the ball escape the world (the out-of-play
    // resolution below runs after possession, so a dribbler carrying it over
    // a line is judged the same as a shot crossing it)
    ball = {
      ...ball,
      x: clamp(ball.x, -PITCH_HALF_WID - 2, PITCH_HALF_WID + 2),
      y: clamp(ball.y, -PITCH_HALF_LEN - 3, PITCH_HALF_LEN + 3),
    };

    // ---- Possession / dribbling ----
    const speedNow = Math.hypot(ball.vx, ball.vy);
    const fresh = matchPlayers(ctx, match.id); // positions moved this tick
    // Snapshot the restart protection as a plain number: the closures below
    // outlive the narrowing on `match`, which is reassigned all through the
    // tick. -1 = anyone may play the ball.
    const protectedSide = match.graceTicks === 0 ? -1 : match.restartSide;
    // the boot that just struck it has to let it go
    if (ball.lockTicks > 0) ball = { ...ball, lockTicks: ball.lockTicks - 1 };
    const lockedOut = ball.lockTicks > 0 ? ball.lastTouchId : null;
    const eligible = (p: PlayerRow) =>
      !p.spectator &&
      p.role === ROLE_OUTFIELD &&
      p.slideTicks === 0 &&
      (protectedSide < 0 || p.side === protectedSide) &&
      !(lockedOut !== null && sameId(p.identity, lockedOut));

    let owner: PlayerRow | null = null;
    if (ball.hasOwner) {
      const prev = fresh.find(p => sameId(p.identity, ball!.ownerId));
      if (
        prev && eligible(prev) &&
        Math.hypot(ball.x - prev.x, ball.y - prev.y) <
          CONTROL_KEEP_RADIUS * charStat(prev.characterId).tackle
      ) {
        owner = prev;
      }
    }
    if (!owner && ball.z < CONTROL_MAX_Z) {
      let bestD = Infinity;
      for (const p of fresh) {
        if (!eligible(p)) continue;
        const d = Math.hypot(ball.x - p.x, ball.y - p.y);
        const radius = CONTROL_RADIUS * charStat(p.characterId).tackle;
        if (d < radius && d < bestD) {
          bestD = d;
          owner = p;
        }
      }
      if (owner && speedNow > CONTROL_MAX_SPEED) {
        // too hot to own — but a body in the way traps it down
        ball = { ...ball, vx: ball.vx * TRAP_DAMP, vy: ball.vy * TRAP_DAMP, vz: Math.min(ball.vz, 2) };
        match = clearGraceOnTouch(ctx, match, owner.side);
        ball = {
          ...ball,
          lastTouchSide: owner.side,
          lastTouchId: owner.identity,
          lockTicks: 0, // a new touch ends the striker's lock
        };
        owner = null;
      }
    }

    if (owner) {
      // Contest: an opposing outfielder inside the radius can poke it loose.
      const bx = ball.x;
      const by = ball.y;
      const ownerSide = owner.side;
      const contester = fresh.find(
        p =>
          p.side !== ownerSide &&
          eligible(p) &&
          Math.hypot(bx - p.x, by - p.y) <
            CONTROL_RADIUS * charStat(p.characterId).tackle
      );
      if (
        contester &&
        hash01(Number(match.id % 65536n) * 3.1 + match.clockTicks * 0.7) <
          CONTEST_CHANCE * charStat(contester.characterId).tackle
      ) {
        const ang = hash01(match.clockTicks * 1.3 + Number(match.id % 977n)) * Math.PI * 2;
        ball = {
          ...ball,
          vx: Math.cos(ang) * 14,
          vy: Math.sin(ang) * 14,
          vz: 0,
          hasOwner: false,
          ownerId: ZERO_ID,
          lastTouchSide: contester.side,
          lastTouchId: contester.identity,
          lockTicks: 0,
        };
        match = clearGraceOnTouch(ctx, match, contester.side);
      } else {
        // Dribble carry: the ball rides a touch ahead of the runner.
        const moving = owner.dirX !== 0 || owner.dirY !== 0;
        let fx: number;
        let fy: number;
        if (moving) {
          const len = Math.hypot(owner.dirX, owner.dirY) || 1;
          fx = owner.dirX / len;
          fy = owner.dirY / len;
        } else {
          fx = 0;
          fy = attackSign(owner.side);
        }
        const lead = TOUCH_AHEAD + (owner.sprinting && moving ? 1.2 : 0);
        const txp = owner.x + fx * lead;
        const typ = owner.y + fy * lead;
        ball = {
          ...ball,
          x: ball.x + (txp - ball.x) * 0.45,
          y: ball.y + (typ - ball.y) * 0.45,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          hasOwner: true,
          ownerId: owner.identity,
          lastTouchSide: owner.side,
          lastTouchId: owner.identity,
        };
        match = clearGraceOnTouch(ctx, match, owner.side);
      }
    } else if (ball.hasOwner) {
      ball = { ...ball, hasOwner: false, ownerId: ZERO_ID };
    }

    // Out of play? Judged last, so a carried ball counts like a struck one.
    if (resolveOutOfPlay(ctx, match, ball, { x: prevX, y: prevY, z: prevZ }, fresh)) return;

    ctx.db.ball.matchId.update(ball);
  }
);
