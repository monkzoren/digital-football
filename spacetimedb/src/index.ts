import { schema, table, t, SenderError, ScheduleAt, type ReducerCtx } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Court geometry (world units ~ feet). Net at y=0, side 0 owns y<0, side 1 y>0.
// ---------------------------------------------------------------------------
const COURT_HALF_LEN = 39;
const COURT_HALF_WID = 21.6;
const NET_HEIGHT = 3.2;

// Line calls: the painted lines belong to the court. A ball whose edge still
// clips the line is IN — allow ball radius (0.55) + half the painted line
// width (~0.3) past the nominal boundary before calling OUT.
const LINE_MARGIN = 0.85;
const BOUNDS_X = 27.6;
const BOUNDS_Y_NEAR = 3; // closest to net a player may stand
const BOUNDS_Y_FAR = 46;

// Simulation rate. Every tick-counted constant below is derived from this via
// `ticks(seconds)`, so changing TICK_HZ alone rescales the whole game clock and
// keeps the feel identical. Seconds-based constants (flight times, speeds,
// gravity) are already rate-independent and need no scaling.
// NOTE: raising this multiplies row writes — and therefore broadcast traffic
// to every subscribed client — by the same factor, and broadcast is the
// binding constraint on concurrent matches. 120 Hz was tried and reverted:
// 4x the wire cost per match for no felt improvement.
const TICK_HZ = 30;
const TICK_MICROS = BigInt(Math.round(1_000_000 / TICK_HZ));
const DT = 1 / TICK_HZ;
// Round to at least 1 so no duration collapses to zero at low tick rates.
const ticks = (seconds: number) => Math.max(1, Math.round(seconds * TICK_HZ));
const GRAVITY = -70;

const PLAYER_SPEED = 26;

// Four contact tiers, by distance from the body center:
//   0..REACH                 stand and hit (timing quality applies)
//   ..+STRETCH_REACH         reach to hit (never better than GOOD)
//   ..+LUNGE_REACH           jump/dive to hit (always WEAK, roots you)
//   ..+MISS_MARGIN           jump for it and miss (dive, no ball)
const REACH = 3.36; // matches the visual arm + racket length
const STRETCH_REACH = 1.8;
const LUNGE_REACH = 5.0;
const MISS_MARGIN = 2.5;
const CONTACT_DIST = 2.6; // stretch/dive steps leave the ball exactly at arm's length
// Three jump sizes by how far past stretch range the ball is. The recovery
// tick count also tells the client which dive animation to play.
const LUNGE_SHORT = ticks(0.4); // quick side-hop
const LUNGE_MED = ticks(0.8); // full dive + roll
const LUNGE_LONG = ticks(1.0); // huge layout dive
// While lungeTicks is still above this the player is airborne (pinned, no
// steering); below it they're scrambling back up at reduced speed.
const LUNGE_AIRBORNE = ticks(0.267);

function lungeTicksFor(distPastStretch: number): number {
  if (distPastStretch <= 2.4) return LUNGE_SHORT;
  if (distPastStretch <= 4.7) return LUNGE_MED;
  return LUNGE_LONG;
}

const HIT_MAX_Z = 8; // overhead reach incl. a small jump
const SWING_WINDOW = ticks(1 / 6); // a swing stays "live" ~167ms

// Baseline flight times (~10% faster than the original tuning — the default
// pace felt sluggish; the POWER custom rule scales from here)
const DRIVE_TIME = 0.76;
const LOB_TIME = 1.32;
const SMASH_TIME = 0.5;
const SMASH_MIN_Z = 6.5;
// Timed smash: a slow floater (apex above LOB_APEX_Z) can be smashed with a
// PERFECT flat swing even at normal contact height, down to SMASH_LOW_CONTACT.
const SMASH_LOW_CONTACT = 3.2;
const LOB_APEX_Z = 9;
const DRIVE_DEPTH = 26;
const LOB_DEPTH = 31;
const SMASH_DEPTH = 20;
const AIM_X = 18.7; // A/D at contact: left/right placement
const AIM_DEPTH = 12; // W/S at contact: deep drive vs short ball near the net
const MISHIT_DRIFT = 0.6;
// Auto-aim: targets past the safe line keep only this fraction of the
// overshoot, so only a big mishit can stray (barely) wide.
const AUTO_AIM_KEEP = 0.15;
// Hard cap on how far past the sideline a shot can land. Sits just beyond
// LINE_MARGIN so the very worst mishit is still barely OUT, not comfortably.
const AIM_OUT_MAX = 1.2;
// Contact-geometry layer: where the body sits relative to the ball at contact
// shapes what the shot can be (drives only — lobs already loft, smashes
// already demand high contact in front).
const LOW_CONTACT_Z = 1.6; // below: dug off the shoes — slower, lands shorter
const HIGH_CONTACT_Z = 4.8; // above (non-smash): shoulder-high floater
const STEP_IN_LEAD = 1.2; // contact this far in front = stepping in, on the rise
const CONTACT_SIDE_DEAD = 0.6; // lateral offset below this reads as centered
const OPEN_AIM_BONUS = 0.35; // swinging WITH the ball's side opens the angle
const PULL_AIM_PENALTY = 0.4; // pulling it ACROSS the body closes it...
const PULL_DRIFT_MUL = 1.3; // ...and adds error

// Risk model: SLOP (0..1) scores how bad the contact was — late timing,
// off-center contact, hitting from behind the body. Slop loosens the
// auto-aim safety net, so aiming near the lines with bad contact can
// genuinely miss. Perfect centered contact keeps today's guarantees.
const SLOP_WEAK = 0.6;
const SLOP_GOOD = 0.2;
const SLOP_BEHIND = 0.25;
const SLOP_OFFCENTER = 0.12; // per unit of lateral offset past the dead zone
const SLOP_OFFCENTER_MAX = 0.3;
const AUTO_AIM_KEEP_SLOP = 0.3; // extra kept overshoot per point of slop
const AIM_OUT_SLOP = 1.3; // extra past-the-sideline cap per point of slop
const DEPTH_OUT_SLOP = 4.0; // truly butchered deep aim can sail past the baseline
// Weak pokes close to the net lose the automatic net-clearing loft: the
// clearance is capped, low enough on poor low contact to catch the tape.
const NET_RISK_DIST = 13; // weak contact closer than this risks the net
const NET_RISK_SAFE = 1.0; // clearance a weak poke keeps at the band's edge

// PERFECT guarantee: a PERFECT-timed shot never lands wide. The aim solver
// already targets inside the lines on clean contact; only in-flight steering
// (CURL held through the shot, the screw's sidespin, custom physics) can
// carry the landing out. Each tick the guard predicts the landing point and,
// only when it would cross the guard line, re-solves the lateral accel so
// the ball comes down just inside — a smooth arc that reads as the spin
// biting, never a nudge. The guard line wobbles per flight so saturated
// shots paint different spots on the line instead of one telltale mark.
const PERFECT_GUARD_MARGIN = 0.45; // closest a guarded landing gets to the OUT threshold
const PERFECT_GUARD_WOBBLE = 0.6; // extra per-flight variation inside that
const PERFECT_GUARD_ACCEL = 60; // sanity cap on the corrective acceleration

// CURL: keep holding left/right THROUGH and after your shot and the ball
// bends that way — a tiny nudge scaled by the spin stat, pre-bounce only.
// It arms from the direction held at contact; the moment you release (or
// reverse), it disarms for the rest of the flight — no re-pressing.
const CURL_ACCEL = 4.0;
const curlDirFor = (p: PlayerRow) =>
  p.isBot || p.dirX === 0 ? 0 : p.dirX < 0 ? 1 : 2;

// Swing kinds (button pressed)
const SWING_FLAT = 0;
const SWING_LOB = 1;
const SWING_SUPER = 2; // HIT+LOB finisher — only valid on a full meter

// Timing quality, measured from ticks between button press and contact
const Q_PERFECT = 0;
const Q_GOOD = 1;
const Q_WEAK = 2;

// Characters: per-athlete stats, all multipliers around 1.0. Every edge is
// paid for elsewhere — the pip totals on the client's select screen all match
// (client/src/characters.ts mirrors this table as 1–5 pips, same order).
//   speed    run speed
//   power    drive/smash pace (divides flight time)
//   serve    serve pace (divides serve flight time)
//   spin     screw shot: curve strength + meter charge rate + hold-to-curl
//   control  aim: shrinks mishit drift
//   reach    contact radius (stand-and-hit + stretch tiers)
const CHAR_STATS = [
  { speed: 1.0, power: 1.1, serve: 1.16, spin: 0.9, control: 0.92, reach: 1.0 }, // BLAZE — power server
  { speed: 0.94, power: 0.96, serve: 1.0, spin: 1.0, control: 1.08, reach: 1.16 }, // VOLT — volley master
  { speed: 1.12, power: 0.9, serve: 0.95, spin: 1.05, control: 1.06, reach: 0.96 }, // KAI — speed demon
  { speed: 0.96, power: 1.07, serve: 1.0, spin: 0.95, control: 1.12, reach: 0.96 }, // ROSA — baseline queen
  { speed: 1.03, power: 1.0, serve: 1.02, spin: 1.0, control: 1.0, reach: 1.02 }, // VIPER — all-rounder
  { speed: 0.99, power: 0.93, serve: 0.95, spin: 1.4, control: 1.02, reach: 1.0 }, // LUNA — trick artist
  // -- wacky roster (ROSTER.md) — same pip economy, every row sums to 18 --
  { speed: 0.96, power: 0.95, serve: 1.0, spin: 1.4, control: 1.0, reach: 1.0 }, // PEELS — slippery spinner
  { speed: 1.12, power: 0.95, serve: 0.95, spin: 0.95, control: 1.12, reach: 0.96 }, // BISCUIT — good boy
  { speed: 0.96, power: 1.07, serve: 1.16, spin: 0.9, control: 1.06, reach: 0.96 }, // SERVO — serve machine
  { speed: 1.0, power: 0.95, serve: 0.95, spin: 1.05, control: 1.12, reach: 0.96 }, // ZORP — cosmic control
  { speed: 1.0, power: 1.07, serve: 1.08, spin: 1.0, control: 0.96, reach: 0.96 }, // SMASHULA — midnight smasher
  { speed: 0.96, power: 1.1, serve: 1.0, spin: 1.0, control: 0.96, reach: 1.0 }, // PLANK — cannonball power
  { speed: 0.94, power: 1.1, serve: 1.0, spin: 0.95, control: 0.96, reach: 1.16 }, // YETI — abominable reach
  { speed: 0.94, power: 0.95, serve: 1.0, spin: 1.05, control: 1.12, reach: 1.0 }, // GRANNY — crafty placement
  { speed: 1.06, power: 1.0, serve: 0.95, spin: 1.0, control: 1.0, reach: 1.0 }, // DISCO — funky footwork
  { speed: 0.96, power: 0.95, serve: 1.0, spin: 1.0, control: 1.0, reach: 1.16 }, // INKY — eight-arm wall
  { speed: 0.94, power: 1.0, serve: 1.16, spin: 0.95, control: 1.0, reach: 1.08 }, // PRICKLES — spike server
  { speed: 0.96, power: 0.95, serve: 1.0, spin: 1.4, control: 1.06, reach: 0.96 }, // MYSTO — spin sorcerer
];
const CHAR_COUNT = CHAR_STATS.length;
const charStat = (id: number) => CHAR_STATS[id] ?? CHAR_STATS[4];

// Courts: bounce restitution (vz) and surface friction (vx/vy keep factor)
const COURTS = [
  { vz: 0.5, vxy: 0.8 }, // 0 grass — fast, skiddy, low
  { vz: 0.55, vxy: 0.75 }, // 1 hard
  { vz: 0.66, vxy: 0.66 }, // 2 clay — slow, high bounce
];

// Two-press serve: press to toss, press again near the apex to strike.
const TOSS_Z0 = 6;
const TOSS_VZ = 30; // apex ≈ 12.4
const SERVE_IDEAL_Z = 12;

const PAUSE_TICKS = ticks(5.833); // between points — slow-mo replay + 2s hold on the landing
const COUNTDOWN_TICKS = ticks(3); // 3-2-1 before a match's first serve
// A match is a single set: best of 3 games, and reaching gamesToWin takes it
// outright. There is no 2-game margin — 2-1 ends the match — so 3 games is
// the hard ceiling on how long one runs.
const GAMES_TO_WIN = 2; // quick lobbies — short, arcade-length matches
const TOURNEY_GAMES_TO_WIN = 2; // tournament matches move fast

// Practice bot
const BOT_NAME = 'ACE BOT';
// Every bot plays VIPER, the all-rounder: character stats swing real strength
// (RUN 1 on PRICKLES, RCH 5 on INKY), and bracket fillers have to be equally
// tough whoever draws them.
const BOT_CHAR = 4;
const BOT_SERVE_DELAY = ticks(1.2); // before the bot tosses
const BOT_DEAD_ZONE = 0.8;
const BOT_HOME_Y = 34;
// How far past the bounce a bot reads a serve, in ticks (~1.2 s) — long
// enough for the ball to cross the whole half, short enough to stay cheap.
const SERVE_READ_STEPS = ticks(1.2);

// Bot difficulty levels (0 easy · 1 normal · 2 hard). These are the raw
// numbers per level; what a bot actually plays to is one of the two profiles
// derived below, picked by whether it is returning serve.
//   speed    movement multiplier
//   stretch  fraction of STRETCH_REACH the bot can use
//   lunge    fraction of LUNGE_REACH (0 = never dives)
//   perfect  chance a clean hit is PERFECT
//   weak     chance a clean hit is WEAK
//   whiff    chance the bot doesn't swing at a return at all
//   aimErr   lateral error (world units) in its landing prediction
//   serveVz  toss vz at which the bot strikes its serve (lower = worse serve)
const BOT_LEVELS = [
  { speed: 0.78, stretch: 0.5, lunge: 0.0, perfect: 0.0, weak: 0.55, whiff: 0.2, aimErr: 3.2, serveVz: -26 },
  { speed: 0.9, stretch: 1.0, lunge: 0.45, perfect: 0.06, weak: 0.22, whiff: 0.07, aimErr: 1.6, serveVz: -20 },
  { speed: 1.0, stretch: 1.0, lunge: 1.0, perfect: 0.15, weak: 0.0, whiff: 0.0, aimErr: 0.0, serveVz: 2 },
];

// Returning serve is its own skill, and the bots were badly short of it:
// they read the serve's bounce in the service box, sprinted forward to a
// mark the ball was already leaving, and got aced. So the level's dials are
// no longer flat — a bot plays a serve return to a sharpened profile and
// ordinary rally play 10% below its level.
//   returning  multipliers applied while a served ball is in flight
//   rally      one dial: capability x0.9, and the stats that HURT the bot
//              (weak contact, whiffs, misread landings) /0.9 instead
const BOT_RETURN_MUL = {
  speed: 1.12, stretch: 1.35, lunge: 1.8, perfect: 1, weak: 0.6, whiff: 0.15, aimErr: 0.3,
};
const BOT_RALLY_SCALE = 0.9;

type BotDials = Omit<(typeof BOT_LEVELS)[number], 'serveVz'>;

// Both profiles are fixed per level, so they are derived once here rather
// than rebuilt on every tick. serveVz is left out: it dials the bot's OWN
// serve, which neither profile touches.
const BOT_RETURN_DIALS: BotDials[] = BOT_LEVELS.map(l => ({
  speed: Math.min(1, l.speed * BOT_RETURN_MUL.speed),
  stretch: Math.min(1, l.stretch * BOT_RETURN_MUL.stretch),
  lunge: Math.min(1, l.lunge * BOT_RETURN_MUL.lunge),
  perfect: Math.min(1, l.perfect * BOT_RETURN_MUL.perfect),
  weak: l.weak * BOT_RETURN_MUL.weak,
  whiff: l.whiff * BOT_RETURN_MUL.whiff,
  aimErr: l.aimErr * BOT_RETURN_MUL.aimErr,
}));
const BOT_RALLY_DIALS: BotDials[] = BOT_LEVELS.map(l => ({
  speed: l.speed * BOT_RALLY_SCALE,
  stretch: l.stretch * BOT_RALLY_SCALE,
  lunge: l.lunge * BOT_RALLY_SCALE,
  perfect: l.perfect * BOT_RALLY_SCALE,
  weak: Math.min(1, l.weak / BOT_RALLY_SCALE),
  whiff: Math.min(1, l.whiff / BOT_RALLY_SCALE),
  aimErr: l.aimErr / BOT_RALLY_SCALE,
}));

// Rulesets — how a lobby's matches are scored
const RULES_TENNIS = 0;
const RULES_BEERPONG = 1;
const RULES_TARGETS = 2;

// Beer pong: a triangle of 6 cups per side, apex toward the net. Sink a shot
// (first bounce inside a cup) to remove it; clear all 6 opponent cups to win.
const CUP_RADIUS = 2.2;
const CUP_LAYOUT: [number, number][] = [
  [0, 23],
  [-2.75, 27], [2.75, 27],
  [-5.5, 31], [0, 31], [5.5, 31],
];
const BEERPONG_PAUSE = ticks(1.833); // between throws — quick turn-around
// Throw accuracy: the intended cup is the nearest live one to your stick
// intent; strike timing sets the scatter radius around it (cup radius 2.2,
// so PERFECT nearly always sinks, GOOD ~40%, WEAK is a prayer).
const THROW_SCATTER = [1.8, 3.0, 5.5]; // indexed by Q_PERFECT/Q_GOOD/Q_WEAK
const THROW_TIME = 1.15; // lofted arc, seconds

// Target practice: solo drill — the machine feeds TARGET_BALLS serves, hit
// every bullseye on the far side (first bounce inside the ring scores).
const TARGET_RADIUS = 2.6;
const TARGET_BALLS = 20;
const TARGET_LAYOUT: [number, number][] = [
  [-13, 17], [13, 17], [0, 21], [-8, 26], [8, 26], [0, 31], [-14, 33], [14, 33],
];
const TARGETS_PAUSE = ticks(1.5);

// Custom-rules physics multiplier bounds
const PHYS_GRAVITY_RANGE = [0.3, 2.5];
const PHYS_DRAG_RANGE = [0, 0.6];
const PHYS_SPEED_RANGE = [0.5, 1.8];
const PHYS_BOUNCE_RANGE = [0.4, 1.6];

// Match phases
const PHASE_SERVE = 1;
const PHASE_RALLY = 2;
const PHASE_POINT_OVER = 3;
const PHASE_GAME_OVER = 4;

// Match lifecycle
const M_PENDING = 0;
const M_LIVE = 1;
const M_DONE = 2;

// Lobby modes / status
const MODE_QUICK = 0;
const MODE_TOURNAMENT = 1;
const L_OPEN = 0; // quick: waiting for opponent · tournament: registration
const L_RUNNING = 1;
const L_FINISHED = 2;

const NO_WINNER = 255;
const MAX_TOURNAMENT_PLAYERS = 16;
// Team play: a side holds up to 3 players (lobby.teamSize picks 1v1/2v2/3v3)
const MAX_TEAM_SIZE = 3;

// Tournament formats
const FORMAT_SINGLE = 0; // lose once and you're out
const FORMAT_DOUBLE = 1; // drop to the losers bracket; lose twice and you're out

// Which bracket a tournament match belongs to
const BR_WINNERS = 0;
const BR_LOSERS = 1;
const BR_FINAL = 2; // grand final: winners-bracket champ vs losers-bracket champ

// ---------------------------------------------------------------------------
// Tournament betting: idle (non-playing) members of a tournament room stake
// credits on the matches they are watching. Odds open from each unit's
// tournament performance and are then corrected by the money itself.
// ---------------------------------------------------------------------------
const BET_STARTING_CREDITS = 1500;
const BET_MIN_STAKE = 10;
// Matches can go live the instant a round is drawn, so a tournament match
// with someone able to bet on it opens with a longer countdown: this window
// plus the usual 3-2-1.
const BET_WINDOW_TICKS = ticks(12);
// Virtual credits backing the opening line. This is the market's stiffness:
// a big bet moves the odds noticeably, but one bettor can't peg them.
const BET_SEED_TOTAL = 1000;
const BET_PRIOR_MIN = 0.15; // prior clamp — opening odds stay inside ~1.18x-6.7x
const BET_ODDS_MIN_MILLI = 1050; // decimal odds x1000: 1.05x floor...
const BET_ODDS_MAX_MILLI = 20000; // ...20x ceiling
// Bet lifecycle
const B_OPEN = 0;
const B_WON = 1;
const B_LOST = 2;

// ---------------------------------------------------------------------------
// Accounts: the persistent profile behind an identity. SpacetimeDB derives an
// identity by hashing a JWT's iss+sub, so a Firebase token yields the SAME
// identity forever — which is what makes XP, MMR and reconnect mean anything.
// ---------------------------------------------------------------------------
// Set this to the Firebase project id when the project is created. The module
// runs in a wasm sandbox with no env access, so it is a source constant by
// necessity. Only used to tell a Firebase token apart from any other issuer.
const FIREBASE_PROJECT = 'digital-football';
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT}`;

const PROV_NONE = 0; // raw SpacetimeDB token (local dev, legacy client)
const PROV_ANON = 1; // Firebase anonymous
const PROV_LINKED = 2; // Firebase + a real provider (Google, password, …)
const PROV_OTHER = 3; // some other issuer — accepted, but flagged

// XP: every finished match pays out, in every mode. Casual matches (anything
// with a bot on court, or a non-tennis ruleset) pay half.
const XP_PLAY = 50; // finishing a match at all
const XP_PER_GAME = 25; // per game won
const XP_WIN = 100; // winner's bonus
const XP_CASUAL_MUL = 50; // percent, applied to casual matches
// Level L -> L+1 costs LEVEL_BASE + LEVEL_STEP*(L-1), so the total XP needed
// to REACH level L closes to 50*(L-1)*(L+2). Mirrored in client/src/config.ts.
const LEVEL_BASE = 200;
const LEVEL_STEP = 100;
const LEVEL_MAX = 99;
const LOG_KEEP = 20; // match_log rows kept per account

// MMR: Elo, K-factor by experience so new accounts find their level fast and
// settled ones stop swinging.
const MMR_START = 1000;
const MMR_FLOOR = 100;
const MMR_CEIL = 4000;
const K_PLACEMENT = 48; // first PLACEMENT_MATCHES ranked matches
const K_EARLY = 32; // up to SETTLED_MATCHES
const K_SETTLED = 24; // thereafter
const PLACEMENT_MATCHES = 10;
const SETTLED_MATCHES = 30;

// How a match ended — shapes the XP payout and lands in the match log.
const END_PLAYED = 0;
const END_FORFEIT = 1;
const END_TIMEOUT = 2;

// Reconnect: a dropped player's match HALTS instead of being forfeited. All
// in microseconds, to compare against ctx.timestamp directly.
const GRACE_QUICK = 300_000_000n; // 5 min
const GRACE_TOURNEY = 120_000_000n; // 2 min — rounds run as waves; a 5-minute
// stall on one dropped player stalls the whole bracket behind them
const CLAIM_UNLOCK = 60_000_000n; // opponent may end it early after 1 min
const REAP_AFTER = 60_000_000n; // room teardown, after the longest grace

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
    court: t.u8(),
    concurrent: t.u8(), // tournament: how many matches run at once
    championName: t.string(),
    createdAt: t.timestamp(),
    ruleset: t.u8().default(0), // 0 tennis · 1 beer pong · 2 target practice
    botLevel: t.u8().default(1), // 0 easy · 1 normal · 2 hard
    // Custom rules — ball physics multipliers (1 = standard, dragMul 0 = none)
    gravityMul: t.f32().default(1),
    dragMul: t.f32().default(0),
    speedMul: t.f32().default(1),
    bounceMul: t.f32().default(1),
    // NOTE: new columns must be APPENDED — inserting mid-table breaks
    // SpacetimeDB's automatic migration (table reorder).
    isPublic: t.bool().default(false), // listed in the public lobby browser
    format: t.u8().default(0), // tournament: 0 single elim · 1 double elim
    teamSize: t.u8().default(1), // players per side: 1 = singles, 2 = doubles
    // NOTE: appended columns — the betting crown, decided when the champion
    // is crowned. A tournament ends with two winners: the one who won on
    // court, and the one who read the bracket best from the stands.
    betWinnerName: t.string().default(''), // '' = nobody ever placed a bet
    betWinnerCredits: t.u32().default(0),
  }
);

// Beer pong cups and practice bullseyes: one row per target on the court.
// Sunk/hit targets stay as rows (alive=false) so clients can animate them.
const Target = table(
  {
    name: 'target',
    public: true,
    indexes: [{ accessor: 'byMatch', algorithm: 'btree', columns: ['matchId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64(),
    side: t.u8(), // which half of the court the target sits in
    x: t.f32(),
    y: t.f32(),
    radius: t.f32(),
    alive: t.bool(),
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
    slot: t.u8(), // bracket position within the round
    state: t.u8(), // 0 pending · 1 live · 2 done
    p0Id: t.identity(),
    p1Id: t.identity(),
    hasP1: t.bool(), // false = bye, p0 advances automatically
    phase: t.u8(),
    p0Points: t.u8(),
    p1Points: t.u8(),
    p0Games: t.u8(),
    p1Games: t.u8(),
    gamesToWin: t.u8(),
    servingSide: t.u8(),
    pauseTicks: t.u16(),
    pointMsg: t.string(),
    winnerSide: t.u8(),
    rematchVotes: t.u8(), // quick lobbies only
    startTicks: t.u16().default(0), // match-start 3-2-1 countdown, ticks left
    // NOTE: appended column (see Lobby) — 0 winners · 1 losers · 2 grand final
    bracket: t.u8().default(0),
    // RETIRED: a match is now a single set (best of 3 games), so there is no
    // set tier left to count and these stay 0 forever. Nothing reads them —
    // they are kept only so the published schema and the generated client
    // bindings don't need a migration. Drop them next time the DB is cleared.
    p0Sets: t.u8().default(0),
    p1Sets: t.u8().default(0),
    // NOTE: appended columns — points won across the WHOLE match. p0Points/
    // p1Points reset every game, so a finished row otherwise keeps no
    // performance signal finer than the games score; the betting odds prior
    // reads these.
    p0PtsTotal: t.u16().default(0),
    p1PtsTotal: t.u16().default(0),
    // NOTE: appended columns — reconnect. A dropped player HALTS the match
    // instead of forfeiting it. The deadline is absolute (micros since epoch)
    // rather than a tick counter, so the countdown needs no per-tick write:
    // the row is written once on halt and once on resume, and the client
    // renders the clock from wall time the way it already extrapolates the
    // ball.
    haltMask: t.u8().default(0), // bit 0 = side 0 is short a player, bit 1 = side 1
    haltedAt: t.u64().default(0n), // micros when the halt began (claim unlock reads it)
    haltUntil: t.u64().default(0n), // micros when the grace expires (0 = not halted)
    haltName: t.string().default(''), // who we are waiting for, for the banner
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
    lobbyId: t.u64(), // 0 = not in a room
    matchId: t.u64(), // 0 = not playing (waiting/spectating)
    side: t.u8(), // side within the current match
    eliminated: t.bool(),
    x: t.f32(),
    y: t.f32(),
    dirX: t.i8(),
    dirY: t.i8(),
    swingTicks: t.u8(),
    swingKind: t.u8(),
    swingHeld: t.bool(),
    lungeTicks: t.u8(),
    characterId: t.u8(),
    momentum: t.u16(), // 0..1000 perfect-hit meter; grants speed while charged
    online: t.bool(),
    isBot: t.bool(),
    // NOTE: appended column (see Lobby) — joined a room to watch, never to
    // compete. Spectators hold no match slot and never keep a room alive.
    spectator: t.bool().default(false),
    // doubles: which of the side's two seats this player holds (0 or 1);
    // always 0 in singles
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
    lastHitSide: t.u8(),
    bounces: t.u8(),
    rallyHits: t.u8(),
    spinX: t.f32(), // lateral acceleration: the SCREW SHOT curves for real
    // aimContactZ = launch height of the current flight (the lob-climb
    // detector reads it). aimKind is repurposed as the armed CURL direction
    // (0 none · 1 left · 2 right — set from the stick held at contact;
    // releasing disarms it for the rest of the flight). aimQuality is
    // repurposed as the flight's timing quality, stored as Q_* + 1 (0 =
    // none, e.g. beer pong throws) — the PERFECT guarantee reads it.
    // aimBehind is repurposed as "this flight is a serve", which is what
    // tells a bot to read the ball through its bounce and to play the shot
    // on its serve-return dials. The other aim* columns are dead — kept
    // only to avoid a manual migration.
    aimGraceTicks: t.u8().default(0),
    aimQuality: t.u8().default(0),
    aimKind: t.u8().default(0),
    aimBehind: t.bool().default(false),
    aimContactZ: t.f32().default(0),
    aimDriftBase: t.f32().default(0), // ball.x - player.x at contact
    aimLeadY: t.f32().default(0), // contact distance in front of the body (signed)
    apexZ: t.f32().default(0), // highest z since the last hit — lob detector
    aimApexZ: t.f32().default(0), // incoming ball's apex at contact
    // NOTE: appended column (see Lobby) — hitstop: ticks the ball stays
    // pinned at the contact point before the loaded velocity applies
    freezeTicks: t.u8().default(0),
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
// Rows are only written when a message is ACCEPTED: rejections throw
// SenderError, which rolls back the transaction, so state written before a
// throw could never persist anyway.
const ChatGuard = table(
  { name: 'chat_guard' },
  {
    identity: t.identity().primaryKey(),
    windowStart: t.u64(), // micros since epoch — start of the current burst window
    windowCount: t.u8(), // messages accepted inside that window
    lastAt: t.u64(), // micros of the last accepted message (chat or emote)
    lastText: t.string(), // last accepted chat text, lowercased — duplicate filter
  }
);

// Team membership for team lobbies (2v2/3v3): one row per member. The team
// is identified by its captain's identity — brackets pair captains, and
// goLive seats every member of the two captains' teams. Quick team rooms
// rebuild these from the seat layout whenever a match starts; tournament
// rooms draw them once when the host starts.
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
    slot: t.u8(), // seat within the team (0 = captain)
  }
);

// Betting wallet — one row per human per tournament room. Rows survive a
// leave/rejoin (so nobody re-farms a fresh 1500) and die with the room.
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
    balance: t.u32(), // spendable credits
    staked: t.u32(), // locked in bets that haven't settled yet
    won: t.u32(), // settled winnings (payout total)
    lost: t.u32(), // settled losses (stake total)
  }
);

// One bet: a side, a stake, and the odds LOCKED when it was placed — later
// bets move the line for the next bettor, never for a slip already written.
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
    bettorName: t.string(), // denormalized — the feed reads it after they leave
    side: t.u8(), // 0 = p0's side (captain 0 in team play) · 1 = p1's
    stake: t.u32(),
    oddsMilli: t.u32(), // decimal odds x1000 (1850 = 1.85x)
    state: t.u8(), // 0 open · 1 won · 2 lost
    payout: t.u32(), // stake x odds on a win, else 0
    placedAt: t.timestamp(),
  }
);

// The market for one match. Odds are server-authoritative: the client only
// renders this row and place_bet locks from it, so the price can never drift.
const Book = table(
  { name: 'book', public: true },
  {
    matchId: t.u64().primaryKey(),
    lobbyId: t.u64(),
    open: t.bool(),
    priorMilli: t.u32(), // performance-implied P(side 0) x1000
    seed0: t.u32(), // virtual pools from the prior — never paid out
    seed1: t.u32(),
    pool0: t.u32(), // real credits staked per side
    pool1: t.u32(),
    odds0Milli: t.u32(), // current decimal odds x1000
    odds1Milli: t.u32(),
  }
);

// The first table in this database that OUTLIVES a room. Everything else —
// lobby, match, player, ball, wallet — dies with the game it belongs to, so
// this one carries the whole persistence contract: columns are APPEND-ONLY
// (see the NOTE in Lobby) and a publish that would clear the database now
// destroys real player progress (spacetimedb/publish.sh guards that).
// Kept small and cold: written twice per match, never per tick. Anything
// parked on `player` would be re-broadcast 30x a second instead.
const Account = table(
  {
    name: 'account',
    public: true,
    indexes: [{ accessor: 'byMmr', algorithm: 'btree', columns: ['mmr'] }],
  },
  {
    identity: t.identity().primaryKey(),
    uid: t.string(), // Firebase uid ('' for a raw SpacetimeDB token)
    provider: t.u8(), // PROV_*
    displayName: t.string(), // source of truth; player.name is the session copy
    characterId: t.u8(), // last pick, restored on any device
    xp: t.u32(),
    level: t.u16(), // derived from xp, stored so the client can't drift
    mmr: t.u16(),
    peakMmr: t.u16(),
    ranked: t.u16(), // ranked matches finished (drives the K-factor)
    rankedWins: t.u16(),
    casual: t.u16(), // bot / non-tennis matches finished
    casualWins: t.u16(),
    streak: t.i16(), // + wins in a row, - losses in a row
    bestStreak: t.u16(),
    quits: t.u16(), // forfeits + disconnect timeouts, on your record
    createdAt: t.timestamp(),
    lastSeen: t.timestamp(),
  }
);

// One row per human per finished match. Powers the post-match XP/MMR reveal —
// the client reads its own newest row rather than diffing a snapshot that a
// mid-match reconnect would have thrown away — and is the only record of a
// result that cannot be reconstructed later. Private: read through the
// my_match_log view, which filters to the caller.
const MatchLog = table(
  {
    name: 'match_log',
    indexes: [{ accessor: 'byAccount', algorithm: 'btree', columns: ['identity'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity(),
    matchId: t.u64(), // which match this was — the reveal matches on it
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
    endedBy: t.u8(), // END_*
    playedAt: t.timestamp(),
  }
);

// One row per live websocket. An identity can hold several at once (two tabs,
// or a reconnect that races the old socket's close), so presence is "has at
// least one session" — never "the last disconnect wins". Without this, a
// Firebase identity shared by two tabs would halt a live match every time one
// of them closed, and a reconnect that beat the old socket's close event
// would immediately re-halt the match it had just resumed.
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

// Fires once, when a halted match's grace window expires. A halted match
// costs exactly this one scheduled call — its 30 Hz tick timer is deleted for
// the duration — instead of 9000 no-op ticks over five minutes.
const GraceTimer = table(
  { name: 'grace_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u64(),
  }
);

// Fires once, when a room whose humans have all gone dark should be torn
// down. Reconnect creates a leak that did not exist before: a disconnected
// player still occupies their lobby, so the "last human left" teardown in
// leaveCurrentLobby never runs for a room where everyone dropped.
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
  chat: Chat,
  chatGuard: ChatGuard,
  tickTimer: TickTimer,
  target: Target,
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
type TargetRow = typeof Target.rowType.type;
type WalletRow = typeof Wallet.rowType.type;
type BookRow = typeof Book.rowType.type;
type AccountRow = typeof Account.rowType.type;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sideSign = (side: number) => (side === 0 ? -1 : 1);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sameId = (a: Identity, b: Identity) => a.toHexString() === b.toHexString();

// Deterministic pseudo-random in [0,1) — reducers may not use Math.random.
const hash01 = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// Synthetic identity for one of a lobby's bots. A room can hold several
// (index 0 is the practice bot; tournaments add one per empty bracket seat),
// so the index rides in the bits above the lobby id and can never collide
// with another room's bots.
const botIdentity = (lobbyId: bigint, index = 0) =>
  new Identity(0xb07_00000000_00000000_00000000n + (BigInt(index) << 64n) + lobbyId);

// Megabonk rule: +6% speed per exchange, capped at +80%.
function rallyFactor(rallyHits: number): number {
  return 1 + Math.min(0.8, rallyHits * 0.06);
}
// The lob is the counter-tool: its flight time never inherits rally heat (a
// lob always floats like a lob) and it cools the counter, so the exchanges
// after it start slower. Counterplay stays intact — a floater invites a smash.
const LOB_COOL_HITS = 4; // takes ~24% off the rally speed

// HITSTOP (Lethal League style): deep into a heated rally, every FAST hit
// pins the ball at the contact point for a beat — the launch velocity is
// already loaded, only integration waits — and locks the hitter mid-swing,
// so only the defender may reposition and read the shot. Kicks in at
// HITSTOP_MIN_HITS exchanges (rally speed is at its +80% cap well before
// then) and grows with the rally. Lobs never trigger it: a lob always
// floats, so the freeze only ever accompanies a genuinely fast ball.
const HITSTOP_MIN_HITS = 20;
const HITSTOP_BASE_TICKS = ticks(0.133);
const HITSTOP_MAX_TICKS = ticks(0.333); // deep into a max-heat rally
function hitstopTicks(rallyHits: number): number {
  if (rallyHits < HITSTOP_MIN_HITS) return 0;
  return Math.min(
    HITSTOP_MAX_TICKS,
    HITSTOP_BASE_TICKS + Math.floor((rallyHits - HITSTOP_MIN_HITS) / 2)
  );
}

// Perfect-hit momentum: +250 per PERFECT (of 1000); never drains on its own —
// only the SCREW SHOT spends it. Grants up to +25% movement speed.
const MOMENTUM_GAIN = 250;
const MOMENTUM_MAX = 1000;
// The spin stat scales the charge: LUNA fills the meter in 3 PERFECTs, most
// athletes in 4, and the pure power hitters (spin < 1) need 5.
function momentumGain(characterId: number): number {
  return Math.round(MOMENTUM_GAIN * charStat(characterId).spin);
}
function momentumFactor(momentum: number): number {
  return 1 + (momentum / MOMENTUM_MAX) * 0.25;
}

// Directional reach: full to the SIDES, 0.8x in FRONT, 0.3x BEHIND, and
// high balls shrink it further. Normalized against REACH and the tiers.
function effectiveDist(
  px: number, py: number, side: number,
  bx: number, by: number, bz: number
): number {
  const frontSign = -sideSign(side);
  const lx = Math.abs(bx - px);
  const lyRaw = (by - py) * frontSign;
  const wy = lyRaw >= 0 ? 0.8 : 0.3;
  let d = Math.hypot(lx, lyRaw / wy);
  if (bz > 4.5) d *= 1 + ((bz - 4.5) / 10) * 0.8;
  return d;
}

// Timing windows measured from the press, in SECONDS — at 30 Hz these were
// hardcoded as <=1 and <=3 ticks, which would silently become a 4x harsher
// window at 120 Hz.
const PERFECT_WINDOW = ticks(1 / 30);
const GOOD_WINDOW = ticks(0.1);

function swingQuality(swingTicksAtContact: number): number {
  const elapsed = SWING_WINDOW - swingTicksAtContact;
  if (elapsed <= PERFECT_WINDOW) return Q_PERFECT;
  if (elapsed <= GOOD_WINDOW) return Q_GOOD;
  return Q_WEAK;
}

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

// The non-spectator humans competing in a room (doubles: the four seats).
function lobbyCompetitors(ctx: Ctx, lobbyId: bigint): PlayerRow[] {
  return lobbyPlayers(ctx, lobbyId).filter(p => !p.isBot && !p.spectator);
}

// Team serve rotation: sides alternate every game (servingSide flips in
// awardPoint); WITHIN a side the teammates take turns, so across games
// 0,1,2,... the server is A0, B0, A1, B1 (A2, B2 in 3v3) — everyone serves.
// Games no longer reset mid-match (a match is one set), so the running game
// count IS the rotation. A match is only 2-3 games long, so a sweep can end
// before slot 1 ever serves — that is the cost of the short format.
function servingSlot(match: MatchRow, teamSize: number): number {
  const served = Math.floor((match.p0Games + match.p1Games) / 2);
  return served % Math.max(1, teamSize);
}

function isDesignatedServer(match: MatchRow, p: PlayerRow, teamSize: number): boolean {
  if (p.side !== match.servingSide) return false;
  return teamSize < 2 || p.teamSlot === servingSlot(match, teamSize);
}

type TeamRow = typeof Team.rowType.type;

function deleteTeams(ctx: Ctx, lobbyId: bigint) {
  for (const row of ctx.db.team.byLobby.filter(lobbyId)) ctx.db.team.id.delete(row.id);
}

// Register one team: members[0] is the captain the brackets pair on.
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

// Bracket display / champion name for a captain-identified unit: the joined
// member names for a team, or just the player's name in a 1v1 bracket.
function unitName(ctx: Ctx, lobbyId: bigint, captainId: Identity): string {
  const rows = teamRowsOf(ctx, lobbyId, captainId);
  const ids = rows.length ? rows.map(r => r.memberId) : [captainId];
  return ids
    .map(id => ctx.db.player.identity.find(id)?.name || 'PLAYER')
    .join(' & ');
}

// Scoreboard name for a side: the player's name in singles, "A & B" in doubles.
function teamName(players: PlayerRow[], side: number): string {
  const names = players
    .filter(p => p.side === side)
    .sort((a, b) => a.teamSlot - b.teamSlot)
    .map(p => p.name || 'PLAYER');
  return names.join(' & ') || `Player ${side + 1}`;
}

// "BLAZE WINS!" but "BLAZE & VOLT WIN!" — team labels take the plural verb.
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

// Drive a match's simulation. Split out of goLive because reconnect stops and
// restarts the clock: a halted match has no tick timer at all.
function startTicking(ctx: Ctx, matchId: bigint) {
  deleteTickTimers(ctx, matchId); // never run two clocks on one match
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

function deleteTargets(ctx: Ctx, matchId: bigint) {
  for (const tg of ctx.db.target.byMatch.filter(matchId)) ctx.db.target.id.delete(tg.id);
}

// Custom-rules physics resolved from the lobby (defaults = standard tennis).
interface Phys {
  gravity: number; // world gravity for the ball (< 0)
  drag: number; // exponential velocity damping per second
  speed: number; // shot-speed multiplier (divides flight time)
  bounce: number; // restitution multiplier on top of the court surface
}
function lobbyPhysics(lobby: LobbyRow | null | undefined): Phys {
  return {
    gravity: GRAVITY * (lobby?.gravityMul ?? 1),
    drag: lobby?.dragMul ?? 0,
    speed: lobby?.speedMul ?? 1,
    bounce: lobby?.bounceMul ?? 1,
  };
}

// Give velocity so the ball lands exactly at (tx, ty) after `time` seconds.
function aimBall(ball: BallRow, tx: number, ty: number, time: number, gravity = GRAVITY): BallRow {
  return {
    ...ball,
    vx: (tx - ball.x) / time,
    vy: (ty - ball.y) / time,
    vz: -ball.z / time - 0.5 * gravity * time,
  };
}

// Like aimBall, but lofts the shot just enough to clear the net.
function aimBallClearingNet(
  ball: BallRow, tx: number, ty: number, time: number, gravity = GRAVITY
): BallRow {
  let tm = time;
  for (let i = 0; i < 7; i++) {
    const b = aimBall(ball, tx, ty, tm, gravity);
    if (Math.sign(b.y) === Math.sign(ty) || Math.abs(b.vy) < 0.01) return b;
    const tNet = -b.y / b.vy;
    if (tNet <= 0 || tNet >= tm) return b;
    const zNet = b.z + b.vz * tNet + 0.5 * gravity * tNet * tNet;
    if (zNet >= NET_HEIGHT + 1.0) return b;
    tm *= 1.13;
  }
  return aimBall(ball, tx, ty, tm, gravity);
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------
function setupServe(ctx: Ctx, match: MatchRow): MatchRow {
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  const teamSize = lobbyTeamSize(lobby);
  const totalPoints = match.p0Points + match.p1Points;
  const serveCourtX = (totalPoints % 2 === 0 ? 1 : -1) * -sideSign(match.servingSide) * 7;
  const srvSlot = servingSlot(match, teamSize);
  const recvSlot = totalPoints % Math.max(1, teamSize); // receivers rotate too
  const teamRows = matchPlayers(ctx, match.id);
  for (const p of teamRows) {
    const baselineY = sideSign(p.side) * (COURT_HALF_LEN + 3);
    let x = p.side === match.servingSide ? serveCourtX : -serveCourtX;
    let y = baselineY;
    if (teamSize >= 2) {
      // the active server/receiver take the baseline on the serve's diagonal;
      // their teammates cover the rest of the width up at the service line
      // (one partner: the other half; two partners: both alleys)
      const serving = p.side === match.servingSide;
      const active = p.teamSlot === (serving ? srvSlot : recvSlot);
      if (active) {
        x = (serving ? 1 : -1) * serveCourtX;
      } else {
        const mates = teamRows
          .filter(m => m.side === p.side && m.teamSlot !== (serving ? srvSlot : recvSlot))
          .sort((a, b) => a.teamSlot - b.teamSlot);
        const i = mates.findIndex(m => sameId(m.identity, p.identity));
        x =
          mates.length <= 1
            ? (serving ? -1 : 1) * serveCourtX
            : i === 0
              ? -14
              : 14;
        y = sideSign(p.side) * 15;
      }
    }
    ctx.db.player.identity.update({ ...p, x, y, dirX: 0, dirY: 0, swingTicks: 0 });
  }
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false, bounces: 0, rallyHits: 0 });
  // a bot on serve needs a beat before it tosses (the target-practice ball
  // machine is a bot too, so its feeds pace themselves the same way)
  const botServing = teamRows.some(p => p.isBot && isDesignatedServer(match, p, teamSize));
  const updated = {
    ...match,
    phase: PHASE_SERVE,
    pauseTicks: botServing ? BOT_SERVE_DELAY : 0,
    pointMsg: '',
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
  gamesToWin: number,
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
    phase: p1Id ? PHASE_SERVE : PHASE_GAME_OVER,
    p0Points: 0, p1Points: 0, p0Games: 0, p1Games: 0, p0Sets: 0, p1Sets: 0,
    gamesToWin,
    servingSide: 0,
    pauseTicks: 0,
    pointMsg: p1Id ? '' : 'BYE — advances automatically',
    winnerSide: p1Id ? NO_WINNER : 0,
    rematchVotes: 0,
    startTicks: 0,
    p0PtsTotal: 0,
    p1PtsTotal: 0,
    haltMask: 0,
    haltedAt: 0n,
    haltUntil: 0n,
    haltName: '',
  });
  // Betting opens with the pairing, not with the match: a match waiting behind
  // the concurrency limit takes bets for the whole wait.
  openBook(ctx, lobby, row);
  return row;
}

// Take a pending match live: assign players, spawn ball + tick.
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
        momentum: 0,
        lungeTicks: 0,
        swingTicks: 0,
      });
    }
  };
  if (lobbyTeamSize(liveLobby) >= 2) {
    // team play: p0/p1 are the two captains — seat every member of both
    // teams (quick rooms and tournaments alike register teams up front)
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
  if (!ctx.db.ball.matchId.find(match.id)) {
    ctx.db.ball.insert({
      matchId: match.id,
      active: false,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      lastHitSide: 0,
      bounces: 0,
      rallyHits: 0,
      spinX: 0,
      apexZ: 0,
      aimGraceTicks: 0,
      aimQuality: 0,
      aimKind: 0,
      aimBehind: false,
      aimContactZ: 0,
      aimDriftBase: 0,
      aimLeadY: 0,
      aimApexZ: 0,
      freezeTicks: 0,
    });
  }
  startTicking(ctx, match.id);
  const modeLobby = ctx.db.lobby.id.find(match.lobbyId);
  spawnModeTargets(ctx, modeLobby, match.id);
  const live = setupServe(ctx, {
    ...match,
    state: M_LIVE,
    phase: PHASE_SERVE,
    winnerSide: NO_WINNER,
    // target practice: the ball machine (side 1) feeds every ball
    servingSide: modeLobby?.ruleset === RULES_TARGETS ? 1 : match.servingSide,
  });
  // Every match — quick, bot, tournament, any mode — opens on a 3-2-1. A
  // tournament match somebody could bet on gets a betting window in front of
  // it (players are already seated above, so they don't count as idle).
  const bettable =
    modeLobby?.mode === MODE_TOURNAMENT &&
    match.hasP1 &&
    hasIdleBettor(ctx, match.lobbyId);
  ctx.db.match.id.update({
    ...live,
    startTicks: COUNTDOWN_TICKS + (bettable ? BET_WINDOW_TICKS : 0),
  });
  // A tournament can draw a round while one of its entrants is mid-drop. Halt
  // on the spot rather than starting the countdown into an empty chair and
  // waiting a tick to notice.
  const away = matchPlayers(ctx, match.id).find(
    p => !p.isBot && !p.spectator && !hasSession(ctx, p.identity)
  );
  if (away) syncPresence(ctx, match.id, away.name);
}

// Lay out the mode's targets: beer pong cups on both halves, or the practice
// drill's bullseyes on the machine's half.
function spawnModeTargets(ctx: Ctx, lobby: LobbyRow | null | undefined, matchId: bigint) {
  deleteTargets(ctx, matchId);
  if (!lobby) return;
  if (lobby.ruleset === RULES_BEERPONG) {
    for (const side of [0, 1]) {
      for (const [x, y] of CUP_LAYOUT) {
        ctx.db.target.insert({
          id: 0n, matchId, side, x, y: y * sideSign(side), radius: CUP_RADIUS, alive: true,
        });
      }
    }
  } else if (lobby.ruleset === RULES_TARGETS) {
    for (const [x, y] of TARGET_LAYOUT) {
      ctx.db.target.insert({
        id: 0n, matchId, side: 1, x, y, radius: TARGET_RADIUS, alive: true,
      });
    }
  }
}

// Beer pong: any dead ball that didn't sink a cup — no score, next serve.
function beerPongNextServe(ctx: Ctx, match: MatchRow, msg: string) {
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false });
  ctx.db.match.id.update({
    ...match,
    phase: PHASE_POINT_OVER,
    pauseTicks: BEERPONG_PAUSE,
    servingSide: 1 - match.servingSide,
    pointMsg: msg,
  });
}

// Beer pong: first bounce landed inside a live cup — sink it.
function beerPongSink(ctx: Ctx, match: MatchRow, cup: TargetRow, sinkerSide: number) {
  ctx.db.target.id.update({ ...cup, alive: false });
  const remaining = [...ctx.db.target.byMatch.filter(match.id)].filter(
    tg => tg.side === cup.side && tg.alive
  ).length;
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false });
  const name =
    matchPlayers(ctx, match.id).find(p => p.side === sinkerSide)?.name ?? 'PLAYER';
  const scored = {
    ...match,
    p0Points: match.p0Points + (sinkerSide === 0 ? 1 : 0),
    p1Points: match.p1Points + (sinkerSide === 1 ? 1 : 0),
  };
  if (remaining === 0) {
    finishMatch(ctx, scored, sinkerSide, `${name} CLEARS THE CUPS!`);
  } else {
    ctx.db.match.id.update({
      ...scored,
      phase: PHASE_POINT_OVER,
      pauseTicks: PAUSE_TICKS, // full pause — the sink deserves its replay
      servingSide: cup.side, // the side that got sunk on serves next
      pointMsg: `SPLASH! ${name} SINKS A CUP — ${remaining} LEFT`,
    });
  }
}

// Target practice: every dead ball consumes a feed; rings only score on a hit.
function targetsBallDone(ctx: Ctx, match: MatchRow, hitTarget: TargetRow | null) {
  if (hitTarget) ctx.db.target.id.update({ ...hitTarget, alive: false });
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false });
  const hits = match.p0Points + (hitTarget ? 1 : 0);
  const used = match.p1Points + 1; // p1Points doubles as the feed counter
  const remaining = [...ctx.db.target.byMatch.filter(match.id)].filter(tg => tg.alive).length;
  const ballsLeft = TARGET_BALLS - used;
  const scored = { ...match, p0Points: hits, p1Points: used };
  if (remaining === 0 || ballsLeft <= 0) {
    finishMatch(
      ctx, scored, 0,
      `PRACTICE COMPLETE — ${hits}/${TARGET_LAYOUT.length} TARGETS IN ${used} BALLS`
    );
  } else {
    ctx.db.match.id.update({
      ...scored,
      phase: PHASE_POINT_OVER,
      pauseTicks: TARGETS_PAUSE,
      pointMsg: hitTarget
        ? `TARGET HIT! ${remaining} TO GO`
        : `MISS — ${ballsLeft} BALL${ballsLeft === 1 ? '' : 'S'} LEFT`,
    });
  }
}

function endMatchCleanup(ctx: Ctx, match: MatchRow) {
  deleteTickTimers(ctx, match.id);
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false });
  for (const p of matchPlayers(ctx, match.id)) {
    ctx.db.player.identity.update({ ...p, matchId: 0n, dirX: 0, dirY: 0 });
  }
}

// ---------------------------------------------------------------------------
// Reconnect: a dropped player halts their match instead of forfeiting it.
// ---------------------------------------------------------------------------
// Presence is "holds at least one live websocket". An identity can hold
// several (two tabs; a reconnect racing the old socket's close), so this can
// never be answered by "did the last disconnect fire".
function hasSession(ctx: Ctx, id: Identity): boolean {
  for (const _ of ctx.db.session.byIdentity.filter(id)) return true;
  return false;
}

function deleteGraceTimers(ctx: Ctx, matchId: bigint) {
  for (const g of ctx.db.graceTimer.iter()) {
    if (g.matchId === matchId) ctx.db.graceTimer.scheduledId.delete(g.scheduledId);
  }
}

// Which sides of a live match are short a player right now. A side is only
// whole when EVERY one of its seats is back — in doubles, one returning
// player must not resume the match for a partner who is still gone.
function missingMask(ctx: Ctx, matchId: bigint): number {
  let mask = 0;
  for (const p of matchPlayers(ctx, matchId)) {
    if (p.isBot || p.spectator) continue; // a bot never drops
    if (!hasSession(ctx, p.identity)) mask |= 1 << p.side;
  }
  return mask;
}

// Stop the world. The 30 Hz tick timer is DELETED for the duration, so a
// halted match costs exactly one scheduled call — the grace expiry — rather
// than 9000 no-op ticks over five minutes.
function haltMatch(ctx: Ctx, match: MatchRow, awayName: string) {
  const mask = missingMask(ctx, match.id);
  if (mask === 0) return;
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const grace = lobby?.mode === MODE_TOURNAMENT ? GRACE_TOURNEY : GRACE_QUICK;
  const first = match.haltUntil === 0n;
  // A second drop never extends the first one's clock.
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
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false });
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

// Everyone is back: replay the point. Resuming mid-flight would hand somebody
// a ball they never saw, so the score and server stand but the rally restarts
// from a fresh serve behind the usual 3-2-1.
function resumeMatch(ctx: Ctx, match: MatchRow) {
  deleteGraceTimers(ctx, match.id);
  const live = setupServe(ctx, {
    ...match,
    haltMask: 0,
    haltedAt: 0n,
    haltUntil: 0n,
    haltName: '',
  });
  ctx.db.match.id.update({
    ...live,
    startTicks: COUNTDOWN_TICKS,
    pointMsg: 'RECONNECTED — REPLAYING THE POINT',
  });
  startTicking(ctx, match.id);
}

// Nobody came back. No winner, no XP, no MMR — the room reaper collects the
// rest.
function abandonMatch(ctx: Ctx, match: MatchRow) {
  deleteGraceTimers(ctx, match.id);
  const done = {
    ...match,
    state: M_DONE,
    phase: PHASE_GAME_OVER,
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

// Re-check a live match's presence and halt or resume it accordingly. Safe to
// call from anywhere: it is a no-op when the match's state already matches
// who is actually connected.
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
    if (!match || match.state !== M_LIVE || match.haltMask === 0) return; // resumed already
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
    // A bot "beating" an absent human only means something inside a bracket,
    // where somebody has to advance. In a practice room it is just litter.
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
// Room reaper: reconnect means a disconnected player still occupies their
// lobby, so the "last human left, tear it down" path in leaveCurrentLobby
// never fires for a room where everyone dropped. Without this, such rooms
// leak forever.
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

// Armed when the last human in a room goes dark, comfortably after any grace
// timer that room could still be running.
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
    if (lobbyHasPresence(ctx, arg.lobbyId)) return; // somebody came back
    destroyLobby(ctx, lobby);
  }
);

// A finished match reports here: record winner, pay out, then advance the
// room. Every result in the game funnels through this — won on court, a
// walkover from leaveCurrentLobby, a forfeit, a disconnect timeout — which is
// why it is the only place progression is awarded.
function finishMatch(
  ctx: Ctx,
  match: MatchRow,
  winnerSide: number,
  msg: string,
  endedBy = END_PLAYED
) {
  // Capture the roster FIRST: endMatchCleanup below sets matchId = 0 on every
  // player, after which matchPlayers(match.id) returns nothing and there is
  // nobody left to pay.
  const seats = matchPlayers(ctx, match.id);
  const done = {
    ...match,
    state: M_DONE,
    phase: PHASE_GAME_OVER,
    winnerSide,
    pointMsg: msg,
    // a decided match is never still waiting on anyone
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
    // pay the book out first: the next round's odds read this result
    settleBets(ctx, done, winnerSide);
    eliminateLoser(ctx, lobby, done);
    advanceTournament(ctx, lobby);
  }
}

// Bracket bookkeeping for a decided match: the losing unit is out, unless
// double elim gives it a second life in the losers bracket (only
// losers-bracket and grand-final losses knock you out there).
function eliminateLoser(ctx: Ctx, lobby: LobbyRow, done: MatchRow) {
  const dropsOut = lobby.format !== FORMAT_DOUBLE || done.bracket !== BR_WINNERS;
  const winnerId = done.winnerSide === 0 ? done.p0Id : done.p1Id;
  const loserId = done.winnerSide === 0 ? done.p1Id : done.p0Id;
  if (!dropsOut || sameId(loserId, winnerId)) return;
  // team play: the whole losing team goes out with its captain
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
// Which auth provider is behind this connection. We deliberately do NOT
// reject non-Firebase issuers: a hard check here would break local
// development (the Firebase emulator signs with a key no JWKS can verify) and
// every client still holding a raw token mid-deploy. The provider is recorded
// instead, which leaves the strict version a one-line change later.
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

// The profile behind the caller, created on first sight. Called from
// clientConnected, so every identity that has ever connected has exactly one.
function ensureAccount(ctx: Ctx): AccountRow {
  const { provider, uid, name } = providerOf(ctx);
  const existing = ctx.db.account.identity.find(ctx.sender);
  if (existing) {
    // Linking a guest account to Google keeps the Firebase uid, so the
    // identity is unchanged and only the provider moves anon -> linked.
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

// A profile is guaranteed for anyone who connected, but a bot never does and
// a row can be missing if the module was published mid-session.
function accountOf(ctx: Ctx, id: Identity): AccountRow | undefined {
  return ctx.db.account.identity.find(id) ?? undefined;
}

// Total XP needed to REACH a level, summing the per-level costs above:
//   sum(i=1..L-1) of LEVEL_BASE + LEVEL_STEP*(i-1)
// With the default dials that is 200, 500, 900 … 494 900 at level 99.
// Mirrored in client/src/config.ts — keep the two in sync.
function totalXpFor(level: number): number {
  return ((level - 1) * (2 * LEVEL_BASE + LEVEL_STEP * (level - 2))) / 2;
}

// Integer arithmetic, bounded at LEVEL_MAX iterations — no floats, nothing
// for the client mirror to drift against.
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

// Standard Elo, rounded AWAY from zero so a win is never worth +0 and a loss
// never costs -0. Math.pow is fine in a reducer: determinism only requires
// the same output for the same input on the machine that runs it, and the
// result is stored, never recomputed — the client only ever displays it.
function eloDelta(mine: number, theirs: number, won: boolean, ranked: number): number {
  const expected = 1 / (1 + Math.pow(10, (theirs - mine) / 400));
  const raw = kFactor(ranked) * ((won ? 1 : 0) - expected);
  return raw >= 0 ? Math.max(1, Math.round(raw)) : Math.min(-1, Math.round(raw));
}

// Ranked means: a real pairing, real tennis, no bots on court, not practice.
// A tournament seat filled by insertBot makes that match casual — the filler
// is a placeholder, not an opponent.
function isRanked(
  lobby: LobbyRow | null | undefined,
  match: MatchRow,
  seats: PlayerRow[]
): boolean {
  if (!lobby || !match.hasP1) return false;
  if (lobby.ruleset !== RULES_TENNIS) return false; // beer pong / targets are their own games
  if (lobby.vsBot) return false; // practice
  const competitors = seats.filter(p => !p.spectator);
  const humans = competitors.filter(p => !p.isBot);
  if (humans.length !== competitors.length) return false;
  return [0, 1].every(s => humans.some(p => p.side === s));
}

// Integer mean MMR of one side. A bot holds no account, so it is rated at the
// starting value — only ever reached on a casual match, where it is unused.
function sideMmr(
  seats: PlayerRow[],
  side: number,
  before: Map<string, AccountRow | undefined>
): number {
  const rows = seats.filter(p => p.side === side && !p.spectator);
  if (rows.length === 0) return MMR_START;
  let total = 0;
  for (const p of rows) {
    total += before.get(p.identity.toHexString())?.mmr ?? MMR_START;
  }
  return Math.round(total / rows.length);
}

// Pay out a finished match. MUST be called from finishMatch BEFORE
// endMatchCleanup, which sets matchId = 0 on every player and would leave
// this with an empty roster — silently awarding nothing, on every match.
function awardProgression(
  ctx: Ctx,
  lobby: LobbyRow | null | undefined,
  match: MatchRow,
  seats: PlayerRow[],
  winnerSide: number,
  endedBy: number
) {
  if (winnerSide === NO_WINNER) return; // abandoned — nobody won anything
  // A match that ended before a single point was played (a bye, a pairing
  // that collapsed) is not a result. A forfeit always is.
  if (endedBy === END_PLAYED && match.p0PtsTotal + match.p1PtsTotal === 0) return;
  const humans = seats.filter(p => !p.isBot && !p.spectator);
  if (humans.length === 0) return;
  const ranked = isRanked(lobby, match, seats);

  // Snapshot both sides BEFORE writing, so the two deltas are computed
  // against the same numbers rather than each other's output.
  const before = new Map<string, AccountRow | undefined>();
  for (const p of seats) {
    if (!p.spectator) before.set(p.identity.toHexString(), accountOf(ctx, p.identity));
  }
  const avg = [sideMmr(seats, 0, before), sideMmr(seats, 1, before)];

  for (const p of humans) {
    const acc = before.get(p.identity.toHexString());
    if (!acc) continue;
    const won = p.side === winnerSide;
    const gamesFor = p.side === 0 ? match.p0Games : match.p1Games;
    const gamesAgainst = p.side === 0 ? match.p1Games : match.p0Games;

    let xp = XP_PLAY + gamesFor * XP_PER_GAME + (won ? XP_WIN : 0);
    if (!ranked) xp = Math.round((xp * XP_CASUAL_MUL) / 100);
    // A quitter banks participation only — no game credit, no win bonus.
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
      gamesFor,
      gamesAgainst,
      endedBy,
      playedAt: ctx.timestamp,
    });
    pruneMatchLog(ctx, p.identity);
  }
}

// Keep the newest LOG_KEEP rows per account — the same bounded-history
// pattern insertChat uses for the chat feed.
function pruneMatchLog(ctx: Ctx, id: Identity) {
  const rows = [...ctx.db.matchLog.byAccount.filter(id)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  for (let i = 0; i < rows.length - LOG_KEEP; i++) {
    ctx.db.matchLog.id.delete(rows[i].id);
  }
}

// A player's own results. Index lookup, never .iter() — a view that scans
// re-evaluates on any row change in the table.
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

// Hand out a starting stack. Rejoining a room you already have a wallet in
// keeps the balance you left with — otherwise leaving would reset losses.
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

// How a bracket unit (a captain, so team play works unchanged) has actually
// played this tournament: real finished matches only — byes say nothing.
function unitPerf(
  ctx: Ctx,
  lobbyId: bigint,
  captainId: Identity
): { wins: number; losses: number; ptsW: number; ptsT: number } {
  let wins = 0;
  let losses = 0;
  let ptsW = 0;
  let ptsT = 0;
  for (const m of ctx.db.match.byLobby.filter(lobbyId)) {
    if (m.state !== M_DONE || !m.hasP1) continue;
    const isP0 = sameId(m.p0Id, captainId);
    const isP1 = sameId(m.p1Id, captainId);
    if (!isP0 && !isP1) continue;
    const mine = isP0 ? m.p0PtsTotal : m.p1PtsTotal;
    const theirs = isP0 ? m.p1PtsTotal : m.p0PtsTotal;
    ptsW += mine;
    ptsT += mine + theirs;
    if (m.winnerSide === (isP0 ? 0 : 1)) wins++;
    else losses++;
  }
  return { wins, losses, ptsW, ptsT };
}

// Strength score: point share (the finer signal) weighted by win rate, both
// smoothed toward even so a single result can't produce a runaway price.
function unitStrength(perf: { wins: number; losses: number; ptsW: number; ptsT: number }): number {
  const pointShare = (perf.ptsW + 12) / (perf.ptsT + 24);
  const winRate = (perf.wins + 1) / (perf.wins + perf.losses + 2);
  return Math.pow(pointShare, 1.5) * winRate;
}

// Current line from the seeded pool: odds = total / that side's money, so a
// side carrying more money pays less. Clamped at both ends.
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

// Open the market for a real (non-bye) tournament match.
function openBook(ctx: Ctx, lobby: LobbyRow, match: MatchRow) {
  if (lobby.mode !== MODE_TOURNAMENT || !match.hasP1) return;
  if (ctx.db.book.matchId.find(match.id)) return;
  const s0 = unitStrength(unitPerf(ctx, lobby.id, match.p0Id));
  const s1 = unitStrength(unitPerf(ctx, lobby.id, match.p1Id));
  // round 1 has no history: both sides score the same, so the line opens even
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

// Anyone in the room who could place a bet right now: a human who isn't on a
// court. Their presence is what buys a match its betting window.
function hasIdleBettor(ctx: Ctx, lobbyId: bigint): boolean {
  for (const p of ctx.db.player.byLobby.filter(lobbyId)) {
    if (!p.isBot && p.matchId === 0n && walletOf(ctx, lobbyId, p.identity)) return true;
  }
  return false;
}

// Pay out a finished match and shut its book. Winners are paid at the odds
// on their own slip; losers paid when they placed the bet.
function settleBets(ctx: Ctx, match: MatchRow, winnerSide: number) {
  closeBook(ctx, match.id);
  for (const bet of ctx.db.bet.byMatch.filter(match.id)) {
    if (bet.state !== B_OPEN) continue;
    const won = bet.side === winnerSide;
    const payout = won ? Math.round((bet.stake * bet.oddsMilli) / 1000) : 0;
    ctx.db.bet.id.update({ ...bet, state: won ? B_WON : B_LOST, payout });
    // the wallet still exists even if the bettor left the room
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

// The other crown: the richest wallet among people who actually bet. Sitting
// on an untouched starting stack doesn't win anything. Ties share the title.
function betWinner(ctx: Ctx, lobbyId: bigint): { name: string; credits: number } | null {
  let best = -1;
  const names: string[] = [];
  for (const w of ctx.db.wallet.byLobby.filter(lobbyId)) {
    if (w.won === 0 && w.lost === 0 && w.staked === 0) continue; // never bet
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

// Tear a room's whole economy down with the room.
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
  // Two winners: the bracket's, and the stands'. Every bet has settled by
  // now — the final pays out in finishMatch before the bracket gets here,
  // and rounds run as waves, so no other book can still be open.
  const bettor = betWinner(ctx, lobby.id);
  ctx.db.lobby.id.update({
    ...lobby,
    status: L_FINISHED,
    championName: unitName(ctx, lobby.id, champId) || 'CHAMPION',
    betWinnerName: bettor?.name ?? '',
    betWinnerCredits: bettor?.credits ?? 0,
  });
}

// Is every seat on this side held by a bot? (Team play: the whole unit.)
function unitIsAllBots(ctx: Ctx, lobbyId: bigint, captainId: Identity): boolean {
  const rows = teamRowsOf(ctx, lobbyId, captainId);
  const ids = rows.length ? rows.map(r => r.memberId) : [captainId];
  return ids.every(id => ctx.db.player.identity.find(id)?.isBot ?? false);
}

// A match with a bot on every seat is decided on the spot instead of being
// played out at 30 Hz: nobody is on the sticks, nobody is watching it, and
// the rest of the bracket would be waiting on two identical AIs to rally it
// out. The bots are evenly matched by construction, so it is a coin flip,
// scored like the short best-of-3 the match would have produced.
function simulateBotMatch(ctx: Ctx, lobby: LobbyRow, match: MatchRow) {
  const winnerSide = ctx.random() < 0.5 ? 0 : 1;
  const loserGames = ctx.random() < 0.5 ? 0 : 1; // a sweep, or a decider
  const winnerName = unitName(ctx, lobby.id, winnerSide === 0 ? match.p0Id : match.p1Id);
  const done = {
    ...match,
    state: M_DONE,
    phase: PHASE_GAME_OVER,
    winnerSide,
    p0Games: winnerSide === 0 ? TOURNEY_GAMES_TO_WIN : loserGames,
    p1Games: winnerSide === 1 ? TOURNEY_GAMES_TO_WIN : loserGames,
    pointMsg: `${winnerName} ${winVerb(winnerName)} — BOT MATCH, AUTO-PLAYED`,
  };
  ctx.db.match.id.update(done);
  // Same contract a played match honors: shut the book (it opened with the
  // pairing) and settle anything on it. Nobody can actually have bet — the
  // match is created and decided inside one transaction — but no market is
  // left hanging open on a finished match. The odds model reads the result
  // as a win with no point evidence (p0PtsTotal/p1PtsTotal stay 0), which is
  // exactly what it smooths toward anyway.
  settleBets(ctx, done, winnerSide);
  eliminateLoser(ctx, lobby, done);
}

// Rounds are waves: every match of round R (winners AND losers bracket alike)
// finishes before round R+1 is created, so pairings are always drawn from a
// completed wave. Round 1 is padded to a power of two (see start_tournament),
// so the winners bracket halves cleanly and nobody gets back-to-back byes.
function advanceTournament(ctx: Ctx, lobby: LobbyRow) {
  const matches = lobbyMatches(ctx, lobby.id);
  if (matches.length === 0) return;
  const maxRound = Math.max(...matches.map(m => m.round));
  const roundMatches = matches
    .filter(m => m.round === maxRound)
    .sort((a, b) => a.bracket - b.bracket || a.slot - b.slot);
  // All-bot matches never take a court: resolve them first, then start over
  // from the rows they just changed (this invocation's copies are stale).
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

  // start pending matches up to the concurrency limit (winners bracket first)
  for (const m of roundMatches) {
    if (live >= lobby.concurrent) break;
    if (m.state === M_PENDING) {
      goLive(ctx, m);
      live++;
    }
  }
  if (roundMatches.some(m => m.state !== M_DONE)) return;

  // round complete
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
    // carry the survivors forward: brackets whose matches all resolved in an
    // earlier wave (e.g. the WB final while the LB still plays out) keep
    // their last winner
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
    // losers-bracket pool: pair each LB survivor against a fresh WB dropper
    // (classic "major round" pairing); leftovers pair among themselves
    const lbPool: Identity[] = [];
    for (let i = 0; i < Math.max(lbWinners.length, wbLosers.length); i++) {
      if (i < lbWinners.length) lbPool.push(lbWinners[i]);
      if (i < wbLosers.length) lbPool.push(wbLosers[i]);
    }
    // Odd pool → someone sits out. Sequential pairing byes the last element,
    // so move whoever has had the fewest byes to the back — the free pass
    // rotates instead of landing on the same player wave after wave.
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
      // one survivor per bracket — grand final, winner takes all
      createMatch(
        ctx, lobby, maxRound + 1, 0, wbWinners[0], lbPool[0],
        TOURNEY_GAMES_TO_WIN, BR_FINAL
      );
    } else {
      if (wbWinners.length > 1) {
        for (let i = 0, slot = 0; i < wbWinners.length; i += 2, slot++) {
          const p1 = i + 1 < wbWinners.length ? wbWinners[i + 1] : null;
          createMatch(
            ctx, lobby, maxRound + 1, slot, wbWinners[i], p1,
            TOURNEY_GAMES_TO_WIN, BR_WINNERS
          );
        }
      }
      for (let i = 0, slot = 0; i < lbPool.length; i += 2, slot++) {
        const p1 = i + 1 < lbPool.length ? lbPool[i + 1] : null;
        createMatch(
          ctx, lobby, maxRound + 1, slot, lbPool[i], p1,
          TOURNEY_GAMES_TO_WIN, BR_LOSERS
        );
      }
    }
    advanceTournament(ctx, lobby);
    return;
  }

  // single elimination
  const winners = winnersOf(roundMatches);
  if (winners.length === 1) {
    crownChampion(ctx, lobby, winners[0]);
    return;
  }
  for (let i = 0, slot = 0; i < winners.length; i += 2, slot++) {
    const p1 = i + 1 < winners.length ? winners[i + 1] : null;
    createMatch(ctx, lobby, maxRound + 1, slot, winners[i], p1, TOURNEY_GAMES_TO_WIN);
  }
  advanceTournament(ctx, lobby);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
function awardPoint(ctx: Ctx, match: MatchRow, winnerSide: number, reason: string) {
  let { p0Points, p1Points, p0Games, p1Games, servingSide } = match;
  if (winnerSide === 0) p0Points++;
  else p1Points++;
  // running totals survive the game resets below — the betting odds read
  // them to price the next round
  const p0PtsTotal = match.p0PtsTotal + (winnerSide === 0 ? 1 : 0);
  const p1PtsTotal = match.p1PtsTotal + (winnerSide === 1 ? 1 : 0);

  const winnerName = teamName(matchPlayers(ctx, match.id), winnerSide);
  let msg = `${reason} — point ${winnerName}`;

  const [wp, lp] = winnerSide === 0 ? [p0Points, p1Points] : [p1Points, p0Points];
  let matchOver = false;
  if (wp >= 4 && wp - lp >= 2) {
    if (winnerSide === 0) p0Games++;
    else p1Games++;
    p0Points = 0;
    p1Points = 0;
    servingSide = 1 - servingSide;
    const wg = winnerSide === 0 ? p0Games : p1Games;
    if (wg >= match.gamesToWin) {
      // a match is one set, so reaching gamesToWin takes it on the spot — no
      // 2-game margin, which is what keeps best-of-3 to 3 games
      matchOver = true;
      msg = `${winnerName} ${winVerb(winnerName)} THE MATCH!`;
    } else {
      msg = `GAME ${winnerName}`;
    }
  }

  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false });

  const updated = {
    ...match,
    p0Points, p1Points, p0Games, p1Games, servingSide,
    p0PtsTotal, p1PtsTotal,
  };
  if (matchOver) {
    finishMatch(ctx, updated, winnerSide, msg);
  } else {
    ctx.db.match.id.update({
      ...updated,
      phase: PHASE_POINT_OVER,
      pauseTicks: PAUSE_TICKS,
      pointMsg: msg,
    });
  }
}

// ---------------------------------------------------------------------------
// Hitting
// ---------------------------------------------------------------------------
// Turn stick + timing quality into a landing target and flight time.
function computeShot(
  side: number,
  dirX: number,
  dirY: number,
  characterId: number,
  swingKind: number,
  quality: number,
  leadY: number, // contact distance in front of the body (negative = behind)
  contactZ: number,
  driftBase: number,
  apexZ: number // incoming ball's highest point — lobs invite a timed smash
): { tx: number; ty: number; time: number } {
  const oppSign = -sideSign(side);
  const st = charStat(characterId);
  const power = st.power;
  const behind = leadY < -0.5;
  const aimDepth = dirY * oppSign * AIM_DEPTH;
  const qualityTime = quality === Q_PERFECT ? 0.72 : quality === Q_GOOD ? 1.0 : 1.3;

  let time: number;
  let depth: number;
  // Overhead contact is always a smash; a slow lob can also be smashed at
  // normal height with PERFECT timing on the flat button — the reward for
  // reading the floater.
  const smash =
    !behind &&
    swingKind !== SWING_LOB &&
    (contactZ > SMASH_MIN_Z ||
      (quality === Q_PERFECT && apexZ >= LOB_APEX_Z && contactZ >= SMASH_LOW_CONTACT));
  if (swingKind === SWING_LOB) {
    time = LOB_TIME * (quality === Q_WEAK ? 1.15 : 1);
    depth = LOB_DEPTH + aimDepth * 0.6 + (quality === Q_PERFECT ? 3 : 0);
  } else if (smash) {
    // perfect contact = the STRONG smash
    time = (SMASH_TIME * (quality === Q_PERFECT ? 0.72 : 1)) / power;
    depth = SMASH_DEPTH + aimDepth * 0.5;
  } else {
    time = (DRIVE_TIME * qualityTime) / power;
    depth = DRIVE_DEPTH + aimDepth + (quality === Q_PERFECT ? 4 : 0);

    // Contact height: low balls get dug up (slower, land shorter); a
    // shoulder-high ball that isn't a smash floats a little.
    if (contactZ < LOW_CONTACT_Z) {
      time *= 1.12;
      depth -= 3;
    } else if (contactZ > HIGH_CONTACT_Z) {
      time *= 1.08;
    }
    // Stepping into the ball — clean contact well in front hits on the rise.
    if (leadY > STEP_IN_LEAD && quality !== Q_WEAK) {
      time *= 0.92;
      depth += 2;
    }
  }

  // SLOP: one number for how compromised the contact was — it drives every
  // risk dial below. Perfect centered contact scores 0 (today's behavior).
  const slop = Math.min(
    1,
    (quality === Q_WEAK ? SLOP_WEAK : quality === Q_GOOD ? SLOP_GOOD : 0) +
      (behind ? SLOP_BEHIND : 0) +
      Math.min(
        SLOP_OFFCENTER_MAX,
        Math.max(0, Math.abs(driftBase) - CONTACT_SIDE_DEAD) * SLOP_OFFCENTER
      )
  );
  // sloppy contact while aiming deep risks sailing long — worse off-center
  if (aimDepth > 0) {
    depth += slop * (aimDepth / AIM_DEPTH) * (2 + Math.abs(driftBase) * 1.5);
  }

  // slop also inflates the drift itself: a bad hit sprays harder, which is
  // what finally carries an edge aim past the line
  const driftFactor =
    (quality === Q_PERFECT ? 0.2 : quality === Q_GOOD ? 1.0 : 1.4) * (1 + slop);
  // Lateral contact shapes the angle: swinging toward the side the ball is
  // on opens up the sharp angle; pulling it across the body closes it and
  // makes the shot drift.
  let aimReach = AIM_X;
  let pullDrift = 1;
  if (!smash && dirX !== 0 && Math.abs(driftBase) > CONTACT_SIDE_DEAD) {
    if (Math.sign(dirX) === Math.sign(driftBase)) {
      aimReach *= 1 + OPEN_AIM_BONUS;
    } else {
      aimReach *= 1 - PULL_AIM_PENALTY;
      pullDrift = PULL_DRIFT_MUL;
    }
  }
  // intended aim always targets inside the lines; only drift can stray wide
  // (the control stat shrinks — or, below 1, grows — the mishit error)
  const aimX = clamp(dirX * aimReach, -(COURT_HALF_WID - 1.5), COURT_HALF_WID - 1.5);
  const raw = aimX + (driftBase * MISHIT_DRIFT * driftFactor * pullDrift) / st.control;
  // auto-aim: compress the part of the target past the safe line — slop
  // weakens the compression AND widens the out-cap, so an edge aim off bad
  // contact carries real risk while clean contact stays protected
  const safe = COURT_HALF_WID - 1.0;
  const over = Math.abs(raw) - safe;
  const keep = AUTO_AIM_KEEP + AUTO_AIM_KEEP_SLOP * slop;
  const outMax = AIM_OUT_MAX + AIM_OUT_SLOP * slop;
  const pulled = over > 0 ? Math.sign(raw) * (safe + over * keep) : raw;
  const tx = clamp(pulled, -(COURT_HALF_WID + outMax), COURT_HALF_WID + outMax);
  const ty = oppSign * clamp(depth, 14, 36 + DEPTH_OUT_SLOP * slop);
  return { tx, ty, time };
}

function executeHit(
  match: MatchRow,
  player: PlayerRow,
  ball: BallRow,
  quality: number,
  phys: Phys
): BallRow {
  const oppSign = -sideSign(player.side);
  const leadY = (ball.y - player.y) * oppSign;
  // contact behind the body is always a desperate defensive flick
  const behind = leadY < -0.5;
  if (behind) quality = Q_WEAK;
  const driftBase = ball.x - player.x;
  // A genuine lob CLIMBS after leaving the racket; a serve struck at z≈12
  // merely starts high. Only a real climb makes the incoming ball smashable.
  const climb = ball.apexZ - ball.aimContactZ;
  const lobApex = climb >= 3.5 ? ball.apexZ : 0;
  const { tx, ty, time } = computeShot(
    player.side, player.dirX, player.dirY, player.characterId,
    player.swingKind, quality, leadY, ball.z, driftBase, lobApex
  );

  // SCREW SHOT: the HIT+LOB finisher on a full meter — a vicious curving
  // drive. Never fires on its own; the player has to input the combo.
  const screw =
    player.swingKind === SWING_SUPER &&
    quality !== Q_WEAK &&
    player.momentum >= MOMENTUM_MAX &&
    !behind &&
    ball.z <= SMASH_MIN_Z;
  let finalTx = tx;
  let spinX = 0;
  let finalTime = time;
  if (screw) {
    // the spin stat sets how hard the screw bends — LUNA's is vicious
    const spinStat = charStat(player.characterId).spin;
    const curve = player.dirX !== 0 ? Math.sign(player.dirX) : (ball.x >= 0 ? -1 : 1);
    finalTx = clamp(tx + curve * 5 * spinStat, -COURT_HALF_WID - 4, COURT_HALF_WID + 4);
    spinX = -curve * 28 * spinStat;
    finalTime = time * 0.62;
  }

  const isLob = player.swingKind === SWING_LOB;
  const outHits = isLob
    ? Math.max(0, ball.rallyHits - LOB_COOL_HITS)
    : Math.min(255, ball.rallyHits + 1);
  const aimTime = finalTime / ((isLob ? 1 : rallyFactor(ball.rallyHits)) * phys.speed);
  if (screw && quality === Q_PERFECT) {
    // PERFECT guarantee, launch half: the screw aims outside the line and
    // trusts its sidespin to carry the ball back in — but a rally-heated
    // (short) flight gives the spin less air time to work. Budget the aim
    // by the drift the spin will actually deliver, so a PERFECT screw
    // launches on a line its bend can honor; the bend itself is untouched.
    const drift = 0.5 * spinX * aimTime * aimTime;
    finalTx = clamp(finalTx, -COURT_HALF_WID - drift, COURT_HALF_WID - drift);
  }
  const flight = aimBallClearingNet(ball, finalTx, ty, aimTime, phys.gravity);
  // WEAK-HIT NET RISK: a weak poke doesn't get the free loft. Inside the
  // risk band its net clearance is capped — gently at the band's edge, and
  // hard enough up close (worse on low contact) to genuinely catch the
  // tape. The capped shot also drops shorter than its target, like a real
  // mistimed dig. A small deterministic wobble keeps the marginal band
  // from being a hard line.
  if (quality === Q_WEAK && !isLob && Math.abs(ball.y) < NET_RISK_DIST) {
    const tNet = flight.vy !== 0 ? -flight.y / flight.vy : -1;
    if (tNet > 0) {
      const near = 1 - Math.abs(ball.y) / NET_RISK_DIST;
      const low =
        ball.z < LOW_CONTACT_Z ? (LOW_CONTACT_Z - ball.z) / LOW_CONTACT_Z : 0;
      const wobble =
        (hash01(ball.x * 3.7 + ball.y * 1.3 + ball.rallyHits * 17.9) - 0.5) * 0.8;
      // floor at -0.3: even the ugliest point-blank dig keeps a sliver of a
      // chance to scrape over (wobble can still lift it past the tape)
      const margin =
        Math.max(
          NET_RISK_SAFE + (1 - near) * 2.5 - near * (1.8 + low * 1.6),
          -0.3
        ) + wobble;
      const zNet =
        flight.z + flight.vz * tNet + 0.5 * phys.gravity * tNet * tNet;
      if (zNet > NET_HEIGHT + margin) {
        flight.vz -= (zNet - (NET_HEIGHT + margin)) / tNet;
      }
    }
  }
  return {
    ...flight,
    lastHitSide: player.side,
    bounces: 0,
    rallyHits: outHits,
    spinX,
    aimBehind: false, // the serve's flight ends the moment it is returned
    apexZ: ball.z, // fresh arc — the tick raises this as the ball climbs
    aimContactZ: ball.z, // launch height — the lob-climb detector reads this
    aimKind: curlDirFor(player), // CURL arms from the stick held at contact
    aimQuality: quality + 1, // the PERFECT guarantee reads this in flight
    freezeTicks: isLob ? 0 : hitstopTicks(outHits),
  };
}

// Where to meet a serve. A serve is the one shot that is nowhere near its
// own bounce mark when you play it: it pitches deep in the service box and
// climbs away toward the baseline, so a bot that runs at the mark arrives
// long after the ball has gone — and one that then chases the NEXT bounce
// turns and sprints out past its own baseline, away from the ball it was
// standing next to. Walk the arc the ball will actually be played on and
// pick the point the bot can reach with the most time to spare: the ball at
// its most playable, which is what standing in to take a serve on the rise
// amounts to. Arriving early is the whole point — a bot that only just gets
// there has to fling itself at the ball, and a dive returns a serve about as
// well as it sounds. When nothing on the arc is reachable this still yields
// the closest the bot can come, so it chases rather than gives up.
function serveIntercept(
  bot: PlayerRow,
  ball: BallRow,
  g: number,
  sgn: number,
  bounce: { rest: number; skid: number; speed: number }
): { x: number; y: number } | null {
  // The walk starts where the playable arc starts: for a serve still in the
  // air that is its bounce in the service box, for one that has pitched
  // already it is simply where the ball is now.
  let t0 = 0;
  let sx = ball.x, sy = ball.y, sz = ball.z;
  let svx = ball.vx, svy = ball.vy, svz = ball.vz;
  if (ball.bounces === 0) {
    const disc = ball.vz * ball.vz + 2 * g * ball.z;
    t0 = (ball.vz + Math.sqrt(Math.max(0, disc))) / g;
    sx = ball.x + ball.vx * t0;
    sy = ball.y + ball.vy * t0;
    sz = 0;
    svz = -(ball.vz - g * t0) * bounce.rest;
    svx = ball.vx * bounce.skid;
    svy = ball.vy * bounce.skid;
  }
  let best: { x: number; y: number } | null = null;
  let bestSlack = -Infinity;
  for (let k = 1; k <= SERVE_READ_STEPS; k++) {
    const dt = k * DT;
    const z = sz + svz * dt - 0.5 * g * dt * dt;
    if (z <= 0) break; // next ground contact — the point is already gone
    const x = sx + svx * dt;
    const y = sy + svy * dt;
    if (y * sgn < 2) break; // back over the net: not ours to play
    if (z > HIT_MAX_Z) continue; // still overhead — can't be struck yet
    // time to spare: the run it needs against the run it has (the rest of
    // the flight, plus however long the ball takes to reach this point)
    const slack = bounce.speed * (t0 + dt) - Math.hypot(x - bot.x, y - bot.y);
    if (slack > bestSlack) {
      bestSlack = slack;
      best = { x, y };
    }
  }
  return best;
}

// Bot steering: predict the landing point; high arcs read as lobs. Easier
// bots misjudge the landing spot laterally (deterministic per return).
// `bounce` is passed only while a SERVE is in the air — see serveIntercept.
function botSteer(
  bot: PlayerRow,
  ball: BallRow | null | undefined,
  gravity: number,
  aimErr: number,
  errSeed: number,
  bounce: { rest: number; skid: number; speed: number } | null
): PlayerRow {
  // everything below is mirrored onto the bot's own half — a bot can hold
  // either side of the net (tournaments seat them wherever the draw lands)
  const sgn = sideSign(bot.side);
  const ownHalf = (y: number) =>
    sgn > 0 ? clamp(y, 8, BOUNDS_Y_FAR - 1) : clamp(y, -(BOUNDS_Y_FAR - 1), -8);
  let tx = 0;
  let ty = sgn * BOT_HOME_Y;
  if (ball && ball.active && ball.lastHitSide !== bot.side) {
    const g = -gravity;
    const disc = ball.vz * ball.vz + 2 * g * ball.z;
    const tLand = (ball.vz + Math.sqrt(Math.max(0, disc))) / g;
    const lx = ball.x + ball.vx * tLand;
    const ly = ball.y + ball.vy * tLand;
    if (ly * sgn > 2) {
      const apex = ball.z + (ball.vz > 0 ? (ball.vz * ball.vz) / (2 * g) : 0);
      const lobbish = apex > 9;
      // a serve is played off its bounce, not on the mark it leaves
      const meet = bounce ? serveIntercept(bot, ball, g, sgn, bounce) : null;
      if (meet) {
        tx = clamp(meet.x, -BOUNDS_X, BOUNDS_X);
        ty = ownHalf(meet.y); // stand ON the interception, not behind it
      } else {
        tx = clamp(lx, -BOUNDS_X, BOUNDS_X);
        // stand a step behind the bounce, deeper still under a lob
        ty = ownHalf(ly + sgn * (lobbish ? 3.5 : 1.5));
      }
    } else {
      tx = clamp(ball.x + ball.vx * 0.25, -BOUNDS_X, BOUNDS_X);
      ty = ownHalf(ball.y + ball.vy * 0.2);
    }
    if (aimErr > 0) {
      tx = clamp(
        tx + (hash01(errSeed * 5.7 + ball.rallyHits * 3.71) - 0.5) * 2 * aimErr,
        -BOUNDS_X, BOUNDS_X
      );
    }
  }
  const dx = tx - bot.x;
  const dy = ty - bot.y;
  return {
    ...bot,
    dirX: Math.abs(dx) > BOT_DEAD_ZONE ? Math.sign(dx) : 0,
    dirY: Math.abs(dy) > 2 ? Math.sign(dy) : 0,
  };
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------
function executeToss(ctx: Ctx, match: MatchRow, server: PlayerRow, ball: BallRow) {
  ctx.db.ball.matchId.update({
    ...ball,
    active: true,
    x: server.x,
    y: server.y,
    z: TOSS_Z0,
    vx: 0, vy: 0, vz: TOSS_VZ,
    lastHitSide: server.side,
    bounces: 0,
    rallyHits: 0,
    spinX: 0,
    aimBehind: false,
    freezeTicks: 0,
  });
}

// Beer pong throw: a lofted toss at the opponent's rack. The stick picks
// which part of the triangle to attack (auto-aimed to the nearest live cup),
// and strike timing sets the scatter. Literal beer pong — nobody returns it.
function executeBeerPongThrow(
  ctx: Ctx, match: MatchRow, server: PlayerRow, ball: BallRow, phys: Phys
) {
  const dz = Math.abs(ball.z - SERVE_IDEAL_Z);
  const quality = dz <= 1 ? Q_PERFECT : dz <= 3 ? Q_GOOD : Q_WEAK;
  const oppSign = -sideSign(server.side);
  // stick intent: a rough zone over the rack...
  const intentX = server.dirX * 5.5;
  const intentY = oppSign * (27 - server.dirY * oppSign * 4.5);
  // ...snapped to the nearest cup still standing
  let cupX = 0;
  let cupY = oppSign * 27;
  let best = Infinity;
  for (const tg of ctx.db.target.byMatch.filter(match.id)) {
    if (!tg.alive || tg.side === server.side) continue;
    const d = Math.hypot(tg.x - intentX, tg.y - intentY);
    if (d < best) {
      best = d;
      cupX = tg.x;
      cupY = tg.y;
    }
  }
  const scatter = THROW_SCATTER[quality] ?? THROW_SCATTER[Q_WEAK];
  const tx = cupX + (ctx.random() - 0.5) * 2 * scatter;
  const ty = cupY + (ctx.random() - 0.5) * 2 * scatter;
  const thrown = aimBall(
    {
      ...ball, lastHitSide: server.side, bounces: 0, spinX: 0,
      apexZ: ball.z, aimContactZ: ball.z, aimKind: curlDirFor(server),
      aimQuality: 0, // no lines in beer pong — the throw lands where it lands
    },
    tx, ty, THROW_TIME / phys.speed, phys.gravity
  );
  ctx.db.ball.matchId.update(thrown);
  ctx.db.match.id.update({ ...match, phase: PHASE_RALLY, pointMsg: '' });
}

function executeServeStrike(ctx: Ctx, match: MatchRow, server: PlayerRow, ball: BallRow) {
  const lobby = ctx.db.lobby.id.find(match.lobbyId);
  const phys = lobbyPhysics(lobby);
  if (lobby?.ruleset === RULES_BEERPONG) {
    executeBeerPongThrow(ctx, match, server, ball, phys);
    return;
  }
  const dz = Math.abs(ball.z - SERVE_IDEAL_Z);
  const quality = dz <= 1 ? Q_PERFECT : dz <= 3 ? Q_GOOD : Q_WEAK;
  const receiverSign = -sideSign(server.side);
  // serve MUST land in the DIAGONAL service box
  const boxSign = -Math.sign(server.x || 1);
  const boxX = boxSign * 6;
  const aimSpread = quality === Q_WEAK ? 1.5 : 4;
  const rawTx = boxX + server.dirX * aimSpread;
  const tx =
    boxSign > 0
      ? clamp(rawTx, 1.5, COURT_HALF_WID - 1.5)
      : clamp(rawTx, -COURT_HALF_WID + 1.5, -1.5);
  const ty = receiverSign * (quality === Q_PERFECT ? 17 : quality === Q_GOOD ? 14 : 11);
  const st = charStat(server.characterId);
  // the serve stat is the big-serve dial: it divides the flight time
  const time =
    (quality === Q_PERFECT ? 0.45 : quality === Q_GOOD ? 0.58 : 0.77) / st.serve;

  // Perfect serves charge the meter; a FULL meter makes a screw serve.
  const fresh = ctx.db.player.identity.find(server.identity);
  const screwServe =
    quality === Q_PERFECT && fresh != null && fresh.momentum >= MOMENTUM_MAX;
  let sTx = tx;
  let sTime = time;
  let sSpin = 0;
  if (screwServe) {
    const out = Math.sign(boxX) || 1;
    sTx = tx - out * 2.5 * st.spin;
    sSpin = out * 22 * st.spin;
    sTime = time * 0.82;
  }
  const served = aimBallClearingNet(
    // aimContactZ = strike height, so the receiver's climb check reads the
    // serve's apex as "started high", never as a smashable lob
    {
      ...ball, lastHitSide: server.side, bounces: 0, spinX: 0,
      apexZ: ball.z, aimContactZ: ball.z, aimKind: curlDirFor(server),
      aimQuality: quality + 1, // the PERFECT guarantee reads this in flight
      aimBehind: true, // ...and the receiving bot reads this as "serve"
    },
    sTx, ty, sTime / phys.speed, phys.gravity
  );
  served.spinX = sSpin;
  ctx.db.ball.matchId.update(served);
  ctx.db.match.id.update({ ...match, phase: PHASE_RALLY, pointMsg: '' });
  if (fresh) {
    ctx.db.player.identity.update({
      ...fresh,
      momentum: screwServe
        ? 0
        : quality === Q_PERFECT
          ? Math.min(MOMENTUM_MAX, fresh.momentum + momentumGain(fresh.characterId))
          : fresh.momentum,
    });
  }
}

// ---------------------------------------------------------------------------
// Rooms (lobbies)
// ---------------------------------------------------------------------------
// The physics args every lobby-creating reducer accepts (multipliers; 1 =
// standard, dragMul 0 = none). Values are clamped server-side.
const physArgs = {
  gravityMul: t.f32(),
  dragMul: t.f32(),
  speedMul: t.f32(),
  bounceMul: t.f32(),
};
interface PhysArgs {
  gravityMul: number;
  dragMul: number;
  speedMul: number;
  bounceMul: number;
}
function clampPhys(v: PhysArgs): PhysArgs {
  const safe = (n: number, def: number) => (Number.isFinite(n) && n > 0 ? n : def);
  return {
    gravityMul: clamp(safe(v.gravityMul, 1), PHYS_GRAVITY_RANGE[0], PHYS_GRAVITY_RANGE[1]),
    dragMul: clamp(Number.isFinite(v.dragMul) ? v.dragMul : 0, PHYS_DRAG_RANGE[0], PHYS_DRAG_RANGE[1]),
    speedMul: clamp(safe(v.speedMul, 1), PHYS_SPEED_RANGE[0], PHYS_SPEED_RANGE[1]),
    bounceMul: clamp(safe(v.bounceMul, 1), PHYS_BOUNCE_RANGE[0], PHYS_BOUNCE_RANGE[1]),
  };
}

function insertLobby(
  ctx: Ctx,
  mode: number,
  vsBot: boolean,
  court: number,
  concurrent: number,
  ruleset: number,
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
    court: court < COURTS.length ? court : 0,
    concurrent: clamp(concurrent, 1, 4),
    championName: '',
    betWinnerName: '',
    betWinnerCredits: 0,
    createdAt: ctx.timestamp,
    ruleset: ruleset <= RULES_TARGETS ? ruleset : RULES_TENNIS,
    botLevel: clamp(botLevel, 0, BOT_LEVELS.length - 1),
    gravityMul: p.gravityMul,
    dragMul: p.dragMul,
    speedMul: p.speedMul,
    bounceMul: p.bounceMul,
  });
}

// Seat a bot in a room. Bots are ordinary player rows (so they render, hit,
// and hold a bracket seat like anyone else) that the tick drives instead of
// a client; `index` is unique within the lobby and picks the name/character.
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
    y: sideSign(side) * (COURT_HALF_LEN + 3),
    dirX: 0,
    dirY: 0,
    swingTicks: 0,
    swingKind: 0,
    swingHeld: false,
    lungeTicks: 0,
    characterId: BOT_CHAR,
    momentum: 0,
    online: true,
    isBot: true,
    spectator: false,
    teamSlot: 0,
  };
  if (ctx.db.player.identity.find(identity)) ctx.db.player.identity.update(row);
  else ctx.db.player.insert(row);
  return identity;
}

// Tear a whole room down: bots deleted, watchers released, and every row
// keyed to the room or its matches removed. Called both when the last player
// walks out and when the reaper finds a room nobody came back to.
function destroyLobby(ctx: Ctx, lobby: LobbyRow) {
  disarmReaper(ctx, lobby.id);
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    if (p.isBot) ctx.db.player.identity.delete(p.identity);
    else releaseSpectator(ctx, p);
  }
  // before the match rows go: the books are keyed by match
  deleteBetting(ctx, lobby.id);
  for (const m of lobbyMatches(ctx, lobby.id)) {
    deleteTickTimers(ctx, m.id);
    deleteGraceTimers(ctx, m.id);
    deleteTargets(ctx, m.id);
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

  // Walking out of a live match is a DECISION, not a dropped socket: it
  // forfeits on the spot, at full MMR weight. (Doubles: one player leaving
  // forfeits for the team.) Only an involuntary close buys the grace window.
  //
  // This runs BEFORE the seat is cleared below: finishMatch pays out from the
  // match roster, and a player already cleared off it would walk away from
  // the loss without it ever touching their rating.
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
  // Re-read: finishMatch above cleared matchId through endMatchCleanup, so
  // spreading the row captured on the way in would resurrect the old seat.
  const cleared = ctx.db.player.identity.find(player.identity) ?? player;
  ctx.db.player.identity.update({
    ...cleared,
    lobbyId: 0n,
    matchId: 0n,
    eliminated: false,
    // leaving always ends spectatorship — otherwise the flag would follow the
    // player into the next room they create, which counts competitors
    spectator: false,
    dirX: 0, dirY: 0,
    swingTicks: 0,
    lungeTicks: 0,
  });
  if (!lobby) return;

  const remaining = lobbyPlayers(ctx, lobby.id).filter(
    p => !sameId(p.identity, player.identity)
  );
  // Only competitors keep a room alive — once the last one is gone there is
  // nothing left to watch, so the watchers go back to the menu with it.
  const remainingPlayers = remaining.filter(p => !p.isBot && !p.spectator);
  if (remainingPlayers.length === 0) {
    destroyLobby(ctx, lobby);
    return;
  }
  // re-read: finishMatch above may have advanced the bracket / crowned a
  // champion — spreading the stale row captured earlier would clobber that
  const cur = ctx.db.lobby.id.find(lobby.id);
  if (cur && !sameId(cur.hostId, remainingPlayers[0].identity)) {
    ctx.db.lobby.id.update({ ...cur, hostId: remainingPlayers[0].identity });
  }
}

// Put a watcher back on the menu (their room went away under them).
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
  // Presence is counted, never toggled: this identity may already hold a
  // socket (a second tab, or the old one whose close hasn't landed yet).
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
      // a returning account brings its name and character back with it
      name: account.displayName,
      lobbyId: 0n,
      matchId: 0n,
      side: 0,
      eliminated: false,
      x: 0, y: 0,
      dirX: 0, dirY: 0,
      swingTicks: 0,
      swingKind: 0,
      swingHeld: false,
      lungeTicks: 0,
      characterId: account.characterId,
      momentum: 0,
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
  // Coming back to a room: call off its reaper, and let a match that halted
  // for this player pick up where it stopped.
  if (existing.lobbyId !== 0n) disarmReaper(ctx, existing.lobbyId);
  if (existing.matchId !== 0n) syncPresence(ctx, existing.matchId);
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const connId = ctx.connectionId;
  if (connId) ctx.db.session.connectionId.delete(connId);
  // Another tab still holds this identity — nothing has actually gone away.
  if (hasSession(ctx, ctx.sender)) return;

  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) return;
  const offline = { ...player, online: false };
  ctx.db.player.identity.update(offline);
  if (player.lobbyId === 0n) return;

  const match = player.matchId === 0n ? null : ctx.db.match.id.find(player.matchId);
  if (match && match.state === M_LIVE) {
    // On court: HALT the match and hold the seat. The grace timer decides.
    haltMatch(ctx, match, player.name);
    armReaper(ctx, player.lobbyId);
    return;
  }
  // Not on court. A tournament entrant whose bracket is already running keeps
  // their seat (their next match will halt if they are still away); everyone
  // else — a lobby still filling up, a watcher, an entrant who hasn't been
  // drawn yet — frees it, because a ghost seat blocks a real joiner.
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
  // account.displayName is the source of truth — player.name is the copy the
  // room reads, so it follows you to the next device you sign in on.
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
  { court: t.u8(), ruleset: t.u8(), isPublic: t.bool(), teamSize: t.u8(), ...physArgs },
  (ctx, { court, ruleset, isPublic, teamSize, gravityMul, dragMul, speedMul, bounceMul }) => {
    if (ruleset !== RULES_TENNIS && ruleset !== RULES_BEERPONG) {
      throw new SenderError('This mode is single-player — start it vs the bot');
    }
    const size = clamp(teamSize, 1, MAX_TEAM_SIZE);
    if (size > 1 && ruleset !== RULES_TENNIS) {
      throw new SenderError('Team matches are tennis-only for now');
    }
    const player = getPlayer(ctx);
    leaveCurrentLobby(ctx, player);
    const lobby = insertLobby(ctx, MODE_QUICK, false, court, 1, ruleset, 1, {
      gravityMul, dragMul, speedMul, bounceMul,
    }, isPublic, size);
    const fresh = ctx.db.player.identity.find(ctx.sender)!;
    ctx.db.player.identity.update({
      ...fresh, lobbyId: lobby.id, side: 0, teamSlot: 0, x: 0, y: -COURT_HALF_LEN - 3,
    });
  }
);

export const create_practice = spacetimedb.reducer(
  { court: t.u8(), ruleset: t.u8(), botLevel: t.u8(), ...physArgs },
  (ctx, { court, ruleset, botLevel, gravityMul, dragMul, speedMul, bounceMul }) => {
    if (ruleset > RULES_TARGETS) throw new SenderError('Unknown ruleset');
    const player = getPlayer(ctx);
    leaveCurrentLobby(ctx, player);
    // practice rooms are never listed publicly
    const lobby = insertLobby(ctx, MODE_QUICK, true, court, 1, ruleset, botLevel, {
      gravityMul, dragMul, speedMul, bounceMul,
    }, false);
    const fresh = ctx.db.player.identity.find(ctx.sender)!;
    ctx.db.player.identity.update({ ...fresh, lobbyId: lobby.id });
    const botId = insertBot(ctx, lobby.id, 0, 1);
    ctx.db.lobby.id.update({ ...lobby, status: L_RUNNING });
    const match = createMatch(ctx, lobby, 1, 0, ctx.sender, botId, GAMES_TO_WIN);
    goLive(ctx, match);
  }
);

export const create_tournament = spacetimedb.reducer(
  { court: t.u8(), concurrent: t.u8(), isPublic: t.bool(), format: t.u8(), teamSize: t.u8(), ...physArgs },
  (ctx, { court, concurrent, isPublic, format, teamSize, gravityMul, dragMul, speedMul, bounceMul }) => {
    const player = getPlayer(ctx);
    leaveCurrentLobby(ctx, player);
    const lobby = insertLobby(ctx, MODE_TOURNAMENT, false, court, concurrent, RULES_TENNIS, 1, {
      gravityMul, dragMul, speedMul, bounceMul,
    }, isPublic, clamp(teamSize, 1, MAX_TEAM_SIZE));
    ctx.db.lobby.id.update({
      ...lobby,
      format: format === FORMAT_DOUBLE ? FORMAT_DOUBLE : FORMAT_SINGLE,
    });
    const fresh = ctx.db.player.identity.find(ctx.sender)!;
    ctx.db.player.identity.update({ ...fresh, lobbyId: lobby.id });
  }
);

// Host can tweak the format and court count while registration is open —
// the lobby screen previews the bracket from these settings.
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
  const competitors = members.filter(m => !m.spectator);

  if (lobby.mode === MODE_QUICK) {
    // The court is taken — anyone else holding the code comes in to watch.
    const capacity = lobbyTeamSize(lobby) * 2;
    if (competitors.length >= capacity || lobby.status !== L_OPEN) {
      const live = lobbyMatches(ctx, lobby.id).some(m => m.state === M_LIVE);
      if (!live) throw new SenderError('That match is over');
      joinAsSpectator(ctx, player, lobby);
      return;
    }
    leaveCurrentLobby(ctx, player);
    // Seats fill sides evenly, captains first: (side 0, seat 0) is the host,
    // then (1,0), (0,1), (1,1), (0,2), (1,2) — teams always end up even.
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
      x: 0,
      y: sideSign(side) * (COURT_HALF_LEN + 3),
    });
    if (competitors.length + 1 < capacity) return; // room still filling up
    ctx.db.lobby.id.update({ ...lobby, status: L_RUNNING });
    const all = lobbyCompetitors(ctx, lobby.id);
    const cap0 = all.find(p => p.side === 0 && p.teamSlot === 0) ?? all[0];
    const cap1 =
      all.find(p => p.side === 1 && p.teamSlot === 0) ??
      all.find(p => !sameId(p.identity, cap0.identity))!;
    registerQuickTeams(ctx, lobby.id, all);
    const match = createMatch(ctx, lobby, 1, 0, cap0.identity, cap1.identity, GAMES_TO_WIN);
    goLive(ctx, match);
    return;
  }

  // tournament: join during registration as a player; later as a spectator
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

// Quick team rooms: (re)build the two team rows from the current seat
// layout, so goLive can seat everyone the same way tournaments do.
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

// Park someone in a room as a watcher: no match slot, no bracket seat.
// `eliminated` keeps the tournament screens treating them as out of the draw.
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
  // Watching a live tournament comes with a stack — a returning watcher keeps
  // whatever they left with.
  if (lobby.mode === MODE_TOURNAMENT && lobby.status === L_RUNNING) {
    grantWallet(ctx, lobby.id, ctx.sender);
  }
}

// Watch a specific live match from the menu's live list. Public rooms only —
// a private match is still watchable, but only by someone with its code.
export const spectate_match = spacetimedb.reducer(
  { matchId: t.u64() },
  (ctx, { matchId }) => {
    const player = getPlayer(ctx);
    const match = ctx.db.match.id.find(matchId);
    if (!match || match.state !== M_LIVE) throw new SenderError('That match has finished');
    if (
      sameId(match.p0Id, ctx.sender) ||
      sameId(match.p1Id, ctx.sender) ||
      player.matchId === matchId // doubles partners aren't p0/p1
    ) {
      throw new SenderError("You're playing in that match");
    }
    const lobby = ctx.db.lobby.id.find(match.lobbyId);
    if (!lobby) throw new SenderError('That match has finished');
    if (!lobby.isPublic) throw new SenderError('That match is private — you need the code');
    // already in the room (waiting out a round, say): nothing to move
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
  // Anyone who dropped during registration is not in the draw: their seat
  // would go straight into a halted round-1 match nobody is sitting in.
  // (Once the bracket IS running a dropped entrant keeps their seat — see
  // onDisconnect — because there is a real result riding on it by then.)
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    if (!p.isBot && !p.spectator && !hasSession(ctx, p.identity)) {
      leaveCurrentLobby(ctx, p);
    }
  }
  const entrants = lobbyPlayers(ctx, lobby.id).filter(p => !p.isBot && !p.spectator);
  const teamSize = lobbyTeamSize(lobby);
  if (entrants.length < 2) throw new SenderError('Need at least 2 players');

  // deterministic shuffle for seeding (and, in team play, the team draw)
  const order = entrants.map(p => p.identity);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1)) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  // Every empty seat in the draw is filled by a bot rather than a bye, so no
  // entrant is handed a walkover: a short team gets bot partners, and the
  // bracket is padded to a power of two with bot units. They play at the
  // room's difficulty (normal for tournaments) like any other competitor.
  let botCount = 0;
  const addBot = () => insertBot(ctx, lobby.id, botCount++, 1);
  // Team play: chunk the shuffled entrants into teams; the bracket pairs the
  // captains and goLive seats every registered member of both teams.
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
  // Round 1 is a full power of two, so the fold pairing (seed i vs seed
  // S-1-i) leaves no empty slot: every later round pairs evenly too.
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
  // Betting stack for everyone in the room — entrants bet while they wait
  // out a round, and the eliminated keep playing the bracket from the stands.
  // (The bots seated above hold no wallet: they never bet.)
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    if (!p.isBot) grantWallet(ctx, lobby.id, p.identity);
  }
  for (let slot = 0; slot < size / 2; slot++) {
    const hi = size - 1 - slot;
    createMatch(
      ctx, { ...lobby, status: L_RUNNING }, 1, slot, units[slot], units[hi],
      TOURNEY_GAMES_TO_WIN
    );
  }
  advanceTournament(ctx, { ...lobby, status: L_RUNNING });
});

// Stake credits on a tournament match you are NOT playing in. Every check
// here is the authority — the client's disabled buttons are only a courtesy.
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
    // only idle members of the room bet — never someone standing on a court
    if (player.matchId !== 0n) throw new SenderError("You can't bet while you're playing");

    const match = ctx.db.match.id.find(matchId);
    if (!match || match.lobbyId !== lobby.id) throw new SenderError('No such match');
    if (!match.hasP1) throw new SenderError('That match is a bye');
    const book = ctx.db.book.matchId.find(matchId);
    if (!book) throw new SenderError('No betting on that match');
    if (!book.open) throw new SenderError('Betting is closed for this match');

    // Never bet on yourself: a player who can profit from losing breaks the
    // bracket. In team play that covers every member of both teams.
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

    // Lock the price the bettor is looking at, then let the money move the
    // line for whoever bets next.
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

// Give up the match you are in. Deliberately NOT the same as leaving the
// room: you stay for the rematch vote or the bracket screen, and in a
// tournament this eliminates you exactly like a loss on court.
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

// End a halted match early rather than sitting out the full grace window.
// Locked for the first CLAIM_UNLOCK so a real network blip is always
// survivable; after that, nobody is held hostage by a closed tab.
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
  // without this a watcher's vote would count as the missing player's
  // (doubles: any competitor may vote for their team)
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
    // clean up old match rows, then start a fresh one with the same pairing
    for (const m of matches) {
      deleteTickTimers(ctx, m.id);
      deleteTargets(ctx, m.id);
      if (ctx.db.ball.matchId.find(m.id)) ctx.db.ball.matchId.delete(m.id);
      ctx.db.match.id.delete(m.id);
    }
    // team play: re-seat from the current roster (teams are kept — seats
    // persist on the player rows); singles keeps the exact old pairing
    const cap0 =
      teamSize >= 2
        ? (all.find(p => p.side === 0 && p.teamSlot === 0) ?? all[0]).identity
        : last.p0Id;
    const cap1 =
      teamSize >= 2
        ? (all.find(p => p.side === 1 && p.teamSlot === 0) ?? all[1]).identity
        : last.p1Id;
    registerQuickTeams(ctx, lobby.id, all);
    const match = createMatch(ctx, lobby, 1, 0, cap0, cap1, GAMES_TO_WIN);
    goLive(ctx, match);
  } else {
    ctx.db.match.id.update({ ...last, rematchVotes: votes });
  }
});

// ---------------------------------------------------------------------------
// Chat + emotes
// ---------------------------------------------------------------------------
const CHAT_KEEP = 30;
const EMOTES = ['👍', '😂', '🔥', '😭', '🎾', '❤️', '😡', '🤝'];

// Anti-spam thresholds, all in microseconds. A full burst window acts as a
// natural cooldown because rejected sends never advance the guard state.
// Mirrored in client/src/main.ts for instant local feedback — keep in sync.
const CHAT_MIN_GAP = 800_000n; // between chat messages
const EMOTE_MIN_GAP = 400_000n; // between emotes (mashing them is part of the fun)
const CHAT_WINDOW = 10_000_000n; // burst window length
const CHAT_WINDOW_MAX = 8; // messages allowed per window (chat + emotes)
const CHAT_DUP_GAP = 5_000_000n; // identical text rejected within this

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
  { dirX: t.i8(), dirY: t.i8() },
  (ctx, { dirX, dirY }) => {
    const player = getPlayer(ctx);
    if (player.matchId === 0n) return;
    const dx = clamp(dirX, -1, 1);
    const dy = clamp(dirY, -1, 1);
    ctx.db.player.identity.update({ ...player, dirX: dx, dirY: dy });
  }
);

export const swing = spacetimedb.reducer({ kind: t.u8() }, (ctx, { kind }) => {
  const player = getPlayer(ctx);
  if (player.matchId === 0n) return;
  if (player.lungeTicks > 0) return; // committed to a lunge — no re-swing yet
  const match = ctx.db.match.id.find(player.matchId);
  if (!match || match.state !== M_LIVE) return;
  if (match.phase === PHASE_SERVE && player.side === match.servingSide) {
    if (match.startTicks > 0) return; // still in the 3-2-1 countdown
    // doubles: only the designated server may toss — not their partner
    const serveLobby = ctx.db.lobby.id.find(match.lobbyId);
    if (!isDesignatedServer(match, player, lobbyTeamSize(serveLobby))) return;
    const ball = ctx.db.ball.matchId.find(match.id);
    if (!ball) return;
    if (!ball.active) executeToss(ctx, match, player, ball);
    else executeServeStrike(ctx, match, player, ball);
  } else if (match.phase === PHASE_RALLY) {
    // SUPER only arms on a full meter — otherwise the combo is a plain drive
    const swingKind =
      kind === SWING_LOB
        ? SWING_LOB
        : kind === SWING_SUPER && player.momentum >= MOMENTUM_MAX
          ? SWING_SUPER
          : SWING_FLAT;
    ctx.db.player.identity.update({
      ...player,
      swingTicks: SWING_WINDOW,
      swingKind,
      swingHeld: true,
    });
  }
});

export const swing_release = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.matchId === 0n || !player.swingHeld) return;
  ctx.db.player.identity.update({ ...player, swingHeld: false });
});

// ---------------------------------------------------------------------------
// Simulation tick (30 Hz per live match)
// ---------------------------------------------------------------------------
export const game_tick = spacetimedb.reducer(
  { onSchedule: TickTimer },
  { arg: TickTimer.rowType },
  (ctx, { arg }) => {
    const match = ctx.db.match.id.find(arg.matchId);
    if (!match || match.state !== M_LIVE) {
      ctx.db.tickTimer.scheduledId.delete(arg.scheduledId);
      return;
    }
    // Halted: somebody dropped and the grace window is running. haltMatch
    // already deleted this timer — this only catches one that outlived it by
    // a tick, and makes sure the world never moves while a seat is empty.
    if (match.haltMask !== 0) {
      ctx.db.tickTimer.scheduledId.delete(arg.scheduledId);
      return;
    }
    const lobby = ctx.db.lobby.id.find(match.lobbyId);
    const ruleset = lobby?.ruleset ?? RULES_TENNIS;
    const phys = lobbyPhysics(lobby);
    const botIdx = clamp(lobby?.botLevel ?? 1, 0, BOT_LEVELS.length - 1);
    const botLvl = BOT_LEVELS[botIdx];
    const surf = COURTS[lobby?.court ?? 0] ?? COURTS[0];

    // Match-start countdown: the world holds still until the 3-2-1 elapses
    // (the client renders the numbers straight from startTicks).
    if (match.phase === PHASE_SERVE && match.startTicks > 0) {
      const left = match.startTicks - 1;
      ctx.db.match.id.update({ ...match, startTicks: left });
      // first ball is imminent — the book shuts. One indexed lookup on one
      // tick per match; the steady-state loop never touches betting tables.
      if (left === 0) closeBook(ctx, match.id);
      return;
    }

    // Move players. Long rallies heat everything up (megabonk rule).
    const ballRow = ctx.db.ball.matchId.find(match.id);
    const heat =
      match.phase === PHASE_RALLY && ballRow ? rallyFactor(ballRow.rallyHits) : 1;
    // HITSTOP holds the hitter frozen mid-swing (Lethal League style) —
    // movement, lunge recovery, everything waits out the freeze with the ball
    const ballFrozen =
      match.phase === PHASE_RALLY && !!ballRow && ballRow.active && ballRow.freezeTicks > 0;
    const players = matchPlayers(ctx, match.id);
    // Steer every bot in the match — a bracket filler can hold either side,
    // and two bots can be drawn against each other. (The target-practice
    // machine only serves; it never chases the ball.)
    // A served ball puts the receiving side on its serve-return dials (and
    // lets it read the ball through the bounce); everyone else — the server
    // recovering included — plays the rally profile. Same restitution the
    // bounce itself uses below, so the read matches the physics.
    // Takes the ball explicitly: the contact layer below returns the serve
    // part-way through its own loop, and a doubles partner checked after
    // that must see the rally profile, not a stale serve flag.
    const isReturning = (b: BallRow | null | undefined, side: number) =>
      !!b && b.active && b.aimBehind && side !== b.lastHitSide;
    const dialsFor = (b: BallRow | null | undefined, side: number) =>
      isReturning(b, side) ? BOT_RETURN_DIALS[botIdx] : BOT_RALLY_DIALS[botIdx];
    // The read has to know how fast the bot can actually run, or it picks an
    // interception it can't make. Same restitution the bounce below applies.
    const serveBounceFor = (p: PlayerRow) =>
      isReturning(ballRow, p.side)
        ? {
            rest: Math.min(0.95, surf.vz * phys.bounce),
            skid: surf.vxy,
            speed:
              PLAYER_SPEED * charStat(p.characterId).speed *
              dialsFor(ballRow, p.side).speed,
          }
        : null;
    if (match.phase === PHASE_RALLY && ruleset !== RULES_TARGETS) {
      for (let i = 0; i < players.length; i++) {
        if (!players[i].isBot) continue;
        players[i] = botSteer(
          players[i], ballRow, phys.gravity, dialsFor(ballRow, players[i].side).aimErr,
          // seeded per bot, so partners don't chase the ball in lockstep
          Number(match.id) + players[i].side * 31 + players[i].teamSlot * 17,
          serveBounceFor(players[i])
        );
      }
    }
    for (const p of players) {
      // the frozen hitter is pinned in place until the ball unfreezes
      if (ballFrozen && p.side === ballRow!.lastHitSide) continue;
      // single atomic update per player — a second update with a stale spread
      // would silently revert the lungeTicks decrement
      let recoverDamp = 1;
      const lungeTicks = p.lungeTicks > 0 ? p.lungeTicks - 1 : 0;
      const stateChanged = lungeTicks !== p.lungeTicks;
      if (p.lungeTicks > 0 && p.lungeTicks > LUNGE_AIRBORNE) {
        ctx.db.player.identity.update({ ...p, lungeTicks });
        continue;
      }
      if (p.lungeTicks > 0) recoverDamp = 0.45;
      if (p.dirX === 0 && p.dirY === 0) {
        if (stateChanged) ctx.db.player.identity.update({ ...p, lungeTicks });
        continue;
      }
      // The server is pinned to the baseline in their serve court until the
      // serve is struck: sideways shuffle only, no walking in. In doubles
      // only the designated server is pinned — their partner roams free.
      const isServing =
        match.phase === PHASE_SERVE &&
        isDesignatedServer(match, p, lobbyTeamSize(lobby));
      // backpedaling toward your own baseline is slower — lobs buy real time
      const retreating = p.dirY * sideSign(p.side) > 0 ? 0.75 : 1;
      const speed =
        PLAYER_SPEED * charStat(p.characterId).speed * heat * recoverDamp *
        momentumFactor(p.momentum) * retreating *
        (p.isBot ? dialsFor(ballRow, p.side).speed : 1);
      const len = Math.hypot(p.dirX, p.dirY) || 1;
      let x = clamp(p.x + (p.dirX / len) * speed * DT, -BOUNDS_X, BOUNDS_X);
      let y: number;
      if (isServing) {
        if (ruleset === RULES_BEERPONG) {
          // beer pong: line up your throw anywhere along the baseline
          y = sideSign(p.side) * (COURT_HALF_LEN + 3);
        } else {
          const parity = (match.p0Points + match.p1Points) % 2 === 0 ? 1 : -1;
          const halfSign = parity * -sideSign(p.side);
          x = halfSign > 0 ? clamp(x, 1, BOUNDS_X) : clamp(x, -BOUNDS_X, -1);
          y = sideSign(p.side) * (COURT_HALF_LEN + 3);
        }
      } else {
        const rawY = p.y + (p.dirY / len) * speed * DT;
        y =
          p.side === 0
            ? clamp(rawY, -BOUNDS_Y_FAR, -BOUNDS_Y_NEAR)
            : clamp(rawY, BOUNDS_Y_NEAR, BOUNDS_Y_FAR);
      }
      ctx.db.player.identity.update({ ...p, x, y, lungeTicks });
    }

    if (match.phase === PHASE_SERVE) {
      // whoever is up to serve: if it's a bot, the tick tosses and strikes
      // for it (either side of the net, and in bot-vs-bot matches)
      const botServer = players.find(
        p => p.isBot && isDesignatedServer(match, p, lobbyTeamSize(lobby))
      );
      const sball = ctx.db.ball.matchId.find(match.id);
      if (sball && sball.active) {
        // toss in flight: vertical motion only
        const z = sball.z + sball.vz * DT + 0.5 * phys.gravity * DT * DT;
        const vz = sball.vz + phys.gravity * DT;
        if (z <= 0) {
          ctx.db.ball.matchId.update({ ...sball, active: false, z: 0, vz: 0 });
        } else {
          ctx.db.ball.matchId.update({ ...sball, z, vz });
          // easier bots strike the toss late — a slower, softer serve (and in
          // target practice this is the feed-speed dial)
          if (botServer && vz < botLvl.serveVz) {
            const roll = hash01(
              Number(match.id) * 31 + match.p0Points * 7 + match.p1Points * 13
            );
            const aim = Math.floor(roll * 3) - 1;
            // beer pong: the second axis picks which cup row to attack
            const aimY = Math.floor(hash01(roll * 91.7 + 4.2) * 3) - 1;
            executeServeStrike(
              ctx, match, { ...botServer, dirX: aim, dirY: aimY }, { ...sball, z, vz }
            );
          }
        }
      } else if (botServer) {
        const remaining = match.pauseTicks - 1;
        if (remaining <= 0) {
          if (sball) executeToss(ctx, match, botServer, sball);
        } else {
          ctx.db.match.id.update({ ...match, pauseTicks: remaining });
        }
      }
      return;
    }

    if (match.phase === PHASE_POINT_OVER) {
      const remaining = match.pauseTicks - 1;
      if (remaining <= 0) setupServe(ctx, match);
      else ctx.db.match.id.update({ ...match, pauseTicks: remaining });
      return;
    }

    if (match.phase !== PHASE_RALLY) return;

    let ball = ctx.db.ball.matchId.find(match.id);
    if (!ball || !ball.active) return;

    // HITSTOP: the ball hangs at the contact point with its launch velocity
    // loaded; players (moved above) are free to reposition through it.
    if (ball.freezeTicks > 0) {
      ctx.db.ball.matchId.update({ ...ball, freezeTicks: ball.freezeTicks - 1 });
      return;
    }

    // CURL/nudge: keep holding the direction you hit with and the shot
    // bends a touch that way, scaled by the spin stat. Pre-bounce only, and
    // never for the bot (its held direction is movement steering, not
    // intent). Armed at contact (ball.aimKind); the moment the hitter
    // releases or reverses, it disarms for the rest of the flight —
    // re-pressing does nothing.
    let curl = 0;
    if (ball.bounces === 0 && ball.aimKind !== 0) {
      const hitSide = ball.lastHitSide;
      const hitter = players.find(pl => pl.side === hitSide && !pl.isBot);
      if (hitter) {
        const armedDir = ball.aimKind === 1 ? -1 : 1;
        if (hitter.dirX === armedDir) {
          curl = armedDir * CURL_ACCEL * charStat(hitter.characterId).spin;
        } else {
          ball = { ...ball, aimKind: 0 };
        }
      }
    }

    // PERFECT guarantee, flight half (constants by PERFECT_GUARD_MARGIN):
    // predict where this lateral accel puts the landing; if it would cross
    // the per-flight guard line, re-solve the accel over the remaining
    // flight so the ball comes down just inside instead. Re-run every tick,
    // the correction stays tiny and the arc smooth — a steered PERFECT shot
    // rides the paint rather than missing. Inward steering is never touched.
    let ax = ball.spinX + curl;
    if (ball.bounces === 0 && ball.aimQuality === Q_PERFECT + 1) {
      const g = -phys.gravity;
      const tLand =
        (ball.vz + Math.sqrt(Math.max(0, ball.vz * ball.vz + 2 * g * ball.z))) / g;
      if (tLand > 2 * DT) {
        // seeded off flight-constant fields, so the line holds for the flight
        const wob = hash01(
          ball.aimContactZ * 7.3 + ball.rallyHits * 13.7 + ball.lastHitSide * 5.1
        );
        const capX =
          COURT_HALF_WID + LINE_MARGIN - PERFECT_GUARD_MARGIN - wob * PERFECT_GUARD_WOBBLE;
        const lx = ball.x + ball.vx * tLand + 0.5 * ax * tLand * tLand;
        if (Math.abs(lx) > capX) {
          const need =
            (Math.sign(lx) * capX - ball.x - ball.vx * tLand) / (0.5 * tLand * tLand);
          ax = clamp(need, -PERFECT_GUARD_ACCEL, PERFECT_GUARD_ACCEL);
        }
      }
    }
    // Integrate ball (spinX = screw-shot sidespin curving the flight;
    // custom-rules drag bleeds velocity exponentially).
    const prevX = ball.x;
    const prevY = ball.y;
    const prevZ = ball.z;
    const newZ = ball.z + ball.vz * DT + 0.5 * phys.gravity * DT * DT;
    const dragKeep = phys.drag > 0 ? Math.max(0, 1 - phys.drag * DT) : 1;
    ball = {
      ...ball,
      x: ball.x + ball.vx * DT + 0.5 * ax * DT * DT,
      y: ball.y + ball.vy * DT,
      z: newZ,
      vx: (ball.vx + ax * DT) * dragKeep,
      vy: ball.vy * dragKeep,
      vz: (ball.vz + phys.gravity * DT) * dragKeep,
      apexZ: Math.max(ball.apexZ, newZ),
    };

    // Net check: crossed y=0 below net height?
    if (prevY !== ball.y && Math.sign(prevY) !== Math.sign(ball.y) && prevY !== 0) {
      const f = Math.abs(prevY) / Math.abs(ball.y - prevY);
      const zAtNet = prevZ + (ball.z - prevZ) * f;
      if (zAtNet < NET_HEIGHT && Math.abs(ball.x) < COURT_HALF_WID + 2) {
        ctx.db.ball.matchId.update({ ...ball, active: false });
        if (ruleset === RULES_BEERPONG) beerPongNextServe(ctx, match, 'NET!');
        else if (ruleset === RULES_TARGETS) targetsBallDone(ctx, match, null);
        else awardPoint(ctx, match, 1 - ball.lastHitSide, 'NET!');
        return;
      }
    }

    // Ground bounce.
    if (ball.z <= 0 && ball.vz < 0) {
      // A 30 Hz tick carries the ball up to a full step PAST the true z=0
      // contact (several units of x/y on a hot rally) — enough to turn a
      // shot aimed inside the baseline into a phantom OUT. Interpolate the
      // touchdown back to the crossing, like the net check above, so the
      // line call reads where the ball actually met the court.
      if (prevZ > 0) {
        const f = clamp(prevZ / (prevZ - ball.z), 0, 1);
        ball = {
          ...ball,
          x: prevX + (ball.x - prevX) * f,
          y: prevY + (ball.y - prevY) * f,
        };
      }
      const inCourt =
        Math.abs(ball.x) <= COURT_HALF_WID + LINE_MARGIN &&
        Math.abs(ball.y) <= COURT_HALF_LEN + LINE_MARGIN;
      const landedSide = ball.y < 0 ? 0 : 1;
      if (ball.bounces === 0) {
        if (!inCourt || landedSide === ball.lastHitSide) {
          ctx.db.ball.matchId.update({ ...ball, z: 0, active: false });
          if (ruleset === RULES_BEERPONG) beerPongNextServe(ctx, match, 'OUT!');
          else if (ruleset === RULES_TARGETS) targetsBallDone(ctx, match, null);
          else awardPoint(ctx, match, 1 - ball.lastHitSide, 'OUT!');
          return;
        }
        // Beer pong: the throw ends where it first lands — cup or not,
        // there is no rally. Bullseyes likewise only score on first bounce.
        if (
          ruleset === RULES_BEERPONG ||
          (ruleset === RULES_TARGETS && landedSide === 1 && ball.lastHitSide === 0)
        ) {
          const bx = ball.x;
          const by = ball.y;
          const cup = [...ctx.db.target.byMatch.filter(match.id)].find(
            tg => tg.alive && tg.side === landedSide && Math.hypot(tg.x - bx, tg.y - by) <= tg.radius
          );
          if (cup) {
            ctx.db.ball.matchId.update({ ...ball, z: 0, active: false });
            if (ruleset === RULES_BEERPONG) beerPongSink(ctx, match, cup, ball.lastHitSide);
            else targetsBallDone(ctx, match, cup);
            return;
          }
          if (ruleset === RULES_BEERPONG) {
            ctx.db.ball.matchId.update({ ...ball, z: 0, active: false });
            beerPongNextServe(ctx, match, 'MISS!');
            return;
          }
        }
        // custom-rules bounciness stacks on the surface (capped so the ball
        // always loses energy)
        const rest = Math.min(0.95, surf.vz * phys.bounce);
        ball = { ...ball, z: 0, vz: -ball.vz * rest, vx: ball.vx * surf.vxy, vy: ball.vy * surf.vxy, bounces: 1 };
      } else {
        ctx.db.ball.matchId.update({ ...ball, z: 0, active: false });
        if (ruleset === RULES_BEERPONG) beerPongNextServe(ctx, match, 'DOUBLE BOUNCE!');
        else if (ruleset === RULES_TARGETS) targetsBallDone(ctx, match, null);
        else awardPoint(ctx, match, ball.lastHitSide, 'DOUBLE BOUNCE!');
        return;
      }
    }

    // Swing contact. Beer pong is throw-only — the ball can never be struck
    // in flight, so the whole contact layer is skipped.
    if (ruleset !== RULES_BEERPONG)
    for (const p of players) {
      if (p.isBot) {
        // the target-practice machine never returns the ball
        if (ruleset === RULES_TARGETS) continue;
        const current = ctx.db.player.identity.find(p.identity)!;
        const botDist = Math.hypot(ball.x - current.x, ball.y - current.y);
        const eBot = effectiveDist(current.x, current.y, current.side, ball.x, ball.y, ball.z);
        // Difficulty: easier bots reach less, never dive, and sometimes just
        // don't swing at a return at all (deterministic per exchange). On a
        // serve those dials sharpen right up — refusing to swing at a serve
        // was the most maddening way to be handed a point.
        const dials = dialsFor(ball, p.side);
        const whiff =
          dials.whiff > 0 &&
          hash01(Number(match.id) * 2.3 + ball.rallyHits * 11.13) < dials.whiff;
        const botReach = REACH * charStat(current.characterId).reach;
        const botStretch = STRETCH_REACH * dials.stretch;
        const botLunge = LUNGE_REACH * dials.lunge;
        const botCanReach = !whiff && ball.lastHitSide !== p.side && ball.z < HIT_MAX_Z;
        // Don't dive at a ball that is walking into your strike zone. On a
        // return the bot is already standing where it read the serve, so
        // flinging itself at the first thing to enter lunge range trades a
        // clean return for a scrambled one — it waits the extra tick and
        // hits the ball properly. Rally play keeps diving as before: there
        // the bot is usually still closing the ball down, not set for it.
        const closing =
          isReturning(ball, p.side) &&
          effectiveDist(
            current.x, current.y, current.side,
            ball.x + ball.vx * DT, ball.y + ball.vy * DT,
            ball.z + ball.vz * DT + 0.5 * phys.gravity * DT * DT
          ) < eBot;
        if (botLunge > 0 && botCanReach && !closing && eBot > botReach + botStretch && eBot <= botReach + botStretch + botLunge - 0.5) {
          const roll2 = hash01(ball.y * 5.1 + Number(match.id) * 3);
          ball = executeHit(
            match,
            { ...current, dirX: Math.floor(roll2 * 3) - 1, dirY: 0, swingKind: SWING_FLAT },
            ball,
            Q_WEAK,
            phys
          );
          const nx = current.x + (ball.x - current.x) * 0.85;
          const ny = current.y + (ball.y - current.y) * 0.85;
          ctx.db.player.identity.update({
            ...current, x: nx, y: ny, swingTicks: 6,
            lungeTicks: lungeTicksFor(eBot - botReach - botStretch),
          });
          continue;
        }
        if (botCanReach && eBot > botReach && eBot <= botReach + botStretch) {
          const roll3 = hash01(ball.x * 4.7 + Number(match.id) * 5);
          ball = executeHit(
            match,
            { ...current, dirX: Math.floor(roll3 * 3) - 1, dirY: 0, swingKind: SWING_FLAT },
            ball,
            Q_GOOD,
            phys
          );
          const fB = Math.max(0, 1 - CONTACT_DIST / botDist);
          const nx = current.x + (ball.x - current.x) * fB;
          const ny = current.y + (ball.y - current.y) * fB;
          ctx.db.player.identity.update({ ...current, x: nx, y: ny, swingTicks: 6 });
          continue;
        }
        const canHit = botCanReach && eBot <= botReach;
        if (canHit) {
          const roll = hash01(ball.x * 7.3 + ball.y * 3.1 + Number(match.id));
          const aim = Math.floor(roll * 3) - 1;
          // difficulty shapes the clean-contact quality distribution
          const quality =
            roll < dials.perfect
              ? Q_PERFECT
              : roll < dials.perfect + dials.weak
                ? Q_WEAK
                : Q_GOOD;
          // full meter + a perfect roll: the bot lands its finisher too
          const kind =
            current.momentum >= MOMENTUM_MAX && quality === Q_PERFECT
              ? SWING_SUPER
              : roll > 0.87 ? SWING_LOB : SWING_FLAT;
          ball = executeHit(
            match,
            { ...current, dirX: aim, dirY: 0, swingKind: kind },
            ball,
            quality,
            phys
          );
          ctx.db.player.identity.update({
            ...current,
            swingTicks: 6,
            momentum: ball.spinX !== 0
              ? 0
              : quality === Q_PERFECT
                ? Math.min(MOMENTUM_MAX, current.momentum + momentumGain(current.characterId))
                : current.momentum,
          });
        } else if (current.swingTicks > 0) {
          ctx.db.player.identity.update({ ...current, swingTicks: current.swingTicks - 1 });
        }
        continue;
      }
      if (p.swingTicks <= 0) continue;
      const current = ctx.db.player.identity.find(p.identity)!;
      const dist = Math.hypot(ball.x - current.x, ball.y - current.y);
      const eDist = effectiveDist(current.x, current.y, current.side, ball.x, ball.y, ball.z);
      // the reach stat grows (or shrinks) the stand-and-hit + stretch tiers
      const reach = REACH * charStat(current.characterId).reach;
      const stretch = STRETCH_REACH * charStat(current.characterId).reach;
      const reachable = ball.lastHitSide !== p.side && ball.z < HIT_MAX_Z;
      if (reachable && eDist <= reach) {
        // tier 1: stand and hit (a quick tap is always a weak poke)
        const q = current.swingHeld ? swingQuality(current.swingTicks) : Q_WEAK;
        ball = executeHit(match, current, ball, q, phys);
        const firedScrew = ball.spinX !== 0;
        ctx.db.player.identity.update({
          ...current,
          swingTicks: 0,
          momentum: firedScrew
            ? 0
            : q === Q_PERFECT
              ? Math.min(MOMENTUM_MAX, current.momentum + momentumGain(current.characterId))
              : current.momentum,
        });
      } else if (reachable && eDist <= reach + stretch) {
        // tier 2: reach to hit — never better than GOOD (tap = weak)
        const quality = current.swingHeld
          ? Math.max(swingQuality(current.swingTicks), Q_GOOD)
          : Q_WEAK;
        ball = executeHit(match, current, ball, quality, phys);
        const f = Math.max(0, 1 - CONTACT_DIST / dist);
        const nx = clamp(current.x + (ball.x - current.x) * f, -BOUNDS_X, BOUNDS_X);
        const ny = current.y + (ball.y - current.y) * f;
        ctx.db.player.identity.update({ ...current, x: nx, y: ny, swingTicks: 0 });
      } else if (reachable && eDist <= reach + stretch + LUNGE_REACH) {
        // tier 3: jump/dive to hit — weak stab, roots you
        ball = executeHit(match, current, ball, Q_WEAK, phys);
        const fD = Math.max(0.5, 1 - CONTACT_DIST / dist);
        const nx = clamp(current.x + (ball.x - current.x) * fD, -BOUNDS_X, BOUNDS_X);
        const ny = current.y + (ball.y - current.y) * fD;
        ctx.db.player.identity.update({
          ...current, x: nx, y: ny, swingTicks: 0,
          lungeTicks: lungeTicksFor(eDist - reach - stretch),
        });
      } else {
        const remaining = current.swingTicks - 1;
        if (remaining <= 0) {
          // tier 4: dive for it and miss — only when plausible
          const dx = ball.x - current.x;
          const dy = ball.y - current.y;
          const len = Math.hypot(dx, dy) || 1;
          const eLen = effectiveDist(current.x, current.y, current.side, ball.x, ball.y, ball.z);
          const plausible =
            ball.lastHitSide !== current.side &&
            eLen <= reach + stretch + LUNGE_REACH + MISS_MARGIN;
          if (plausible) {
            const lt = lungeTicksFor(eLen - reach - stretch);
            const step = Math.min(
              len,
              lt === LUNGE_SHORT ? 2.4 : lt === LUNGE_MED ? 4.5 : 6.5
            );
            const nx = clamp(current.x + (dx / len) * step, -BOUNDS_X, BOUNDS_X);
            const nyRaw = current.y + (dy / len) * step;
            const ny =
              current.side === 0
                ? clamp(nyRaw, -BOUNDS_Y_FAR, -BOUNDS_Y_NEAR)
                : clamp(nyRaw, BOUNDS_Y_NEAR, BOUNDS_Y_FAR);
            ctx.db.player.identity.update({
              ...current, x: nx, y: ny, swingTicks: 0, lungeTicks: lt,
            });
          } else {
            ctx.db.player.identity.update({ ...current, swingTicks: 0 });
          }
        } else {
          ctx.db.player.identity.update({ ...current, swingTicks: remaining });
        }
      }
    }

    ctx.db.ball.matchId.update(ball);
  }
);
