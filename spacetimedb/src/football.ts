// ---------------------------------------------------------------------------
// THE FOOTBALL.
//
// Everything that makes this a football match lives in this file: the pitch,
// the ball, the players' movement, possession, the laws, the keeper, the two
// team brains, and the 30 Hz tick that runs them. The meta layer — rooms,
// accounts, betting, tournaments — lives in index.ts and calls in through a
// handful of exported functions; nothing in here knows what a lobby costs or
// what a bet pays.
//
// This is a clean rewrite. The previous simulation grew by accretion and its
// hard-won lessons are recorded in CLAUDE.md; every one of them is honoured
// here BY DESIGN rather than by patch. The load-bearing ones:
//
//  - Control is a token on the BODY (ctrlSeat), never on the person.
//  - Bots steer on FLOAT headings (mvX/mvY); dirX/dirY is rendered facing.
//  - Movement is INSTANT. The stick is the velocity.
//  - Possession is a TOUCH CYCLE: the ball is knocked, rolls free, is caught.
//    Between touches nothing writes its position. A touch is an EVENT, aimed
//    at a spot in FRONT of the runner, only once he has caught the ball.
//  - A ball waiting to be restarted is DEAD. Nobody dribbles it off the spot.
//  - A struck ball locks out its kicker (lockTicks); any new touch clears it.
//  - Out-of-play is judged on where the ball IS, after possession.
//  - The keeper's shot prediction is exact; `err` alone makes him beatable
//    and must exceed the gap between his reach and the post.
//  - Defenders slide AT THE TOUCH, not at the man. Ball first is fair.
//  - Team behaviour is ONE PLAN PER SIDE PER TICK, assigned in one place.
// ---------------------------------------------------------------------------

import type { Ctx, PlayerRow, MatchRow, BallRow, LobbyRow } from './index';
import { Identity } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Wire enums. These are the values the client renders and the schema stores —
// they are the contract, and they do not change in a rewrite.
// ---------------------------------------------------------------------------
export const PHASE_KICKOFF = 1;
export const PHASE_LIVE = 2;
export const PHASE_PAUSE = 3;
export const PHASE_OVER = 4;

export const RK_NONE = 0;
export const RK_KICKOFF = 1;
export const RK_THROWIN = 2;
export const RK_GOALKICK = 3;
export const RK_CORNER = 4;
export const RK_HALFTIME = 5;
export const RK_OVERTIME = 6;
export const RK_DROP = 7;
export const RK_FREEKICK = 8;
export const RK_PENALTY = 9;

export const ROLE_OUTFIELD = 0;
export const ROLE_KEEPER = 1;
export const CTRL_NONE = 255;

export const KICK_NORMAL = 0;
export const KICK_CHIP = 1;

// The three context buttons the client sends.
export const ACT_PRIMARY = 0;
export const ACT_SECOND = 1;
export const ACT_THIRD = 2;

// ---------------------------------------------------------------------------
// Time and pitch. One metre is roughly 3.3 units.
// ---------------------------------------------------------------------------
// THE BUILD STAMP. Bump this on EVERY push (CLAUDE.md says so too). The
// client shows its own stamp and this one side by side, in red when they
// differ — because half of this project's history is fixes that were live
// locally while the deployment quietly ran last week's module, and "are you
// sure you pushed?" should be answerable by looking at the screen.
export const MODULE_BUILD = '2026-09-01-A';

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
export const ticks = (s: number) => Math.round(s * TICK_HZ);

export const PITCH_HALF_LEN = 66;
export const PITCH_HALF_WID = 34;
export const GOAL_HALF_W = 6.5;
export const GOAL_HEIGHT = 6.6;
export const BOX_DEPTH = 20;
export const BOX_HALF_W = 20;
export const CENTER_CIRCLE_R = 10;
export const BALL_RADIUS = 0.45;
const P_BOUNDS_X = PITCH_HALF_WID + 2;
const P_BOUNDS_Y = PITCH_HALF_LEN + 2;

export const HALF_SECONDS = 180;
export const OT_SECONDS = 120;

// Match format: human seats per side; the pitch always carries 3 + keeper.
export const MAX_TEAM_SIZE = 3;
export const OUTFIELD_PER_SIDE = 3;

const GOAL_PAUSE = ticks(7.5);
const RESTART_PAUSE = ticks(1.4);
const HALFTIME_PAUSE = ticks(6);
export const COUNTDOWN_TICKS = ticks(3);
// A kickoff nobody takes freezes the match forever — but WHO is waiting
// matters. An abandoned side gets a stand-in after four seconds; a human who
// is actually connected gets a proper moment to read the pitch, because a
// game that plays your kickoff for you while you look at the controls feels
// broken, not helpful.
const KICKOFF_AUTO = ticks(4);
const KICKOFF_AUTO_HUMAN = ticks(15);
// The restart window: only the awarded side may play the ball, and the set
// piece must be TAKEN inside it — four seconds, the small-sided law.
const RESTART_GRACE = ticks(4);

// ---------------------------------------------------------------------------
// Movement. INSTANT: the stick is the velocity, smoothness is the renderer's
// job. The client mirrors PLAYER_SPEED and SPRINT_MUL in config.ts and
// dead-reckons with them — change one and you change both.
// ---------------------------------------------------------------------------
export const PLAYER_SPEED = 15.5;
export const SPRINT_MUL = 1.6;
const DRIBBLE_MUL = 0.85;
export const STAMINA_MAX = 1000;
const SPRINT_DRAIN = 3;
const STAMINA_REGEN = 2;

// ---------------------------------------------------------------------------
// The ball. Quadratic AIR DRAG stops a struck ball (decays with distance);
// constant ROLLING RESISTANCE brings a slow one to rest. Either alone fails:
// resistance alone sends a shot 750 units down a 132-unit pitch, drag alone
// lets a dying ball creep forever.
// ---------------------------------------------------------------------------
const BALL_DRAG = 0.03;
export const GRAVITY = -38;
export interface Phys {
  gravity: number;
  friction: number; // Coulomb rolling resistance, units/s^2
  bounce: number;
  power: number; // kick power multiplier (custom rules)
}

// ---------------------------------------------------------------------------
// Possession: the touch cycle.
// ---------------------------------------------------------------------------
const CONTROL_RADIUS = 2.8; // a loose ball inside this can be taken
const CONTROL_KEEP_RADIUS = 5.4; // an owner keeps the ball out to here
const CONTROL_MAX_SPEED = 46; // hotter than this cannot be owned, only trapped
const CONTROL_MAX_Z = 2.5;
const TRAP_DAMP = 0.3;
const TOUCH_AHEAD = 3.2; // where a touch puts the ball, in front of the boot
const TOUCH_TRIGGER = 2.0; // how far AHEAD the ball may be before the next touch
const TOUCH_KNOCK = 4.5; // how much faster than the runner the ball leaves
const SETTLE_DAMP = 0.55;
const CONTEST_CHANCE = 0.008; // per tick — 0.05 was 78% PER SECOND

// ---------------------------------------------------------------------------
// Kicks.
// ---------------------------------------------------------------------------
export const KICK_RANGE = 3.4;
const KICK_MAX_Z = 4.5;
const KICK_LOCK = ticks(0.3);
const KICK_MIN_SPEED = 26;
const KICK_MAX_SPEED = 78;
const CHIP_MIN_SPEED = 24;
const CHIP_MAX_SPEED = 52;
export const SHOOT_RANGE = 34; // forward kicks in here are re-aimed at goal
const PASS_POWER = 0.42;
const LOB_POWER = 0.6;
const SHORT_POWER = 0.22;
const SHOT_POWER = 1.0;

// ---------------------------------------------------------------------------
// The slide.
// ---------------------------------------------------------------------------
const SLIDE_TOTAL = ticks(1.0);
const SLIDE_ACTIVE_AFTER = ticks(0.6);
const SLIDE_SPEED = 26;
const SLIDE_REACH = 4.0;
const SLIDE_COST = 220;
const SLIDE_KNOCK = 40;
const FOUL_REACH = 3.2; // a lunge reaching a man inside this, sans ball, fouls
const PENALTY_SPOT = 12;
const CARDS_FOR_RED = 2;

// ---------------------------------------------------------------------------
// The keeper.
// ---------------------------------------------------------------------------
const KEEPER_SPEED = 15;
const KEEPER_LINE = 3.0;
const KEEPER_MAX_X = GOAL_HALF_W + 1.5;
const KEEPER_RANGE_Y = BOX_DEPTH;
export const KEEPER_CLEAR_RADIUS = 3.4;
const KEEPER_CLEAR_SPEED = 62;
const KEEPER_HOLD = ticks(1.3);
const KEEPER_HOLD_HUMAN = ticks(4); // the small-sided four-second law
const KEEPER_THROW_RANGE = 46;
const DIVE_TICKS = ticks(0.55);
const DIVE_SPEED = 24;
const DIVE_REACH = 1.45; // × CLEAR_RADIUS while airborne; goal covers 6.5
const DIVE_TRIGGER = 2.2;
// err must EXCEED (GOAL_HALF_W − reach·CLEAR_RADIUS) or the keeper is
// unbeatable — his crossing prediction is exact.
const KEEPER_LEVELS = [
  { speed: 0.62, reach: 0.75, react: 0.14, err: 4.0 },
  { speed: 0.85, reach: 1.0, react: 0.22, err: 3.4 },
  { speed: 1.05, reach: 1.15, react: 0.3, err: 2.8 },
];

// ---------------------------------------------------------------------------
// AI dials. tackleChance is PER TICK — keep it tiny.
// ---------------------------------------------------------------------------
const BOT_LEVELS = [
  { speed: 0.78, reactErr: 5.0, shootErr: 0.22, tackleChance: 0.006 },
  { speed: 0.9, reactErr: 2.4, shootErr: 0.1, tackleChance: 0.012 },
  { speed: 1.0, reactErr: 0.8, shootErr: 0.04, tackleChance: 0.024 },
];
const AI_PRESS_BUBBLE = PITCH_HALF_WID * 0.21; // second-man rule radius
const ATTACK_SPACING = 13; // support rule: never set up on the carrier's toes
const AI_SEPARATION_R = PITCH_HALF_WID * 0.29;
const AI_PASS_MAX = 52;
const PRESS_HYSTERESIS = 1.15; // challenger must be this much better to take the job
const JOCKEY_RANGE = 7;
// OUTSIDE the steal radius (CONTROL_RADIUS 2.8), on purpose: a jockey who
// parks inside it is rolling the contest dice against the carrier every
// single tick — a 21%-per-second silent theft that meant nobody ever got a
// moment on the ball. Containment CONTAINS; taking the ball costs a
// deliberate poke or a slide, or waits for a heavy touch.
const JOCKEY_OFF = 4.2;
const COVER_DEPTH = 14;
const MARK_GOALSIDE = 3.5;
const SUPPORT_BEHIND = 14;
const ADVANCE_AHEAD = 20;
const RESTART_RETREAT = 16; // five metres, the law
const OPTION_SHORT = 13;
const OPTION_LONG = 30;
const TRANSITION_TICKS = ticks(2.2);

// Switching.
const SWITCH_LOCK = ticks(0.22);
const AUTO_LOCK = ticks(0.6);
const AUTO_SWITCH_RANGE = 28;
const AUTO_SWITCH_MARGIN = 6;

// ---------------------------------------------------------------------------
// The roster's stats (1.0 = baseline). Only the sim reads these.
// ---------------------------------------------------------------------------
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
export const charStat = (id: number) => CHAR_STATS[id] ?? CHAR_STATS[4];

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sameId = (a: Identity, b: Identity) => a.toHexString() === b.toHexString();
const ZERO_ID = new Identity(0n);
export const sideSign = (side: number) => (side === 0 ? -1 : 1); // own goal line
export const attackSign = (side: number) => -sideSign(side); // way we shoot
const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const clockSecs = (m: MatchRow) => Math.ceil(m.clockTicks / TICK_HZ);

function matchPlayers(ctx: Ctx, matchId: bigint): PlayerRow[] {
  return [...ctx.db.player.byMatch.filter(matchId)];
}
/** Bodies actually on the pitch for a side (not watching, not sent off). */
function onPitch(players: PlayerRow[], side: number): PlayerRow[] {
  return players.filter(p => p.side === side && !p.spectator && !p.sentOff);
}
function outfielders(players: PlayerRow[], side: number): PlayerRow[] {
  return onPitch(players, side).filter(p => p.role === ROLE_OUTFIELD);
}

// ---------------------------------------------------------------------------
// THE KICK — the one primitive every strike, pass, throw, clearance and set
// piece goes through. It aims, assists, powers, launches and locks.
// ---------------------------------------------------------------------------
export function kickBall(
  ctx: Ctx,
  match: MatchRow,
  ball: BallRow,
  kicker: PlayerRow,
  kind: number,
  power01: number,
  aimX: number, // direction, relative to the ball
  aimY: number,
  err = 0,
  shootAssist = false
): void {
  const st = charStat(kicker.characterId);
  let ang = Math.atan2(aimY, aimX);
  // Eight-way aim cannot hit a fourteen-foot goal from an angle: a forward
  // kick inside SHOOT_RANGE is re-aimed at the mouth. Without this the game
  // is unplayable, which was learned the hard way.
  const atkY = attackSign(kicker.side) * PITCH_HALF_LEN;
  const goalDist = Math.hypot(ball.x, atkY - ball.y);
  if (shootAssist && goalDist < SHOOT_RANGE) {
    const cornerX = clamp(aimX + ball.x, -(GOAL_HALF_W - 1.2), GOAL_HALF_W - 1.2);
    ang = Math.atan2(atkY - ball.y, cornerX - ball.x);
  }
  ang += (hash01(match.clockTicks * 2.7 + ball.x) - 0.5) * 2 * err * (2 - st.accuracy);

  const p = clamp(power01, 0, 1);
  let speed: number;
  let vz: number;
  if (kind === KICK_CHIP) {
    speed = CHIP_MIN_SPEED + p * (CHIP_MAX_SPEED - CHIP_MIN_SPEED);
    vz = 14 + p * 12;
  } else {
    speed = KICK_MIN_SPEED + p * (KICK_MAX_SPEED - KICK_MIN_SPEED);
    vz = 1.5 + p * 7;
  }
  speed *= st.power;

  ctx.db.ball.matchId.update({
    ...ball,
    active: true,
    z: Math.max(ball.z, 0),
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    vz,
    lastTouchSide: kicker.side,
    lastTouchId: kicker.identity,
    hasOwner: false,
    ownerId: ZERO_ID,
    // the kicker's own control radius must not swallow the shot next tick
    lockTicks: KICK_LOCK,
    // the back-pass law rides on this: a keeper may not handle a ball an
    // outfield team-mate DELIBERATELY kicked (a throw-in comes through here
    // too, which the law also covers)
    fromKick: kicker.role !== ROLE_KEEPER,
  });
}

/** A touch by the protected side ends restart protection. */
function clearGrace(ctx: Ctx, match: MatchRow, side: number): MatchRow {
  if (match.graceTicks > 0 && side === match.restartSide) {
    const next = { ...match, graceTicks: 0 };
    ctx.db.match.id.update(next);
    return next;
  }
  return match;
}
function mayTouch(match: MatchRow, side: number): boolean {
  return match.graceTicks === 0 || side === match.restartSide;
}

// ---------------------------------------------------------------------------
// AIMING HELP: who a pass is for, and where to put it.
// ---------------------------------------------------------------------------
function laneClear(
  x0: number, y0: number, x1: number, y1: number, foes: PlayerRow[], width: number
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  for (const f of foes) {
    const t = clamp(((f.x - x0) * dx + (f.y - y0) * dy) / len2, 0, 1);
    if (Math.hypot(x0 + dx * t - f.x, y0 + dy * t - f.y) < width) return false;
  }
  return true;
}

/**
 * ASSISTED PASSING: the stick picks a direction, this picks the MAN. Aiming a
 * pass at raw eight-way degrees is what made passing feel awful.
 */
export function pickPassTarget(
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
      const cos = (dx * stickX + dy * stickY) / (d * stick);
      if (cos < 0.1) continue; // never pass backwards into the stick
      score += cos * 100;
    } else {
      score += dy * atk * 1.2; // nothing held: the best forward option
    }
    const open = foes.reduce((a, o) => Math.min(a, Math.hypot(o.x - m.x, o.y - m.y)), 99);
    score += Math.min(open, 20) * 1.5 - d * 0.25;
    if (!laneClear(me.x, me.y, m.x, m.y, foes, 2.0)) score -= 40;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/**
 * LEAD THE RECEIVER: aim where he will be when the ball arrives, not where he
 * stands. A pass at a running man's feet is a pass behind him.
 */
function leadTarget(
  from: BallRow, target: PlayerRow, ballSpeed: number
): { x: number; y: number } {
  const d = Math.hypot(target.x - from.x, target.y - from.y);
  const flight = clamp(d / Math.max(ballSpeed, 1), 0, 1.1);
  const run =
    PLAYER_SPEED * charStat(target.characterId).speed * (target.sprinting ? SPRINT_MUL : 1);
  const lx = clamp(target.velX * run * flight, -14, 14);
  let ly = clamp(target.velY * run * flight, -14, 14);
  // NEVER lead a retreating man toward his own goal. A defender dropping into
  // shape gets the ball at his FEET: leading his run overshoots him toward a
  // keeper the back-pass law forbids from catching, and the kick log showed
  // exactly that — a pressured pass back, led past the receiver, sailing
  // over the keeper into its own net two seconds into the match.
  if (ly * sideSign(target.side) > 0) ly = 0;
  return {
    x: clamp(target.x + lx, -(PITCH_HALF_WID - 2), PITCH_HALF_WID - 2),
    y: clamp(target.y + ly, -(PITCH_HALF_LEN - 2), PITCH_HALF_LEN - 2),
  };
}

/** Where a rolling ball can first be met, walking it forward under drag. */
function interceptPoint(
  px: number, py: number, speed: number, ball: BallRow
): { x: number; y: number; t: number } {
  let bx = ball.x, by = ball.y, vx = ball.vx, vy = ball.vy;
  const STEP = 0.1;
  for (let i = 1; i <= 20; i++) {
    const sp = Math.hypot(vx, vy);
    if (sp > 0.01) {
      const k = Math.max(0, sp / (1 + BALL_DRAG * sp * STEP) - 2.4 * STEP) / sp;
      vx *= k; vy *= k;
    }
    bx += vx * STEP; by += vy * STEP;
    const t = i * STEP;
    if (Math.hypot(bx - px, by - py) <= speed * t) return { x: bx, y: by, t };
  }
  return { x: bx, y: by, t: 2 };
}

// ---------------------------------------------------------------------------
// THE REFEREE. Goals, dead balls, fouls, cards, and the whistle that ends the
// tick. Every award here puts the match into PHASE_PAUSE; the resume logic in
// the tick turns the pause back into play.
// ---------------------------------------------------------------------------

/** Hooks the meta layer provides: naming and match-ending live out there. */
export interface MetaHooks {
  /** the 3-2-1 finished (the meta layer closes the betting book here) */
  countdownDone?(ctx: Ctx, match: MatchRow): void;
  teamName(players: PlayerRow[], side: number): string;
  /** A result: golden goal, or full time with a winner. Ends the match. */
  matchWon(ctx: Ctx, match: MatchRow, winnerSide: number, msg: string): void;
  winVerb(name: string): string;
}

function awardGoal(
  ctx: Ctx, match: MatchRow, ball: BallRow, crossedEnd: number, hooks: MetaHooks
): void {
  const scoringSide = 1 - crossedEnd;
  const seats = matchPlayers(ctx, match.id);
  const toucher = ctx.db.player.identity.find(ball.lastTouchId);
  const ownGoal = !!toucher && toucher.side === crossedEnd;
  const scorerName = toucher?.name || hooks.teamName(seats, scoringSide);
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

  const scored = { ...match, p0Goals, p1Goals };
  if (match.half >= 3) {
    // golden goal: the match ends the moment it goes in
    const winner = hooks.teamName(seats, scoringSide);
    hooks.matchWon(
      ctx, scored, scoringSide,
      `GOLDEN GOAL! ${winner} ${hooks.winVerb(winner)} ${p0Goals}–${p1Goals}!`
    );
    return;
  }
  ctx.db.match.id.update({
    ...scored,
    phase: PHASE_PAUSE,
    pauseTicks: GOAL_PAUSE,
    restartKind: RK_KICKOFF,
    kickoffSide: crossedEnd, // the side that conceded restarts
    pointMsg: ownGoal ? `OWN GOAL by ${scorerName}!` : `GOOOAL! ${scorerName} SCORES!`,
  });
}

/** Park the world and queue a restart. */
function awardRestart(
  ctx: Ctx, match: MatchRow, ball: BallRow,
  kind: number, side: number, x: number, y: number, msg: string
): void {
  ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
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

/** The man who will take a pending restart: nearest outfielder of the side. */
function restartTaker(ctx: Ctx, match: MatchRow): PlayerRow | null {
  const mine = outfielders(matchPlayers(ctx, match.id), match.restartSide)
    .filter(p => p.slideTicks === 0);
  if (mine.length === 0) return null;
  return mine.reduce((a, b) =>
    Math.hypot(a.x - match.restartX, a.y - match.restartY) <
    Math.hypot(b.x - match.restartX, b.y - match.restartY) ? a : b
  );
}

/**
 * A FOUL: a slide reached the man without having taken the ball. Free kick
 * where it happened; a penalty inside the offender's own area, and a caution
 * for chopping down the man actually in possession — two cautions is a red,
 * and a sent-off body genuinely leaves the match.
 */
function awardFoul(
  ctx: Ctx, match: MatchRow, ball: BallRow,
  offender: PlayerRow, victim: PlayerRow, hadBall: boolean
): void {
  const defSign = sideSign(offender.side);
  const penalty =
    Math.abs(victim.x) < BOX_HALF_W &&
    Math.abs(victim.y - defSign * PITCH_HALF_LEN) < BOX_DEPTH &&
    victim.y * defSign > 0;

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
      ctrlSeat: sentOff ? CTRL_NONE : offender.ctrlSeat,
      slideTicks: 0, mvX: 0, mvY: 0, velX: 0, velY: 0,
      kickHeld: false, kickTicks: 0, holdTicks: 0,
    });
  }
  awardRestart(
    ctx, match, ball,
    penalty ? RK_PENALTY : RK_FREEKICK,
    victim.side,
    penalty ? 0 : clamp(victim.x, -PITCH_HALF_WID + 2, PITCH_HALF_WID - 2),
    penalty
      ? defSign * (PITCH_HALF_LEN - PENALTY_SPOT)
      : clamp(victim.y, -PITCH_HALF_LEN + 2, PITCH_HALF_LEN - 2),
    (penalty ? 'PENALTY' : 'FREE KICK') + cardMsg
  );
}

/**
 * Is the ball out of play — and what happens next? Judged on where the ball
 * IS, after possession has run, so a dribbler walking it over a line counts
 * exactly like a shot crossing it. Returns true when the tick is over.
 */
function resolveOutOfPlay(
  ctx: Ctx, match: MatchRow, ball: BallRow, hooks: MetaHooks
): boolean {
  if (!ball.active) return false;
  const players = matchPlayers(ctx, match.id);

  if (Math.abs(ball.y) > PITCH_HALF_LEN) {
    const crossedEnd = ball.y < 0 ? 0 : 1;
    // between the posts and under the bar: GOAL
    if (Math.abs(ball.x) < GOAL_HALF_W && ball.z < GOAL_HEIGHT) {
      awardGoal(ctx, match, ball, crossedEnd, hooks);
      return true;
    }
    const attacker = 1 - crossedEnd;
    if (ball.lastTouchSide === crossedEnd) {
      awardRestart(
        ctx, match, ball, RK_CORNER, attacker,
        (ball.x >= 0 ? 1 : -1) * (PITCH_HALF_WID - 1),
        sideSign(crossedEnd) * (PITCH_HALF_LEN - 1),
        `CORNER — ${hooks.teamName(players, attacker)}`
      );
    } else {
      awardRestart(
        ctx, match, ball, RK_GOALKICK, crossedEnd,
        (ball.x >= 0 ? 1 : -1) * 6,
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
      `THROW-IN — ${hooks.teamName(players, side)}`
    );
    return true;
  }
  return false;
}

/** The half's clock ran out. */
function endOfClock(ctx: Ctx, match: MatchRow, hooks: MetaHooks): void {
  const seats = matchPlayers(ctx, match.id);
  const parkBall = () => {
    const ball = ctx.db.ball.matchId.find(match.id);
    if (ball) ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
  };
  if (match.half === 1) {
    ctx.db.match.id.update({
      ...match,
      phase: PHASE_PAUSE, pauseTicks: HALFTIME_PAUSE,
      restartKind: RK_HALFTIME, pointMsg: 'HALF-TIME',
    });
    parkBall();
    return;
  }
  if (match.half === 2) {
    if (match.p0Goals !== match.p1Goals) {
      const winnerSide = match.p0Goals > match.p1Goals ? 0 : 1;
      const winner = hooks.teamName(seats, winnerSide);
      hooks.matchWon(
        ctx, match, winnerSide,
        `FULL TIME — ${winner} ${hooks.winVerb(winner)} ${match.p0Goals}–${match.p1Goals}!`
      );
      return;
    }
    ctx.db.match.id.update({
      ...match,
      phase: PHASE_PAUSE, pauseTicks: HALFTIME_PAUSE,
      restartKind: RK_OVERTIME,
      pointMsg: `${match.p0Goals}–${match.p1Goals} AT FULL TIME — GOLDEN GOAL!`,
    });
    parkBall();
    return;
  }
  // overtime expired scoreless: sudden death, play on at 0:00
  ctx.db.match.id.update({ ...match, pointMsg: 'NEXT GOAL WINS!' });
}

// ---------------------------------------------------------------------------
// THE KEEPER. His HANDS work whoever is driving him; his FEET belong to the
// stick when a human holds his seat and to the line-keeping AI when not.
// Both learned the hard way: running the AI over a human's stick made the two
// fight for one body every tick.
// ---------------------------------------------------------------------------
function keeperPlay(
  ctx: Ctx, match: MatchRow, lobby: LobbyRow | null | undefined,
  keeper: PlayerRow, ball: BallRow
): void {
  const lvl = KEEPER_LEVELS[clamp(lobby?.botLevel ?? 1, 0, KEEPER_LEVELS.length - 1)];
  const gs = sideSign(keeper.side);
  const lineY = gs * (PITCH_HALF_LEN - KEEPER_LINE);
  const st = charStat(keeper.characterId);

  // ---- HOLDING IT: pinned to the gloves, then distributed ----
  if (keeper.holdTicks > 0) {
    const left = keeper.holdTicks - 1;
    ctx.db.player.identity.update({ ...keeper, holdTicks: left, mvX: 0, mvY: 0 });
    if (left > 0) {
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
    // DISTRIBUTE (the AI keeper; a human picks his own moment via action).
    // Find the best-placed team-mate; a throw if he is close, a punt if not.
    const players = matchPlayers(ctx, match.id);
    const mates = outfielders(players, keeper.side);
    const foes = outfielders(players, 1 - keeper.side);
    const target = pickPassTarget(keeper, mates, foes, 0, attackSign(keeper.side), KEEPER_THROW_RANGE);
    const released = { ...ball, x: keeper.x, y: keeper.y, z: 1.4, hasOwner: false, ownerId: ZERO_ID };
    if (target) {
      kickBall(
        ctx, match, released, keeper, KICK_NORMAL, 0.35,
        target.x - keeper.x, target.y - keeper.y
      );
    } else {
      // nobody to pick out: put a punt down a flank
      const flank = (hash01(match.clockTicks) > 0.5 ? 1 : -1) * 18;
      ctx.db.ball.matchId.update({
        ...released,
        active: true,
        vx: flank + (hash01(match.clockTicks * 1.7) - 0.5) * 6,
        vy: -gs * KEEPER_CLEAR_SPEED * st.power,
        vz: 26,
        lastTouchSide: keeper.side,
        lastTouchId: keeper.identity,
        lockTicks: KICK_LOCK,
        fromKick: false,
      });
    }
    clearGrace(ctx, match, keeper.side);
    return;
  }

  // ---- CATCHING IT ----
  const dist = Math.hypot(ball.x - keeper.x, ball.y - keeper.y);
  const inOwnBox =
    Math.abs(ball.x) < BOX_HALF_W && Math.abs(ball.y - gs * PITCH_HALF_LEN) < BOX_DEPTH;
  // He may not re-handle his own release until someone else plays it (the
  // only version of that rule that terminates), may not scoop up his own
  // side's placed restart, and may not handle a team-mate's deliberate kick —
  // the back-pass law. He can still play any of them with his feet.
  const justReleased = sameId(ball.lastTouchId, keeper.identity);
  const ourRestart = match.graceTicks > 0 && match.restartSide === keeper.side;
  const backPass =
    ball.fromKick && ball.lastTouchSide === keeper.side &&
    !sameId(ball.lastTouchId, keeper.identity);
  const airborne = keeper.diveTicks > 0;
  const reachNow = KEEPER_CLEAR_RADIUS * lvl.reach * (airborne ? DIVE_REACH : 1);
  if (
    ball.active && !justReleased && !ourRestart && !backPass &&
    dist < reachNow && ball.z < (airborne ? GOAL_HEIGHT : 7) &&
    mayTouch(match, keeper.side)
  ) {
    if (inOwnBox) {
      // CATCH: into the gloves for the hold
      const hold = keeper.ctrlSeat !== CTRL_NONE ? KEEPER_HOLD_HUMAN : KEEPER_HOLD;
      ctx.db.player.identity.update({
        ...keeper, holdTicks: hold, mvX: 0, mvY: 0, diveTicks: 0,
      });
      ctx.db.ball.matchId.update({
        ...ball,
        active: true,
        x: keeper.x, y: keeper.y - gs * 1.2, z: 2.6,
        vx: 0, vy: 0, vz: 0,
        hasOwner: true,
        ownerId: keeper.identity,
        lastTouchSide: keeper.side,
        lastTouchId: keeper.identity,
        lockTicks: 0,
        fromKick: false,
      });
      clearGrace(ctx, match, keeper.side);
      return;
    }
    // outside his area he is just another pair of feet: hoof it clear
    const flank = (ball.x >= 0 ? 1 : -1) * 22;
    ctx.db.ball.matchId.update({
      ...ball,
      active: true,
      vx: flank + (hash01(match.clockTicks * 1.3) - 0.5) * 6,
      vy: -gs * KEEPER_CLEAR_SPEED * st.power,
      vz: 26,
      z: Math.max(ball.z, 0.5),
      lastTouchSide: keeper.side,
      lastTouchId: keeper.identity,
      hasOwner: false,
      ownerId: ZERO_ID,
      lockTicks: KICK_LOCK,
      fromKick: false,
    });
    clearGrace(ctx, match, keeper.side);
    return;
  }

  // ---- HIS FEET ---- a human's stick owns them (moved by the integrator).
  if (keeper.ctrlSeat !== CTRL_NONE) return;

  // Hold the ball-to-goal line; commit late to where a shot will cross, off
  // by `err` — his prediction is exact, so err is the ONLY thing beating him.
  let targetX = clamp(ball.x * 0.55, -KEEPER_MAX_X, KEEPER_MAX_X);
  const tToLine =
    ball.active && Math.abs(ball.vy) > 0.01 ? (lineY - ball.y) / ball.vy : -1;
  const incoming = ball.active && ball.vy * gs > 8 && tToLine > 0 && tToLine < lvl.react;
  if (incoming) {
    // one error roll per shot, seeded off the struck velocity, so he commits
    // to a single (slightly wrong) spot instead of re-aiming every tick
    const err = (hash01(Math.round(ball.vx) * 3.7 + Math.round(ball.vy) * 1.9) - 0.5) * 2 * lvl.err;
    targetX = clamp(ball.x + ball.vx * tToLine + err, -KEEPER_MAX_X, KEEPER_MAX_X);
  }
  let targetY = lineY;
  if (
    !ball.hasOwner && Math.abs(ball.x) < BOX_HALF_W &&
    Math.abs(ball.y - gs * PITCH_HALF_LEN) < KEEPER_RANGE_Y
  ) {
    // a loose ball in his box: step out to it
    targetY = gs * (PITCH_HALF_LEN - Math.min(
      KEEPER_RANGE_Y - 1,
      Math.abs(gs * PITCH_HALF_LEN - ball.y) * 0.5 + KEEPER_LINE
    ));
  }

  // THE DIVE: a shot heading somewhere he cannot walk to is the moment he
  // leaves his feet. Spent whether or not he gets there.
  let diveTicks = keeper.diveTicks;
  let diveDirX = keeper.diveDirX;
  let diveDirY = keeper.diveDirY;
  if (diveTicks === 0 && incoming) {
    const rx = targetX - keeper.x;
    const ry = targetY - keeper.y;
    const gap = Math.hypot(rx, ry);
    if (gap > DIVE_TRIGGER) {
      diveTicks = DIVE_TICKS;
      diveDirX = rx / gap;
      diveDirY = ry / gap;
    }
  }
  const diving = diveTicks > 0;
  if (diving) diveTicks -= 1;

  const speed = diving
    ? DIVE_SPEED * lvl.speed
    : KEEPER_SPEED * lvl.speed * (incoming ? 1.7 : 1);
  const dx = diving ? diveDirX : targetX - keeper.x;
  const dy = diving ? diveDirY : targetY - keeper.y;
  const len = Math.hypot(dx, dy);
  const step = diving ? speed * DT : Math.min(len, speed * DT);
  const nx = len > 0.01 ? keeper.x + (dx / len) * step : keeper.x;
  const ny = len > 0.01 ? keeper.y + (dy / len) * step : keeper.y;
  // Publish a velocity: keeperPlay moves him OUTSIDE the integrator, and the
  // client dead-reckons every body along velX/velY — a keeper without one
  // steps at 30 Hz while everyone else glides.
  const vScale = PLAYER_SPEED * st.speed;
  const moved = len > 0.01 ? step / DT : 0;
  ctx.db.player.identity.update({
    ...keeper,
    x: clamp(nx, -KEEPER_MAX_X, KEEPER_MAX_X),
    y: gs > 0
      ? clamp(ny, PITCH_HALF_LEN - KEEPER_RANGE_Y, PITCH_HALF_LEN - 0.5)
      : clamp(ny, -(PITCH_HALF_LEN - 0.5), -(PITCH_HALF_LEN - KEEPER_RANGE_Y)),
    velX: len > 0.01 ? ((dx / len) * moved) / vScale : 0,
    velY: len > 0.01 ? ((dy / len) * moved) / vScale : 0,
    diveTicks, diveDirX, diveDirY,
    dirX: Math.abs(dx) > 0.7 ? Math.sign(dx) : 0,
    dirY: Math.abs(dy) > 0.7 ? Math.sign(dy) : 0,
  });
}

// ---------------------------------------------------------------------------
// CONTROL. The seat token: player.ctrlSeat holds the teamSlot of the human
// driving that BODY (CTRL_NONE = AI). The token lives on the body, never the
// person, so two humans on one footballer is unrepresentable. bindPilot is
// the ONLY writer.
// ---------------------------------------------------------------------------
export function controlledBody(ctx: Ctx, me: PlayerRow): PlayerRow {
  if (me.matchId === 0n) return me;
  // EVERY body, keeper included — filtering this made the token invisible
  // once control reached the keeper.
  for (const b of ctx.db.player.byMatch.filter(me.matchId)) {
    if (b.side === me.side && b.ctrlSeat === me.teamSlot) return b;
  }
  const mine = ctx.db.player.identity.find(me.identity);
  // Sent off: the seat must find a different body or the stick drives a man
  // on the touchline for the rest of the match.
  if (mine && mine.sentOff) {
    let alt: PlayerRow | null = null;
    for (const b of ctx.db.player.byMatch.filter(me.matchId)) {
      if (b.side !== me.side || b.spectator || b.sentOff) continue;
      if (b.ctrlSeat !== CTRL_NONE || b.role !== ROLE_OUTFIELD) continue;
      if (!alt || b.teamSlot < alt.teamSlot) alt = b;
    }
    if (alt) return ctx.db.player.identity.update({ ...alt, ctrlSeat: me.teamSlot });
    return mine;
  }
  if (!mine || mine.role !== ROLE_OUTFIELD || mine.sentOff) return me;
  // Stamp rather than merely return: an unstamped body would be handed to
  // both the AI and the stick, every tick, forever.
  return ctx.db.player.identity.update({ ...mine, ctrlSeat: mine.teamSlot });
}

export function bindPilot(
  ctx: Ctx, me: PlayerRow, from: PlayerRow, to: PlayerRow, lock: number
): void {
  if (sameId(from.identity, to.identity)) return;
  // Re-read both bodies: callers hand rows from earlier snapshots, and
  // spreading a stale row rubber-bands the body a tick backwards.
  const oldBody = ctx.db.player.identity.find(from.identity);
  const target = ctx.db.player.identity.find(to.identity);
  if (!target || target.sentOff) return;
  if (oldBody && oldBody.ctrlSeat === me.teamSlot) {
    ctx.db.player.identity.update({
      ...oldBody, ctrlSeat: CTRL_NONE, sprinting: false, kickHeld: false, kickTicks: 0,
    });
  }
  ctx.db.player.identity.update({
    ...target,
    ctrlSeat: me.teamSlot,
    switchLock: lock,
    // hand the new man the stick's CURRENT state, not his old AI heading
    dirX: oldBody?.dirX ?? target.dirX,
    dirY: oldBody?.dirY ?? target.dirY,
    mvX: oldBody?.dirX ?? target.mvX,
    mvY: oldBody?.dirY ?? target.mvY,
    sprinting: oldBody?.sprinting ?? false,
    // taking over a keeper mid-catch buys the human window to pick a pass
    holdTicks:
      target.role === ROLE_KEEPER && target.holdTicks > 0
        ? KEEPER_HOLD_HUMAN
        : target.holdTicks,
  });
}

function switchCandidates(ctx: Ctx, me: PlayerRow, cur: PlayerRow): PlayerRow[] {
  return matchPlayers(ctx, me.matchId).filter(
    b =>
      b.side === me.side && !b.spectator && !b.sentOff &&
      b.slideTicks === 0 && b.ctrlSeat === CTRL_NONE &&
      !sameId(b.identity, cur.identity)
  );
}

/** The SWITCH button: cycle through team-mates by distance to the ball. */
export function switchPilot(ctx: Ctx, me: PlayerRow): void {
  const cur = controlledBody(ctx, me);
  if (cur.switchLock > 0) return;
  const ball = ctx.db.ball.matchId.find(me.matchId);
  const candidates = switchCandidates(ctx, me, cur)
    .map(b => ({
      b,
      d: ball ? Math.hypot(b.x - ball.x, b.y - ball.y) : 0,
    }))
    .sort((a, c) => a.d - c.d);
  if (candidates.length === 0) return;
  // Repeated presses walk the ranking; a stateless "nearest" would bounce
  // between two men as the ball moves.
  const idx = cur.switchIdx % candidates.length;
  const next = candidates[idx].b;
  const fresh = ctx.db.player.identity.find(me.identity);
  if (!fresh) return;
  bindPilot(ctx, fresh, cur, next, SWITCH_LOCK);
  const stamped = ctx.db.player.identity.find(next.identity);
  if (stamped) {
    ctx.db.player.identity.update({ ...stamped, switchIdx: (idx + 1) % 250 });
  }
}

/**
 * AUTO-SWITCH: control follows the ball to the right footballer. Runs late in
 * the tick. One pilot per target; the human whose man is furthest from the
 * ball has the least to lose by being moved.
 */
function autoSwitch(ctx: Ctx, match: MatchRow, ball: BallRow | null | undefined): void {
  if (!ball) return;
  if (match.graceTicks > 0) return; // a restart chose its taker; leave it
  const players = matchPlayers(ctx, match.id);
  const humans = players.filter(p => !p.isBot && !p.spectator && p.matchId === match.id);

  // A keeper who has just caught it always takes the gloves' human: holding
  // the ball IS having possession, and the player must be the one to release.
  for (const person of humans) {
    const holder = players.find(
      q => q.side === person.side && q.role === ROLE_KEEPER && q.holdTicks > 0
    );
    const cur = controlledBody(ctx, person);
    if (holder && !sameId(cur.identity, holder.identity) && holder.ctrlSeat === CTRL_NONE) {
      const fresh = ctx.db.player.identity.find(person.identity);
      if (fresh) bindPilot(ctx, fresh, cur, holder, AUTO_LOCK);
      continue;
    }
  }

  // CONTROL FOLLOWS YOUR OWN PASS. The moment your kick is in flight, your
  // stick moves to the man best placed to receive it — the single switch a
  // player expects most, and the one the distance rule below can never make
  // (the receiver is usually well inside its range).
  for (const person of humans) {
    const fresh = ctx.db.player.identity.find(person.identity);
    if (!fresh) continue;
    const cur = controlledBody(ctx, fresh);
    if (cur.switchLock > 0) continue;
    if (ball.hasOwner || !sameId(ball.lastTouchId, cur.identity)) continue;
    if (Math.hypot(ball.vx, ball.vy) < 10) continue; // a tap, not a pass
    let best: PlayerRow | null = null;
    let bestT = Infinity;
    for (const b of switchCandidates(ctx, fresh, cur)) {
      if (b.role !== ROLE_OUTFIELD) continue;
      const t = interceptPoint(
        b.x, b.y, PLAYER_SPEED * charStat(b.characterId).speed * SPRINT_MUL, ball
      ).t;
      if (t < bestT) { bestT = t; best = b; }
    }
    if (best && bestT < 1.6) bindPilot(ctx, fresh, cur, best, AUTO_LOCK);
  }

  const proposals: { person: PlayerRow; from: PlayerRow; to: PlayerRow; fromDist: number }[] = [];
  for (const person of humans) {
    const fresh = ctx.db.player.identity.find(person.identity);
    if (!fresh) continue;
    const cur = controlledBody(ctx, fresh);
    if (cur.switchLock > 0) continue;
    if (cur.role === ROLE_KEEPER && cur.holdTicks > 0) continue; // he IS the play
    const ballIsOurs = ball.hasOwner && (() => {
      const o = players.find(p => sameId(p.identity, ball.ownerId));
      return o?.side === fresh.side;
    })();
    if (ballIsOurs) continue; // in possession, switching is the player's call
    // lead the ball slightly, so the switch anticipates rather than trails
    const leadX = ball.x + ball.vx * 0.2;
    const leadY = ball.y + ball.vy * 0.2;
    const curDist = Math.hypot(cur.x - leadX, cur.y - leadY);
    if (curDist < AUTO_SWITCH_RANGE + AUTO_SWITCH_MARGIN) continue;
    const best = switchCandidates(ctx, fresh, cur)
      .map(b => ({ b, d: Math.hypot(b.x - leadX, b.y - leadY) }))
      .sort((a, c) => a.d - c.d)[0];
    if (best && best.d < AUTO_SWITCH_RANGE && best.d < curDist - AUTO_SWITCH_MARGIN) {
      proposals.push({ person: fresh, from: cur, to: best.b, fromDist: curDist });
    }
  }
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
// THE TEAM BRAIN. One plan per side per tick. Every off-ball job — press,
// cover, mark, run, support, offer, retreat, hunt, break — is assigned HERE,
// in one place, from the team's phase. The bots then simply go where their
// job says. This is the structural difference from the old brain, whose
// players each guessed at the team's intent from inside their own if-chains
// and produced the mindless ball-chasing everyone could see.
// ---------------------------------------------------------------------------
interface Job {
  x: number;
  y: number;
  sprint: boolean;
  /** exempt from the second-man rule (restart takers, counter-pressers) */
  atBall?: boolean;
}
type Plan = Map<string, Job>; // by identity hex

// The 4v4 shape: a forward and two wide men. Wide men are the width in
// attack and the cover in defence — with three bodies there is no spare man.
const FORMATION = [
  { name: 'ST', ax: 0.0, ay: 0.44 },
  { name: 'LW', ax: -0.5, ay: -0.16 },
  { name: 'RW', ax: 0.5, ay: -0.16 },
];
export const posOf = (teamSlot: number) => clamp(teamSlot, 0, OUTFIELD_PER_SIDE - 1);
export const positionName = (slot: number) => FORMATION[posOf(slot)].name;
export const BOT_LEVEL_COUNT = BOT_LEVELS.length;
export const HALF_TICKS = ticks(HALF_SECONDS);
/** A man's flank is HIS — derived from teamSlot so it can never flip. */
const flankOf = (p: PlayerRow) => (p.teamSlot % 2 === 0 ? -1 : 1);

/** Where the block wants a man standing when nothing sharper claims him. */
function anchorFor(side: number, slot: number, ballX: number, ballY: number, poss: boolean) {
  const up = attackSign(side);
  const f = FORMATION[posOf(slot)];
  const lineY = clamp(ballY * 0.45 + up * (poss ? 10 : -8), -PITCH_HALF_LEN * 0.55, PITCH_HALF_LEN * 0.55);
  let y = lineY + up * f.ay * PITCH_HALF_LEN;
  // the wide pair are the cover: neither may let the ball get goal-side
  if (posOf(slot) !== 0) {
    const gsY = ballY * up - 6;
    y = Math.min(y * up, gsY) * up;
  }
  return {
    x: clamp(ballX * 0.25 + f.ax * PITCH_HALF_WID, -(PITCH_HALF_WID - 3), PITCH_HALF_WID - 3),
    y: clamp(y, -(PITCH_HALF_LEN - 5), PITCH_HALF_LEN - 6),
  };
}

/** Elect the presser with hysteresis so the job does not flap between men. */
function electPresser(
  match: MatchRow, side: number, men: PlayerRow[], ball: BallRow
): { slot: number; match: MatchRow } {
  const cost = (p: PlayerRow) =>
    Math.hypot(ball.x + ball.vx * 0.2 - p.x, ball.y + ball.vy * 0.2 - p.y) /
    (PLAYER_SPEED * charStat(p.characterId).speed);
  let best: PlayerRow | null = null;
  for (const m of men) {
    if (m.slideTicks > 0) continue;
    if (!best || cost(m) < cost(best)) best = m;
  }
  if (!best) return { slot: 255, match };
  const curSlot = side === 0 ? match.presser0 : match.presser1;
  const incumbent = men.find(m => m.teamSlot === curSlot && m.slideTicks === 0);
  const winner =
    incumbent && cost(incumbent) < cost(best) * PRESS_HYSTERESIS ? incumbent : best;
  if (winner.teamSlot !== curSlot) {
    match =
      side === 0
        ? { ...match, presser0: winner.teamSlot }
        : { ...match, presser1: winner.teamSlot };
  }
  return { slot: winner.teamSlot, match };
}

function teamPlan(
  match: MatchRow, side: number, men: PlayerRow[], all: PlayerRow[],
  ball: BallRow, presserSlot: number, heldBySide: number
): Plan {
  const plan: Plan = new Map();
  const up = attackSign(side);
  const myGoalY = sideSign(side) * PITCH_HALF_LEN;
  const put = (p: PlayerRow, x: number, y: number, sprint = false, atBall = false) =>
    plan.set(p.identity.toHexString(), {
      x: clamp(x, -(PITCH_HALF_WID - 3), PITCH_HALF_WID - 3),
      y: clamp(y, -(PITCH_HALF_LEN - 4), PITCH_HALF_LEN - 4),
      sprint, atBall,
    });

  const carrier = ball.hasOwner
    ? all.find(p => sameId(p.identity, ball.ownerId))
    : undefined;
  const weOwn = carrier?.side === side;
  const restart = match.graceTicks > 0;
  const trans = match.transTicks > 0;

  // ---- SET PIECE ----------------------------------------------------------
  if (restart) {
    if (match.restartSide === side) {
      // one takes it, the others OFFER: one short and certain, one up the line
      const taker = men.reduce((a, b) =>
        Math.hypot(a.x - match.restartX, a.y - match.restartY) <
        Math.hypot(b.x - match.restartX, b.y - match.restartY) ? a : b
      );
      for (const m of men) {
        if (sameId(m.identity, taker.identity)) {
          put(m, match.restartX, match.restartY, false, true);
        } else {
          const short = m.teamSlot % 2 === 0;
          const reach = short ? OPTION_SHORT : OPTION_LONG;
          put(
            m,
            match.restartX + flankOf(m) * reach * 0.55,
            match.restartY + up * reach,
            true
          );
        }
      }
    } else {
      // theirs: stand off it (the five-metre law), goal-side
      for (const m of men) {
        const away = Math.hypot(m.x - match.restartX, m.y - match.restartY) || 1;
        const ox = match.restartX + ((m.x - match.restartX) / away) * RESTART_RETREAT;
        const oy = match.restartY + ((m.y - match.restartY) / away) * RESTART_RETREAT;
        put(m, ox, oy * 0.65 + myGoalY * 0.35, true);
      }
    }
    return plan;
  }

  // ---- KEEPER HOLDING -----------------------------------------------------
  if (heldBySide === side) {
    // ours: break wide, get OUTSIDE the area, be throwable-to
    for (const m of men) {
      put(m, flankOf(m) * (PITCH_HALF_WID - 8), myGoalY - sideSign(side) * (BOX_DEPTH + 8), true);
    }
    return plan;
  }
  if (heldBySide >= 0) {
    // theirs: nothing to win standing over him — drop into shape
    for (const m of men) {
      const a = anchorFor(side, m.teamSlot, ball.x, ball.y, false);
      put(m, a.x, (a.y + myGoalY) / 2);
    }
    return plan;
  }

  // ---- IN POSSESSION ------------------------------------------------------
  if (weOwn && carrier) {
    const others = men.filter(m => !sameId(m.identity, carrier.identity));
    // decided by who is already further forward, so nobody turns to swap
    others.sort((a, b) => (b.y - a.y) * up);
    const breaking = trans && match.possSide === side;
    others.forEach((m, i) => {
      if (i === 0) {
        // the RUN: beyond the carrier, wide of him for a lane; at the box,
        // attack the far post; on a fresh turnover, just GO
        const nearBox = Math.abs(carrier.y - up * PITCH_HALF_LEN) < BOX_DEPTH + 10;
        if (nearBox) {
          put(m, -Math.sign(carrier.x || 1) * GOAL_HALF_W, up * (PITCH_HALF_LEN - 8), true);
        } else {
          put(m, carrier.x + flankOf(m) * 16, carrier.y + up * (breaking ? 28 : ADVANCE_AHEAD), true);
        }
      } else {
        // the SUPPORT: a short angle BEHIND the ball — a man level with the
        // carrier is not an option, he is a second carrier
        put(m, carrier.x + flankOf(m) * 13, carrier.y - up * SUPPORT_BEHIND, breaking);
      }
    });
    put(carrier, carrier.x, carrier.y); // the brain never steers the carrier
    return plan;
  }

  // ---- OUT OF POSSESSION --------------------------------------------------
  const counterPress = trans && !!carrier && carrier.side !== side;
  const byBall = [...men].sort(
    (a, b) =>
      Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y)
  );
  for (const m of men) {
    const isPresser = m.teamSlot === presserSlot;
    const rank = byBall.findIndex(q => sameId(q.identity, m.identity));
    if (isPresser) {
      // the one man allowed at the ball — and once ARRIVED he jockeys
      // goal-side rather than sprinting through the dribbler
      const d = Math.hypot(ball.x - m.x, ball.y - m.y);
      if (carrier && d < JOCKEY_RANGE) {
        const dgx = 0 - ball.x;
        const dgy = myGoalY - ball.y;
        const dg = Math.hypot(dgx, dgy) || 1;
        put(m, ball.x + (dgx / dg) * JOCKEY_OFF, ball.y + (dgy / dg) * JOCKEY_OFF, false, true);
      } else {
        put(m, ball.x + ball.vx * 0.25, ball.y + ball.vy * 0.25, true, true);
      }
    } else if (counterPress && rank <= 1) {
      // WE JUST LOST IT: one extra man hunts with the presser — the one
      // deliberate suspension of the second-man rule
      put(m, ball.x, ball.y, true, true);
    } else if (rank <= 1) {
      // COVER: the line between ball and our goal — but BLENDED toward his
      // formation anchor. A cover point computed purely off the ball follows
      // every touch of it, and a whole defence tracking the ball is what
      // reads from the stands as "no formation, everyone chasing". Keeping
      // a third of the anchor keeps his zone identity while he covers.
      const dgx = 0 - ball.x;
      const dgy = myGoalY - ball.y;
      const dg = Math.hypot(dgx, dgy) || 1;
      const back = Math.min(COVER_DEPTH, dg * 0.5);
      const a = anchorFor(side, m.teamSlot, ball.x, ball.y, false);
      put(
        m,
        (ball.x + (dgx / dg) * back) * 0.65 + a.x * 0.35,
        (ball.y + (dgy / dg) * back) * 0.65 + a.y * 0.35,
        true
      );
    } else {
      // MARK the most advanced opponent, goal-side of him — same blend, so
      // the marker shades his man without abandoning his zone entirely
      let danger: PlayerRow | null = null;
      for (const f of outfielders(all, 1 - side)) {
        if (!danger || (f.y - danger.y) * -up > 0) danger = f;
      }
      const a = anchorFor(side, m.teamSlot, ball.x, ball.y, false);
      if (danger) {
        put(
          m,
          danger.x * 0.85 * 0.7 + a.x * 0.3,
          (danger.y + Math.sign(myGoalY - danger.y || 1) * MARK_GOALSIDE) * 0.7 + a.y * 0.3
        );
      } else {
        put(m, a.x, a.y);
      }
    }
  }
  return plan;
}

/** Point a bot at its job with an ANALOG heading (mv floats, dir = facing). */
function steerBot(ctx: Ctx, bot: PlayerRow, job: Job): void {
  const fresh = ctx.db.player.identity.find(bot.identity);
  if (!fresh) return;
  const dx = job.x - fresh.x;
  const dy = job.y - fresh.y;
  const d = Math.hypot(dx, dy);
  const ARRIVE = 1.2;
  const mvX = d > ARRIVE ? dx / d : 0;
  const mvY = d > ARRIVE ? dy / d : 0;
  ctx.db.player.identity.update({
    ...fresh,
    mvX, mvY,
    dirX: Math.abs(mvX) > 0.35 ? Math.sign(mvX) : 0,
    dirY: Math.abs(mvY) > 0.35 ? Math.sign(mvY) : 0,
    sprinting: job.sprint && d > 6 && fresh.stamina > 250,
  });
}

/** Structural rules applied over ANY plan: spacing, second man, support. */
function applyShapeRules(
  job: Job, bot: PlayerRow, ball: BallRow, carrier: PlayerRow | undefined,
  mates: PlayerRow[]
): Job {
  let { x, y } = job;
  // separation: two men never occupy one spot
  let nm: PlayerRow | null = null;
  let nd = AI_SEPARATION_R;
  for (const m of mates) {
    const d = Math.hypot(m.x - bot.x, m.y - bot.y);
    if (d < nd) { nd = d; nm = m; }
  }
  if (nm && nd > 0.01) {
    const push = (AI_SEPARATION_R - nd) * 0.8;
    x += ((bot.x - nm.x) / nd) * push;
    y += ((bot.y - nm.y) / nd) * push;
  }
  if (!job.atBall) {
    // the second-man rule: stay out of the ball's bubble
    const bd = Math.hypot(x - ball.x, y - ball.y);
    if (bd < AI_PRESS_BUBBLE && bd > 0.01) {
      x = ball.x + ((x - ball.x) / bd) * AI_PRESS_BUBBLE;
      y = ball.y + ((y - ball.y) / bd) * AI_PRESS_BUBBLE;
    }
    // the support rule: never set up on your own carrier's toes
    if (carrier && !sameId(carrier.identity, bot.identity) && carrier.side === bot.side) {
      const cd = Math.hypot(x - carrier.x, y - carrier.y);
      if (cd < ATTACK_SPACING && cd > 0.01) {
        x = carrier.x + ((x - carrier.x) / cd) * ATTACK_SPACING;
        y = carrier.y + ((y - carrier.y) / cd) * ATTACK_SPACING;
      }
    }
  }
  return { ...job, x, y };
}

// ---------------------------------------------------------------------------
// THE MAN ON THE BALL (bot): one scored decision — shoot > pass > carry.
// ---------------------------------------------------------------------------
function botOnBall(
  ctx: Ctx, match: MatchRow, lobby: LobbyRow | null | undefined,
  bot: PlayerRow, ball: BallRow, mates: PlayerRow[], foes: PlayerRow[]
): void {
  const lvl = BOT_LEVELS[clamp(lobby?.botLevel ?? 1, 0, BOT_LEVELS.length - 1)];
  const up = attackSign(bot.side);
  const goalY = up * PITCH_HALF_LEN;
  const goalDist = Math.hypot(ball.x, goalY - ball.y);
  const nearestFoe = foes.reduce(
    (d, o) => Math.min(d, Math.hypot(o.x - bot.x, o.y - bot.y)), 99
  );

  // SHOOT. Try BOTH corners; up close, shoot even through traffic — a low
  // percentage shot forces a save, a rebound, a corner. A bot that only ever
  // shoots down a perfectly clear lane against a packed defence produces the
  // sterile 0-0 midfield the kick log showed: continuous passing, one shot
  // in six minutes.
  if (goalDist < SHOOT_RANGE && 1 - goalDist / SHOOT_RANGE > 0.25) {
    const first = hash01(match.clockTicks * 0.9 + bot.teamSlot) < 0.5 ? -1 : 1;
    let corner = 0;
    for (const c of [first, -first]) {
      const cx = c * (GOAL_HALF_W - 1.6);
      if (laneClear(ball.x, ball.y, cx, goalY, foes, 1.2)) { corner = cx; break; }
    }
    if (corner === 0 && goalDist < 20) corner = first * (GOAL_HALF_W - 1.6);
    if (corner !== 0) {
      kickBall(
        ctx, match, ball, bot, KICK_NORMAL, clamp(0.55 + (1 - goalDist / SHOOT_RANGE), 0.5, 1),
        corner - ball.x, goalY - ball.y, lvl.shootErr
      );
      return;
    }
  }

  // PASS: score progression, openness and the lane; lead the receiver.
  let best: PlayerRow | null = null;
  let bestScore = 2; // even under pressure, a pass must be WORTH something
  for (const m of mates) {
    const d = Math.hypot(m.x - bot.x, m.y - bot.y);
    if (d < 8 || d > AI_PASS_MAX) continue;
    if (!laneClear(ball.x, ball.y, m.x, m.y, foes, 2.2)) continue;
    const open = foes.reduce((a, o) => Math.min(a, Math.hypot(o.x - m.x, o.y - m.y)), 99);
    let score = (m.y - bot.y) * up * 0.6 + open * 1.2 - d * 0.15;
    // A ball into your own defensive quarter is the last resort, not an
    // outlet: the kick log showed pressured midfielders drilling 70-speed
    // passes at defenders standing seven units off their own line, where a
    // miss cannot even be caught (the back-pass law) and rolls in.
    if (Math.abs(m.y - sideSign(bot.side) * PITCH_HALF_LEN) < 20) score -= 25;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (best && (nearestFoe < 7 || bestScore > 14)) {
    const d = Math.hypot(best.x - bot.x, best.y - bot.y);
    const aim = leadTarget(ball, best, 55);
    // a pass played TOWARD your own goal is played SOFTLY — weight of pass
    // is half of what makes a back-pass safe (the other half is the aim)
    const backward = (best.y - bot.y) * up < 0;
    kickBall(
      ctx, match, ball, bot, KICK_NORMAL,
      clamp(d / AI_PASS_MAX + 0.25, 0.25, backward ? 0.45 : 0.85),
      aim.x - ball.x, aim.y - ball.y, lvl.shootErr * 0.7
    );
    return;
  }

  // CARRY: at goal, bending away from the nearest defender into space.
  let cx = clamp(ball.x * 0.6, -PITCH_HALF_WID + 6, PITCH_HALF_WID - 6);
  const closest = foes.reduce(
    (a: PlayerRow | null, o) =>
      !a || Math.hypot(o.x - bot.x, o.y - bot.y) < Math.hypot(a.x - bot.x, a.y - bot.y) ? o : a,
    null
  );
  if (closest && Math.hypot(closest.x - bot.x, closest.y - bot.y) < 12) {
    cx = clamp(cx - Math.sign(closest.x - bot.x) * 10, -PITCH_HALF_WID + 6, PITCH_HALF_WID - 6);
  }
  steerBot(ctx, bot, { x: cx, y: goalY, sprint: true, atBall: true });
}

/**
 * One bot, one tick. Takes the team plan; handles the jobs a position alone
 * cannot express: playing the ball, taking a restart, meeting a pass, and
 * the slide — which is only ever rolled AT THE TOUCH, while the carrier's
 * gap to the ball is open, because that is when a lunge takes ball first.
 */
function botPlay(
  ctx: Ctx, match: MatchRow, lobby: LobbyRow | null | undefined,
  bot: PlayerRow, ball: BallRow, plan: Plan,
  mates: PlayerRow[], foes: PlayerRow[], heldBySide: number
): void {
  const lvl = BOT_LEVELS[clamp(lobby?.botLevel ?? 1, 0, BOT_LEVELS.length - 1)];

  // ON THE BALL
  if (ball.hasOwner && sameId(ball.ownerId, bot.identity)) {
    botOnBall(ctx, match, lobby, bot, ball, mates, foes);
    return;
  }

  // TAKE THE RESTART: a dead ball is owned by nobody, so the taker must be
  // told to play it — or an AI side stands over its own throw-in until the
  // window dies.
  if (
    match.graceTicks > 0 && match.restartSide === bot.side &&
    Math.hypot(ball.x - bot.x, ball.y - bot.y) < KICK_RANGE &&
    match.phase === PHASE_LIVE
  ) {
    const job = plan.get(bot.identity.toHexString());
    if (job?.atBall) {
      const up = attackSign(bot.side);
      const kind = match.restartKind;
      const pick = pickPassTarget(bot, mates, foes, 0, up, kind === RK_CORNER ? PITCH_HALF_LEN : PITCH_HALF_LEN * 0.7);
      const aim = pick ? leadTarget(ball, pick, 50) : null;
      kickBall(
        ctx, match, ball, bot,
        kind === RK_CORNER ? KICK_CHIP : KICK_NORMAL,
        kind === RK_CORNER ? LOB_POWER : PASS_POWER,
        aim ? aim.x - ball.x : kind === RK_CORNER ? -ball.x : 0,
        aim ? aim.y - ball.y : kind === RK_CORNER ? up * PITCH_HALF_LEN - ball.y : up * 18,
        lvl.shootErr * 0.6
      );
      clearGrace(ctx, match, bot.side);
      return;
    }
  }

  // RECEIVE: one man — the one who can get there soonest — meets a pass.
  const ballSpeed = Math.hypot(ball.vx, ball.vy);
  if (
    !ball.hasOwner && ballSpeed > 6 && heldBySide < 0 && match.graceTicks === 0 &&
    ball.lastTouchSide === bot.side && ball.z < CONTROL_MAX_Z + 3
  ) {
    const sprintOf = (p: PlayerRow) =>
      PLAYER_SPEED * charStat(p.characterId).speed * SPRINT_MUL;
    const mine = interceptPoint(bot.x, bot.y, sprintOf(bot), ball);
    let bestT = mine.t;
    for (const m of mates) {
      if (m.role !== ROLE_OUTFIELD) continue;
      const t = interceptPoint(m.x, m.y, sprintOf(m), ball).t;
      if (t < bestT) bestT = t;
    }
    if (mine.t <= bestT) {
      steerBot(ctx, bot, { x: mine.x, y: mine.y, sprint: true, atBall: true });
      return;
    }
  }

  // THE SLIDE — at the touch, never at the man.
  const dist = Math.hypot(ball.x - bot.x, ball.y - bot.y);
  const carrier = ball.hasOwner ? foes.find(f => sameId(f.identity, ball.ownerId)) : undefined;
  const oppOwns = !!carrier;
  const winnable =
    !ball.hasOwner ||
    (carrier !== undefined &&
      Math.hypot(ball.x - carrier.x, ball.y - carrier.y) > TOUCH_TRIGGER + 0.6);
  if (
    oppOwns && winnable && dist < 6 && bot.slideTicks === 0 &&
    bot.stamina >= SLIDE_COST && mayTouch(match, bot.side) &&
    hash01(bot.teamSlot * 11.7 + match.clockTicks * 0.31) < lvl.tackleChance
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

  // Otherwise: go where the plan says, shaped by the structural rules.
  // The support rule needs OUR carrier, not the opponent one the slide used.
  const ourCarrier = ball.hasOwner
    ? mates.find(m => sameId(m.identity, ball.ownerId))
    : undefined;
  const job = plan.get(bot.identity.toHexString());
  if (job) {
    steerBot(ctx, bot, applyShapeRules(job, bot, ball, ourCarrier, mates));
  }
}

// ---------------------------------------------------------------------------
// THE THREE BUTTONS. One reducer, resolved by CONTEXT, server-side:
//   on the ball        pass · lob · shoot
//   chasing            poke · slide · switch
//   keeper with ball   throw · long ball · put it down
//   at a set piece     take it · high · short   (a penalty: shoot · chip · place)
// Every action is a single press. Nothing is charged or timed.
// ---------------------------------------------------------------------------
export function slideTackle(ctx: Ctx, me: PlayerRow, body: PlayerRow): void {
  if (body.slideTicks > 0 || body.stamina < SLIDE_COST) return;
  // lunge the way the stick points; standing dead still, lunge upfield
  const mv = Math.hypot(body.mvX, body.mvY);
  const fx = mv > 0.01 ? body.mvX / mv : 0;
  const fy = mv > 0.01 ? body.mvY / mv : attackSign(body.side);
  ctx.db.player.identity.update({
    ...body,
    slideTicks: SLIDE_TOTAL,
    slideDirX: fx,
    slideDirY: fy,
    stamina: Math.max(0, body.stamina - SLIDE_COST),
  });
}

export function footballAction(ctx: Ctx, me: PlayerRow, button: number): void {
  if (me.matchId === 0n || me.spectator) return;
  const match = ctx.db.match.id.find(me.matchId);
  if (!match || match.state !== 1) return;
  if (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF) return;
  const body = controlledBody(ctx, me);
  if (body.slideTicks > 0) return; // committed
  const ball = ctx.db.ball.matchId.find(match.id);
  if (!ball) return;
  const players = matchPlayers(ctx, me.matchId);
  const mates = onPitch(players, body.side).filter(p => !sameId(p.identity, body.identity));
  const foes = outfielders(players, 1 - body.side);
  const stickX = body.dirX;
  const stickY = body.dirY;
  const atk = attackSign(body.side);

  // ---- KEEPER, BALL IN HAND ----
  if (body.role === ROLE_KEEPER && body.holdTicks > 0) {
    if (button === ACT_THIRD) {
      // PUT IT DOWN: become an ordinary player in possession
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
        fromKick: false,
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
    kickBall(
      ctx, match, released, body,
      long ? KICK_CHIP : KICK_NORMAL,
      long ? 0.85 : 0.4,
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
    if (kind === RK_PENALTY) {
      // a penalty is a SHOT, not a pass
      const goalY = atk * PITCH_HALF_LEN;
      const aimX = clamp(stickX * (GOAL_HALF_W - 1.2), -(GOAL_HALF_W - 1.2), GOAL_HALF_W - 1.2);
      kickBall(
        ctx, match, ball, body,
        button === ACT_SECOND ? KICK_CHIP : KICK_NORMAL,
        button === ACT_THIRD ? PASS_POWER : SHOT_POWER,
        aimX - ball.x, goalY - ball.y, 0, true
      );
      clearGrace(ctx, match, body.side);
      return;
    }
    const short = button === ACT_THIRD;
    const high = button === ACT_SECOND;
    const range = short ? 26 : kind === RK_CORNER ? PITCH_HALF_LEN : PITCH_HALF_LEN * 0.8;
    const target = pickPassTarget(body, mates, foes, stickX, stickY, range);
    const aim = target ? leadTarget(ball, target, high ? 42 : 55) : null;
    kickBall(
      ctx, match, ball, body,
      high || kind === RK_CORNER ? KICK_CHIP : KICK_NORMAL,
      short ? SHORT_POWER : high ? LOB_POWER : PASS_POWER,
      aim ? aim.x - ball.x : kind === RK_CORNER ? -ball.x : stickX || 0,
      aim ? aim.y - ball.y : kind === RK_CORNER ? atk * PITCH_HALF_LEN - ball.y : stickY || atk
    );
    if (match.phase === PHASE_KICKOFF) {
      ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, graceTicks: 0, pointMsg: '' });
    } else {
      clearGrace(ctx, match, body.side);
    }
    return;
  }

  // ---- ON THE BALL ----
  if (iHaveBall) {
    if (button === ACT_THIRD) {
      // SHOOT — power from distance, aim assisted at the mouth
      const goalY = atk * PITCH_HALF_LEN;
      const aimX = clamp(stickX * (GOAL_HALF_W - 1.2), -(GOAL_HALF_W - 1.2), GOAL_HALF_W - 1.2);
      kickBall(ctx, match, ball, body, KICK_NORMAL, SHOT_POWER, aimX - ball.x, goalY - ball.y, 0, true);
      return;
    }
    const lob = button === ACT_SECOND;
    const target = pickPassTarget(
      body, mates, foes, stickX, stickY, lob ? PITCH_HALF_LEN : AI_PASS_MAX
    );
    const aim = target ? leadTarget(ball, target, lob ? 42 : 55) : null;
    kickBall(
      ctx, match, ball, body,
      lob ? KICK_CHIP : KICK_NORMAL,
      lob ? LOB_POWER : PASS_POWER,
      aim ? aim.x - ball.x : stickX || 0,
      aim ? aim.y - ball.y : stickY || atk
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
  // the standing poke: wins a close ball with none of the slide's commitment
  const d = Math.hypot(ball.x - body.x, ball.y - body.y);
  if (d < CONTROL_RADIUS * 2.2 && ball.z < CONTROL_MAX_Z + 1 && mayTouch(match, body.side)) {
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
      fromKick: false, // a challenge, not a pass
    });
    clearGrace(ctx, match, body.side);
  }
}

// ---------------------------------------------------------------------------
// SETUP — where bodies stand at a kickoff. Exported for the meta layer, which
// places rosters when a match is created.
// ---------------------------------------------------------------------------
export function kickoffSpot(
  side: number, pos: number, kickoffSide: number
): { x: number; y: number } {
  const up = attackSign(side);
  // the taker stands over the ball, a step into his own half
  if (side === kickoffSide && pos === 0) return { x: 0, y: -up * 2.5 };
  const f = FORMATION[posOf(pos)];
  return {
    x: f.ax * PITCH_HALF_WID * 0.8,
    y: -up * (Math.abs(f.ay) * PITCH_HALF_LEN * 0.6 + PITCH_HALF_LEN * 0.2),
  };
}
export function keeperSpot(side: number): { x: number; y: number } {
  return { x: 0, y: sideSign(side) * (PITCH_HALF_LEN - KEEPER_LINE) };
}

// ---------------------------------------------------------------------------
// THE TICK. 30 Hz, server-authoritative, one match. Order matters and is the
// sum of everything learned:
//   countdown → pause resolution → kickoff discipline → brains+movement →
//   keepers → ball physics → possession → referee → clock → control
// A whistle (goal, restart, foul) ENDS the tick.
// ---------------------------------------------------------------------------
export function tickFootball(
  ctx: Ctx, match: MatchRow, lobby: LobbyRow | null | undefined,
  phys: Phys, hooks: MetaHooks
): void {
  // ---- match-start countdown: the world holds still ----
  if (match.startTicks > 0) {
    const left = match.startTicks - 1;
    ctx.db.match.id.update({ ...match, startTicks: left });
    if (left === 0) hooks.countdownDone?.(ctx, match);
    return;
  }

  // ---- PAUSE: goal celebration / restart placement / half-time ----
  if (match.phase === PHASE_PAUSE) {
    if (match.pauseTicks > 1) {
      ctx.db.match.id.update({ ...match, pauseTicks: match.pauseTicks - 1 });
      return;
    }
    resumeFromPause(ctx, match);
    return;
  }
  if (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF) return;

  let ball = ctx.db.ball.matchId.find(match.id);
  if (!ball) return;
  let players = matchPlayers(ctx, match.id);

  // ---- KICKOFF: hand it to the man in the circle; auto-take if ignored ----
  if (match.phase === PHASE_KICKOFF && match.startTicks === 0) {
    match = { ...match, pauseTicks: Math.min(65000, match.pauseTicks + 1) };
    ctx.db.match.id.update(match);
    if (match.pauseTicks === 1) {
      const koSide = match.kickoffSide;
      const taker = players.find(
        p => p.side === koSide && p.role === ROLE_OUTFIELD &&
          !p.spectator && !p.sentOff && p.teamSlot === 0
      );
      const person = players.find(
        p => !p.isBot && !p.spectator && p.side === koSide && p.role === ROLE_OUTFIELD
      );
      if (taker && person) bindPilot(ctx, person, controlledBody(ctx, person), taker, SWITCH_LOCK);
    }
  }

  // ---- TRANSITION MEMORY: who has it, and did that just change ----
  const carrierNow = ball.hasOwner
    ? players.find(q => sameId(q.identity, ball!.ownerId))
    : undefined;
  {
    const holder = carrierNow ? carrierNow.side : 255;
    if (holder !== 255 && match.possSide !== 255 && holder !== match.possSide) {
      match = { ...match, possSide: holder, transTicks: TRANSITION_TICKS };
      ctx.db.match.id.update(match);
    } else if (holder !== 255 && holder !== match.possSide) {
      match = { ...match, possSide: holder };
      ctx.db.match.id.update(match);
    } else if (match.transTicks > 0) {
      match = { ...match, transTicks: match.transTicks - 1 };
      ctx.db.match.id.update(match);
    }
  }

  // ---- THE TWO BRAINS: elect pressers, draw the plans ----
  const heldBy = players.find(p => p.role === ROLE_KEEPER && p.holdTicks > 0)?.side ?? -1;
  const plans: Plan[] = [];
  for (const side of [0, 1]) {
    const men = outfielders(players, side);
    const e = electPresser(match, side, men, ball);
    if (e.match !== match) {
      match = e.match;
      ctx.db.match.id.update(match);
    }
    plans.push(
      match.phase === PHASE_LIVE
        ? teamPlan(match, side, men, players, ball, e.slot, heldBy)
        : new Map()
    );
  }

  // ---- MOVEMENT: every body, one pass ----
  for (const p of players) {
    if (p.spectator) continue;
    let cur = ctx.db.player.identity.find(p.identity);
    if (!cur) continue;

    // a sent-off man is walked to the touchline and stays there
    if (cur.sentOff) {
      const off = sideSign(cur.side) * (PITCH_HALF_WID + 6);
      if (Math.abs(cur.x - off) > 0.5 || Math.abs(cur.y) > 0.5) {
        ctx.db.player.identity.update({
          ...cur, x: off, y: 0, mvX: 0, mvY: 0, velX: 0, velY: 0,
          kickHeld: false, kickTicks: 0, slideTicks: 0, ctrlSeat: CTRL_NONE,
        });
      }
      continue;
    }

    // the slide: a committed lunge, then a stun — with the foul check
    if (cur.slideTicks > 0) {
      const t2 = cur.slideTicks - 1;
      if (cur.slideTicks > SLIDE_ACTIVE_AFTER) {
        const nx = clamp(cur.x + cur.slideDirX * SLIDE_SPEED * DT, -P_BOUNDS_X, P_BOUNDS_X);
        const ny = clamp(cur.y + cur.slideDirY * SLIDE_SPEED * DT, -P_BOUNDS_Y, P_BOUNDS_Y);
        ctx.db.player.identity.update({ ...cur, x: nx, y: ny, slideTicks: t2 });
        let wonBall = false;
        if (
          ball && ball.active && match.phase === PHASE_LIVE &&
          mayTouch(match, cur.side) && ball.z < CONTROL_MAX_Z
        ) {
          const reach = SLIDE_REACH * charStat(cur.characterId).tackle;
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
            match = clearGrace(ctx, match, cur.side);
            ball = ctx.db.ball.matchId.find(match.id);
            wonBall = true;
          }
        }
        // ball first is fair, however many it caught; a lunge that reached
        // only the MAN is a foul, and the whistle ends the tick
        const slider = cur;
        if (!wonBall && ball && match.phase === PHASE_LIVE) {
          const victim = players.find(
            q =>
              q.side !== slider.side && !q.spectator && !q.sentOff &&
              q.slideTicks === 0 && Math.hypot(q.x - nx, q.y - ny) < FOUL_REACH
          );
          if (victim) {
            const hadBall = !!ball.hasOwner && sameId(ball.ownerId, victim.identity);
            awardFoul(ctx, match, ball, slider, victim, hadBall);
            return;
          }
        }
      } else {
        ctx.db.player.identity.update({ ...cur, slideTicks: t2 });
      }
      continue;
    }

    // AI keepers move in keeperPlay; a human-driven keeper walks like anyone
    if (cur.role === ROLE_KEEPER && cur.ctrlSeat === CTRL_NONE) continue;

    // bots: think, then move on the heading the brain wrote
    if (cur.ctrlSeat === CTRL_NONE && match.phase === PHASE_LIVE && ball) {
      const mates = onPitch(players, cur.side).filter(q => !sameId(q.identity, cur!.identity));
      const foes = outfielders(players, 1 - cur.side);
      botPlay(ctx, match, lobby, cur, ball, plans[cur.side], mates, foes, heldBy);
      ball = ctx.db.ball.matchId.find(match.id);
      match = ctx.db.match.id.find(match.id)!;
      if (match.state !== 1 || (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF)) return;
      cur = ctx.db.player.identity.find(p.identity);
      if (!cur || cur.slideTicks > 0) continue;
    } else if (cur.ctrlSeat === CTRL_NONE && match.phase === PHASE_KICKOFF && ball) {
      // kickoff: the taker walks to the ball and plays it; late, a stand-in
      const humanWaiting = players.some(
        q => !q.isBot && !q.spectator && q.side === match.kickoffSide && q.online
      );
      const standIn =
        match.pauseTicks > (humanWaiting ? KICKOFF_AUTO_HUMAN : KICKOFF_AUTO)
          ? outfielders(players, cur.side).find(b => b.ctrlSeat === CTRL_NONE)?.teamSlot
          : undefined;
      const amTaker = cur.teamSlot === 0 || (standIn !== undefined && cur.teamSlot === standIn);
      if (cur.side === match.kickoffSide && amTaker) {
        const d = Math.hypot(ball.x - cur.x, ball.y - cur.y);
        if (d < KICK_RANGE) {
          const mates = onPitch(players, cur.side).filter(q => !sameId(q.identity, cur!.identity));
          const foes = outfielders(players, 1 - cur.side);
          const pick = pickPassTarget(cur, mates, foes, 0, attackSign(cur.side), PITCH_HALF_LEN * 0.6);
          kickBall(
            ctx, match, ball, cur, KICK_NORMAL, 0.32,
            pick ? pick.x - ball.x : (hash01(Number(match.id % 997n)) - 0.5) * 12,
            pick ? pick.y - ball.y : attackSign(cur.side) * 12
          );
          ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, graceTicks: 0, pointMsg: '' });
          match = ctx.db.match.id.find(match.id)!;
          ball = ctx.db.ball.matchId.find(match.id);
          continue;
        }
        const len = d || 1;
        // STEER ON mv — dir alone is only the facing, and a taker who only
        // faces the ball stands there while the match never starts
        ctx.db.player.identity.update({
          ...cur,
          mvX: (ball.x - cur.x) / len,
          mvY: (ball.y - cur.y) / len,
          dirX: Math.abs(ball.x - cur.x) > 0.5 ? Math.sign(ball.x - cur.x) : 0,
          dirY: Math.abs(ball.y - cur.y) > 0.5 ? Math.sign(ball.y - cur.y) : 0,
        });
        cur = ctx.db.player.identity.find(p.identity)!;
      } else {
        // everyone else walks to his kickoff station
        const spot =
          cur.role === ROLE_KEEPER
            ? keeperSpot(cur.side)
            : kickoffSpot(cur.side, posOf(cur.teamSlot), match.kickoffSide);
        const kd = Math.hypot(spot.x - cur.x, spot.y - cur.y) || 1;
        ctx.db.player.identity.update({
          ...cur,
          mvX: kd > 1 ? (spot.x - cur.x) / kd : 0,
          mvY: kd > 1 ? (spot.y - cur.y) / kd : 0,
          dirX: Math.abs(spot.x - cur.x) > 0.6 ? Math.sign(spot.x - cur.x) : 0,
          dirY: Math.abs(spot.y - cur.y) > 0.6 ? Math.sign(spot.y - cur.y) : 0,
          sprinting: false,
        });
        cur = ctx.db.player.identity.find(p.identity)!;
      }
    }

    // INTEGRATE. Instant: the stick (or the brain's heading) IS the velocity.
    const st = charStat(cur.characterId);
    const human = cur.ctrlSeat !== CTRL_NONE;
    const hx = human ? cur.dirX : cur.mvX;
    const hy = human ? cur.dirY : cur.mvY;
    const hlen = Math.hypot(hx, hy);
    const moving = hlen > 0;
    const wantSprint = cur.sprinting && moving && cur.stamina > 0;
    const drain = wantSprint ? Math.round(SPRINT_DRAIN / st.stamina) : 0;
    const stamina = clamp(cur.stamina - drain + (wantSprint ? 0 : STAMINA_REGEN), 0, STAMINA_MAX);
    const owns = !!ball && ball.hasOwner && sameId(ball.ownerId, cur.identity);
    let speed = PLAYER_SPEED * st.speed * (wantSprint ? SPRINT_MUL : 1);
    if (owns) speed *= DRIBBLE_MUL;
    if (!moving) {
      if (stamina !== cur.stamina || cur.velX !== 0 || cur.velY !== 0) {
        ctx.db.player.identity.update({ ...cur, stamina, velX: 0, velY: 0 });
      }
      continue;
    }
    const vX = hx / hlen;
    const vY = hy / hlen;
    let x = clamp(cur.x + vX * speed * DT, -P_BOUNDS_X, P_BOUNDS_X);
    let y = clamp(cur.y + vY * speed * DT, -P_BOUNDS_Y, P_BOUNDS_Y);
    if (match.phase === PHASE_KICKOFF) {
      // kickoff discipline: your own half; non-kickoff side out of the circle
      y = sideSign(cur.side) > 0 ? Math.max(y, 0.5) : Math.min(y, -0.5);
      if (cur.side !== match.kickoffSide && Math.hypot(x, y) < CENTER_CIRCLE_R) {
        const n = Math.hypot(x, y) || 1;
        x = (x / n) * CENTER_CIRCLE_R;
        y = (y / n) * CENTER_CIRCLE_R;
        y = sideSign(cur.side) > 0 ? Math.max(y, 0.5) : Math.min(y, -0.5);
      }
    }
    ctx.db.player.identity.update({ ...cur, x, y, stamina, velX: vX, velY: vY });
  }

  // ---- KEEPERS (hands always; feet only when no human drives them) ----
  ball = ctx.db.ball.matchId.find(match.id);
  if (ball && match.phase === PHASE_LIVE) {
    for (const p of players) {
      if (p.role !== ROLE_KEEPER || p.sentOff) continue;
      const cur = ctx.db.player.identity.find(p.identity);
      if (cur) keeperPlay(ctx, match, lobby, cur, ctx.db.ball.matchId.find(match.id)!);
    }
    match = ctx.db.match.id.find(match.id)!;
    if (match.state !== 1) return;
  }

  if (match.phase !== PHASE_LIVE) return;

  // ---- THE CLOCK ----
  if (match.clockTicks > 0) {
    const left = match.clockTicks - 1;
    match = { ...match, clockTicks: left };
    ctx.db.match.id.update(match);
    if (left === 0) {
      endOfClock(ctx, match, hooks);
      return;
    }
  }
  if (match.graceTicks > 0) {
    match = { ...match, graceTicks: match.graceTicks - 1 };
    ctx.db.match.id.update(match);
  }

  // ---- BALL PHYSICS ----
  ball = ctx.db.ball.matchId.find(match.id);
  if (!ball || !ball.active) return;
  if (ball.z > 0.01 || ball.vz > 0.01) {
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
      const vz = -ball.vz * phys.bounce;
      ball = { ...ball, z: 0, vz: vz < 1.6 ? 0 : vz, vx: ball.vx * 0.9, vy: ball.vy * 0.9 };
    }
  } else {
    const sp = Math.hypot(ball.vx, ball.vy);
    let k = 0;
    if (sp > 0) {
      const afterDrag = sp / (1 + BALL_DRAG * sp * DT);
      k = Math.max(0, afterDrag - phys.friction * DT) / sp;
    }
    let vx = ball.vx * k;
    let vy = ball.vy * k;
    if (Math.hypot(vx, vy) < 0.6) { vx = 0; vy = 0; }
    ball = { ...ball, x: ball.x + vx * DT, y: ball.y + vy * DT, z: 0, vx, vy, vz: 0 };
  }
  ball = {
    ...ball,
    x: clamp(ball.x, -PITCH_HALF_WID - 2, PITCH_HALF_WID + 2),
    y: clamp(ball.y, -PITCH_HALF_LEN - 3, PITCH_HALF_LEN + 3),
  };

  // ---- POSSESSION: the touch cycle ----
  const holderNow = matchPlayers(ctx, match.id).some(
    p => p.role === ROLE_KEEPER && p.holdTicks > 0
  );
  if (holderNow) {
    ctx.db.ball.matchId.update(ball);
    autoSwitch(ctx, match, ball);
    return;
  }
  const fresh = matchPlayers(ctx, match.id);
  const protectedSide = match.graceTicks === 0 ? -1 : match.restartSide;
  if (ball.lockTicks > 0) ball = { ...ball, lockTicks: ball.lockTicks - 1 };
  const lockedOut = ball.lockTicks > 0 ? ball.lastTouchId : null;
  const eligible = (p: PlayerRow) =>
    !p.spectator && !p.sentOff &&
    (p.role === ROLE_OUTFIELD || p.ctrlSeat !== CTRL_NONE) &&
    p.slideTicks === 0 &&
    (protectedSide < 0 || p.side === protectedSide) &&
    !(lockedOut !== null && sameId(p.identity, lockedOut));

  const restartHeld = match.graceTicks > 0;
  let owner: PlayerRow | null = null;
  if (restartHeld) {
    // a ball waiting to be restarted is DEAD: held on the spot, unowned
    ball = { ...ball, vx: 0, vy: 0, vz: 0, hasOwner: false, ownerId: ZERO_ID };
  } else if (ball.hasOwner) {
    const prev = fresh.find(p => sameId(p.identity, ball!.ownerId));
    if (
      prev && eligible(prev) &&
      Math.hypot(ball.x - prev.x, ball.y - prev.y) <
        CONTROL_KEEP_RADIUS * charStat(prev.characterId).tackle
    ) {
      owner = prev;
    }
  }
  const speedNow = Math.hypot(ball.vx, ball.vy);
  if (!owner && !restartHeld && ball.z < CONTROL_MAX_Z) {
    let bestD = Infinity;
    // A ball at shot pace is BLOCKED, not controlled — and a block needs a
    // body genuinely in the way. Letting the full control radius stop hot
    // balls turned a packed defence into a wall that swallowed every shot:
    // a full watched match produced continuous passing, several shots, and
    // 0-0 through ninety minutes of clock and overtime.
    const reachFor = (p: PlayerRow) =>
      speedNow > CONTROL_MAX_SPEED ? 1.4 : CONTROL_RADIUS * charStat(p.characterId).tackle;
    for (const p of fresh) {
      if (!eligible(p)) continue;
      const d = Math.hypot(ball.x - p.x, ball.y - p.y);
      if (d < reachFor(p) && d < bestD) {
        bestD = d;
        owner = p;
      }
    }
    if (owner && speedNow > CONTROL_MAX_SPEED) {
      // too hot to own — a body in the way traps it down
      ball = {
        ...ball,
        vx: ball.vx * TRAP_DAMP, vy: ball.vy * TRAP_DAMP, vz: Math.min(ball.vz, 2),
        lastTouchSide: owner.side,
        lastTouchId: owner.identity,
        lockTicks: 0,
        fromKick: false,
      };
      match = clearGrace(ctx, match, owner.side);
      owner = null;
    }
  }

  if (owner) {
    // contest: an opponent inside the radius can poke it loose
    const contester = fresh.find(
      p =>
        p.side !== owner!.side && eligible(p) &&
        Math.hypot(ball!.x - p.x, ball!.y - p.y) < CONTROL_RADIUS * charStat(p.characterId).tackle
    );
    if (
      contester &&
      hash01(Number(match.id % 65536n) * 3.1 + match.clockTicks * 0.7) <
        CONTEST_CHANCE * charStat(contester.characterId).tackle
    ) {
      const ang = hash01(match.clockTicks * 1.3 + Number(match.id % 977n)) * Math.PI * 2;
      ball = {
        ...ball,
        vx: Math.cos(ang) * 14, vy: Math.sin(ang) * 14, vz: 0,
        hasOwner: false, ownerId: ZERO_ID,
        lastTouchSide: contester.side,
        lastTouchId: contester.identity,
        lockTicks: 0,
        fromKick: false,
      };
      match = clearGrace(ctx, match, contester.side);
    } else {
      const moving = owner.mvX !== 0 || owner.mvY !== 0;
      const mlen = Math.hypot(owner.mvX, owner.mvY) || 1;
      const fx = moving ? owner.mvX / mlen : 0;
      const fy = moving ? owner.mvY / mlen : attackSign(owner.side);
      const dx = ball.x - owner.x;
      const dy = ball.y - owner.y;
      const ownSpeedNow =
        Math.hypot(owner.velX, owner.velY) * PLAYER_SPEED *
        charStat(owner.characterId).speed * (owner.sprinting ? SPRINT_MUL : 1) * DRIBBLE_MUL;
      const takingOver = !ball.hasOwner || !sameId(ball.ownerId, owner.identity);
      if (takingOver) {
        // FIRST TOUCH: the pace comes off and it settles in front of you —
        // scaled by control, so a laser pass is harder to take down
        const inSpeed = Math.hypot(ball.vx, ball.vy);
        const keep = clamp(
          TRAP_DAMP * (1.6 - charStat(owner.characterId).curl) * (0.5 + inSpeed / CONTROL_MAX_SPEED),
          0, 0.6
        );
        ball = { ...ball, vx: ball.vx * keep + fx * 2, vy: ball.vy * keep + fy * 2, vz: 0, z: 0 };
      } else if (!moving) {
        // standing over it: close control is close control
        const sX = owner.x + fx * TOUCH_TRIGGER;
        const sY = owner.y + fy * TOUCH_TRIGGER;
        ball = {
          ...ball,
          x: ball.x + (sX - ball.x) * SETTLE_DAMP,
          y: ball.y + (sY - ball.y) * SETTLE_DAMP,
          z: 0,
          vx: ball.vx * (1 - SETTLE_DAMP),
          vy: ball.vy * (1 - SETTLE_DAMP),
          vz: 0,
        };
      } else if (
        dx * fx + dy * fy < TOUCH_TRIGGER &&
        Math.hypot(ball.vx, ball.vy) < ownSpeedNow * 1.05
      ) {
        // THE NEXT TOUCH — an event, only once he has caught the ball, and
        // aimed at a spot directly in FRONT of him so it comes back into his
        // path instead of drifting off his shoulder
        const spotX = owner.x + fx * TOUCH_AHEAD;
        const spotY = owner.y + fy * TOUCH_AHEAD;
        const ax = spotX - ball.x;
        const ay = spotY - ball.y;
        const al = Math.hypot(ax, ay) || 1;
        const knock = ownSpeedNow + TOUCH_KNOCK;
        ball = { ...ball, vx: (ax / al) * knock, vy: (ay / al) * knock, vz: 0, z: 0 };
      }
      // between touches nothing writes the ball's position: it is rolling
      ball = {
        ...ball,
        hasOwner: true,
        ownerId: owner.identity,
        lastTouchSide: owner.side,
        lastTouchId: owner.identity,
        fromKick: false, // taking it under control clears the back-pass
        lockTicks: 0, // and a new touch always ends the striker's lock
      };
      match = clearGrace(ctx, match, owner.side);
    }
  } else if (ball.hasOwner && !restartHeld) {
    ball = { ...ball, hasOwner: false, ownerId: ZERO_ID };
  }

  ctx.db.ball.matchId.update(ball);
  autoSwitch(ctx, match, ball);

  // ---- THE REFEREE: out of play, judged on where the ball IS ----
  resolveOutOfPlay(ctx, match, ball, hooks);
}

// ---------------------------------------------------------------------------
// RESUME: turning a pause back into play.
// ---------------------------------------------------------------------------
const OT_TICKS = ticks(OT_SECONDS);

/**
 * Line both teams up for a kickoff — match start, after a goal, new half.
 * Every kickoff hands each human back their own footballer, so reconnects
 * resume through here with no special case.
 */
export function setupKickoff(ctx: Ctx, match: MatchRow, msg: string): MatchRow {
  for (const p of matchPlayers(ctx, match.id)) {
    const spot =
      p.role === ROLE_KEEPER
        ? keeperSpot(p.side)
        : kickoffSpot(p.side, posOf(p.teamSlot), match.kickoffSide);
    ctx.db.player.identity.update({
      ...p, x: spot.x, y: spot.y, dirX: 0, dirY: 0, mvX: 0, mvY: 0,
      velX: 0, velY: 0, kickTicks: 0, kickHeld: false, slideTicks: 0,
      holdTicks: 0, diveTicks: 0,
      ctrlSeat: !p.isBot && p.role === ROLE_OUTFIELD && !p.sentOff ? p.teamSlot : CTRL_NONE,
      switchLock: 0,
    });
  }
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) {
    ctx.db.ball.matchId.update({
      ...ball, active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      hasOwner: false, ownerId: ZERO_ID, fromKick: false, lockTicks: 0,
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

function resumeFromPause(ctx: Ctx, match: MatchRow): void {
  switch (match.restartKind) {
    case RK_KICKOFF:
      setupKickoff(ctx, match, 'KICKOFF');
      return;
    case RK_HALFTIME:
      setupKickoff(
        ctx,
        { ...match, half: 2, clockTicks: HALF_TICKS, kickoffSide: 1 },
        'SECOND HALF'
      );
      return;
    case RK_OVERTIME:
      setupKickoff(
        ctx,
        {
          ...match, half: 3, clockTicks: OT_TICKS,
          kickoffSide: hash01(Number(match.id % 9973n)) < 0.5 ? 0 : 1,
        },
        'GOLDEN GOAL — NEXT GOAL WINS'
      );
      return;
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
          z: match.restartKind === RK_THROWIN ? 3.4 : 0, // in the thrower's hands
          vx: 0, vy: 0, vz: 0,
          hasOwner: false,
          ownerId: ZERO_ID,
          lastTouchSide: match.restartSide,
          lockTicks: 0,
          fromKick: false, // the stoppage clears the back-pass state
        });
      }
      // PUT THE TAKER ON THE BALL — he does not race his own restart. Just
      // inside the line for a throw-in or corner (standing outside puts the
      // ball between him and the field, and his first touch knocks it
      // straight back out).
      if (match.restartKind !== RK_DROP && match.restartKind !== RK_PENALTY) {
        const taker = restartTaker(ctx, match);
        if (taker) {
          const outX = Math.sign(match.restartX) || 1;
          const outY = Math.sign(match.restartY) || 1;
          let tx = match.restartX;
          let ty = match.restartY + sideSign(match.restartSide) * 2.2;
          if (match.restartKind === RK_THROWIN) {
            tx = outX * (PITCH_HALF_WID - 1.5);
            ty = match.restartY;
          } else if (match.restartKind === RK_CORNER) {
            tx = outX * (PITCH_HALF_WID - 1.5);
            ty = outY * (PITCH_HALF_LEN - 1.5);
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
      // A PENALTY is taken with the box cleared and the keeper on his line.
      if (match.restartKind === RK_PENALTY) {
        const defSign = -sideSign(match.restartSide);
        const taker = restartTaker(ctx, match);
        for (const p of matchPlayers(ctx, match.id)) {
          if (p.spectator || p.sentOff) continue;
          if (p.role === ROLE_KEEPER && p.side !== match.restartSide) {
            ctx.db.player.identity.update({
              ...p, x: 0, y: defSign * (PITCH_HALF_LEN - 1),
              mvX: 0, mvY: 0, velX: 0, velY: 0, holdTicks: 0,
            });
            continue;
          }
          if (taker && sameId(p.identity, taker.identity)) {
            ctx.db.player.identity.update({
              ...p, x: 0, y: match.restartY + sideSign(match.restartSide) * 3,
              mvX: 0, mvY: 0, velX: 0, velY: 0,
            });
            continue;
          }
          const lane = (p.teamSlot % 3) - 1;
          ctx.db.player.identity.update({
            ...p,
            x: clamp(lane * 9 + (p.side === match.restartSide ? 2 : -2), -BOX_HALF_W, BOX_HALF_W),
            y: defSign * (PITCH_HALF_LEN - BOX_DEPTH - 4),
            mvX: 0, mvY: 0, velX: 0, velY: 0,
          });
        }
      }
      // hand the restart to the player, if a human is on the awarded side
      if (match.restartKind !== RK_DROP) {
        const awarded = match.restartSide;
        const taker = restartTaker(ctx, match);
        if (taker) {
          const person = matchPlayers(ctx, match.id).find(
            p => !p.isBot && !p.spectator && p.side === awarded && p.role === ROLE_OUTFIELD
          );
          if (person) bindPilot(ctx, person, controlledBody(ctx, person), taker, SWITCH_LOCK);
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
      ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, pauseTicks: 0 });
      return;
  }
}
