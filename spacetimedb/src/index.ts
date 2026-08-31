import { schema, table, t, SenderError, ScheduleAt, type ReducerCtx } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';

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
// Match format
// ---------------------------------------------------------------------------
const HALF_SECONDS = 180; // two 3-minute halves of game clock
const OT_SECONDS = 120; // golden-goal overtime; at 0 it runs on as sudden death
const HALF_TICKS = HALF_SECONDS * TICK_HZ;
const OT_TICKS = OT_SECONDS * TICK_HZ;

// Celebration before the kickoff resets. MUST outlast the client's replay
// budget (CUT_DELAY + WINDOW/SPEED + TAIL ~= 5.9 s) or the replay cuts away
// before the ball crosses the line — a goal replay that never shows the goal.
const GOAL_PAUSE = ticks(7.5);
const RESTART_PAUSE = ticks(1.4); // throw-in / corner / goal kick placement
const HALFTIME_PAUSE = ticks(6);
const COUNTDOWN_TICKS = ticks(3); // 3-2-1 before the first kickoff
// Only the awarded side may play the ball, and it is also the window in which
// the restart can be TAKEN. 1.6s was a race: the taker had to reach the ball
// and pick a pass before it expired. Standing over the ball he now needs only
// enough time to look up, which is what a real throw-in takes.
const RESTART_GRACE = ticks(4);
// If the human who should restart just stands there, a team-mate steps up
// and takes it. Without this, a player who concedes and then does nothing
// freezes the match for everyone, permanently.
const KICKOFF_AUTO = ticks(4);

// Restart kinds — what the pending pause resolves into.
const RK_NONE = 0;
const RK_KICKOFF = 1; // after a goal (kickoffSide concedes) and at half starts
const RK_THROWIN = 2; // ball over a touchline — taken with the hands
const RK_GOALKICK = 3; // over the goal line off an attacker
const RK_CORNER = 4; // over the goal line off a defender
const RK_HALFTIME = 5;
const RK_OVERTIME = 6;
const RK_DROP = 7; // neutral drop after a reconnect halt
const RK_FREEKICK = 8; // foul outside the area
const RK_PENALTY = 9; // foul by the defending side inside its own area

// ---------------------------------------------------------------------------
// Movement, dribbling, kicking
// ---------------------------------------------------------------------------
// Match pace. Deliberately below a real jog: the arcade read of "slow the
// game down" is about how much time you have on the ball, and at 17 the
// whole pitch went past faster than anyone could think.
const PLAYER_SPEED = 15.5;
// NOTE: there is deliberately no acceleration constant. Movement is instant;
// the renderer owns how smooth it LOOKS.
const SPRINT_MUL = 1.6; // the burst still matters, it just starts lower
const DRIBBLE_MUL = 0.85; // 4.4 m/s — running with the ball at pace
const STAMINA_MAX = 1000;
const SPRINT_DRAIN = 7; // per tick while sprinting and moving
const STAMINA_REGEN = 3; // per tick otherwise

const CONTROL_RADIUS = 2.8; // ball inside this sticks to your feet (~0.85 m)
// An owner keeps the ball out to here. It has to be comfortably beyond the
// knock distance: chasing your own touch IS dribbling, and losing possession
// the instant the ball left your boot would make the touch cycle unplayable.
const CONTROL_KEEP_RADIUS = 5.4;
// Faster balls can only be trapped, not owned. This sat BELOW the bottom of
// the real passing range, so every pass firm enough to beat a defender was
// untakeable by construction.
const CONTROL_MAX_SPEED = 46;
const CONTROL_MAX_Z = 2.5; // thigh height, so a dropping ball can be taken
const TRAP_DAMP = 0.3; // a trap kills most of the ball's pace
const TOUCH_AHEAD = 3.2; // ~1 m knock in front of the runner
// Dribbling is a cycle of TOUCHES, not a magnet. You knock the ball ahead,
// it rolls free for a couple of strides, you catch up to it and knock it
// again. TOUCH_TRIGGER is how close you have to get before the next touch
// goes in — reaching it is what sets the rhythm, so the cadence follows your
// speed for free — and TOUCH_KNOCK is how much faster than you the ball
// leaves your boot. Between touches the ball is genuinely loose: it carries
// its own velocity, drag slows it, and a defender can get to it. That gap is
// the whole reason a dribble is a risk rather than a guarantee.
const TOUCH_TRIGGER = 1.9;
const TOUCH_KNOCK = 9.0;
// Standing still, the ball settles at your feet instead of rolling away.
const SETTLE_DAMP = 0.55;
const CONTEST_CHANCE = 0.05; // per tick, standing challenge inside the radius

// How long a struck ball is out of its kicker's reach (see Ball.lockTicks).
const KICK_LOCK = ticks(0.3);
const KICK_RANGE = 3.4; // release must happen with the ball this close
const KICK_MAX_Z = 4.5; // chest height — below this, volleys were impossible
const KICK_CHARGE_TICKS = ticks(0.8); // full power after this long a hold
// Inside this range of the opponent goal a forward kick becomes a shot on
// target (see executeKick).
const SHOOT_RANGE = 34;
const KICK_MIN_SPEED = 34; // a soft pass (37 km/h)
const KICK_MAX_SPEED = 100; // a proper strike (110 km/h)
const CHIP_MIN_SPEED = 24;
const CHIP_MAX_SPEED = 62;

// Kick kinds (button pressed)
const KICK_NORMAL = 0; // tap = pass, hold = ripper; shoot by aiming at goal
const KICK_CHIP = 1; // lofted: crosses, chips over the keeper

// Slide tackle: a committed lunge, then a recovery stun.
const SLIDE_TOTAL = ticks(1.0); // full commitment, lunge + stun
const SLIDE_ACTIVE_AFTER = ticks(0.6); // slideTicks above this = still lunging
const SLIDE_SPEED = 26; // 7.9 m/s — a lunge, not a teleport
// Must EXCEED CONTROL_KEEP_RADIUS, or a sliding player has to get closer to
// the ball than a standing one — which is backwards.
const SLIDE_REACH = 4.0;
const SLIDE_COST = 220; // stamina
const SLIDE_KNOCK = 40; // pace the won ball is knocked ahead with
// A lunge that reaches a man rather than the ball is a foul. The reach is a
// touch shorter than SLIDE_REACH so that a tackle which was ALWAYS going to
// win the ball is not also punished for the follow-through.
const FOUL_REACH = 3.2;
// Where a penalty is spotted, measured in from the goal line.
const PENALTY_SPOT = 12;
// A caution is shown for a foul on a player who actually had the ball. Two
// of them is a red, the same as the real thing.
const CARDS_FOR_RED = 2;

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
// Air drag, shared by every surface: dv/dt = -BALL_DRAG * v^2, which decays
// speed by e^-(BALL_DRAG * distance). At 0.03 a ball keeps about a third of
// its pace over 40 units — a shot still arrives hard, a pass settles.
const BALL_DRAG = 0.03;

// `friction` is CONSTANT DECELERATION in units/s^2 (Coulomb rolling
// resistance), not an exponential decay rate — see the rolling branch in
// game_tick. Real grass takes ~0.6-1.0 m/s^2 off a rolling ball.
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

const ROLE_OUTFIELD = 0;
const ROLE_KEEPER = 1;

// Control token (player.ctrlSeat): the teamSlot of the human driving this
// body, or CTRL_NONE when the AI has it.
const CTRL_NONE = 255;

// Switching. A manual press locks briefly so a mashed button lands on one
// body; an automatic handover locks longer so the game does not fight the
// player for the stick.
const SWITCH_LOCK = ticks(0.22);
const AUTO_LOCK = ticks(0.6);
// Auto-switch only hands you a defender who is genuinely better placed...
const AUTO_SWITCH_MARGIN = 6;
// ...and only when the ball is close enough for it to be your problem.
const AUTO_SWITCH_RANGE = 28;
// How hard a held stick biases manual selection toward that direction.
const SWITCH_STICK_W = 14;
// The ball's near-future position is what you actually want to switch toward.
const SWITCH_LEAD = 0.35;

// Keeper tuning: the keeper is always a bot, one per side, spawned with the
// match and deleted with it.
const KEEPER_SPEED = 15; // a keeper is not faster than an outfielder
const KEEPER_LINE = 3.0; // how far off the goal line it holds (~1 m)
const KEEPER_MAX_X = GOAL_HALF_W + 1.5; // never camp outside your own post
const KEEPER_RANGE_Y = BOX_DEPTH; // never strays past the box
// What the keeper can actually get a glove to. Arm reach plus a step is ~4.2,
// but the keeper's predicted crossing point is EXACT (a ball in free flight
// crosses at x + vx*t regardless of when you compute it), so at that radius
// it covers two thirds of the mouth and can never be wrong-footed — an
// unbeatable wall. Until it dives properly, its reach is what has to give.
const KEEPER_CLEAR_RADIUS = 3.4;
const KEEPER_CLEAR_SPEED = 62;
// A keeper CATCHES rather than volleying everything back: it holds the ball
// for a beat and then picks a pass. Real football, and it also gives the
// defending side a moment to breathe after a save.
const KEEPER_HOLD = ticks(1.3);
// A human on the gloves gets the six seconds the laws actually allow, and
// then the keeper plays it anyway. Without a ceiling, a player who does not
// press anything (or does not realise they have been given the keeper)
// freezes the match with the ball in their hands, forever.
const KEEPER_HOLD_HUMAN = ticks(6);
// A throw finds a team-mate; anything longer gets hit.
const KEEPER_THROW_RANGE = 46; // anything less is a back-pass to the striker

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
// `err` is how far off the true crossing point the keeper commits. It is the
// ONLY thing making a keeper beatable, so it has to exceed the gap between
// its reach and the corner of the goal.
const KEEPER_LEVELS = [
  { speed: 0.62, reach: 0.75, react: 0.14, err: 4.0 },
  { speed: 0.85, reach: 1.0, react: 0.22, err: 2.6 },
  { speed: 1.05, reach: 1.15, react: 0.3, err: 1.4 },
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
    // NOTE: appended — the teamSlot of each side's elected presser (255 =
    // none). Stored so the election has HYSTERESIS: recomputed from scratch
    // every tick it would flap between two equidistant players. A u8, not an
    // Identity, to keep toHexString out of the 30 Hz path.
    presser0: t.u8().default(255),
    presser1: t.u8().default(255),
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

// The BODY this person is currently driving — the row their stick moves.
// Usually their own, but after a switch it is a team-mate's.
//
// The fallback STAMPS rather than merely returning: if no body carries my
// seat, claim my own row first. Returning an unstamped row would hand the
// same body to both botPlay and the human stick, every tick, forever.
function controlledBody(ctx: Ctx, me: PlayerRow): PlayerRow {
  if (me.matchId === 0n) return me;
  // ANY body, keeper included. Filtering to outfielders here made the token
  // invisible the moment control moved to the keeper, so the self-heal below
  // decided nobody held the seat and stamped a second claimant.
  for (const b of ctx.db.player.byMatch.filter(me.matchId)) {
    if (b.side === me.side && b.ctrlSeat === me.teamSlot) return b;
  }
  const mine = ctx.db.player.identity.find(me.identity);
  // Sent off. My own row is no longer a body on the pitch, so the seat has to
  // find another one — otherwise the fallback stamps a man who is standing on
  // the touchline and the stick drives nobody for the rest of the match.
  if (mine && mine.sentOff) {
    let alt: PlayerRow | null = null;
    for (const b of ctx.db.player.byMatch.filter(me.matchId)) {
      if (b.side !== me.side || b.spectator || b.sentOff) continue;
      if (b.ctrlSeat !== CTRL_NONE) continue;
      if (b.role !== ROLE_OUTFIELD) continue;
      if (!alt || b.teamSlot < alt.teamSlot) alt = b;
    }
    if (alt) return ctx.db.player.identity.update({ ...alt, ctrlSeat: me.teamSlot });
    return mine;
  }
  if (!mine || mine.role !== ROLE_OUTFIELD || mine.sentOff) return me;
  return ctx.db.player.identity.update({ ...mine, ctrlSeat: mine.teamSlot });
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
// ---------------------------------------------------------------------------
// Formation: a 1-2-1 diamond per side. Slot 0 is the striker, so a lone human
// (teamSize 1) gets the position that is actually fun to play; extra human
// seats fill outward from there and the rest are bot fillers.
//
// Anchors are FRACTIONS of the pitch, never absolute units, so re-sizing the
// pitch can never silently break the shape.
// ---------------------------------------------------------------------------
const POS_ST = 0;
const POS_LM = 1;
const POS_RM = 2;
const POS_CB = 3;
const OUTFIELD_PER_SIDE = 4;

const FORMATION = [
  { name: 'ST', ax: 0.0, ay: 0.42 },
  { name: 'LM', ax: -0.55, ay: 0.02 },
  { name: 'RM', ax: 0.55, ay: 0.02 },
  { name: 'CB', ax: 0.0, ay: -0.44 },
];
const posOf = (teamSlot: number) => clamp(teamSlot, 0, OUTFIELD_PER_SIDE - 1);

// Nobody but the elected presser may come inside this radius of the ball.
// This one rule is what structurally prevents the under-8s huddle: however
// the duty logic behaves, at most one player per side converges on the ball.
const AI_PRESS_BUBBLE = PITCH_HALF_WID * 0.21;
// How far off your formation anchor you may drift while off the ball.
const AI_ZONE_LEASH = PITCH_HALF_LEN * 0.35;
// Team-mates repel each other at this range, so two men never occupy one spot.
const AI_SEPARATION_R = PITCH_HALF_WID * 0.29;
// Seconds of advantage the incumbent presser keeps, so the job stops flapping.
const PRESS_HYST = 0.12;
// The longest pass a bot will attempt.
const AI_PASS_MAX = PITCH_HALF_LEN * 0.7;

// How hard the whole block tracks the ball. Never 1:1 — a team that mirrors
// the ball exactly reads as a shoal of fish, not a shape.
const LINE_FOLLOW = 0.55;
const LINE_PUSH = 6; // squeeze up when we have it
const LINE_DROP = 4; // sit deeper when they do
const BALL_SIDE_SHIFT = 0.45; // the block slides toward the ball's flank...
const BALL_SIDE_MAX = 0.35; // ...but never past this fraction of the half-width
const CB_GOALSIDE = 4; // the centre-back always stays this far goal-side of the ball
const ST_MAX_TRACKBACK = 0.25; // the striker never chases past this into our half

// Attack-space: u grows toward the goal this side is attacking, so the same
// arithmetic works for both sides without sign juggling at every step.
const toU = (side: number, y: number) => y * attackSign(side);
const fromU = (side: number, u: number) => u * attackSign(side);

interface Shape {
  side: number;
  lineU: number; // where the block's centre sits, in attack-space
  shiftX: number;
}

function teamShape(side: number, ballX: number, ballY: number, weHavePoss: boolean): Shape {
  const ballU = toU(side, ballY);
  const lineU = clamp(
    ballU * LINE_FOLLOW + (weHavePoss ? LINE_PUSH : -LINE_DROP),
    -PITCH_HALF_LEN * 0.55,
    PITCH_HALF_LEN * 0.55
  );
  const shiftX = clamp(
    ballX * BALL_SIDE_SHIFT,
    -PITCH_HALF_WID * BALL_SIDE_MAX,
    PITCH_HALF_WID * BALL_SIDE_MAX
  );
  return { side, lineU, shiftX };
}

// Where a given position wants to stand, given the block and the ball.
function anchorFor(shape: Shape, pos: number, ballX: number, ballY: number): { x: number; y: number } {
  const f = FORMATION[pos] ?? FORMATION[POS_ST];
  const ballU = toU(shape.side, ballY);
  let u = shape.lineU + f.ay * PITCH_HALF_LEN;
  // The two rules that keep the shape honest: a centre-back that lets the ball
  // get behind it is not a centre-back, and a striker who tracks all the way
  // back is why the pitch ends up with everyone in one half.
  if (pos === POS_CB) u = Math.min(u, ballU - CB_GOALSIDE);
  if (pos === POS_ST) u = Math.max(u, -PITCH_HALF_LEN * ST_MAX_TRACKBACK);
  u = clamp(u, -(PITCH_HALF_LEN - 4), PITCH_HALF_LEN - 6);
  const x = clamp(shape.shiftX + f.ax * PITCH_HALF_WID, -(PITCH_HALF_WID - 3), PITCH_HALF_WID - 3);
  return { x, y: fromU(shape.side, u) };
}

// Kickoff shape: the same formation, squeezed into your own half. The team you
// see lined up is the team you are about to play with.
function kickoffSpot(
  side: number,
  pos: number,
  kickoffSide: number
): { x: number; y: number } {
  if (side === kickoffSide && pos === POS_ST) return { x: 0, y: fromU(side, -2.5) };
  const f = FORMATION[pos] ?? FORMATION[POS_ST];
  // everyone behind the halfway line, spread on their formation width
  let u = -PITCH_HALF_LEN * 0.5 + (f.ay + 0.44) * PITCH_HALF_LEN * 0.6;
  u = Math.min(u, -3);
  let x = f.ax * PITCH_HALF_WID;
  let y = fromU(side, u);
  // the side not kicking off has to stand out of the centre circle
  if (side !== kickoffSide && Math.hypot(x, y) < CENTER_CIRCLE_R + 1.5) {
    y = fromU(side, -(CENTER_CIRCLE_R + 2));
  }
  return { x, y };
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
    } else {
      const spot = kickoffSpot(p.side, posOf(p.teamSlot), match.kickoffSide);
      x = spot.x;
      y = spot.y;
    }
    ctx.db.player.identity.update({
      ...p, x, y, dirX: 0, dirY: 0, mvX: 0, mvY: 0,
      kickTicks: 0, kickHeld: false, slideTicks: 0, holdTicks: 0,
      // Every kickoff hands each human back their own footballer. Reconnect
      // resumes through here, so a returning player needs no special case.
      ctrlSeat: !p.isBot && p.role === ROLE_OUTFIELD ? p.teamSlot : CTRL_NONE,
      switchLock: 0,
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
    presser0: 255,
    presser1: 255,
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
    name: `${FORMATION[posOf(slot)].name} BOT`,
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
  // no keeper is still holding a ball that has gone out of play
  for (const k of matchPlayers(ctx, match.id)) {
    if (k.role === ROLE_KEEPER && k.holdTicks > 0) {
      ctx.db.player.identity.update({ ...k, holdTicks: 0 });
    }
  }
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

// Who steps up to take a restart. A goal kick is played from the edge of the
// area by an outfielder, not by the keeper — a keeper is a bot, and handing
// it the ball would take the restart away from the player. Everything else
// goes to whoever is nearest the spot.
function restartTaker(ctx: Ctx, match: MatchRow): PlayerRow | null {
  const mine = matchPlayers(ctx, match.id).filter(
    p =>
      p.side === match.restartSide &&
      p.role === ROLE_OUTFIELD &&
      !p.spectator && !p.sentOff &&
      p.slideTicks === 0
  );
  if (mine.length === 0) return null;
  if (match.restartKind === RK_GOALKICK) {
    // the deepest man — the centre-back — takes it
    return mine.reduce((a, b) =>
      toU(match.restartSide, a.y) < toU(match.restartSide, b.y) ? a : b
    );
  }
  return mine.reduce((a, b) =>
    Math.hypot(a.x - match.restartX, a.y - match.restartY) <
    Math.hypot(b.x - match.restartX, b.y - match.restartY)
      ? a
      : b
  );
}

// ---------------------------------------------------------------------------
// Discipline. A slide that reaches the man instead of the ball is a foul, and
// a foul has consequences: the other side gets the ball back where it
// happened, the referee shows a card if the victim actually had possession,
// and a second card is a sending-off that the offending side plays out a man
// down. Inside the offender's own area it is a penalty.
// ---------------------------------------------------------------------------
function awardFoul(
  ctx: Ctx,
  match: MatchRow,
  ball: BallRow,
  offender: PlayerRow,
  victim: PlayerRow,
  hadBall: boolean
): void {
  const defSign = sideSign(offender.side); // the offender's OWN goal line
  const inOffendersBox =
    Math.abs(victim.x) < BOX_HALF_W &&
    Math.abs(victim.y - defSign * PITCH_HALF_LEN) < BOX_DEPTH &&
    victim.y * defSign > 0;
  const penalty = inOffendersBox;

  // A caution is for a foul on a player who actually had the ball — a
  // deliberate stopping of an attack. A clumsy lunge at a loose ball is a
  // free kick and nothing more.
  let cards = offender.cards;
  let sentOff = offender.sentOff;
  let cardMsg = '';
  if (hadBall) {
    cards = Math.min(255, cards + 1);
    if (cards >= CARDS_FOR_RED) {
      sentOff = true;
      cardMsg = ' — RED CARD';
    } else {
      cardMsg = ' — YELLOW CARD';
    }
  }
  if (cards !== offender.cards || sentOff !== offender.sentOff) {
    ctx.db.player.identity.update({
      ...offender,
      cards,
      sentOff,
      // a sent-off man walks: no stick, no lunge, no ball
      ctrlSeat: sentOff ? CTRL_NONE : offender.ctrlSeat,
      slideTicks: 0,
      mvX: 0, mvY: 0, velX: 0, velY: 0,
      kickHeld: false, kickTicks: 0,
      holdTicks: 0,
    });
  }

  const spotX = penalty ? 0 : clamp(victim.x, -PITCH_HALF_WID + 2, PITCH_HALF_WID - 2);
  const spotY = penalty
    ? defSign * (PITCH_HALF_LEN - PENALTY_SPOT)
    : clamp(victim.y, -PITCH_HALF_LEN + 2, PITCH_HALF_LEN - 2);
  awardRestart(
    ctx,
    match,
    ball,
    penalty ? RK_PENALTY : RK_FREEKICK,
    victim.side,
    spotX,
    spotY,
    (penalty ? 'PENALTY' : 'FREE KICK') + cardMsg
  );
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
    // The back-pass law hangs off this flag: a DELIBERATE kick by an
    // outfielder is the thing the keeper may not then pick up. A throw-in is
    // executed through here too, which is right — the law covers that as well.
    fromKick: kicker.role !== ROLE_KEEPER,
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

// ---------------------------------------------------------------------------
// Player switching. The token moves between BODIES; a person never holds one
// directly, which is what makes "two humans on one footballer" impossible to
// represent rather than merely forbidden.
// ---------------------------------------------------------------------------
// THE ONLY WRITER OF THE TOKEN.
function bindPilot(ctx: Ctx, me: PlayerRow, from: PlayerRow, to: PlayerRow, lock: number) {
  if (sameId(from.identity, to.identity)) return;
  // RE-READ both bodies. The callers hand us rows from a snapshot taken
  // earlier in the tick, and spreading a stale row would write its old
  // position back over whatever the movement loop just did — a visible
  // one-tick rubber-band on every handover.
  const oldBody = ctx.db.player.identity.find(from.identity);
  const target = ctx.db.player.identity.find(to.identity);
  if (!target) return;
  const stickX = oldBody ? oldBody.dirX : from.dirX;
  const stickY = oldBody ? oldBody.dirY : from.dirY;
  const sprint = oldBody ? oldBody.sprinting : from.sprinting;
  if (oldBody) {
    // slideTicks is deliberately PRESERVED — a man dropped mid-lunge finishes
    // the lunge under AI, as he should.
    ctx.db.player.identity.update({
      ...oldBody,
      ctrlSeat: CTRL_NONE,
      dirX: 0, dirY: 0, mvX: 0, mvY: 0, sprinting: false,
    });
  }
  // Claim the new one, CARRYING THE HELD STICK across. The client dedupes
  // set_input against its last send, so zeroing the stick here would leave
  // the new man standing still until the player physically changed direction.
  ctx.db.player.identity.update({
    ...target,
    ctrlSeat: me.teamSlot,
    dirX: stickX, dirY: stickY,
    // clear the AI's heading with the same write, or it survives the handover
    mvX: stickX, mvY: stickY,
    sprinting: sprint,
    // taking over a keeper mid-catch buys the full six seconds to pick a pass
    holdTicks:
      target.role === ROLE_KEEPER && target.holdTicks > 0
        ? KEEPER_HOLD_HUMAN
        : target.holdTicks,
  });
  // Re-read the person before writing their bookkeeping: when `from` IS this
  // row, a stale spread would resurrect the token on the body just vacated.
  const person = ctx.db.player.identity.find(me.identity);
  if (person) ctx.db.player.identity.update({ ...person, switchLock: lock });
}

// Bodies this human may take over. The KEEPER is included: you have to be
// able to come out for a cross and to play the ball once you have caught it.
function switchCandidates(ctx: Ctx, me: PlayerRow, cur: PlayerRow): PlayerRow[] {
  return matchPlayers(ctx, me.matchId).filter(
    b =>
      b.side === me.side &&
      !b.spectator && !b.sentOff &&
      b.slideTicks === 0 &&
      b.ctrlSeat === CTRL_NONE &&
      !sameId(b.identity, cur.identity)
  );
}

// Hand this human the next body. Shared by the SWITCH button and the
// standalone switch_player reducer, so there is one implementation.
function switchPilot(ctx: Ctx, me: PlayerRow): void {
  const match = ctx.db.match.id.find(me.matchId);
  if (!match || match.state !== M_LIVE) return;
  if (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF) return;
  const cur = controlledBody(ctx, me);
  if (cur.slideTicks > 0) return; // committed to the lunge
  const ball = ctx.db.ball.matchId.find(match.id);
  // You cannot walk away from a ball you are carrying. FIFA-correct, and it
  // deletes a whole class of confusing states.
  if (ball && ball.hasOwner && sameId(ball.ownerId, cur.identity)) return;

  // Defensive repair: release any OTHER body still claiming my seat, so the
  // invariant heals itself instead of needing to have never been broken.
  for (const b of matchPlayers(ctx, me.matchId)) {
    if (b.ctrlSeat === me.teamSlot && b.side === me.side && !sameId(b.identity, cur.identity)) {
      ctx.db.player.identity.update({ ...b, ctrlSeat: CTRL_NONE });
    }
  }

  const cands = switchCandidates(ctx, me, cur);
  if (cands.length === 0) return;

  const lead = ball
    ? { x: ball.x + ball.vx * SWITCH_LEAD, y: ball.y + ball.vy * SWITCH_LEAD }
    : { x: 0, y: 0 };
  const stickLen = Math.hypot(cur.dirX, cur.dirY);
  const ranked = cands
    .map(b => {
      let score = Math.hypot(b.x - lead.x, b.y - lead.y);
      if (stickLen > 0) {
        // A held stick means "give me the man over THERE".
        const dx = b.x - cur.x;
        const dy = b.y - cur.y;
        const d = Math.hypot(dx, dy) || 1;
        const cos = (dx * cur.dirX + dy * cur.dirY) / (d * stickLen);
        if (cos > 0.2) score -= SWITCH_STICK_W * cos;
      }
      return { b, score };
    })
    .sort((p, q) => p.score - q.score);

  // A re-press inside the lock walks the cursor down the ranking.
  const idx = me.switchLock > 0 ? (me.switchIdx + 1) % ranked.length : 0;
  const person = ctx.db.player.identity.find(me.identity);
  if (person) ctx.db.player.identity.update({ ...person, switchIdx: idx });
  const fresh = ctx.db.player.identity.find(me.identity) ?? me;
  bindPilot(ctx, fresh, cur, ranked[idx].b, SWITCH_LOCK);
}

// A committed lunge at the ball. Shared by the SLIDE button and the restart
// handover.
function slideTackle(ctx: Ctx, me: PlayerRow, body: PlayerRow): void {
  if (body.slideTicks > 0 || body.stamina < SLIDE_COST) return;
  let dx = body.dirX;
  let dy = body.dirY;
  if (dx === 0 && dy === 0) {
    dy = attackSign(body.side);
    dx = 0;
  }
  const len = Math.hypot(dx, dy) || 1;
  ctx.db.player.identity.update({
    ...body,
    slideTicks: SLIDE_TOTAL,
    slideDirX: dx / len,
    slideDirY: dy / len,
    stamina: Math.max(0, body.stamina - SLIDE_COST),
  });
}

export const switch_player = spacetimedb.reducer(ctx => {
  const me = getPlayer(ctx);
  if (me.matchId === 0n || me.spectator) return;
  switchPilot(ctx, me);
});

// ---------------------------------------------------------------------------
// ACTIONS. Three buttons whose meaning comes from the situation, so the whole
// game is playable without a manual:
//
//   on the ball      1 PASS        2 LOB PASS      3 SHOOT
//   chasing          1 TACKLE      2 SLIDE         3 SWITCH PLAYER
//   keeper, holding  1 THROW       2 LONG BALL     3 PUT BALL DOWN
//   throw-in         1 THROW IN    2 LONG THROW    3 SHORT THROW
//   corner           1 CORNER      2 HIGH CORNER   3 SHORT CORNER
//
// Every one of them is a single press. Nothing is charged and nothing is
// timed: holding a button to build power is what made this feel like a
// fighting game rather than football.
// ---------------------------------------------------------------------------
const ACT_SECOND = 1;
const ACT_THIRD = 2;

// Fixed weights, so a pass is a pass every time you press it.
const PASS_POWER = 0.42;
const LOB_POWER = 0.6;
const SHOT_POWER = 1.0;
const THROW_POWER = 0.45;
const SHORT_POWER = 0.3;

// Who a pass should go to. The stick picks the DIRECTION and the game finds
// the man — aiming a pass at raw eight-way degrees is why passing felt bad.
function pickPassTarget(
  me: PlayerRow,
  mates: PlayerRow[],
  foes: PlayerRow[],
  stickX: number,
  stickY: number,
  maxRange: number
): PlayerRow | null {
  const stick = Math.hypot(stickX, stickY);
  const atk = attackSign(me.side);
  let best: PlayerRow | null = null;
  let bestScore = -Infinity;
  for (const m of mates) {
    const dx = m.x - me.x;
    const dy = m.y - me.y;
    const d = Math.hypot(dx, dy);
    if (d < 3 || d > maxRange) continue;
    let score = 0;
    if (stick > 0.01) {
      // how well this man lines up with where I am pointing
      const cos = (dx * stickX + dy * stickY) / (d * stick);
      if (cos < 0.1) continue; // never pass backwards into the stick
      score += cos * 100;
    } else {
      score += dy * atk * 1.2; // nothing held: the most useful forward option
    }
    const open = foes.reduce((acc, o) => Math.min(acc, Math.hypot(o.x - m.x, o.y - m.y)), 99);
    score += Math.min(open, 20) * 1.5 - d * 0.25;
    if (!laneClear(me.x, me.y, m.x, m.y, foes, 2.0)) score -= 40;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function sidesOf(ctx: Ctx, me: PlayerRow, body: PlayerRow) {
  const all = matchPlayers(ctx, me.matchId);
  return {
    mates: all.filter(
      p =>
        p.side === body.side && !p.spectator && !p.sentOff &&
        !sameId(p.identity, body.identity)
    ),
    foes: all.filter(
      p => p.side !== body.side && p.role === ROLE_OUTFIELD && !p.spectator && !p.sentOff
    ),
  };
}

export const action = spacetimedb.reducer({ button: t.u8() }, (ctx, { button }) => {
  const me = getPlayer(ctx);
  if (me.matchId === 0n || me.spectator) return;
  const match = ctx.db.match.id.find(me.matchId);
  if (!match || match.state !== M_LIVE) return;
  if (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF) return;
  const body = controlledBody(ctx, me);
  if (body.slideTicks > 0) return; // committed
  const ball = ctx.db.ball.matchId.find(match.id);
  if (!ball) return;
  const { mates, foes } = sidesOf(ctx, me, body);
  const stickX = body.dirX;
  const stickY = body.dirY;
  const atk = attackSign(body.side);

  // ---- KEEPER WITH THE BALL IN ITS HANDS ----
  if (body.role === ROLE_KEEPER && body.holdTicks > 0) {
    if (button === ACT_THIRD) {
      // PUT BALL DOWN: stop holding and keep it at your feet, so the keeper
      // becomes an ordinary player in possession.
      ctx.db.player.identity.update({ ...body, holdTicks: 0 });
      ctx.db.ball.matchId.update({
        ...ball,
        active: true,
        x: body.x, y: body.y + atk * 1.5, z: 0,
        vx: 0, vy: 0, vz: 0,
        hasOwner: true,
        ownerId: body.identity,
        lastTouchSide: body.side,
        lastTouchId: body.identity,
        lockTicks: 0,
        fromKick: false, // putting it down is not a pass back to yourself
      });
      return;
    }
    const long = button === ACT_SECOND;
    const target = pickPassTarget(
      body, mates, foes, stickX, stickY,
      long ? PITCH_HALF_LEN * 1.4 : KEEPER_THROW_RANGE
    );
    ctx.db.player.identity.update({ ...body, holdTicks: 0 });
    const released = { ...ball, x: body.x, y: body.y, z: 1.4, hasOwner: false, ownerId: ZERO_ID };
    executeKick(
      ctx, match, released, body,
      long ? KICK_CHIP : KICK_NORMAL,
      long ? LOB_POWER : THROW_POWER,
      target ? target.x - body.x : stickX || 0,
      target ? target.y - body.y : stickY || atk
    );
    return;
  }

  const iHaveBall = ball.hasOwner && sameId(ball.ownerId, body.identity);
  const takingRestart =
    match.graceTicks > 0 && match.restartSide === body.side &&
    Math.hypot(ball.x - body.x, ball.y - body.y) < KICK_RANGE + 2;

  // ---- SET PIECES ----
  if (takingRestart || (match.phase === PHASE_KICKOFF && body.side === match.kickoffSide)) {
    const kind = match.phase === PHASE_KICKOFF ? RK_KICKOFF : match.restartKind;
    // A PENALTY is a shot, not a pass. Routing it through the pass finder
    // would have the taker roll it to the nearest team-mate from twelve
    // yards, which is not a penalty by any reading.
    if (kind === RK_PENALTY) {
      const goalY = atk * PITCH_HALF_LEN;
      const aimX = clamp(stickX * (GOAL_HALF_W - 1.2), -(GOAL_HALF_W - 1.2), GOAL_HALF_W - 1.2);
      executeKick(
        ctx, match, ball, body, button === ACT_SECOND ? KICK_CHIP : KICK_NORMAL,
        button === ACT_THIRD ? PASS_POWER : SHOT_POWER,
        aimX - ball.x, goalY - ball.y, 0, true
      );
      clearGraceOnTouch(ctx, match, body.side);
      return;
    }
    const short = button === ACT_THIRD;
    const high = button === ACT_SECOND;
    const range = short ? 26 : kind === RK_CORNER ? PITCH_HALF_LEN : PITCH_HALF_LEN * 0.8;
    const target = pickPassTarget(body, mates, foes, stickX, stickY, range);
    // a corner with nobody picked out goes to the middle of the goalmouth
    const fallbackX = kind === RK_CORNER ? 0 - ball.x : stickX || 0;
    const fallbackY = kind === RK_CORNER ? atk * PITCH_HALF_LEN - ball.y : stickY || atk;
    executeKick(
      ctx, match, ball, body,
      high || kind === RK_CORNER ? KICK_CHIP : KICK_NORMAL,
      short ? SHORT_POWER : high ? LOB_POWER : PASS_POWER,
      target ? target.x - ball.x : fallbackX,
      target ? target.y - ball.y : fallbackY
    );
    if (match.phase === PHASE_KICKOFF) {
      ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, graceTicks: 0, pointMsg: '' });
    } else {
      clearGraceOnTouch(ctx, match, body.side);
    }
    return;
  }

  // ---- ON THE BALL ----
  if (iHaveBall) {
    if (button === ACT_THIRD) {
      // SHOOT. Power comes from the distance, not from a held button.
      const goalY = atk * PITCH_HALF_LEN;
      const aimX = clamp(stickX * (GOAL_HALF_W - 1.2), -(GOAL_HALF_W - 1.2), GOAL_HALF_W - 1.2);
      executeKick(
        ctx, match, ball, body, KICK_NORMAL, SHOT_POWER,
        aimX - ball.x, goalY - ball.y, 0, true
      );
      return;
    }
    const lob = button === ACT_SECOND;
    const target = pickPassTarget(
      body, mates, foes, stickX, stickY, lob ? PITCH_HALF_LEN : AI_PASS_MAX
    );
    executeKick(
      ctx, match, ball, body,
      lob ? KICK_CHIP : KICK_NORMAL,
      lob ? LOB_POWER : PASS_POWER,
      target ? target.x - ball.x : stickX || 0,
      target ? target.y - ball.y : stickY || atk
    );
    return;
  }

  // ---- CHASING ----
  if (button === ACT_THIRD) {
    switchPilot(ctx, me);
    return;
  }
  if (button === ACT_SECOND) {
    slideTackle(ctx, me, body);
    return;
  }
  // PRIMARY while chasing: a standing challenge — a poke at the ball that
  // wins it if you are close, with none of the slide's commitment.
  const d = Math.hypot(ball.x - body.x, ball.y - body.y);
  if (d < CONTROL_RADIUS * 2.2 && ball.z < CONTROL_MAX_Z + 1) {
    const len = d || 1;
    ctx.db.ball.matchId.update({
      ...ball,
      vx: ((ball.x - body.x) / len) * 18,
      vy: ((ball.y - body.y) / len) * 18,
      vz: 2,
      hasOwner: false,
      ownerId: ZERO_ID,
      lastTouchSide: body.side,
      lastTouchId: body.identity,
      lockTicks: KICK_LOCK,
      fromKick: false, // a poke at the ball is a challenge, not a pass
    });
    clearGraceOnTouch(ctx, match, body.side);
  }
});

// ---------------------------------------------------------------------------
// Bot brains
// ---------------------------------------------------------------------------
// Steer an outfield bot: chase / carry / support by whether its team has the
// ball. Writes dirX/dirY (like a human stick) and may kick via executeKick.
// How long this player would take to reach the ball, roughly. Time, not
// distance: a slow centre-back should decline to chase a ball the striker
// will get to first.
function timeToBall(p: PlayerRow, ball: BallRow, speed: number): number {
  const lead = 0.25;
  const bx = ball.x + ball.vx * lead;
  const by = ball.y + ball.vy * lead;
  return Math.hypot(bx - p.x, by - p.y) / Math.max(1, speed);
}

// Elect ONE presser per side, with hysteresis against the incumbent.
function electPresser(
  ctx: Ctx,
  match: MatchRow,
  ball: BallRow,
  out: PlayerRow[][]
): MatchRow {
  let p0 = match.presser0;
  let p1 = match.presser1;
  for (const side of [0, 1]) {
    const squad = out[side];
    if (squad.length === 0) continue;
    const incumbent = side === 0 ? p0 : p1;
    let bestSlot = 255;
    let bestT = Infinity;
    for (const p of squad) {
      if (p.slideTicks > 0) continue;
      const speed = PLAYER_SPEED * charStat(p.characterId).speed;
      let t = timeToBall(p, ball, speed);
      if (p.teamSlot === incumbent) t -= PRESS_HYST; // the job is yours to lose
      if (t < bestT) {
        bestT = t;
        bestSlot = p.teamSlot;
      }
    }
    if (side === 0) p0 = bestSlot;
    else p1 = bestSlot;
  }
  if (p0 !== match.presser0 || p1 !== match.presser1) {
    return { ...match, presser0: p0, presser1: p1 };
  }
  return match;
}

// Is the straight line from `from` to `mate` clear of opponents? Point-to-
// segment distance, no square roots in the inner test.
function laneClear(
  fx: number, fy: number, tx: number, ty: number, foes: PlayerRow[], w: number
): boolean {
  const dx = tx - fx;
  const dy = ty - fy;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.01) return true;
  for (const o of foes) {
    let t = ((o.x - fx) * dx + (o.y - fy) * dy) / len2;
    if (t <= 0 || t >= 1) continue; // behind the passer or past the target
    const px = fx + dx * t;
    const py = fy + dy * t;
    const ox = o.x - px;
    const oy = o.y - py;
    if (ox * ox + oy * oy < w * w) return false;
  }
  return true;
}

// The brain for one bot body. `mates` and `foes` come from a snapshot the
// tick already holds, so this adds no table reads.
function botPlay(
  ctx: Ctx,
  match: MatchRow,
  lobby: LobbyRow | null | undefined,
  bot: PlayerRow,
  ball: BallRow,
  mates: PlayerRow[],
  foes: PlayerRow[],
  isPresser: boolean,
  possSide: number,
  // the side whose KEEPER is holding the ball, or -1. Everyone must clear
  // that penalty area — nobody stands over a keeper waiting for a drop.
  heldBySide: number,
  seed: number
): void {
  const lvl = BOT_LEVELS[clamp(lobby?.botLevel ?? 1, 0, BOT_LEVELS.length - 1)];
  const atk = attackSign(bot.side);
  const goalY = atk * PITCH_HALF_LEN;
  const iOwn = ball.hasOwner && sameId(ball.ownerId, bot.identity);
  const noise = (k: number) => (hash01(seed * 7.31 + k) - 0.5) * 2;

  // ---- ON THE BALL: one scored decision, ordered shoot > pass > carry ----
  if (iOwn) {
    const goalDist = Math.hypot(ball.x, goalY - ball.y);
    const nearestFoe = foes.reduce(
      (d, o) => Math.min(d, Math.hypot(o.x - bot.x, o.y - bot.y)),
      99
    );
    // SHOOT: close enough, and the mouth is not walled off.
    if (goalDist < SHOOT_RANGE) {
      const corner = (hash01(seed * 9.1 + match.clockTicks) < 0.5 ? -1 : 1) * (GOAL_HALF_W - 1.6);
      const clearShot = laneClear(ball.x, ball.y, corner, goalY, foes, 1.6);
      const urgency = 1 - goalDist / SHOOT_RANGE;
      if (clearShot && urgency > 0.25) {
        executeKick(
          ctx, match, ball, bot, KICK_NORMAL, clamp(0.55 + urgency, 0.5, 1),
          corner - ball.x, goalY - ball.y, lvl.shootErr
        );
        return;
      }
    }
    // PASS: score every mate on progression, how open they are, and whether
    // the lane is actually on. Beats rolling a die for it.
    let best: PlayerRow | null = null;
    let bestScore = 0;
    for (const mate of mates) {
      const d = Math.hypot(mate.x - bot.x, mate.y - bot.y);
      if (d < 8 || d > AI_PASS_MAX) continue;
      if (!laneClear(ball.x, ball.y, mate.x, mate.y, foes, 2.2)) continue;
      const openness = foes.reduce(
        (m, o) => Math.min(m, Math.hypot(o.x - mate.x, o.y - mate.y)),
        99
      );
      const progress = (mate.y - bot.y) * atk; // + = further upfield
      const score = progress * 0.6 + openness * 1.2 - d * 0.15;
      if (score > bestScore) {
        bestScore = score;
        best = mate;
      }
    }
    const pressured = nearestFoe < 7;
    if (best && (pressured || bestScore > 14)) {
      const d = Math.hypot(best.x - bot.x, best.y - bot.y);
      const lead = 3 * atk; // lay it ahead of them, not at their feet
      executeKick(
        ctx, match, ball, bot, KICK_NORMAL, clamp(d / AI_PASS_MAX + 0.25, 0.25, 0.85),
        best.x - ball.x, best.y + lead - ball.y, lvl.shootErr * 0.7
      );
      return;
    }
    // CARRY: run at goal, but bend away from the nearest opponent so the
    // dribble goes into space instead of straight into a tackle.
    let cx = clamp(ball.x * 0.6, -PITCH_HALF_WID + 6, PITCH_HALF_WID - 6);
    const closest = foes.reduce(
      (a: PlayerRow | null, o) =>
        !a || Math.hypot(o.x - bot.x, o.y - bot.y) < Math.hypot(a.x - bot.x, a.y - bot.y) ? o : a,
      null
    );
    if (closest && Math.hypot(closest.x - bot.x, closest.y - bot.y) < 12) {
      cx = clamp(cx - Math.sign(closest.x - bot.x) * 10, -PITCH_HALF_WID + 6, PITCH_HALF_WID - 6);
    }
    steerBot(ctx, bot, cx, goalY, true);
    return;
  }

  // ---- OFF THE BALL ----
  let tx: number;
  let ty: number;
  if (isPresser && heldBySide < 0) {
    // The one player allowed to go to the ball — but not while it is in a
    // keeper's hands, when there is nothing to press.
    tx = ball.x + ball.vx * 0.25 + noise(1) * lvl.reactErr;
    ty = ball.y + ball.vy * 0.25 + noise(2) * lvl.reactErr;
    const dist = Math.hypot(ball.x - bot.x, ball.y - bot.y);
    const oppOwns = ball.hasOwner && possSide === 1 - bot.side;
    if (
      oppOwns && dist < 6 && bot.slideTicks === 0 && bot.stamina >= SLIDE_COST &&
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
    // Hold your station in the block.
    const shape = teamShape(bot.side, ball.x, ball.y, possSide === bot.side);
    const anchor = anchorFor(shape, posOf(bot.teamSlot), ball.x, ball.y);
    tx = anchor.x + noise(3) * 1.5;
    ty = anchor.y + noise(4) * 1.2;

    // SEPARATION: repel from the nearest team-mate so two men never stack.
    let nearMate: PlayerRow | null = null;
    let nearD = AI_SEPARATION_R;
    for (const m of mates) {
      const d = Math.hypot(m.x - bot.x, m.y - bot.y);
      if (d < nearD) {
        nearD = d;
        nearMate = m;
      }
    }
    if (nearMate && nearD > 0.01) {
      const push = (AI_SEPARATION_R - nearD) * 0.8;
      tx += ((bot.x - nearMate.x) / nearD) * push;
      ty += ((bot.y - nearMate.y) / nearD) * push;
    }

    // THE SECOND-MAN RULE: you are not the presser, so stay out of the ball's
    // bubble. Structural, not advisory — it holds no matter what the duty
    // logic above decided.
    const bd = Math.hypot(tx - ball.x, ty - ball.y);
    if (bd < AI_PRESS_BUBBLE && bd > 0.01) {
      tx = ball.x + ((tx - ball.x) / bd) * AI_PRESS_BUBBLE;
      ty = ball.y + ((ty - ball.y) / bd) * AI_PRESS_BUBBLE;
    }
  }
  // CLEAR THE AREA. While a keeper has the ball in its hands the penalty box
  // belongs to it: attackers may not stand over it waiting for a drop, and
  // its own defenders should be showing for the throw, not blocking it.
  let clearingBox = false;
  if (heldBySide >= 0) {
    const gl = sideSign(heldBySide) * PITCH_HALF_LEN;
    const inBox =
      Math.abs(bot.x) < BOX_HALF_W + 2 && Math.abs(bot.y - gl) < BOX_DEPTH + 2;
    if (inBox) {
      // Out to the edge of the area, keeping your width — and at a RUN. The
      // hold is only about a second, so a walking retreat leaves half the
      // players still standing in the box when the keeper releases.
      ty = gl - sideSign(heldBySide) * (BOX_DEPTH + 4);
      tx = clamp(bot.x, -(PITCH_HALF_WID - 3), PITCH_HALF_WID - 3);
      clearingBox = true;
    }
  }
  steerBot(ctx, bot, tx, ty, clearingBox);
}

// Point a bot at a spot with an ANALOG heading. Also writes dirX/dirY, which
// the renderer reads as facing, but movement integrates mvX/mvY.
function steerBot(ctx: Ctx, bot: PlayerRow, tx: number, ty: number, sprint: boolean) {
  const fresh = ctx.db.player.identity.find(bot.identity);
  if (!fresh) return;
  const dx = tx - fresh.x;
  const dy = ty - fresh.y;
  const d = Math.hypot(dx, dy);
  // Arrive radius: a bot standing on its anchor must not jitter around it.
  const ARRIVE = 1.2;
  const mvX = d > ARRIVE ? dx / d : 0;
  const mvY = d > ARRIVE ? dy / d : 0;
  ctx.db.player.identity.update({
    ...fresh,
    mvX,
    mvY,
    dirX: Math.abs(mvX) > 0.35 ? Math.sign(mvX) : 0,
    dirY: Math.abs(mvY) > 0.35 ? Math.sign(mvY) : 0,
    sprinting: sprint && d > 14 && fresh.stamina > 250,
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

  // ---- HANDS ----
  // Already holding it: keep it in the gloves, then throw or kick it out.
  if (keeper.holdTicks > 0) {
    const left = keeper.holdTicks - 1;
    ctx.db.player.identity.update({ ...keeper, holdTicks: left, mvX: 0, mvY: 0 });
    if (left > 0) {
      // pinned to the gloves, at chest height, untouchable by anyone
      ctx.db.ball.matchId.update({
        ...ball,
        active: true,
        x: keeper.x + (ball.x > keeper.x ? 0.6 : -0.6),
        y: keeper.y - gs * 1.2,
        z: 2.6,
        vx: 0, vy: 0, vz: 0,
        hasOwner: true,
        ownerId: keeper.identity,
        lastTouchSide: keeper.side,
        lastTouchId: keeper.identity,
        fromKick: false,
      });
      return;
    }
    // DISTRIBUTE: find the best team-mate upfield and pick them out. A fixed
    // hoof toward whichever flank the ball happened to be on is a free
    // turnover on every goal kick, and a 3-minute half has a lot of those.
    const mates = matchPlayers(ctx, match.id).filter(
      p => p.side === keeper.side && p.role === ROLE_OUTFIELD && !p.spectator && !p.sentOff
    );
    const foes = matchPlayers(ctx, match.id).filter(
      p => p.side !== keeper.side && p.role === ROLE_OUTFIELD && !p.spectator && !p.sentOff
    );
    let best: PlayerRow | null = null;
    let bestScore = -Infinity;
    for (const m of mates) {
      const d = Math.hypot(m.x - keeper.x, m.y - keeper.y);
      if (d < 6) continue; // too close to be worth a throw
      const open = foes.reduce(
        (acc, o) => Math.min(acc, Math.hypot(o.x - m.x, o.y - m.y)),
        99
      );
      // upfield and unmarked, and don't hand it to someone in our own six-yard box
      const upfield = (m.y - keeper.y) * -gs;
      const score = upfield * 0.5 + open * 1.4 - (d > KEEPER_THROW_RANGE ? 25 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    const st = charStat(keeper.characterId);
    if (best && bestScore > 0) {
      const d = Math.hypot(best.x - keeper.x, best.y - keeper.y);
      const lofted = d > KEEPER_THROW_RANGE * 0.6;
      // aim at the accurate keeper's man; a poor one sprays it
      const err = (ctx.random() - 0.5) * 2 * (lvl.err * 1.5);
      // executeKick stamps lockTicks + lastTouchId, which is what stops the
      // keeper re-gathering its own distribution on the next tick.
      executeKick(
        ctx, match,
        { ...ball, x: keeper.x, y: keeper.y, z: 1.2, hasOwner: false, ownerId: ZERO_ID },
        keeper,
        lofted ? KICK_CHIP : KICK_NORMAL,
        // never a dink: a weak distribution just drops the ball back into the
        // six-yard box for the striker who was already standing there
        clamp(d / KEEPER_THROW_RANGE, 0.5, 0.95),
        best.x + err - keeper.x,
        best.y - keeper.y
      );
    } else {
      // nobody on: put it long down a flank
      const flank = ball.x >= 0 ? 1 : -1;
      ctx.db.ball.matchId.update({
        ...ball,
        active: true,
        x: keeper.x, y: keeper.y, z: 1.2,
        vx: flank * 22 + (ctx.random() - 0.5) * 6,
        vy: -gs * KEEPER_CLEAR_SPEED * st.power,
        vz: 26,
        lastTouchSide: keeper.side,
        lastTouchId: keeper.identity,
        fromKick: false,
        hasOwner: false,
        ownerId: ZERO_ID,
        lockTicks: KICK_LOCK,
      });
    }
    clearGraceOnTouch(ctx, match, keeper.side);
    return;
  }

  // CATCH IT. A keeper may only handle the ball inside its own penalty area —
  // outside it, it is just another player and can only kick.
  const dist = Math.hypot(ball.x - keeper.x, ball.y - keeper.y);
  const inOwnBox =
    Math.abs(ball.x) < BOX_HALF_W && Math.abs(ball.y - gs * PITCH_HALF_LEN) < BOX_DEPTH;
  // A keeper may not handle the ball it just released until somebody else
  // plays it — the actual law, and the only version that terminates. Keying
  // this on the brief KICK_LOCK instead let the keeper re-gather the moment
  // the lock expired: holds came out at 3-5s instead of one, and the ball
  // spent 89% of the match in a pair of gloves.
  const justReleased = sameId(ball.lastTouchId, keeper.identity);
  // Nor may it gather a ball placed for its OWN side's restart. A goal kick
  // is spotted inside the area with the keeper standing over it, so without
  // this the keeper scoops up the restart the player was handed and the goal
  // kick is never theirs to take.
  const ourRestart = match.graceTicks > 0 && match.restartSide === keeper.side;
  // THE BACK-PASS LAW. A keeper may not handle a ball a team-mate has
  // deliberately kicked (or thrown in) to him. He can still play it with his
  // feet like anyone else — which is the whole point of the law, and what
  // makes a hurried pass back a decision rather than a free reset.
  const backPass =
    ball.fromKick &&
    ball.lastTouchSide === keeper.side &&
    !sameId(ball.lastTouchId, keeper.identity);
  if (
    ball.active && !justReleased && !ourRestart && !backPass &&
    dist < KEEPER_CLEAR_RADIUS * lvl.reach && ball.z < 7 &&
    mayTouch(match, keeper.side)
  ) {
    if (inOwnBox) {
      ctx.db.player.identity.update({ ...keeper, holdTicks: KEEPER_HOLD, mvX: 0, mvY: 0 });
      ctx.db.ball.matchId.update({
        ...ball,
        active: true,
        x: keeper.x, y: keeper.y - gs * 1.2, z: 2.6,
        vx: 0, vy: 0, vz: 0,
        hasOwner: true,
        ownerId: keeper.identity,
        lastTouchSide: keeper.side,
        lastTouchId: keeper.identity,
        fromKick: false,
        lockTicks: 0,
      });
      clearGraceOnTouch(ctx, match, keeper.side);
      return;
    }
    // outside the area: no hands, just boot it clear
    const flank = ball.x >= 0 ? 1 : -1;
    const st = charStat(keeper.characterId);
    ctx.db.ball.matchId.update({
      ...ball,
      active: true,
      vx: flank * 22 + (ctx.random() - 0.5) * 6,
      vy: -gs * KEEPER_CLEAR_SPEED * st.power,
      vz: 26,
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
      ctx, match, ball, RK_THROWIN, side,
      (ball.x >= 0 ? 1 : -1) * (PITCH_HALF_WID - 0.5),
      clamp(ball.y, -PITCH_HALF_LEN + 2, PITCH_HALF_LEN - 2),
      `THROW-IN — ${teamName(players, side)}`
    );
    return true;
  }
  return false;
}

// Hand each human the footballer they should be driving. Runs every tick,
// BEFORE resolveOutOfPlay (which ends the tick on a goal or a restart, i.e.
// on exactly the ticks control most needs to move).
//
// Elections are per TARGET, not per human: resolve who should be handed over
// once, then pick the single best pilot for them. A per-human loop reads
// ctrlSeat from a stale snapshot and, in 2v2, lets two humans both claim the
// same receiver — the second silently overwriting the first.
function autoSwitchPass(ctx: Ctx, match: MatchRow, ball: BallRow | null | undefined) {
  const roster = matchPlayers(ctx, match.id);
  const people = roster.filter(p => !p.isBot && !p.spectator && p.matchId === match.id);
  if (people.length === 0) return;

  // Self-heal + lock decay. This one loop turns every possible token bug from
  // permanent into a one-tick hiccup.
  for (const person of people) {
    if (person.switchLock > 0) {
      ctx.db.player.identity.update({ ...person, switchLock: person.switchLock - 1 });
    }
    const held = roster.some(
      b => b.side === person.side && b.ctrlSeat === person.teamSlot
    );
    if (!held) controlledBody(ctx, ctx.db.player.identity.find(person.identity) ?? person);
  }
  if (match.graceTicks > 0) return; // a restart is being taken; leave control alone
  if (!ball) return;

  const live = matchPlayers(ctx, match.id);
  const bodyOf = (person: PlayerRow) =>
    live.find(b => b.side === person.side && b.ctrlSeat === person.teamSlot);
  const ownerRow = ball.hasOwner ? live.find(b => sameId(b.identity, ball.ownerId)) : undefined;
  const leadX = ball.x + ball.vx * SWITCH_LEAD;
  const leadY = ball.y + ball.vy * SWITCH_LEAD;

  // Collect one proposal per human, then resolve collisions on the target.
  const proposals: { person: PlayerRow; from: PlayerRow; to: PlayerRow; fromDist: number }[] = [];
  for (const person of people) {
    const fresh = ctx.db.player.identity.find(person.identity) ?? person;
    if (fresh.switchLock > 0) continue;
    const cur = bodyOf(fresh);
    if (!cur) continue;
    if (cur.kickHeld) continue; // never yank the stick out of a shot
    const curDist = Math.hypot(cur.x - leadX, cur.y - leadY);

    // 0. THE KEEPER HAS CAUGHT IT. Hand them the gloves so the distribution
    //    is theirs to make — otherwise you watch the AI throw your ball away.
    const holder = live.find(
      b => b.side === fresh.side && b.role === ROLE_KEEPER && b.holdTicks > 0
    );
    if (holder && holder.ctrlSeat === CTRL_NONE) {
      proposals.push({ person: fresh, from: cur, to: holder, fromDist: curDist });
      continue;
    }
    // 1. RECEPTION — the ball arrives at a team-mate. The keystone trigger:
    //    without it you pass and then watch the AI play your football.
    if (ownerRow && ownerRow.side === fresh.side && ownerRow.ctrlSeat === CTRL_NONE &&
        ownerRow.role === ROLE_OUTFIELD) {
      proposals.push({ person: fresh, from: cur, to: ownerRow, fromDist: curDist });
      continue;
    }
    // 2. SLIDE STUN — you missed, you are on the floor. Hand over during the
    //    stun (never during the lunge: you committed to that).
    if (cur.slideTicks > 0 && cur.slideTicks <= SLIDE_ACTIVE_AFTER) {
      const best = switchCandidates(ctx, fresh, cur)
        .sort(
          (a, b) =>
            Math.hypot(a.x - leadX, a.y - leadY) - Math.hypot(b.x - leadX, b.y - leadY)
        )[0];
      if (best) proposals.push({ person: fresh, from: cur, to: best, fromDist: curDist });
      continue;
    }
    // 3. LOOSE OR DEFENDING — gated on the ball NOT being ours. Note this
    //    covers an opponent dribbling at our goal too: the carry writes
    //    hasOwner every tick, so gating on !hasOwner would silently disable
    //    the entire defensive half of the feature.
    const ballIsOurs = !!ownerRow && ownerRow.side === fresh.side;
    if (!ballIsOurs && curDist < AUTO_SWITCH_RANGE + AUTO_SWITCH_MARGIN) {
      const best = switchCandidates(ctx, fresh, cur)
        .map(b => ({ b, d: Math.hypot(b.x - leadX, b.y - leadY) }))
        .sort((a, c) => a.d - c.d)[0];
      if (best && best.d < AUTO_SWITCH_RANGE && best.d < curDist - AUTO_SWITCH_MARGIN) {
        proposals.push({ person: fresh, from: cur, to: best.b, fromDist: curDist });
      }
    }
  }

  // One pilot per target: the human whose current man is FURTHEST from the
  // ball has the least to lose by being moved.
  const claimed = new Set<string>();
  for (const p of proposals.sort((a, b) => b.fromDist - a.fromDist)) {
    const key = p.to.identity.toHexString();
    if (claimed.has(key)) continue;
    const target = ctx.db.player.identity.find(p.to.identity);
    if (!target || target.ctrlSeat !== CTRL_NONE) continue;
    claimed.add(key);
    bindPilot(ctx, p.person, p.from, target, AUTO_LOCK);
  }
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
        case RK_THROWIN:
        case RK_GOALKICK:
        case RK_CORNER:
        case RK_FREEKICK:
        case RK_PENALTY:
        case RK_DROP: {
          const ball = ctx.db.ball.matchId.find(match.id);
          if (ball) {
            ctx.db.ball.matchId.update({
              ...ball,
              active: true,
              x: match.restartX,
              y: match.restartY,
              // a throw-in starts in the taker's hands, above their head
              z: match.restartKind === RK_THROWIN ? 3.4 : 0,
              vx: 0, vy: 0, vz: 0,
              hasOwner: false,
              ownerId: ZERO_ID,
              lastTouchSide: match.restartSide,
              lockTicks: 0,
              // a stoppage clears the back-pass state: whatever the keeper
              // could not pick up before the whistle, he can after it
              fromKick: false,
            });
          }
          // PUT THE TAKER ON THE BALL. Nothing moved him there before, so a
          // corner or a throw-in meant jogging twenty units to the flag or the
          // touchline while the 1.6-second grace ran down — and the moment it
          // expired `takingRestart` went false and the restart could no longer
          // be taken at all. Goal kicks hid the bug, because the man who takes
          // one is the deepest defender and he is already standing there.
          //
          // A footballer does not race his own restart. He stands over the
          // ball: outside the line for a throw-in and at the flag for a
          // corner, which is where the laws put him anyway, and a step behind
          // it for everything else.
          if (match.restartKind !== RK_DROP && match.restartKind !== RK_PENALTY) {
            const taker = restartTaker(ctx, match);
            if (taker) {
              const outX = Math.sign(match.restartX) || 1;
              const outY = Math.sign(match.restartY) || 1;
              let tx: number;
              let ty: number;
              if (match.restartKind === RK_THROWIN) {
                // behind the touchline, facing in — where a thrower stands
                tx = outX * (PITCH_HALF_WID + 1);
                ty = match.restartY;
              } else if (match.restartKind === RK_CORNER) {
                tx = outX * (PITCH_HALF_WID + 1);
                ty = outY * (PITCH_HALF_LEN + 1);
              } else {
                // a step behind the ball, on the side away from the goal we
                // are attacking, so the first touch is forward
                tx = match.restartX;
                ty = match.restartY + sideSign(match.restartSide) * 2.2;
              }
              ctx.db.player.identity.update({
                ...taker,
                x: clamp(tx, -P_BOUNDS_X, P_BOUNDS_X),
                y: clamp(ty, -P_BOUNDS_Y, P_BOUNDS_Y),
                mvX: 0, mvY: 0, velX: 0, velY: 0,
                kickHeld: false, kickTicks: 0, slideTicks: 0,
              });
            }
          }
          // A PENALTY is taken with the area cleared: everyone but the taker
          // and the defending keeper is pushed to the edge of the box, and the
          // keeper is put on his line. Without this the ten bodies standing
          // where the whistle caught them make the spot kick meaningless.
          if (match.restartKind === RK_PENALTY) {
            const defSign = -sideSign(match.restartSide); // the goal being shot at
            const taker = restartTaker(ctx, match);
            for (const p of matchPlayers(ctx, match.id)) {
              if (p.spectator || p.sentOff) continue;
              if (p.role === ROLE_KEEPER && p.side !== match.restartSide) {
                ctx.db.player.identity.update({
                  ...p,
                  x: 0, y: defSign * (PITCH_HALF_LEN - 1),
                  mvX: 0, mvY: 0, velX: 0, velY: 0, holdTicks: 0,
                });
                continue;
              }
              if (taker && sameId(p.identity, taker.identity)) {
                ctx.db.player.identity.update({
                  ...p,
                  x: 0, y: match.restartY + sideSign(match.restartSide) * 3,
                  mvX: 0, mvY: 0, velX: 0, velY: 0,
                });
                continue;
              }
              // everyone else: back to the edge of the area, fanned out
              const lane = (p.teamSlot % 4) - 1.5;
              ctx.db.player.identity.update({
                ...p,
                x: clamp(lane * 7 + (p.side === match.restartSide ? 2 : -2), -BOX_HALF_W, BOX_HALF_W),
                y: defSign * (PITCH_HALF_LEN - BOX_DEPTH - 4),
                mvX: 0, mvY: 0, velX: 0, velY: 0,
              });
            }
          }
          // HAND THE RESTART TO THE PLAYER. A restart the human watches a bot
          // take is a restart they did not get to play — most of all a goal
          // kick, which is their team's ball and the start of their attack.
          // A drop ball is nobody's, so control stays where it is.
          if (match.restartKind !== RK_DROP) {
            // `match` is reassigned all through the tick, so bind the side
            // here rather than reading it from inside the closure below.
            const awarded = match.restartSide;
            const taker = restartTaker(ctx, match);
            if (taker) {
              const person = matchPlayers(ctx, match.id).find(
                p =>
                  !p.isBot && !p.spectator && p.side === awarded &&
                  p.role === ROLE_OUTFIELD
              );
              if (person) {
                const cur = controlledBody(ctx, person);
                bindPilot(ctx, person, cur, taker, SWITCH_LOCK);
              }
            }
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

    // How long this kickoff has been waiting to be taken. pauseTicks is unused
    // during PHASE_KICKOFF, so it doubles as the timer.
    if (match.phase === PHASE_KICKOFF && match.startTicks === 0) {
      match = { ...match, pauseTicks: Math.min(65000, match.pauseTicks + 1) };
      ctx.db.match.id.update(match);
    }

    // ONE snapshot of the roster, partitioned once, so the brain below adds
    // no table reads and no per-bot filtering inside the 30 Hz loop.
    const outBySide: PlayerRow[][] = [[], []];
    for (const p of players) {
      if (p.role === ROLE_OUTFIELD && !p.spectator && !p.sentOff) outBySide[p.side].push(p);
    }
    for (const side of [0, 1]) outBySide[side].sort((a, b) => a.teamSlot - b.teamSlot);
    const carrier =
      ball && ball.hasOwner ? players.find(q => sameId(q.identity, ball!.ownerId)) : undefined;
    const possSide = carrier ? carrier.side : ball ? ball.lastTouchSide : 0;
    if (ball && match.phase === PHASE_LIVE) {
      const elected = electPresser(ctx, match, ball, outBySide);
      if (elected !== match) {
        match = elected;
        ctx.db.match.id.update(match);
      }
    }

    // ---- Movement (humans by stick, outfield bots by brain, keepers) ----
    for (const p of players) {
      if (p.spectator) continue;
      // A sent-off player is off the pitch and stays off it: walked to the
      // touchline once and then skipped entirely, so the side really does
      // play out the rest of the match a man down.
      if (p.sentOff) {
        const off = sideSign(p.side) * (PITCH_HALF_WID + 6);
        if (Math.abs(p.x - off) > 0.5 || Math.abs(p.y) > 0.5) {
          ctx.db.player.identity.update({
            ...p, x: off, y: 0, mvX: 0, mvY: 0, velX: 0, velY: 0,
            kickHeld: false, kickTicks: 0, slideTicks: 0, ctrlSeat: CTRL_NONE,
          });
        }
        continue;
      }
      // AI keepers are moved by keeperPlay; a human-driven one walks like
      // anyone else, or taking the gloves would leave you rooted to the spot.
      if (p.role === ROLE_KEEPER && p.ctrlSeat === CTRL_NONE) continue;
      let cur = ctx.db.player.identity.find(p.identity);
      if (!cur) continue;

      // Slide: a committed lunge, then a stun on the ground.
      if (cur.slideTicks > 0) {
        const t2 = cur.slideTicks - 1;
        if (cur.slideTicks > SLIDE_ACTIVE_AFTER) {
          const nx = clamp(cur.x + cur.slideDirX * SLIDE_SPEED * DT, -P_BOUNDS_X, P_BOUNDS_X);
          const ny = clamp(cur.y + cur.slideDirY * SLIDE_SPEED * DT, -P_BOUNDS_Y, P_BOUNDS_Y);
          ctx.db.player.identity.update({ ...cur, x: nx, y: ny, slideTicks: t2 });
          let wonBall = false;
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
                fromKick: false, // a tackle is not a deliberate pass
              });
              match = clearGraceOnTouch(ctx, match, cur.side);
              ball = ctx.db.ball.matchId.find(match.id);
              wonBall = true;
            }
          }
          // FOUL. A lunge that got nowhere near the ball but did reach an
          // opponent is a foul, and it is what makes the slide a decision
          // rather than a free action — before this the tackle could only
          // ever win the ball or whiff, which is why the game had no rules
          // worth the name. Ball first: a tackle that took the ball is a
          // fair tackle no matter who it also caught.
          const slider = cur;
          if (!wonBall && ball && match.phase === PHASE_LIVE) {
            const victim = players.find(
              q =>
                q.side !== slider.side && !q.spectator && !q.sentOff &&
                q.slideTicks === 0 &&
                Math.hypot(q.x - nx, q.y - ny) < FOUL_REACH
            );
            if (victim) {
              const hadBall = !!ball.hasOwner && sameId(ball.ownerId, victim.identity);
              awardFoul(ctx, match, ball, slider, victim, hadBall);
              return; // the whistle has gone; the rest of the tick is moot
            }
          }
        } else {
          ctx.db.player.identity.update({ ...cur, slideTicks: t2 });
        }
        continue;
      }

      // Outfield bot brain writes its stick (and may kick).
      // The single gate that turns the token into control. On today's roster
      // this is provably identical to the old `cur.isBot` test — humans hold
      // their own seat, every bot holds CTRL_NONE — but it now asks the right
      // question: is a human's stick driving THIS body?
      if (cur.ctrlSeat === CTRL_NONE && match.phase === PHASE_LIVE && ball) {
        const mySlot = cur.teamSlot;
        const mates = outBySide[cur.side].filter(m => m.teamSlot !== mySlot);
        const foes = outBySide[1 - cur.side];
        const isPresser =
          (cur.side === 0 ? match.presser0 : match.presser1) === mySlot;
        const holder = players.find(q => q.role === ROLE_KEEPER && q.holdTicks > 0);
        botPlay(
          ctx, match, lobby, cur, ball, mates, foes, isPresser, possSide,
          holder ? holder.side : -1,
          // Seeded per body. Outfield teamSlot is unique per side, so no two
          // bots ever draw the same noise and move as one.
          Number(match.id % 100000n) + cur.side * 31 + mySlot * 17
        );
        ball = ctx.db.ball.matchId.find(match.id);
        match = ctx.db.match.id.find(match.id)!;
        if (match.state !== M_LIVE || (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF)) return;
        cur = ctx.db.player.identity.find(p.identity);
        if (!cur || cur.slideTicks > 0) continue;
      } else if (cur.ctrlSeat === CTRL_NONE && match.phase === PHASE_KICKOFF && ball) {
        // bot kickoff: walk to the spot and poke it to a teammate
        const standIn =
          match.pauseTicks > KICKOFF_AUTO
            ? outBySide[cur.side].find(b => b.ctrlSeat === CTRL_NONE)?.teamSlot
            : undefined;
        const amTaker =
          cur.teamSlot === 0 || (standIn !== undefined && cur.teamSlot === standIn);
        if (cur.side === match.kickoffSide && amTaker && match.startTicks === 0) {
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
          // Everyone else walks to their kickoff station. Freezing them here
          // would leave eight of ten players standing perfectly still at the
          // start of every half and after every goal — the first thing a
          // player sees, and the thing that made this look unfinished.
          const spot = kickoffSpot(cur.side, posOf(cur.teamSlot), match.kickoffSide);
          const dx = spot.x - cur.x;
          const dy = spot.y - cur.y;
          const kd = Math.hypot(dx, dy) || 1;
          ctx.db.player.identity.update({
            ...cur,
            mvX: kd > 1 ? dx / kd : 0,
            mvY: kd > 1 ? dy / kd : 0,
            dirX: Math.abs(dx) > 0.6 ? Math.sign(dx) : 0,
            dirY: Math.abs(dy) > 0.6 ? Math.sign(dy) : 0,
            sprinting: false,
          });
          cur = ctx.db.player.identity.find(p.identity)!;
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
        if (stamina !== cur.stamina || kickTicks !== cur.kickTicks || cur.velX !== 0) {
          ctx.db.player.identity.update({ ...cur, stamina, kickTicks, velX: 0, velY: 0 });
        }
        continue;
      }
      const owns = !!ball && ball.hasOwner && sameId(ball.ownerId, cur.identity);
      let speed = PLAYER_SPEED * st.speed;
      if (wantSprint) speed *= SPRINT_MUL;
      if (owns) speed *= DRIBBLE_MUL;
      // Analog heading, chosen by WHO IS DRIVING — never by "is mv set".
      // A body handed to a human still carries the AI's last unit vector, and
      // the client dedupes set_input against its last send, so an mv-first
      // rule leaves the new man sprinting off on the bot's heading and
      // ignoring the stick until the player happens to change direction.
      // That is the difference between a footballer and a runaway.
      const human = cur.ctrlSeat !== CTRL_NONE;
      const hx = human ? cur.dirX : cur.mvX;
      const hy = human ? cur.dirY : cur.mvY;
      const hlen = Math.hypot(hx, hy);
      // INSTANT. The stick is the velocity — press and you are moving at pace,
      // release and you stop. Ramping this is what made the game feel like it
      // was answering late; the cure for a twitchy LOOK is smoothing the
      // animation, which is the renderer's job, not slowing the simulation.
      const vX = hlen > 0 ? hx / hlen : 0;
      const vY = hlen > 0 ? hy / hlen : 0;
      let x = clamp(cur.x + vX * speed * DT, -P_BOUNDS_X, P_BOUNDS_X);
      let y = clamp(cur.y + vY * speed * DT, -P_BOUNDS_Y, P_BOUNDS_Y);
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
      ctx.db.player.identity.update({ ...cur, x, y, stamina, kickTicks, velX: vX, velY: vY });
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
      // same drag in the air, on the full 3D speed
      const sp3 = Math.hypot(ball.vx, ball.vy, ball.vz);
      const dk = sp3 > 0 ? 1 / (1 + BALL_DRAG * sp3 * DT) : 1;
      ball = {
        ...ball,
        x: ball.x + ball.vx * DT,
        y: ball.y + ball.vy * DT,
        z: ball.z + ball.vz * DT + 0.5 * phys.gravity * DT * DT,
        vx: ball.vx * dk,
        vy: ball.vy * dk,
        vz: (ball.vz + phys.gravity * DT) * dk,
      };
      if (ball.z <= 0 && ball.vz < 0) {
        // bounce
        const vz = -ball.vz * phys.bounce;
        ball = {
          ...ball,
          z: 0,
          // absolute threshold, so it scales with GRAVITY (2.5 * 38/60)
          vz: vz < 1.6 ? 0 : vz,
          vx: ball.vx * 0.9,
          vy: ball.vy * 0.9,
        };
      }
    } else {
      // Rolling. TWO terms, because one is not enough:
      //   - quadratic AIR DRAG (dv/dt = -k v^2, integrated exactly below).
      //     This is what actually stops a struck ball: it decays speed
      //     exponentially with DISTANCE, so a 100-unit shot is still hot at
      //     30 units but a pass has settled by the time it arrives.
      //   - Coulomb ROLLING resistance, a constant decel that brings a slow
      //     ball to rest instead of letting it creep forever.
      // Rolling resistance alone is physically right for a slow ball and
      // catastrophic for a fast one: at 2.4 units/s^2 a 60-unit pass rolls
      // 750 units, and this pitch is 132 long — so every pass left the field.
      const sp = Math.hypot(ball.vx, ball.vy);
      let k = 0;
      if (sp > 0) {
        const afterDrag = sp / (1 + BALL_DRAG * sp * DT);
        k = Math.max(0, afterDrag - phys.friction * DT) / sp;
      }
      let vx = ball.vx * k;
      let vy = ball.vy * k;
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
    // A ball in a keeper's hands is out of play for everyone: no outfielder
    // may take it, it cannot roll out, and the keeper's own code owns its
    // position until it is released.
    // Read FRESH: `players` was snapshotted before the keeper loop ran, so on
    // the very tick of a catch the stale copy still says holdTicks = 0 and
    // possession would strip the ball straight out of the gloves.
    const keeperHolding = matchPlayers(ctx, match.id).some(
      p => p.role === ROLE_KEEPER && p.holdTicks > 0
    );
    if (keeperHolding) {
      // The ball is out of play for everyone, but control still has to move:
      // returning here without the auto-switch is why a keeper could catch it
      // and the player never got the gloves.
      ctx.db.ball.matchId.update(ball);
      autoSwitchPass(ctx, match, ball);
      return;
    }

    const speedNow = Math.hypot(ball.vx, ball.vy);
    const fresh = matchPlayers(ctx, match.id); // positions moved this tick
    // Snapshot the restart protection as a plain number: the closures below
    // outlive the narrowing on `match`, which is reassigned all through the
    // tick. -1 = anyone may play the ball.
    const protectedSide = match.graceTicks === 0 ? -1 : match.restartSide;
    // the boot that just struck it has to let it go
    if (ball.lockTicks > 0) ball = { ...ball, lockTicks: ball.lockTicks - 1 };
    const lockedOut = ball.lockTicks > 0 ? ball.lastTouchId : null;
    // A keeper only enters the possession model when a HUMAN is driving it
    // (after PUT BALL DOWN): an AI keeper uses its hands and its own code,
    // and letting it dribble would send it up the pitch.
    const eligible = (p: PlayerRow) =>
      !p.spectator && !p.sentOff &&
      (p.role === ROLE_OUTFIELD || p.ctrlSeat !== CTRL_NONE) &&
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
          fromKick: false, // trapped off a body, not played
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
          fromKick: false,
        };
        match = clearGraceOnTouch(ctx, match, contester.side);
      } else {
        // DRIBBLE. The ball used to be pinned to a point in front of the
        // runner every tick with its velocity zeroed — a magnet on a string.
        // Nothing about that is football: the ball never rolled, it could
        // never be nicked between touches, and because it had no velocity the
        // client could not interpolate it either, so a dribble strobed.
        //
        // Now the ball is TOUCHED. When the runner catches up to it, he knocks
        // it ahead and it rolls away under its own momentum until he reaches
        // it again. Everything else — drag, the contest above, out of play —
        // treats it as the loose ball it now genuinely is.
        const moving = owner.mvX !== 0 || owner.mvY !== 0;
        let fx: number;
        let fy: number;
        if (moving) {
          const len = Math.hypot(owner.mvX, owner.mvY) || 1;
          fx = owner.mvX / len;
          fy = owner.mvY / len;
        } else {
          fx = 0;
          fy = attackSign(owner.side);
        }
        const dx = ball.x - owner.x;
        const dy = ball.y - owner.y;
        const gap = Math.hypot(dx, dy);
        if (!moving) {
          // Standing over it: kill the roll so close control is close
          // control, and nudge it to the near side of the boot.
          const settleX = owner.x + fx * TOUCH_TRIGGER;
          const settleY = owner.y + fy * TOUCH_TRIGGER;
          ball = {
            ...ball,
            x: ball.x + (settleX - ball.x) * SETTLE_DAMP,
            y: ball.y + (settleY - ball.y) * SETTLE_DAMP,
            z: 0,
            vx: ball.vx * (1 - SETTLE_DAMP),
            vy: ball.vy * (1 - SETTLE_DAMP),
            vz: 0,
          };
        } else if (gap < TOUCH_TRIGGER) {
          // Caught up to it — put the next touch in. The knock goes along the
          // run, with a small correction so the ball comes back in front of
          // the boot rather than drifting off a shoulder.
          const ownSpeed = Math.hypot(owner.velX, owner.velY) * PLAYER_SPEED *
            charStat(owner.characterId).speed * (owner.sprinting ? SPRINT_MUL : 1);
          const knock = ownSpeed * DRIBBLE_MUL + TOUCH_KNOCK;
          const cx = gap > 0.01 ? dx / gap : fx;
          const cy = gap > 0.01 ? dy / gap : fy;
          const ax = fx * 0.8 + cx * 0.2;
          const ay = fy * 0.8 + cy * 0.2;
          const al = Math.hypot(ax, ay) || 1;
          ball = {
            ...ball,
            vx: (ax / al) * knock,
            vy: (ay / al) * knock,
            vz: 0,
            z: 0,
          };
        }
        // Between touches nothing is written to the ball's position at all —
        // it is rolling, and the integrator owns it.
        ball = {
          ...ball,
          hasOwner: true,
          ownerId: owner.identity,
          lastTouchSide: owner.side,
          lastTouchId: owner.identity,
          fromKick: false, // taking it under control clears the back-pass
        };
        match = clearGraceOnTouch(ctx, match, owner.side);
      }
    } else if (ball.hasOwner) {
      ball = { ...ball, hasOwner: false, ownerId: ZERO_ID };
    }

    // Hand control to the right footballer BEFORE the out-of-play test, which
    // returns and ends the tick on a goal or a restart.
    ctx.db.ball.matchId.update(ball);
    autoSwitchPass(ctx, match, ball);

    // Out of play? Judged last, so a carried ball counts like a struck one.
    if (resolveOutOfPlay(ctx, match, ball, { x: prevX, y: prevY, z: prevZ }, fresh)) return;

    ctx.db.ball.matchId.update(ball);
  }
);
