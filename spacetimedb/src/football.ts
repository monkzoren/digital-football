// ---------------------------------------------------------------------------
// DIGITAL FOOTBALL — THE ARCADE GAME.
//
// This is the whole sport in one file, written to the TRADITIONAL ARCADE
// SOCCER formula and not to a simulation. The distinction is the design:
//
//   THE BALL IS GLUED TO YOUR FEET while you have it. It does not roll free
//   between touches; it does not get nicked by a body brushing past. Only a
//   TACKLE takes it — a deliberate act by an opponent, which can miss.
//   A PASS arrives at a team-mate's feet and becomes his, and your stick
//   goes with it. A SHOT is fast, aim-assisted at the goal, and goes in
//   often: keepers are beatable and matches finish 4-3, not 0-0.
//   THE AI HOLDS A FORMATION BLOCK that slides with the ball — one man
//   presses, the rest keep shape and make themselves available. Simple,
//   legible, predictable, the way Sensible Soccer and ISS read from above.
//   RULES ARE LIGHT: throw-ins, corners, goal kicks, a keeper who picks up
//   anything in his box, a rare foul when a slide catches a man. No offside.
//
// The meta layer (rooms, accounts, betting) lives in index.ts and calls in
// through the exports at the bottom; nothing here knows what a lobby costs.
//
// Wire contract the client depends on and this file honours:
//   ctrlSeat token on the BODY (CTRL_NONE = AI); mvX/mvY float heading for
//   bots, dirX/dirY = stick / rendered facing; velX/velY = fraction of top
//   speed; PLAYER_SPEED and SPRINT_MUL mirrored in client/src/config.ts.
// ---------------------------------------------------------------------------

import type { Ctx, PlayerRow, MatchRow, BallRow, LobbyRow } from './index';
import { Identity } from 'spacetimedb';

// Bump on EVERY push, in lockstep with CLIENT_BUILD in client/src/config.ts.
export const MODULE_BUILD = '2026-09-04-A';

// ---- wire enums -------------------------------------------------------------
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
export const ACT_PRIMARY = 0;
export const ACT_SECOND = 1;
export const ACT_THIRD = 2;

// ---- time and pitch ---------------------------------------------------------
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
export const MAX_TEAM_SIZE = 3;
export const OUTFIELD_PER_SIDE = 3;

const GOAL_PAUSE = ticks(7.5);
const RESTART_PAUSE = ticks(1.2);
const HALFTIME_PAUSE = ticks(6);
export const COUNTDOWN_TICKS = ticks(3);
const KICKOFF_AUTO = ticks(4); // an abandoned side
const KICKOFF_AUTO_HUMAN = ticks(15); // a human reading the pitch
const RESTART_GRACE = ticks(4); // only the awarded side; must be TAKEN inside it
const AI_RESTART_DELAY = ticks(0.9); // a bot takes its restart after a beat

// ---- movement: instant, the stick is the velocity ----------------------------
export const PLAYER_SPEED = 15.5; // mirrored in client/src/config.ts
export const SPRINT_MUL = 1.6; // mirrored in client/src/config.ts
const DRIBBLE_MUL = 0.92; // arcade: barely slower with the ball
export const STAMINA_MAX = 1000;
const SPRINT_DRAIN = 3;
const STAMINA_REGEN = 3;

// ---- the ball ---------------------------------------------------------------
const BALL_DRAG = 0.03;
export const GRAVITY = -38;
export interface Phys { gravity: number; friction: number; bounce: number; power: number }
// GLUE: where the ball sits relative to a carrier's feet.
const GLUE_AHEAD = 1.7;
// A loose ball inside this becomes yours (arcade: generous).
const TAKE_RADIUS = 3.0;
const TAKE_MAX_Z = 3.2;
const TAKE_MAX_SPEED = 62; // hotter is a block/deflection, not control
const BLOCK_RADIUS = 1.3; // a hot ball needs a body genuinely in the way

// ---- kicks: fast, satisfying ------------------------------------------------
export const KICK_RANGE = 3.6;
const KICK_LOCK = ticks(0.25);
const PASS_SPEED_MIN = 34;
const PASS_SPEED_MAX = 56; // always under TAKE_MAX_SPEED: a pass is CONTROLLABLE on arrival
const LOB_SPEED = 46;
const SHOT_SPEED_MIN = 74;
const SHOT_SPEED_MAX = 82;
export const SHOOT_RANGE = 32;

// ---- tackles: the ONLY way to lose the ball ----------------------------------
const TACKLE_RANGE = 3.4; // standing tackle reach to the BALL
const TACKLE_STUN = ticks(0.55); // a tackle that misses leaves you flat-footed
const TACKLE_COOLDOWN = ticks(0.9);
// A bot must be in range for this long before it may tackle, and stepping out
// of range resets it. This is the whole difference between "marked" and
// "dispossessed": a carrier with a defender on him gets a live moment, and a
// change of direction that breaks the range is a real dodge.
const TACKLE_ARM = ticks(0.45);
const BOT_SETTLE = ticks(0.45); // a bot carries for this long before it may kick
const SLIDE_TOTAL = ticks(1.0);
const SLIDE_ACTIVE_AFTER = ticks(0.6);
const SLIDE_SPEED = 30;
const SLIDE_REACH = 4.2;
const SLIDE_COST = 200;
const SLIDE_KNOCK = 36;
const FOUL_REACH = 2.6; // a slide reaching the man well short of the ball
const PENALTY_SPOT = 12;
const CARDS_FOR_RED = 2;

// ---- the keeper: arcade — beatable, but a wall in the middle -----------------
const KEEPER_SPEED = 17;
const KEEPER_LINE = 3.0;
const KEEPER_MAX_X = GOAL_HALF_W + 1.5;
const KEEPER_RANGE_Y = BOX_DEPTH;
export const KEEPER_CLEAR_RADIUS = 3.2;
const KEEPER_HOLD = ticks(1.6);
const KEEPER_HOLD_HUMAN = ticks(4);
const KEEPER_THROW_RANGE = 50;
const DIVE_TICKS = ticks(0.5);
const DIVE_SPEED = 26;
const DIVE_REACH = 1.6;
// How much of the goal a keeper covers by reflex, per level, and how often
// a dive to the corner comes off. These are the scoring dials.
// Measured on the first cut (reflex 3.2 / dive 0.45): 2-12 in six minutes.
// The reflex covers the middle; the dive rate decides the corners.
const KEEPER_LEVELS = [
  { speed: 0.75, reflex: 3.8, dive: 0.45 },
  { speed: 0.95, reflex: 4.6, dive: 0.6 },
  { speed: 1.1, reflex: 5.2, dive: 0.72 },
];

// ---- the AI -----------------------------------------------------------------
// tackleChance is PER TICK while in range (0.02 ≈ 45% per second); tackleWin
// is the odds it comes off, and a miss stuns the tackler. Together they set
// how long a carrier gets on the ball with a defender on him: measured at
// 0.05/0.65 a receiver was dispossessed before he could take a step.
const BOT_LEVELS = [
  { speed: 0.8, shootErr: 0.2, tackleChance: 0.012, tackleWin: 0.45 },
  { speed: 0.92, shootErr: 0.14, tackleChance: 0.02, tackleWin: 0.5 },
  { speed: 1.0, shootErr: 0.05, tackleChance: 0.035, tackleWin: 0.6 },
];
const PRESS_HYSTERESIS = 1.15;
const BLOCK_FOLLOW_X = 0.35; // how far the formation slides across with the ball
const BLOCK_FOLLOW_Y = 0.55; // ... and up and down the pitch
const BLOCK_PUSH_ATTACK = 14; // the block steps up in possession
const BLOCK_DROP_DEFEND = 10; // ... and drops without it
const AI_PRESS_BUBBLE = 7; // only the presser inside this
const AI_SEPARATION = 9;
const AI_PASS_MAX = 50;
const RESTART_RETREAT = 15;
const OPTION_SHORT = 12;
const OPTION_LONG = 28;

// ---- switching --------------------------------------------------------------
const SWITCH_LOCK = ticks(0.22);
const AUTO_LOCK = ticks(0.5);
const AUTO_SWITCH_RANGE = 26;
const AUTO_SWITCH_MARGIN = 6;

// ---- the roster's stats (1.0 = baseline; speed mirrored in the client) -------
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

// ---- helpers ----------------------------------------------------------------
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sameId = (a: Identity, b: Identity) => a.toHexString() === b.toHexString();
const ZERO_ID = new Identity(0n);
export const sideSign = (side: number) => (side === 0 ? -1 : 1); // own goal line
export const attackSign = (side: number) => -sideSign(side);
const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const clockSecs = (m: MatchRow) => Math.ceil(m.clockTicks / TICK_HZ);
function matchPlayers(ctx: Ctx, matchId: bigint): PlayerRow[] {
  return [...ctx.db.player.byMatch.filter(matchId)];
}
function onPitch(players: PlayerRow[], side: number): PlayerRow[] {
  return players.filter(p => p.side === side && !p.spectator && !p.sentOff);
}
function outfielders(players: PlayerRow[], side: number): PlayerRow[] {
  return onPitch(players, side).filter(p => p.role === ROLE_OUTFIELD);
}
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

// ---------------------------------------------------------------------------
// THE KICK. Every pass, lob, shot, throw and restart is one of these.
// ---------------------------------------------------------------------------
export function kickBall(
  ctx: Ctx, match: MatchRow, ball: BallRow, kicker: PlayerRow,
  kind: number, speed: number, aimX: number, aimY: number, vz: number, err = 0
): void {
  const st = charStat(kicker.characterId);
  let ang = Math.atan2(aimY, aimX);
  ang += (hash01(match.clockTicks * 2.7 + ball.x + kicker.teamSlot) - 0.5) * 2 * err * (2 - st.accuracy);
  const v = speed * st.power;
  ctx.db.ball.matchId.update({
    ...ball,
    active: true,
    z: Math.max(ball.z, 0),
    vx: Math.cos(ang) * v,
    vy: Math.sin(ang) * v,
    vz,
    lastTouchSide: kicker.side,
    lastTouchId: kicker.identity,
    hasOwner: false,
    ownerId: ZERO_ID,
    lockTicks: KICK_LOCK, // the kicker's own feet must not re-take it next tick
    fromKick: kind === KICK_NORMAL || kind === KICK_CHIP,
  });
}

/** Aim assist for a shot: the stick picks a corner; the kick goes at it. */
function shotAim(kicker: PlayerRow, ball: BallRow, stickX: number): { x: number; y: number } {
  const goalY = attackSign(kicker.side) * PITCH_HALF_LEN;
  const cornerX = clamp(stickX * (GOAL_HALF_W - 1.3), -(GOAL_HALF_W - 1.3), GOAL_HALF_W - 1.3);
  return { x: cornerX - ball.x, y: goalY - ball.y };
}
function shotSpeedFor(ball: BallRow, side: number): number {
  const d = Math.hypot(ball.x, attackSign(side) * PITCH_HALF_LEN - ball.y);
  return clamp(SHOT_SPEED_MIN + (d / SHOOT_RANGE) * (SHOT_SPEED_MAX - SHOT_SPEED_MIN), SHOT_SPEED_MIN, SHOT_SPEED_MAX);
}

function laneClear(x0: number, y0: number, x1: number, y1: number, foes: PlayerRow[], width: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  for (const f of foes) {
    const t = clamp(((f.x - x0) * dx + (f.y - y0) * dy) / len2, 0, 1);
    if (Math.hypot(x0 + dx * t - f.x, y0 + dy * t - f.y) < width) return false;
  }
  return true;
}

/**
 * ASSISTED PASSING. The stick says which way; this picks the MAN — the
 * best team-mate in a wide cone that way, or the best forward option when
 * nothing is held. Arcade passing is generous: it should almost always find
 * someone, because a pass to nobody is the least fun thing in the game.
 */
export function pickPassTarget(
  me: PlayerRow, mates: PlayerRow[], foes: PlayerRow[],
  stickX: number, stickY: number, maxRange: number
): PlayerRow | null {
  const stick = Math.hypot(stickX, stickY);
  const atk = attackSign(me.side);
  let best: PlayerRow | null = null;
  let bestScore = -Infinity;
  for (const m of mates) {
    if (m.role !== ROLE_OUTFIELD) continue; // the keeper is never a pass target
    const dx = m.x - me.x, dy = m.y - me.y;
    const d = Math.hypot(dx, dy);
    if (d < 2.5 || d > maxRange) continue;
    let score = 0;
    if (stick > 0.01) {
      const cos = (dx * stickX + dy * stickY) / (d * stick);
      if (cos < -0.2) continue; // not into your own back
      score += cos * 100;
    } else {
      score += dy * atk * 1.2;
    }
    const open = foes.reduce((a, o) => Math.min(a, dist(o.x, o.y, m.x, m.y)), 99);
    score += Math.min(open, 16) * 1.5 - d * 0.2;
    if (!laneClear(me.x, me.y, m.x, m.y, foes, 1.8)) score -= 30;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

/** Lead a moving receiver — never toward his own goal. */
function leadTarget(from: BallRow, target: PlayerRow, ballSpeed: number): { x: number; y: number } {
  const d = dist(from.x, from.y, target.x, target.y);
  const flight = clamp(d / Math.max(ballSpeed, 1), 0, 1.0);
  const run = PLAYER_SPEED * charStat(target.characterId).speed * (target.sprinting ? SPRINT_MUL : 1);
  const lx = clamp(target.velX * run * flight, -12, 12);
  let ly = clamp(target.velY * run * flight, -12, 12);
  if (ly * sideSign(target.side) > 0) ly = 0;
  return {
    x: clamp(target.x + lx, -(PITCH_HALF_WID - 2), PITCH_HALF_WID - 2),
    y: clamp(target.y + ly, -(PITCH_HALF_LEN - 2), PITCH_HALF_LEN - 2),
  };
}

/** Pass speed from distance: a short ball is soft, a long one is driven. */
function passSpeedFor(d: number): number {
  return clamp(PASS_SPEED_MIN + (d / AI_PASS_MAX) * (PASS_SPEED_MAX - PASS_SPEED_MIN), PASS_SPEED_MIN, PASS_SPEED_MAX);
}

/** Where a rolling ball can first be met. */
function interceptPoint(px: number, py: number, speed: number, ball: BallRow) {
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
    if (dist(bx, by, px, py) <= speed * t) return { x: bx, y: by, t };
  }
  return { x: bx, y: by, t: 2 };
}

// ---------------------------------------------------------------------------
// THE REFEREE: goals, dead balls, the rare foul, the clock.
// ---------------------------------------------------------------------------
export interface MetaHooks {
  countdownDone?(ctx: Ctx, match: MatchRow): void;
  teamName(players: PlayerRow[], side: number): string;
  matchWon(ctx: Ctx, match: MatchRow, winnerSide: number, msg: string): void;
  winVerb(name: string): string;
}

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

function awardGoal(ctx: Ctx, match: MatchRow, ball: BallRow, crossedEnd: number, hooks: MetaHooks): void {
  const scoringSide = 1 - crossedEnd;
  const seats = matchPlayers(ctx, match.id);
  const toucher = ctx.db.player.identity.find(ball.lastTouchId);
  const ownGoal = !!toucher && toucher.side === crossedEnd;
  const scorerName = toucher?.name || hooks.teamName(seats, scoringSide);
  const p0Goals = match.p0Goals + (scoringSide === 0 ? 1 : 0);
  const p1Goals = match.p1Goals + (scoringSide === 1 ? 1 : 0);
  ctx.db.goalEvent.insert({
    id: 0n, matchId: match.id, lobbyId: match.lobbyId, side: scoringSide,
    scorerName, ownGoal, half: match.half, clockSecs: clockSecs(match), at: ctx.timestamp,
  });
  ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
  const scored = { ...match, p0Goals, p1Goals };
  if (match.half >= 3) {
    const winner = hooks.teamName(seats, scoringSide);
    hooks.matchWon(ctx, scored, scoringSide, `GOLDEN GOAL! ${winner} ${hooks.winVerb(winner)} ${p0Goals}–${p1Goals}!`);
    return;
  }
  ctx.db.match.id.update({
    ...scored, phase: PHASE_PAUSE, pauseTicks: GOAL_PAUSE, restartKind: RK_KICKOFF,
    kickoffSide: crossedEnd,
    pointMsg: ownGoal ? `OWN GOAL by ${scorerName}!` : `GOOOAL! ${scorerName} SCORES!`,
  });
}

function awardRestart(
  ctx: Ctx, match: MatchRow, ball: BallRow, kind: number, side: number, x: number, y: number, msg: string
): void {
  ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
  for (const k of matchPlayers(ctx, match.id)) {
    if (k.role === ROLE_KEEPER && k.holdTicks > 0) ctx.db.player.identity.update({ ...k, holdTicks: 0 });
  }
  ctx.db.match.id.update({
    ...match, phase: PHASE_PAUSE, pauseTicks: RESTART_PAUSE,
    restartKind: kind, restartSide: side, restartX: x, restartY: y, pointMsg: msg,
  });
}

function restartTaker(ctx: Ctx, match: MatchRow): PlayerRow | null {
  const mine = outfielders(matchPlayers(ctx, match.id), match.restartSide).filter(p => p.slideTicks === 0);
  if (mine.length === 0) return null;
  return mine.reduce((a, b) =>
    dist(a.x, a.y, match.restartX, match.restartY) < dist(b.x, b.y, match.restartX, match.restartY) ? a : b
  );
}

/** A slide that reached the man well short of the ball. Rare, and it costs. */
function awardFoul(ctx: Ctx, match: MatchRow, ball: BallRow, offender: PlayerRow, victim: PlayerRow, hadBall: boolean): void {
  const defSign = sideSign(offender.side);
  const penalty =
    Math.abs(victim.x) < BOX_HALF_W && Math.abs(victim.y - defSign * PITCH_HALF_LEN) < BOX_DEPTH && victim.y * defSign > 0;
  let cards = offender.cards, sentOff = offender.sentOff, cardMsg = '';
  if (hadBall) {
    cards = Math.min(255, cards + 1);
    if (cards >= CARDS_FOR_RED) { sentOff = true; cardMsg = ' — RED CARD'; } else cardMsg = ' — YELLOW CARD';
  }
  if (cards !== offender.cards || sentOff !== offender.sentOff) {
    ctx.db.player.identity.update({
      ...offender, cards, sentOff, ctrlSeat: sentOff ? CTRL_NONE : offender.ctrlSeat,
      slideTicks: 0, mvX: 0, mvY: 0, velX: 0, velY: 0, kickHeld: false, kickTicks: 0, holdTicks: 0,
    });
  }
  awardRestart(
    ctx, match, ball, penalty ? RK_PENALTY : RK_FREEKICK, victim.side,
    penalty ? 0 : clamp(victim.x, -PITCH_HALF_WID + 2, PITCH_HALF_WID - 2),
    penalty ? defSign * (PITCH_HALF_LEN - PENALTY_SPOT) : clamp(victim.y, -PITCH_HALF_LEN + 2, PITCH_HALF_LEN - 2),
    (penalty ? 'PENALTY' : 'FREE KICK') + cardMsg
  );
}

/** Out of play, judged on where the ball IS. Returns true when the tick ends. */
function resolveOutOfPlay(ctx: Ctx, match: MatchRow, ball: BallRow, hooks: MetaHooks): boolean {
  if (!ball.active) return false;
  const players = matchPlayers(ctx, match.id);
  if (Math.abs(ball.y) > PITCH_HALF_LEN) {
    const crossedEnd = ball.y < 0 ? 0 : 1;
    if (Math.abs(ball.x) < GOAL_HALF_W && ball.z < GOAL_HEIGHT) {
      awardGoal(ctx, match, ball, crossedEnd, hooks);
      return true;
    }
    const attacker = 1 - crossedEnd;
    if (ball.lastTouchSide === crossedEnd) {
      awardRestart(ctx, match, ball, RK_CORNER, attacker,
        (ball.x >= 0 ? 1 : -1) * (PITCH_HALF_WID - 1), sideSign(crossedEnd) * (PITCH_HALF_LEN - 1),
        `CORNER — ${hooks.teamName(players, attacker)}`);
    } else {
      awardRestart(ctx, match, ball, RK_GOALKICK, crossedEnd,
        (ball.x >= 0 ? 1 : -1) * 6, sideSign(crossedEnd) * (PITCH_HALF_LEN - 6), 'GOAL KICK');
    }
    return true;
  }
  if (Math.abs(ball.x) > PITCH_HALF_WID) {
    const side = 1 - ball.lastTouchSide;
    awardRestart(ctx, match, ball, RK_THROWIN, side,
      (ball.x >= 0 ? 1 : -1) * (PITCH_HALF_WID - 0.5), clamp(ball.y, -PITCH_HALF_LEN + 2, PITCH_HALF_LEN - 2),
      `THROW-IN — ${hooks.teamName(players, side)}`);
    return true;
  }
  return false;
}

function endOfClock(ctx: Ctx, match: MatchRow, hooks: MetaHooks): void {
  const seats = matchPlayers(ctx, match.id);
  const parkBall = () => {
    const ball = ctx.db.ball.matchId.find(match.id);
    if (ball) ctx.db.ball.matchId.update({ ...ball, active: false, hasOwner: false });
  };
  if (match.half === 1) {
    ctx.db.match.id.update({ ...match, phase: PHASE_PAUSE, pauseTicks: HALFTIME_PAUSE, restartKind: RK_HALFTIME, pointMsg: 'HALF-TIME' });
    parkBall();
    return;
  }
  if (match.half === 2) {
    if (match.p0Goals !== match.p1Goals) {
      const winnerSide = match.p0Goals > match.p1Goals ? 0 : 1;
      const winner = hooks.teamName(seats, winnerSide);
      hooks.matchWon(ctx, match, winnerSide, `FULL TIME — ${winner} ${hooks.winVerb(winner)} ${match.p0Goals}–${match.p1Goals}!`);
      return;
    }
    ctx.db.match.id.update({
      ...match, phase: PHASE_PAUSE, pauseTicks: HALFTIME_PAUSE, restartKind: RK_OVERTIME,
      pointMsg: `${match.p0Goals}–${match.p1Goals} AT FULL TIME — GOLDEN GOAL!`,
    });
    parkBall();
    return;
  }
  ctx.db.match.id.update({ ...match, pointMsg: 'NEXT GOAL WINS!' });
}

// ---------------------------------------------------------------------------
// THE KEEPER — arcade. He picks up anything in his box, holds it for a beat,
// throws it out. Against a shot he covers the middle by reflex and DIVES for
// the corners, and a dive comes off less than half the time. That is the
// scoring dial. His feet belong to a human's stick when one drives him.
// ---------------------------------------------------------------------------
function keeperPlay(ctx: Ctx, match: MatchRow, lobby: LobbyRow | null | undefined, keeper: PlayerRow, ball: BallRow): void {
  const lvl = KEEPER_LEVELS[clamp(lobby?.botLevel ?? 1, 0, KEEPER_LEVELS.length - 1)];
  const gs = sideSign(keeper.side);
  const lineY = gs * (PITCH_HALF_LEN - KEEPER_LINE);
  const st = charStat(keeper.characterId);

  // ---- holding: pinned, then thrown out ----
  if (keeper.holdTicks > 0) {
    const left = keeper.holdTicks - 1;
    ctx.db.player.identity.update({ ...keeper, holdTicks: left, mvX: 0, mvY: 0 });
    if (left > 0) {
      ctx.db.ball.matchId.update({
        ...ball, active: true, x: keeper.x + (ball.x > keeper.x ? 0.6 : -0.6), y: keeper.y - gs * 1.2, z: 2.6,
        vx: 0, vy: 0, vz: 0, hasOwner: true, ownerId: keeper.identity,
        lastTouchSide: keeper.side, lastTouchId: keeper.identity, fromKick: false,
      });
      return;
    }
    const players = matchPlayers(ctx, match.id);
    const mates = outfielders(players, keeper.side);
    const foes = outfielders(players, 1 - keeper.side);
    const target = pickPassTarget(keeper, mates, foes, 0, attackSign(keeper.side), KEEPER_THROW_RANGE);
    const released = { ...ball, x: keeper.x, y: keeper.y, z: 1.4, hasOwner: false, ownerId: ZERO_ID };
    if (target) {
      const aim = leadTarget(released, target, 48);
      kickBall(ctx, match, released, keeper, KICK_NORMAL, 48, aim.x - keeper.x, aim.y - keeper.y, 4);
    } else {
      const flank = (hash01(match.clockTicks) > 0.5 ? 1 : -1) * 16;
      kickBall(ctx, match, released, keeper, KICK_CHIP, 60, flank, -gs * 60, 22);
    }
    clearGrace(ctx, match, keeper.side);
    return;
  }

  // ---- catching / saving ----
  const d = dist(ball.x, ball.y, keeper.x, keeper.y);
  const inOwnBox = Math.abs(ball.x) < BOX_HALF_W && Math.abs(ball.y - gs * PITCH_HALF_LEN) < BOX_DEPTH;
  const justReleased = sameId(ball.lastTouchId, keeper.identity);
  const ourRestart = match.graceTicks > 0 && match.restartSide === keeper.side;
  const airborne = keeper.diveTicks > 0;
  const reach = KEEPER_CLEAR_RADIUS * (airborne ? DIVE_REACH : 1);
  // A ball his OWN side has just kicked away from goal is not his to grab —
  // he was snatching goal kicks off the taker's boot as they left.
  const outgoingOwn = ball.lastTouchSide === keeper.side && ball.vy * gs < -12;
  if (ball.active && !justReleased && !ourRestart && !outgoingOwn && d < reach && ball.z < (airborne ? GOAL_HEIGHT : 6) && mayTouch(match, keeper.side)) {
    const hot = Math.hypot(ball.vx, ball.vy) > TAKE_MAX_SPEED;
    // a hot shot straight at him is a SAVE; one to the corner needs the dive
    // to have been the right call — the dice were rolled when he committed
    if (inOwnBox) {
      const hold = keeper.ctrlSeat !== CTRL_NONE ? KEEPER_HOLD_HUMAN : KEEPER_HOLD;
      ctx.db.player.identity.update({ ...keeper, holdTicks: hold, mvX: 0, mvY: 0, diveTicks: 0 });
      ctx.db.ball.matchId.update({
        ...ball, active: true, x: keeper.x, y: keeper.y - gs * 1.2, z: 2.6, vx: 0, vy: 0, vz: 0,
        hasOwner: true, ownerId: keeper.identity, lastTouchSide: keeper.side, lastTouchId: keeper.identity,
        lockTicks: 0, fromKick: false,
      });
      clearGrace(ctx, match, keeper.side);
      return;
    }
    if (!hot) {
      // outside his box he is just feet: hoof it clear
      kickBall(ctx, match, ball, keeper, KICK_CHIP, 60, (ball.x >= 0 ? 1 : -1) * 16, -gs * 60, 22);
      clearGrace(ctx, match, keeper.side);
      return;
    }
  }

  // ---- his feet: a human's stick, or the line-keeping AI ----
  if (keeper.ctrlSeat !== CTRL_NONE) return;

  let targetX = clamp(ball.x * 0.5, -KEEPER_MAX_X, KEEPER_MAX_X);
  let targetY = lineY;
  const tToLine = ball.active && Math.abs(ball.vy) > 0.01 ? (lineY - ball.y) / ball.vy : -1;
  const incoming = ball.active && ball.vy * gs > 12 && tToLine > 0 && tToLine < 0.45;
  let diveTicks = keeper.diveTicks, diveDirX = keeper.diveDirX, diveDirY = keeper.diveDirY;
  if (incoming) {
    const crossX = clamp(ball.x + ball.vx * tToLine, -KEEPER_MAX_X, KEEPER_MAX_X);
    const gap = crossX - keeper.x;
    if (Math.abs(gap) <= lvl.reflex) {
      targetX = crossX; // in reflex range: he simply gets there
    } else if (diveTicks === 0) {
      // out of reach: DIVE — and whether it comes off was decided now, by
      // the level's dive rate, seeded on this shot so it is one roll
      const roll = hash01(Math.round(ball.vx) * 3.7 + Math.round(ball.vy) * 1.9 + match.clockTicks);
      const commitX = roll < lvl.dive ? crossX : keeper.x + Math.sign(gap) * lvl.reflex * 0.6;
      const dx = commitX - keeper.x, dy = lineY - keeper.y;
      const g = Math.hypot(dx, dy) || 1;
      diveTicks = DIVE_TICKS; diveDirX = dx / g; diveDirY = dy / g;
    }
  } else if (
    !ball.hasOwner && inOwnBox && match.graceTicks === 0 &&
    !matchPlayers(ctx, match.id).some(
      q => q.side === keeper.side && q.role === ROLE_OUTFIELD && !q.sentOff && dist(q.x, q.y, ball.x, ball.y) < d
    )
  ) {
    // a loose ball in his box that HE is nearest to: come and get it
    targetX = clamp(ball.x, -BOX_HALF_W + 2, BOX_HALF_W - 2);
    targetY = gs * (PITCH_HALF_LEN - Math.min(KEEPER_RANGE_Y - 1, Math.abs(gs * PITCH_HALF_LEN - ball.y)));
  }
  const diving = diveTicks > 0;
  if (diving) diveTicks -= 1;
  const speed = diving ? DIVE_SPEED * lvl.speed : KEEPER_SPEED * lvl.speed * (incoming ? 1.6 : 1);
  const dx = diving ? diveDirX : targetX - keeper.x;
  const dy = diving ? diveDirY : targetY - keeper.y;
  const len = Math.hypot(dx, dy);
  const step = diving ? speed * DT : Math.min(len, speed * DT);
  const nx = len > 0.01 ? keeper.x + (dx / len) * step : keeper.x;
  const ny = len > 0.01 ? keeper.y + (dy / len) * step : keeper.y;
  const vScale = PLAYER_SPEED * st.speed;
  const moved = len > 0.01 ? step / DT : 0;
  ctx.db.player.identity.update({
    ...keeper,
    x: clamp(nx, -KEEPER_MAX_X, KEEPER_MAX_X),
    y: gs > 0 ? clamp(ny, PITCH_HALF_LEN - KEEPER_RANGE_Y, PITCH_HALF_LEN - 0.5) : clamp(ny, -(PITCH_HALF_LEN - 0.5), -(PITCH_HALF_LEN - KEEPER_RANGE_Y)),
    velX: len > 0.01 ? ((dx / len) * moved) / vScale : 0,
    velY: len > 0.01 ? ((dy / len) * moved) / vScale : 0,
    diveTicks, diveDirX, diveDirY,
    dirX: Math.abs(dx) > 0.7 ? Math.sign(dx) : 0,
    dirY: Math.abs(dy) > 0.7 ? Math.sign(dy) : 0,
  });
}

// ---------------------------------------------------------------------------
// CONTROL: the seat token. bindPilot is the ONLY writer.
// ---------------------------------------------------------------------------
export function controlledBody(ctx: Ctx, me: PlayerRow): PlayerRow {
  if (me.matchId === 0n) return me;
  for (const b of ctx.db.player.byMatch.filter(me.matchId)) {
    if (b.side === me.side && b.ctrlSeat === me.teamSlot) return b; // ANY body, keeper included
  }
  const mine = ctx.db.player.identity.find(me.identity);
  if (mine && mine.sentOff) {
    let alt: PlayerRow | null = null;
    for (const b of ctx.db.player.byMatch.filter(me.matchId)) {
      if (b.side !== me.side || b.spectator || b.sentOff || b.ctrlSeat !== CTRL_NONE || b.role !== ROLE_OUTFIELD) continue;
      if (!alt || b.teamSlot < alt.teamSlot) alt = b;
    }
    return alt ? ctx.db.player.identity.update({ ...alt, ctrlSeat: me.teamSlot }) : mine;
  }
  if (!mine || mine.role !== ROLE_OUTFIELD || mine.sentOff) return me;
  return ctx.db.player.identity.update({ ...mine, ctrlSeat: mine.teamSlot }); // stamp, never merely return
}

export function bindPilot(ctx: Ctx, me: PlayerRow, from: PlayerRow, to: PlayerRow, lock: number, why = '?'): void {
  if (sameId(from.identity, to.identity)) return;
  const oldBody = ctx.db.player.identity.find(from.identity);
  const target = ctx.db.player.identity.find(to.identity);
  if (!target || target.sentOff) return;
  if (oldBody && oldBody.ctrlSeat === me.teamSlot) {
    ctx.db.player.identity.update({ ...oldBody, ctrlSeat: CTRL_NONE, sprinting: false, kickHeld: false, kickTicks: 0 });
  }
  ctx.db.player.identity.update({
    ...target, ctrlSeat: me.teamSlot, switchLock: lock,
    dirX: oldBody?.dirX ?? target.dirX, dirY: oldBody?.dirY ?? target.dirY,
    mvX: oldBody?.dirX ?? target.mvX, mvY: oldBody?.dirY ?? target.mvY,
    sprinting: oldBody?.sprinting ?? false,
    holdTicks: target.role === ROLE_KEEPER && target.holdTicks > 0 ? KEEPER_HOLD_HUMAN : target.holdTicks,
  });
}

function switchCandidates(ctx: Ctx, me: PlayerRow, cur: PlayerRow): PlayerRow[] {
  return matchPlayers(ctx, me.matchId).filter(
    b => b.side === me.side && !b.spectator && !b.sentOff && b.slideTicks === 0 &&
      b.ctrlSeat === CTRL_NONE && !sameId(b.identity, cur.identity)
  );
}

export function switchPilot(ctx: Ctx, me: PlayerRow): void {
  const cur = controlledBody(ctx, me);
  if (cur.switchLock > 0) return;
  const ball = ctx.db.ball.matchId.find(me.matchId);
  const cands = switchCandidates(ctx, me, cur)
    .map(b => ({ b, d: ball ? dist(b.x, b.y, ball.x, ball.y) : 0 }))
    .sort((a, c) => a.d - c.d);
  if (cands.length === 0) return;
  const idx = cur.switchIdx % cands.length;
  const fresh = ctx.db.player.identity.find(me.identity);
  if (!fresh) return;
  bindPilot(ctx, fresh, cur, cands[idx].b, SWITCH_LOCK);
  const stamped = ctx.db.player.identity.find(cands[idx].b.identity);
  if (stamped) ctx.db.player.identity.update({ ...stamped, switchIdx: (idx + 1) % 250 });
}

/** Control follows the ball: your pass, a keeper's catch, the nearest man. */
function autoSwitch(ctx: Ctx, match: MatchRow, ball: BallRow | null | undefined): void {
  if (!ball || match.graceTicks > 0) return;
  const players = matchPlayers(ctx, match.id);
  const humans = players.filter(p => !p.isBot && !p.spectator && p.matchId === match.id);
  for (const person of humans) {
    const fresh = ctx.db.player.identity.find(person.identity);
    if (!fresh) continue;
    const cur = controlledBody(ctx, fresh);
    // your keeper caught it: the gloves are yours
    const holder = players.find(q => q.side === fresh.side && q.role === ROLE_KEEPER && q.holdTicks > 0);
    if (holder && !sameId(cur.identity, holder.identity) && holder.ctrlSeat === CTRL_NONE) {
      bindPilot(ctx, fresh, cur, holder, AUTO_LOCK, 'keeper-caught');
      continue;
    }
    if (cur.switchLock > 0) continue;
    if (cur.role === ROLE_KEEPER && cur.holdTicks > 0) continue;
    if (cur.role === ROLE_KEEPER) {
      // he has let it go: the stick goes back out to the pitch, always —
      // a human left on the keeper walked him to midfield with the ball gone
      const back = switchCandidates(ctx, fresh, cur).filter(b => b.role === ROLE_OUTFIELD)
        .map(b => ({ b, d: dist(b.x, b.y, ball.x, ball.y) })).sort((a, c) => a.d - c.d)[0];
      if (back) bindPilot(ctx, fresh, cur, back.b, AUTO_LOCK, 'keeper-released');
      continue;
    }
    // YOUR OWN PASS: the stick goes with it
    if (!ball.hasOwner && sameId(ball.lastTouchId, cur.identity) && Math.hypot(ball.vx, ball.vy) > 10) {
      let best: PlayerRow | null = null, bestT = Infinity;
      for (const b of switchCandidates(ctx, fresh, cur)) {
        if (b.role !== ROLE_OUTFIELD) continue;
        const t = interceptPoint(b.x, b.y, PLAYER_SPEED * charStat(b.characterId).speed * SPRINT_MUL, ball).t;
        if (t < bestT) { bestT = t; best = b; }
      }
      if (best && bestT < 1.6) bindPilot(ctx, fresh, cur, best, AUTO_LOCK, 'pass-follow');
      continue;
    }
    const owner = ball.hasOwner ? players.find(p => sameId(p.identity, ball.ownerId)) : undefined;
    // THE MAN WITH THE BALL IS YOUR MAN. Whoever on your side has it —
    // a team-mate who won a tackle, picked up a loose ball, took a throw —
    // your stick goes to him, always. Arcade football has one rule for who
    // you control in possession: the carrier. (With more than one human a
    // side, the carrier goes to whoever is nearest him; a human already on
    // a body is never displaced by another human.)
    if (owner && owner.side === fresh.side) {
      if (sameId(owner.identity, cur.identity)) continue; // already him
      if (owner.ctrlSeat !== CTRL_NONE) continue; // another human has him
      if (owner.role !== ROLE_OUTFIELD) continue; // the keeper rule above owns that case
      const rivals = humans.filter(h => h.side === fresh.side && !sameId(h.identity, fresh.identity));
      const myD = dist(cur.x, cur.y, owner.x, owner.y);
      const nearer = rivals.some(h => {
        const hb = controlledBody(ctx, h);
        return hb.switchLock === 0 && dist(hb.x, hb.y, owner.x, owner.y) < myD;
      });
      if (!nearer) bindPilot(ctx, fresh, cur, owner, AUTO_LOCK);
      continue;
    }
    // the ball is theirs or loose and my man is nowhere near it
    const leadX = ball.x + ball.vx * 0.2, leadY = ball.y + ball.vy * 0.2;
    const curD = dist(cur.x, cur.y, leadX, leadY);
    if (match.clockTicks % 15 === 0)    if (curD < AUTO_SWITCH_RANGE + AUTO_SWITCH_MARGIN) continue;
    const best = switchCandidates(ctx, fresh, cur)
      .map(b => ({ b, d: dist(b.x, b.y, leadX, leadY) })).sort((a, c) => a.d - c.d)[0];
    if (best && best.d < AUTO_SWITCH_RANGE && best.d < curD - AUTO_SWITCH_MARGIN) {
      bindPilot(ctx, fresh, cur, best.b, AUTO_LOCK, 'far');
    }
  }
}

// ---------------------------------------------------------------------------
// THE TEAM: a FORMATION BLOCK that slides with the ball. Each man has a home
// in the shape; the whole block steps toward the ball and up or down the
// pitch with possession. One man presses. In possession the two off the
// ball push into their lanes ahead of the carrier so a pass always has
// somewhere to go. That is the entire tactical model, and from above it
// reads as a team.
// ---------------------------------------------------------------------------
const FORMATION = [
  { name: 'ST', ax: 0.0, ay: 0.36 },
  { name: 'LW', ax: -0.52, ay: -0.12 },
  { name: 'RW', ax: 0.52, ay: -0.12 },
];
export const posOf = (slot: number) => clamp(slot, 0, OUTFIELD_PER_SIDE - 1);
export const positionName = (slot: number) => FORMATION[posOf(slot)].name;
export const BOT_LEVEL_COUNT = BOT_LEVELS.length;
export const HALF_TICKS = ticks(HALF_SECONDS);
const OT_TICKS = ticks(OT_SECONDS);

interface Job { x: number; y: number; sprint: boolean; atBall?: boolean }
type Plan = Map<string, Job>;

/** The block: home + ball follow + possession push. */
function blockSpot(side: number, slot: number, ball: BallRow, weOwn: boolean): { x: number; y: number } {
  const up = attackSign(side);
  const f = FORMATION[posOf(slot)];
  const push = up * (weOwn ? BLOCK_PUSH_ATTACK : -BLOCK_DROP_DEFEND);
  return {
    x: clamp(f.ax * PITCH_HALF_WID * 0.85 + ball.x * BLOCK_FOLLOW_X, -(PITCH_HALF_WID - 3), PITCH_HALF_WID - 3),
    y: clamp(up * f.ay * PITCH_HALF_LEN + ball.y * BLOCK_FOLLOW_Y + push, -(PITCH_HALF_LEN - 5), PITCH_HALF_LEN - 6),
  };
}

function electPresser(match: MatchRow, side: number, men: PlayerRow[], ball: BallRow): { slot: number; match: MatchRow } {
  const cost = (p: PlayerRow) => dist(ball.x + ball.vx * 0.2, ball.y + ball.vy * 0.2, p.x, p.y) / (PLAYER_SPEED * charStat(p.characterId).speed);
  let best: PlayerRow | null = null;
  for (const m of men) if (m.slideTicks === 0 && (!best || cost(m) < cost(best))) best = m;
  if (!best) return { slot: 255, match };
  const curSlot = side === 0 ? match.presser0 : match.presser1;
  const inc = men.find(m => m.teamSlot === curSlot && m.slideTicks === 0);
  const winner = inc && cost(inc) < cost(best) * PRESS_HYSTERESIS ? inc : best;
  if (winner.teamSlot !== curSlot) {
    match = side === 0 ? { ...match, presser0: winner.teamSlot } : { ...match, presser1: winner.teamSlot };
  }
  return { slot: winner.teamSlot, match };
}

function teamPlan(match: MatchRow, side: number, men: PlayerRow[], all: PlayerRow[], ball: BallRow, presserSlot: number, heldBySide: number): Plan {
  const plan: Plan = new Map();
  const up = attackSign(side);
  const myGoalY = sideSign(side) * PITCH_HALF_LEN;
  const put = (p: PlayerRow, x: number, y: number, sprint = false, atBall = false) =>
    plan.set(p.identity.toHexString(), {
      x: clamp(x, -(PITCH_HALF_WID - 3), PITCH_HALF_WID - 3),
      y: clamp(y, -(PITCH_HALF_LEN - 4), PITCH_HALF_LEN - 4), sprint, atBall,
    });
  const carrier = ball.hasOwner ? all.find(p => sameId(p.identity, ball.ownerId)) : undefined;
  const weOwn = carrier?.side === side;

  // ---- set piece ----
  if (match.graceTicks > 0) {
    if (match.restartSide === side) {
      const taker = men.reduce((a, b) => dist(a.x, a.y, match.restartX, match.restartY) < dist(b.x, b.y, match.restartX, match.restartY) ? a : b);
      for (const m of men) {
        if (sameId(m.identity, taker.identity)) put(m, match.restartX, match.restartY, false, true);
        else {
          const short = m.teamSlot % 2 === 0;
          const reach = short ? OPTION_SHORT : OPTION_LONG;
          const flank = m.teamSlot % 2 === 0 ? -1 : 1;
          put(m, match.restartX + flank * reach * 0.55, match.restartY + up * reach, true);
        }
      }
    } else {
      for (const m of men) {
        const away = dist(m.x, m.y, match.restartX, match.restartY) || 1;
        put(m, match.restartX + ((m.x - match.restartX) / away) * RESTART_RETREAT,
          (match.restartY + ((m.y - match.restartY) / away) * RESTART_RETREAT) * 0.6 + myGoalY * 0.4, true);
      }
    }
    return plan;
  }
  // ---- a keeper holding ----
  if (heldBySide === side) {
    for (const m of men) put(m, (m.teamSlot % 2 === 0 ? -1 : 1) * (PITCH_HALF_WID - 9), myGoalY - sideSign(side) * (BOX_DEPTH + 8), true);
    return plan;
  }
  if (heldBySide >= 0) {
    for (const m of men) { const b = blockSpot(side, m.teamSlot, ball, false); put(m, b.x, b.y); }
    return plan;
  }
  // ---- in possession: the block steps up; the two off the ball run their lanes ----
  if (weOwn && carrier) {
    for (const m of men) {
      if (sameId(m.identity, carrier.identity)) { put(m, m.x, m.y); continue; }
      const b = blockSpot(side, m.teamSlot, ball, true);
      // ahead of the ball, in your lane: always a forward option
      put(m, b.x, Math.max(b.y * up, (carrier.y + up * 10) * up) * up, true);
    }
    return plan;
  }
  // ---- out of possession: one presser, the block holds and drops ----
  for (const m of men) {
    if (m.teamSlot === presserSlot) {
      put(m, ball.x + ball.vx * 0.25, ball.y + ball.vy * 0.25, true, true);
    } else {
      const b = blockSpot(side, m.teamSlot, ball, false);
      put(m, b.x, b.y, dist(m.x, m.y, b.x, b.y) > 12);
    }
  }
  return plan;
}

function steerBot(ctx: Ctx, bot: PlayerRow, job: Job): void {
  const fresh = ctx.db.player.identity.find(bot.identity);
  if (!fresh) return;
  const dx = job.x - fresh.x, dy = job.y - fresh.y;
  const d = Math.hypot(dx, dy);
  const mvX = d > 1.0 ? dx / d : 0, mvY = d > 1.0 ? dy / d : 0;
  ctx.db.player.identity.update({
    ...fresh, mvX, mvY,
    dirX: Math.abs(mvX) > 0.35 ? Math.sign(mvX) : 0,
    dirY: Math.abs(mvY) > 0.35 ? Math.sign(mvY) : 0,
    sprinting: job.sprint && d > 5 && fresh.stamina > 200,
  });
}

/** Structural rules over any plan: spacing and the second-man rule. */
function applyShapeRules(job: Job, bot: PlayerRow, ball: BallRow, mates: PlayerRow[]): Job {
  let { x, y } = job;
  let nm: PlayerRow | null = null, nd = AI_SEPARATION;
  for (const m of mates) { const d = dist(m.x, m.y, bot.x, bot.y); if (d < nd) { nd = d; nm = m; } }
  if (nm && nd > 0.01) { const push = (AI_SEPARATION - nd) * 0.8; x += ((bot.x - nm.x) / nd) * push; y += ((bot.y - nm.y) / nd) * push; }
  if (!job.atBall) {
    const bd = dist(x, y, ball.x, ball.y);
    if (bd < AI_PRESS_BUBBLE && bd > 0.01) { x = ball.x + ((x - ball.x) / bd) * AI_PRESS_BUBBLE; y = ball.y + ((y - ball.y) / bd) * AI_PRESS_BUBBLE; }
  }
  return { ...job, x, y };
}

// ---------------------------------------------------------------------------
// THE MAN ON THE BALL (bot): shoot if there is any sight of goal, otherwise
// pass to the best lane, otherwise run at goal. Arcade bots SHOOT.
// ---------------------------------------------------------------------------
function botOnBall(ctx: Ctx, match: MatchRow, lobby: LobbyRow | null | undefined, bot: PlayerRow, ball: BallRow, mates: PlayerRow[], foes: PlayerRow[]): void {
  const lvl = BOT_LEVELS[clamp(lobby?.botLevel ?? 1, 0, BOT_LEVELS.length - 1)];
  const up = attackSign(bot.side);
  const goalY = up * PITCH_HALF_LEN;
  const goalDist = Math.hypot(ball.x, goalY - ball.y);
  const nearestFoe = foes.reduce((d, o) => Math.min(d, dist(o.x, o.y, bot.x, bot.y)), 99);

  if (goalDist < SHOOT_RANGE) {
    const first = hash01(match.clockTicks * 0.9 + bot.teamSlot) < 0.5 ? -1 : 1;
    let corner = 0;
    for (const c of [first, -first]) {
      const cx = c * (GOAL_HALF_W - 1.5);
      if (laneClear(ball.x, ball.y, cx, goalY, foes, 1.1)) { corner = cx; break; }
    }
    if (corner === 0 && goalDist < 18) corner = first * (GOAL_HALF_W - 1.5);
    if (corner !== 0) {
      kickBall(ctx, match, ball, bot, KICK_NORMAL, shotSpeedFor(ball, bot.side), corner - ball.x, goalY - ball.y, 5, lvl.shootErr);
      return;
    }
  }
  let best: PlayerRow | null = null, bestScore = 4;
  for (const m of mates) {
    if (m.role !== ROLE_OUTFIELD) continue;
    const d = dist(m.x, m.y, bot.x, bot.y);
    if (d < 7 || d > AI_PASS_MAX) continue;
    if (!laneClear(ball.x, ball.y, m.x, m.y, foes, 2.0)) continue;
    const open = foes.reduce((a, o) => Math.min(a, dist(o.x, o.y, m.x, m.y)), 99);
    let score = (m.y - bot.y) * up * 0.7 + Math.min(open, 16) * 1.2 - d * 0.15;
    if (Math.abs(m.y - sideSign(bot.side) * PITCH_HALF_LEN) < 22) score -= 25; // not into our own box
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (best && (nearestFoe < 6 || bestScore > 12)) {
    const d = dist(best.x, best.y, bot.x, bot.y);
    const aim = leadTarget(ball, best, passSpeedFor(d));
    const backward = (best.y - bot.y) * up < 0;
    kickBall(ctx, match, ball, bot, KICK_NORMAL, backward ? PASS_SPEED_MIN : passSpeedFor(d), aim.x - ball.x, aim.y - ball.y, 2, lvl.shootErr * 0.6);
    return;
  }
  // run at goal, bending away from the nearest defender
  let cx = clamp(ball.x * 0.6, -PITCH_HALF_WID + 6, PITCH_HALF_WID - 6);
  const closest = foes.reduce((a: PlayerRow | null, o) => !a || dist(o.x, o.y, bot.x, bot.y) < dist(a.x, a.y, bot.x, bot.y) ? o : a, null);
  if (closest && dist(closest.x, closest.y, bot.x, bot.y) < 10) cx = clamp(cx - Math.sign(closest.x - bot.x) * 9, -PITCH_HALF_WID + 6, PITCH_HALF_WID - 6);
  steerBot(ctx, bot, { x: cx, y: goalY, sprint: true, atBall: true });
}

/** A standing tackle on the carrier: wins the ball or leaves you stunned. */
function attemptTackle(ctx: Ctx, match: MatchRow, tackler: PlayerRow, ball: BallRow, carrier: PlayerRow, winChance: number): MatchRow {
  const roll = hash01(match.clockTicks * 1.7 + tackler.teamSlot * 3.3 + Number(match.id % 991n));
  if (roll < winChance * charStat(tackler.characterId).tackle) {
    // WON: the ball is the tackler's, at his feet — arcade, not a scramble
    ctx.db.ball.matchId.update({
      ...ball, vx: 0, vy: 0, vz: 0, z: 0, hasOwner: true, ownerId: tackler.identity,
      lastTouchSide: tackler.side, lastTouchId: tackler.identity, lockTicks: 0, fromKick: false,
    });
    ctx.db.player.identity.update({ ...tackler, kickTicks: TACKLE_COOLDOWN });
    return clearGrace(ctx, match, tackler.side);
  }
  // MISSED: flat-footed for a beat — this is what makes a dodge a dodge
  ctx.db.player.identity.update({ ...tackler, kickTicks: TACKLE_STUN, mvX: 0, mvY: 0, velX: 0, velY: 0 });
  return match;
}

function botPlay(ctx: Ctx, match: MatchRow, lobby: LobbyRow | null | undefined, botIn: PlayerRow, ball: BallRow, plan: Plan, mates: PlayerRow[], foes: PlayerRow[], heldBySide: number): MatchRow {
  const lvl = BOT_LEVELS[clamp(lobby?.botLevel ?? 1, 0, BOT_LEVELS.length - 1)];
  let bot = botIn;
  if (bot.kickTicks > 0) {
    const owns = ball.hasOwner && sameId(ball.ownerId, bot.identity);
    ctx.db.player.identity.update({ ...bot, kickTicks: bot.kickTicks - 1, ...(owns ? {} : { mvX: 0, mvY: 0 }) });
    if (owns) {
      // settling: run with it toward goal, away from the nearest defender
      const up = attackSign(bot.side);
      const closest = foes.reduce((a: PlayerRow | null, o) => !a || dist(o.x, o.y, bot.x, bot.y) < dist(a.x, a.y, bot.x, bot.y) ? o : a, null);
      let cx = clamp(ball.x * 0.6, -PITCH_HALF_WID + 6, PITCH_HALF_WID - 6);
      if (closest && dist(closest.x, closest.y, bot.x, bot.y) < 10) cx = clamp(cx - Math.sign(closest.x - bot.x) * 9, -PITCH_HALF_WID + 6, PITCH_HALF_WID - 6);
      steerBot(ctx, bot, { x: cx, y: up * PITCH_HALF_LEN, sprint: false, atBall: true });
    }
    return match;
  }
  if (ball.hasOwner && sameId(ball.ownerId, bot.identity)) {
    botOnBall(ctx, match, lobby, bot, ball, mates, foes);
    return match;
  }
  // take the restart
  if (match.graceTicks > 0 && match.restartSide === bot.side && match.phase === PHASE_LIVE &&
      dist(ball.x, ball.y, bot.x, bot.y) < KICK_RANGE && match.graceTicks < RESTART_GRACE - AI_RESTART_DELAY) {
    if (plan.get(bot.identity.toHexString())?.atBall) {
      const up = attackSign(bot.side);
      const kind = match.restartKind;
      const pick = pickPassTarget(bot, mates, foes, 0, up, kind === RK_CORNER ? PITCH_HALF_LEN : PITCH_HALF_LEN * 0.7);
      const aim = pick ? leadTarget(ball, pick, 46) : null;
      if (kind === RK_PENALTY) {
        const a = shotAim(bot, ball, hash01(match.clockTicks) < 0.5 ? -1 : 1);
        kickBall(ctx, match, ball, bot, KICK_NORMAL, SHOT_SPEED_MAX, a.x, a.y, 3, lvl.shootErr);
      } else if (kind === RK_CORNER) {
        kickBall(ctx, match, ball, bot, KICK_CHIP, LOB_SPEED, aim ? aim.x - ball.x : -ball.x, aim ? aim.y - ball.y : up * PITCH_HALF_LEN - ball.y, 20, lvl.shootErr * 0.6);
      } else {
        kickBall(ctx, match, ball, bot, KICK_NORMAL, 46, aim ? aim.x - ball.x : 0, aim ? aim.y - ball.y : up * 18, 2, lvl.shootErr * 0.6);
      }
      return clearGrace(ctx, match, bot.side);
    }
  }
  // meet a pass
  const ballSpeed = Math.hypot(ball.vx, ball.vy);
  // YOU DO NOT CHASE YOUR OWN PASS. The kicker (turned bot the moment the
  // human's stick followed the ball to the receiver) was sprinting after
  // the ball he had just played and re-collecting it.
  if (!ball.hasOwner && ballSpeed > 6 && heldBySide < 0 && match.graceTicks === 0 &&
      ball.lastTouchSide === bot.side && !sameId(ball.lastTouchId, bot.identity) && ball.z < TAKE_MAX_Z + 3) {
    const sp = (p: PlayerRow) => PLAYER_SPEED * charStat(p.characterId).speed * SPRINT_MUL;
    const mine = interceptPoint(bot.x, bot.y, sp(bot), ball);
    let bestT = mine.t;
    for (const m of mates) { if (m.role !== ROLE_OUTFIELD) continue; const t = interceptPoint(m.x, m.y, sp(m), ball).t; if (t < bestT) bestT = t; }
    if (mine.t <= bestT) { steerBot(ctx, bot, { x: mine.x, y: mine.y, sprint: true, atBall: true }); return match; }
  }
  // TACKLE the carrier: wind up in range first, then roll; a miss costs a stun
  const carrier = ball.hasOwner ? foes.find(f => sameId(f.identity, ball.ownerId)) : undefined;
  const inRange = !!carrier && mayTouch(match, bot.side) && dist(ball.x, ball.y, bot.x, bot.y) < TACKLE_RANGE;
  const armed = bot.kickKind >= 2 ? bot.kickKind - 2 : 0;
  if (inRange && carrier) {
    if (armed < TACKLE_ARM) {
      ctx.db.player.identity.update({ ...bot, kickKind: armed + 3 });
      bot = ctx.db.player.identity.find(bot.identity)!;
    } else if (hash01(bot.teamSlot * 11.7 + match.clockTicks * 0.31) < lvl.tackleChance * 4) {
      ctx.db.player.identity.update({ ...bot, kickKind: 0 });
      bot = ctx.db.player.identity.find(bot.identity)!;
      return attemptTackle(ctx, match, bot, ball, carrier, lvl.tackleWin);
    }
  } else if (bot.kickKind >= 2) {
    ctx.db.player.identity.update({ ...bot, kickKind: 0 });
    bot = ctx.db.player.identity.find(bot.identity)!;
  }
  // the slide: only when the ball is loose-ish and worth it
  if (carrier && mayTouch(match, bot.side) && bot.slideTicks === 0 && bot.stamina >= SLIDE_COST &&
      dist(ball.x, ball.y, bot.x, bot.y) < 6 && dist(ball.x, ball.y, bot.x, bot.y) > TACKLE_RANGE &&
      hash01(bot.teamSlot * 5.1 + match.clockTicks * 0.17) < lvl.tackleChance * 0.25) {
    const l = dist(ball.x, ball.y, bot.x, bot.y) || 1;
    ctx.db.player.identity.update({ ...bot, slideTicks: SLIDE_TOTAL, slideDirX: (ball.x - bot.x) / l, slideDirY: (ball.y - bot.y) / l, stamina: Math.max(0, bot.stamina - SLIDE_COST) });
    return match;
  }
  const job = plan.get(bot.identity.toHexString());
  if (job) steerBot(ctx, bot, applyShapeRules(job, bot, ball, mates));
  return match;
}

// ---------------------------------------------------------------------------
// THE THREE BUTTONS, resolved by context. Every action is one press.
//   on the ball      pass · lob · shoot
//   chasing          tackle · slide · switch
//   keeper holding   throw · long ball · put it down
//   set piece        take · high · short   (penalty: shoot · chip · placed)
// ---------------------------------------------------------------------------
export function slideTackle(ctx: Ctx, me: PlayerRow, body: PlayerRow): void {
  if (body.slideTicks > 0 || body.stamina < SLIDE_COST) return;
  const mv = Math.hypot(body.mvX, body.mvY);
  const fx = mv > 0.01 ? body.mvX / mv : 0;
  const fy = mv > 0.01 ? body.mvY / mv : attackSign(body.side);
  ctx.db.player.identity.update({ ...body, slideTicks: SLIDE_TOTAL, slideDirX: fx, slideDirY: fy, stamina: Math.max(0, body.stamina - SLIDE_COST) });
}

export function footballAction(ctx: Ctx, me: PlayerRow, button: number): void {
  if (me.matchId === 0n || me.spectator) return;
  const match = ctx.db.match.id.find(me.matchId);
  if (!match || match.state !== 1) return;
  if (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF) return;
  const body = controlledBody(ctx, me);
  if (body.slideTicks > 0 || body.kickTicks > 0) return; // committed / stunned
  const ball = ctx.db.ball.matchId.find(match.id);
  if (!ball) return;
  const players = matchPlayers(ctx, me.matchId);
  const mates = onPitch(players, body.side).filter(p => !sameId(p.identity, body.identity));
  const foes = outfielders(players, 1 - body.side);
  const stickX = body.dirX, stickY = body.dirY;
  const atk = attackSign(body.side);

  // ---- keeper, ball in hand ----
  if (body.role === ROLE_KEEPER && body.holdTicks > 0) {
    if (button === ACT_THIRD) {
      ctx.db.player.identity.update({ ...body, holdTicks: 0 });
      ctx.db.ball.matchId.update({ ...ball, active: true, x: body.x, y: body.y + atk * 1.5, z: 0, vx: 0, vy: 0, vz: 0,
        hasOwner: true, ownerId: body.identity, lastTouchSide: body.side, lastTouchId: body.identity, lockTicks: 0, fromKick: false });
      return;
    }
    const long = button === ACT_SECOND;
    const target = pickPassTarget(body, mates, foes, stickX, stickY, long ? PITCH_HALF_LEN * 1.4 : KEEPER_THROW_RANGE);
    ctx.db.player.identity.update({ ...body, holdTicks: 0 });
    const released = { ...ball, x: body.x, y: body.y, z: 1.4, hasOwner: false, ownerId: ZERO_ID };
    const aim = target ? leadTarget(released, target, long ? 60 : 48) : null;
    kickBall(ctx, match, released, body, long ? KICK_CHIP : KICK_NORMAL, long ? 64 : 48,
      aim ? aim.x - body.x : stickX || 0, aim ? aim.y - body.y : stickY || atk, long ? 22 : 4);
    return;
  }

  const iHaveBall = ball.hasOwner && sameId(ball.ownerId, body.identity);
  const takingRestart = match.graceTicks > 0 && match.restartSide === body.side && dist(ball.x, ball.y, body.x, body.y) < KICK_RANGE + 2;

  // ---- set pieces ----
  if (takingRestart || (match.phase === PHASE_KICKOFF && body.side === match.kickoffSide)) {
    const kind = match.phase === PHASE_KICKOFF ? RK_KICKOFF : match.restartKind;
    if (kind === RK_KICKOFF) {
      // THE KICKOFF is a soft ball to the nearest team-mate — every one of
      // them is behind you by law, and driving it back at pace is how the
      // opening pass ended up loose in your own box.
      const near = mates.filter(m => m.role === ROLE_OUTFIELD)
        .sort((a, b) => dist(a.x, a.y, body.x, body.y) - dist(b.x, b.y, body.x, body.y))[0];
      const stickTarget = Math.hypot(stickX, stickY) > 0.01 ? pickPassTarget(body, mates, foes, stickX, stickY, PITCH_HALF_LEN * 0.8) : null;
      const t = stickTarget ?? near ?? null;
      kickBall(ctx, match, ball, body, KICK_NORMAL, PASS_SPEED_MIN, t ? t.x - ball.x : stickX || 0, t ? t.y - ball.y : stickY || atk, 2);
      ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, graceTicks: 0, pointMsg: '' });
      return;
    }
    if (kind === RK_PENALTY) {
      const a = shotAim(body, ball, stickX);
      kickBall(ctx, match, ball, body, button === ACT_SECOND ? KICK_CHIP : KICK_NORMAL,
        button === ACT_THIRD ? 60 : SHOT_SPEED_MAX, a.x, a.y, button === ACT_SECOND ? 14 : 3);
      clearGrace(ctx, match, body.side);
      return;
    }
    const short = button === ACT_THIRD, high = button === ACT_SECOND;
    const range = short ? 24 : kind === RK_CORNER ? PITCH_HALF_LEN : PITCH_HALF_LEN * 0.8;
    const target = pickPassTarget(body, mates, foes, stickX, stickY, range);
    const spd = short ? PASS_SPEED_MIN : high ? LOB_SPEED : target ? passSpeedFor(dist(target.x, target.y, ball.x, ball.y)) : 46;
    const aim = target ? leadTarget(ball, target, spd) : null;
    kickBall(ctx, match, ball, body, high || kind === RK_CORNER ? KICK_CHIP : KICK_NORMAL, spd,
      aim ? aim.x - ball.x : kind === RK_CORNER ? -ball.x : stickX || 0,
      aim ? aim.y - ball.y : kind === RK_CORNER ? atk * PITCH_HALF_LEN - ball.y : stickY || atk,
      high || kind === RK_CORNER ? 20 : 2);
    if (match.phase === PHASE_KICKOFF) ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, graceTicks: 0, pointMsg: '' });
    else clearGrace(ctx, match, body.side);
    return;
  }

  // ---- on the ball ----
  if (iHaveBall) {
    if (button === ACT_THIRD) {
      const a = shotAim(body, ball, stickX);
      kickBall(ctx, match, ball, body, KICK_NORMAL, shotSpeedFor(ball, body.side), a.x, a.y, 5);
      return;
    }
    const lob = button === ACT_SECOND;
    const target = pickPassTarget(body, mates, foes, stickX, stickY, lob ? PITCH_HALF_LEN : AI_PASS_MAX);
    const spd = lob ? LOB_SPEED : target ? passSpeedFor(dist(target.x, target.y, ball.x, ball.y)) : 46;
    const aim = target ? leadTarget(ball, target, spd) : null;
    kickBall(ctx, match, ball, body, lob ? KICK_CHIP : KICK_NORMAL, spd,
      aim ? aim.x - ball.x : stickX || 0, aim ? aim.y - ball.y : stickY || atk, lob ? 20 : 2);
    return;
  }

  // ---- chasing ----
  if (button === ACT_THIRD) { switchPilot(ctx, me); return; }
  if (button === ACT_SECOND) { slideTackle(ctx, me, body); return; }
  // TACKLE: on the carrier, rolled in your favour; a miss leaves you flat-footed
  const carrier = ball.hasOwner ? foes.find(f => sameId(f.identity, ball.ownerId)) : undefined;
  if (carrier && mayTouch(match, body.side) && dist(ball.x, ball.y, body.x, body.y) < TACKLE_RANGE) {
    attemptTackle(ctx, match, body, ball, carrier, 0.8);
    return;
  }
  // a loose ball just out of reach: a poke toward it
  const d = dist(ball.x, ball.y, body.x, body.y);
  if (!ball.hasOwner && d < TAKE_RADIUS * 2 && ball.z < TAKE_MAX_Z && mayTouch(match, body.side)) {
    const l = d || 1;
    ctx.db.ball.matchId.update({ ...ball, vx: ((ball.x - body.x) / l) * 14, vy: ((ball.y - body.y) / l) * 14, vz: 1,
      hasOwner: false, ownerId: ZERO_ID, lastTouchSide: body.side, lastTouchId: body.identity, lockTicks: KICK_LOCK, fromKick: false });
    clearGrace(ctx, match, body.side);
    return;
  }
  // nothing in range: a wasted tackle still costs a beat
  ctx.db.player.identity.update({ ...body, kickTicks: Math.round(TACKLE_STUN * 0.6) });
}

// ---------------------------------------------------------------------------
// SETUP, RESUME, and THE TICK.
// ---------------------------------------------------------------------------
export function kickoffSpot(side: number, pos: number, kickoffSide: number): { x: number; y: number } {
  const up = attackSign(side);
  if (side === kickoffSide && pos === 0) return { x: 0, y: -up * 2.5 };
  const f = FORMATION[posOf(pos)];
  return { x: f.ax * PITCH_HALF_WID * 0.8, y: -up * (Math.abs(f.ay) * PITCH_HALF_LEN * 0.6 + PITCH_HALF_LEN * 0.2) };
}
export function keeperSpot(side: number): { x: number; y: number } {
  return { x: 0, y: sideSign(side) * (PITCH_HALF_LEN - KEEPER_LINE) };
}

export function setupKickoff(ctx: Ctx, match: MatchRow, msg: string): MatchRow {
  for (const p of matchPlayers(ctx, match.id)) {
    const spot = p.role === ROLE_KEEPER ? keeperSpot(p.side) : kickoffSpot(p.side, posOf(p.teamSlot), match.kickoffSide);
    ctx.db.player.identity.update({
      ...p, x: spot.x, y: spot.y, dirX: 0, dirY: 0, mvX: 0, mvY: 0, velX: 0, velY: 0,
      kickTicks: 0, kickHeld: false, slideTicks: 0, holdTicks: 0, diveTicks: 0,
      ctrlSeat: !p.isBot && p.role === ROLE_OUTFIELD && !p.sentOff ? p.teamSlot : CTRL_NONE, switchLock: 0,
    });
  }
  const ball = ctx.db.ball.matchId.find(match.id);
  if (ball) ctx.db.ball.matchId.update({ ...ball, active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, hasOwner: false, ownerId: ZERO_ID, fromKick: false, lockTicks: 0 });
  const updated = { ...match, phase: PHASE_KICKOFF, restartKind: RK_NONE, restartSide: match.kickoffSide, graceTicks: 0, pauseTicks: 0, pointMsg: msg };
  ctx.db.match.id.update(updated);
  return updated;
}

function resumeFromPause(ctx: Ctx, match: MatchRow): void {
  switch (match.restartKind) {
    case RK_KICKOFF: setupKickoff(ctx, match, 'KICKOFF'); return;
    case RK_HALFTIME: setupKickoff(ctx, { ...match, half: 2, clockTicks: HALF_TICKS, kickoffSide: 1 }, 'SECOND HALF'); return;
    case RK_OVERTIME: setupKickoff(ctx, { ...match, half: 3, clockTicks: OT_TICKS, kickoffSide: hash01(Number(match.id % 9973n)) < 0.5 ? 0 : 1 }, 'GOLDEN GOAL — NEXT GOAL WINS'); return;
    case RK_THROWIN: case RK_GOALKICK: case RK_CORNER: case RK_FREEKICK: case RK_PENALTY: case RK_DROP: {
      const ball = ctx.db.ball.matchId.find(match.id);
      if (ball) ctx.db.ball.matchId.update({ ...ball, active: true, x: match.restartX, y: match.restartY,
        z: match.restartKind === RK_THROWIN ? 3.4 : 0, vx: 0, vy: 0, vz: 0, hasOwner: false, ownerId: ZERO_ID,
        lastTouchSide: match.restartSide, lockTicks: 0, fromKick: false });
      if (match.restartKind !== RK_DROP && match.restartKind !== RK_PENALTY) {
        const taker = restartTaker(ctx, match);
        if (taker) {
          const outX = Math.sign(match.restartX) || 1, outY = Math.sign(match.restartY) || 1;
          let tx = match.restartX, ty = match.restartY + sideSign(match.restartSide) * 2.2;
          if (match.restartKind === RK_THROWIN) { tx = outX * (PITCH_HALF_WID - 1.5); ty = match.restartY; }
          else if (match.restartKind === RK_CORNER) { tx = outX * (PITCH_HALF_WID - 1.5); ty = outY * (PITCH_HALF_LEN - 1.5); }
          ctx.db.player.identity.update({ ...taker, x: clamp(tx, -P_BOUNDS_X, P_BOUNDS_X), y: clamp(ty, -P_BOUNDS_Y, P_BOUNDS_Y),
            mvX: 0, mvY: 0, velX: 0, velY: 0, kickHeld: false, kickTicks: 0, slideTicks: 0 });
        }
      }
      if (match.restartKind === RK_PENALTY) {
        const defSign = -sideSign(match.restartSide);
        const taker = restartTaker(ctx, match);
        for (const p of matchPlayers(ctx, match.id)) {
          if (p.spectator || p.sentOff) continue;
          if (p.role === ROLE_KEEPER && p.side !== match.restartSide) { ctx.db.player.identity.update({ ...p, x: 0, y: defSign * (PITCH_HALF_LEN - 1), mvX: 0, mvY: 0, velX: 0, velY: 0, holdTicks: 0 }); continue; }
          if (taker && sameId(p.identity, taker.identity)) { ctx.db.player.identity.update({ ...p, x: 0, y: match.restartY + sideSign(match.restartSide) * 3, mvX: 0, mvY: 0, velX: 0, velY: 0 }); continue; }
          const lane = (p.teamSlot % 3) - 1;
          ctx.db.player.identity.update({ ...p, x: clamp(lane * 9 + (p.side === match.restartSide ? 2 : -2), -BOX_HALF_W, BOX_HALF_W), y: defSign * (PITCH_HALF_LEN - BOX_DEPTH - 4), mvX: 0, mvY: 0, velX: 0, velY: 0 });
        }
      }
      if (match.restartKind !== RK_DROP) {
        const awarded = match.restartSide;
        const taker = restartTaker(ctx, match);
        if (taker) {
          const person = matchPlayers(ctx, match.id).find(p => !p.isBot && !p.spectator && p.side === awarded && p.role === ROLE_OUTFIELD);
          if (person) bindPilot(ctx, person, controlledBody(ctx, person), taker, SWITCH_LOCK);
        }
      }
      ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, pauseTicks: 0, graceTicks: match.restartKind === RK_DROP ? 0 : RESTART_GRACE, pointMsg: '' });
      return;
    }
    default: ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, pauseTicks: 0 }); return;
  }
}

export function tickFootball(ctx: Ctx, match: MatchRow, lobby: LobbyRow | null | undefined, phys: Phys, hooks: MetaHooks): void {
  if (match.startTicks > 0) {
    const left = match.startTicks - 1;
    ctx.db.match.id.update({ ...match, startTicks: left });
    if (left === 0) hooks.countdownDone?.(ctx, match);
    return;
  }
  if (match.phase === PHASE_PAUSE) {
    if (match.pauseTicks > 1) { ctx.db.match.id.update({ ...match, pauseTicks: match.pauseTicks - 1 }); return; }
    resumeFromPause(ctx, match);
    return;
  }
  if (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF) return;
  let ball = ctx.db.ball.matchId.find(match.id);
  if (!ball) return;
  const players = matchPlayers(ctx, match.id);

  // ---- kickoff: the man in the circle gets the stick; a stand-in if nobody plays it ----
  if (match.phase === PHASE_KICKOFF && match.startTicks === 0) {
    match = { ...match, pauseTicks: Math.min(65000, match.pauseTicks + 1) };
    ctx.db.match.id.update(match);
    if (match.pauseTicks === 1) {
      const koSide = match.kickoffSide;
      const taker = players.find(p => p.side === koSide && p.role === ROLE_OUTFIELD && !p.spectator && !p.sentOff && p.teamSlot === 0);
      const person = players.find(p => !p.isBot && !p.spectator && p.side === koSide && p.role === ROLE_OUTFIELD);
      if (taker && person) bindPilot(ctx, person, controlledBody(ctx, person), taker, SWITCH_LOCK);
    }
  }

  // ---- possession memory (for the transition dial the client shows) ----
  const carrierNow = ball.hasOwner ? players.find(q => sameId(q.identity, ball!.ownerId)) : undefined;
  {
    const holder = carrierNow ? carrierNow.side : 255;
    if (holder !== 255 && holder !== match.possSide) { match = { ...match, possSide: holder, transTicks: match.possSide === 255 ? 0 : ticks(2) }; ctx.db.match.id.update(match); }
    else if (match.transTicks > 0) { match = { ...match, transTicks: match.transTicks - 1 }; ctx.db.match.id.update(match); }
  }

  // ---- the two brains ----
  const heldBy = players.find(p => p.role === ROLE_KEEPER && p.holdTicks > 0)?.side ?? -1;
  const plans: Plan[] = [];
  for (const side of [0, 1]) {
    const men = outfielders(players, side);
    const e = electPresser(match, side, men, ball);
    if (e.match !== match) { match = e.match; ctx.db.match.id.update(match); }
    plans.push(match.phase === PHASE_LIVE ? teamPlan(match, side, men, players, ball, e.slot, heldBy) : new Map());
  }

  // ---- movement ----
  for (const p of players) {
    if (p.spectator) continue;
    let cur = ctx.db.player.identity.find(p.identity);
    if (!cur) continue;
    if (cur.sentOff) {
      const off = sideSign(cur.side) * (PITCH_HALF_WID + 6);
      if (Math.abs(cur.x - off) > 0.5 || Math.abs(cur.y) > 0.5) ctx.db.player.identity.update({ ...cur, x: off, y: 0, mvX: 0, mvY: 0, velX: 0, velY: 0, kickHeld: false, kickTicks: 0, slideTicks: 0, ctrlSeat: CTRL_NONE });
      continue;
    }
    // the slide: lunge, then stun; wins the ball or — rarely — fouls
    if (cur.slideTicks > 0) {
      const t2 = cur.slideTicks - 1;
      if (cur.slideTicks > SLIDE_ACTIVE_AFTER) {
        const nx = clamp(cur.x + cur.slideDirX * SLIDE_SPEED * DT, -P_BOUNDS_X, P_BOUNDS_X);
        const ny = clamp(cur.y + cur.slideDirY * SLIDE_SPEED * DT, -P_BOUNDS_Y, P_BOUNDS_Y);
        ctx.db.player.identity.update({ ...cur, x: nx, y: ny, slideTicks: t2 });
        let won = false;
        if (ball && ball.active && match.phase === PHASE_LIVE && mayTouch(match, cur.side) && ball.z < TAKE_MAX_Z) {
          if (dist(ball.x, ball.y, nx, ny) < SLIDE_REACH * charStat(cur.characterId).tackle) {
            ctx.db.ball.matchId.update({ ...ball, vx: cur.slideDirX * SLIDE_KNOCK, vy: cur.slideDirY * SLIDE_KNOCK, vz: 3,
              lastTouchSide: cur.side, lastTouchId: cur.identity, hasOwner: false, ownerId: ZERO_ID, lockTicks: KICK_LOCK, fromKick: false });
            match = clearGrace(ctx, match, cur.side);
            ball = ctx.db.ball.matchId.find(match.id);
            won = true;
          }
        }
        const slider = cur;
        if (!won && ball && match.phase === PHASE_LIVE) {
          const victim = players.find(q => q.side !== slider.side && !q.spectator && !q.sentOff && q.slideTicks === 0 && dist(q.x, q.y, nx, ny) < FOUL_REACH);
          if (victim && dist(ball.x, ball.y, nx, ny) > SLIDE_REACH) { // nowhere near the ball: a foul
            awardFoul(ctx, match, ball, slider, victim, !!ball.hasOwner && sameId(ball.ownerId, victim.identity));
            return;
          }
        }
      } else ctx.db.player.identity.update({ ...cur, slideTicks: t2 });
      continue;
    }
    if (cur.role === ROLE_KEEPER && cur.ctrlSeat === CTRL_NONE) continue;
    if (cur.ctrlSeat === CTRL_NONE && match.phase === PHASE_LIVE && ball) {
      const mates = onPitch(players, cur.side).filter(q => !sameId(q.identity, cur!.identity));
      const foes = outfielders(players, 1 - cur.side);
      match = botPlay(ctx, match, lobby, cur, ball, plans[cur.side], mates, foes, heldBy);
      ball = ctx.db.ball.matchId.find(match.id);
      match = ctx.db.match.id.find(match.id)!;
      if (match.state !== 1 || (match.phase !== PHASE_LIVE && match.phase !== PHASE_KICKOFF)) return;
      cur = ctx.db.player.identity.find(p.identity);
      if (!cur || cur.slideTicks > 0) continue;
    } else if (cur.ctrlSeat === CTRL_NONE && match.phase === PHASE_KICKOFF && ball) {
      const humanWaiting = players.some(q => !q.isBot && !q.spectator && q.side === match.kickoffSide && q.online);
      const standIn = match.pauseTicks > (humanWaiting ? KICKOFF_AUTO_HUMAN : KICKOFF_AUTO)
        ? outfielders(players, cur.side).find(b => b.ctrlSeat === CTRL_NONE)?.teamSlot : undefined;
      const amTaker = cur.teamSlot === 0 || (standIn !== undefined && cur.teamSlot === standIn);
      if (cur.side === match.kickoffSide && amTaker) {
        const d = dist(ball.x, ball.y, cur.x, cur.y);
        if (d < KICK_RANGE) {
          const mates = onPitch(players, cur.side).filter(q => !sameId(q.identity, cur!.identity));
          const foes = outfielders(players, 1 - cur.side);
          const pick = mates.filter(m => m.role === ROLE_OUTFIELD)
            .sort((a, b) => dist(a.x, a.y, cur!.x, cur!.y) - dist(b.x, b.y, cur!.x, cur!.y))[0];
          kickBall(ctx, match, ball, cur, KICK_NORMAL, PASS_SPEED_MIN, pick ? pick.x - ball.x : 0, pick ? pick.y - ball.y : attackSign(cur.side) * 12, 2);
          ctx.db.match.id.update({ ...match, phase: PHASE_LIVE, graceTicks: 0, pointMsg: '' });
          match = ctx.db.match.id.find(match.id)!;
          ball = ctx.db.ball.matchId.find(match.id);
          continue;
        }
        const l = d || 1;
        ctx.db.player.identity.update({ ...cur, mvX: (ball.x - cur.x) / l, mvY: (ball.y - cur.y) / l,
          dirX: Math.abs(ball.x - cur.x) > 0.5 ? Math.sign(ball.x - cur.x) : 0, dirY: Math.abs(ball.y - cur.y) > 0.5 ? Math.sign(ball.y - cur.y) : 0 });
        cur = ctx.db.player.identity.find(p.identity)!;
      } else {
        const spot = cur.role === ROLE_KEEPER ? keeperSpot(cur.side) : kickoffSpot(cur.side, posOf(cur.teamSlot), match.kickoffSide);
        const kd = dist(spot.x, spot.y, cur.x, cur.y) || 1;
        ctx.db.player.identity.update({ ...cur, mvX: kd > 1 ? (spot.x - cur.x) / kd : 0, mvY: kd > 1 ? (spot.y - cur.y) / kd : 0,
          dirX: Math.abs(spot.x - cur.x) > 0.6 ? Math.sign(spot.x - cur.x) : 0, dirY: Math.abs(spot.y - cur.y) > 0.6 ? Math.sign(spot.y - cur.y) : 0, sprinting: false });
        cur = ctx.db.player.identity.find(p.identity)!;
      }
    }
    // a human stunned by a missed tackle stands for a beat
    if (cur.ctrlSeat !== CTRL_NONE && cur.kickTicks > 0) {
      ctx.db.player.identity.update({ ...cur, kickTicks: cur.kickTicks - 1, velX: 0, velY: 0 });
      continue;
    }
    // INTEGRATE — instant
    const st = charStat(cur.characterId);
    const human = cur.ctrlSeat !== CTRL_NONE;
    const hx = human ? cur.dirX : cur.mvX, hy = human ? cur.dirY : cur.mvY;
    const hlen = Math.hypot(hx, hy);
    const moving = hlen > 0;
    const wantSprint = cur.sprinting && moving && cur.stamina > 0;
    const drain = wantSprint ? Math.round(SPRINT_DRAIN / st.stamina) : 0;
    const stamina = clamp(cur.stamina - drain + (wantSprint ? 0 : STAMINA_REGEN), 0, STAMINA_MAX);
    const owns = !!ball && ball.hasOwner && sameId(ball.ownerId, cur.identity);
    let speed = PLAYER_SPEED * st.speed * (wantSprint ? SPRINT_MUL : 1);
    if (owns) speed *= DRIBBLE_MUL;
    if (!moving) {
      if (stamina !== cur.stamina || cur.velX !== 0 || cur.velY !== 0) ctx.db.player.identity.update({ ...cur, stamina, velX: 0, velY: 0 });
      continue;
    }
    const vX = hx / hlen, vY = hy / hlen;
    let x = clamp(cur.x + vX * speed * DT, -P_BOUNDS_X, P_BOUNDS_X);
    let y = clamp(cur.y + vY * speed * DT, -P_BOUNDS_Y, P_BOUNDS_Y);
    if (match.phase === PHASE_KICKOFF) {
      y = sideSign(cur.side) > 0 ? Math.max(y, 0.5) : Math.min(y, -0.5);
      if (cur.side !== match.kickoffSide && Math.hypot(x, y) < CENTER_CIRCLE_R) {
        const n = Math.hypot(x, y) || 1; x = (x / n) * CENTER_CIRCLE_R; y = (y / n) * CENTER_CIRCLE_R;
        y = sideSign(cur.side) > 0 ? Math.max(y, 0.5) : Math.min(y, -0.5);
      }
    }
    ctx.db.player.identity.update({ ...cur, x, y, stamina, velX: vX, velY: vY });
  }

  // ---- keepers ----
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

  // ---- clock ----
  if (match.clockTicks > 0) {
    const left = match.clockTicks - 1;
    match = { ...match, clockTicks: left };
    ctx.db.match.id.update(match);
    if (left === 0) { endOfClock(ctx, match, hooks); return; }
  }
  if (match.graceTicks > 0) { match = { ...match, graceTicks: match.graceTicks - 1 }; ctx.db.match.id.update(match); }

  // ---- ball physics (a free ball only) ----
  ball = ctx.db.ball.matchId.find(match.id);
  if (!ball || !ball.active) return;
  const fresh = matchPlayers(ctx, match.id);
  const holderNow = fresh.some(p => p.role === ROLE_KEEPER && p.holdTicks > 0);
  if (holderNow) { autoSwitch(ctx, match, ball); return; }
  const restartHeld = match.graceTicks > 0;
  const ownerRow = ball.hasOwner ? fresh.find(p => sameId(p.identity, ball!.ownerId)) : undefined;
  const glued = !!ownerRow && !ownerRow.sentOff && ownerRow.slideTicks === 0 && ownerRow.role === ROLE_OUTFIELD;

  if (restartHeld) {
    ball = { ...ball, vx: 0, vy: 0, vz: 0, hasOwner: false, ownerId: ZERO_ID };
  } else if (glued && ownerRow) {
    // THE GLUE. The ball IS at his feet. Its velocity is his, so the client
    // dead-reckons it along with him.
    const mlen = Math.hypot(ownerRow.mvX, ownerRow.mvY);
    const fx = mlen > 0.01 ? ownerRow.mvX / mlen : 0;
    const fy = mlen > 0.01 ? ownerRow.mvY / mlen : attackSign(ownerRow.side);
    const spd = Math.hypot(ownerRow.velX, ownerRow.velY) * PLAYER_SPEED * charStat(ownerRow.characterId).speed * (ownerRow.sprinting ? SPRINT_MUL : 1) * DRIBBLE_MUL;
    ball = { ...ball, x: ownerRow.x + fx * GLUE_AHEAD, y: ownerRow.y + fy * GLUE_AHEAD, z: 0,
      vx: ownerRow.velX * spd, vy: ownerRow.velY * spd, vz: 0, lastTouchSide: ownerRow.side, lastTouchId: ownerRow.identity, lockTicks: 0, fromKick: false };
  } else {
    if (ball.z > 0.01 || ball.vz > 0.01) {
      const sp3 = Math.hypot(ball.vx, ball.vy, ball.vz);
      const dk = sp3 > 0 ? 1 / (1 + BALL_DRAG * sp3 * DT) : 1;
      ball = { ...ball, x: ball.x + ball.vx * DT, y: ball.y + ball.vy * DT, z: ball.z + ball.vz * DT + 0.5 * phys.gravity * DT * DT, vx: ball.vx * dk, vy: ball.vy * dk, vz: (ball.vz + phys.gravity * DT) * dk };
      if (ball.z <= 0 && ball.vz < 0) { const vz = -ball.vz * phys.bounce; ball = { ...ball, z: 0, vz: vz < 1.6 ? 0 : vz, vx: ball.vx * 0.9, vy: ball.vy * 0.9 }; }
    } else {
      const sp = Math.hypot(ball.vx, ball.vy);
      let k = 0;
      if (sp > 0) { const afterDrag = sp / (1 + BALL_DRAG * sp * DT); k = Math.max(0, afterDrag - phys.friction * DT) / sp; }
      let vx = ball.vx * k, vy = ball.vy * k;
      if (Math.hypot(vx, vy) < 0.6) { vx = 0; vy = 0; }
      ball = { ...ball, x: ball.x + vx * DT, y: ball.y + vy * DT, z: 0, vx, vy, vz: 0 };
    }
    if (ball.lockTicks > 0) ball = { ...ball, lockTicks: ball.lockTicks - 1 };
    // TAKING A LOOSE BALL: the nearest eligible body inside the radius has it.
    const lockedOut = ball.lockTicks > 0 ? ball.lastTouchId : null;
    const protectedSide = match.graceTicks === 0 ? -1 : match.restartSide;
    const speedNow = Math.hypot(ball.vx, ball.vy);
    const hot = speedNow > TAKE_MAX_SPEED;
    let taker: PlayerRow | null = null, bestD = Infinity;
    if (ball.z < TAKE_MAX_Z) {
      for (const p of fresh) {
        if (p.spectator || p.sentOff || p.slideTicks > 0) continue;
        if (p.role !== ROLE_OUTFIELD && p.ctrlSeat === CTRL_NONE) continue;
        if (protectedSide >= 0 && p.side !== protectedSide) continue;
        if (lockedOut && sameId(p.identity, lockedOut)) continue;
        // a pass still travelling is not its passer's to re-take
        if (speedNow > 12 && sameId(p.identity, ball.lastTouchId)) continue;
        const d = dist(ball.x, ball.y, p.x, p.y);
        if (d < (hot ? BLOCK_RADIUS : TAKE_RADIUS) && d < bestD) { bestD = d; taker = p; }
      }
    }
    if (taker) {
      if (hot) {
        // a block: the shot is killed off a body
        ball = { ...ball, vx: ball.vx * 0.25, vy: ball.vy * 0.25, vz: Math.min(ball.vz, 2), lastTouchSide: taker.side, lastTouchId: taker.identity, lockTicks: 0, fromKick: false, hasOwner: false, ownerId: ZERO_ID };
      } else {
        ball = { ...ball, hasOwner: true, ownerId: taker.identity, lastTouchSide: taker.side, lastTouchId: taker.identity, lockTicks: 0, fromKick: false, vx: 0, vy: 0, vz: 0, z: 0 };
        // A BOT SETTLES IT. Deciding on the same tick it took the ball made
        // every possession a one-touch ping — the ball never stopped, the
        // trace showed it re-kicked every few ticks, and a stationary human
        // receiver never had a ball come to rest near him. A short carry
        // before the decision is what makes it look like a player.
        if (taker.ctrlSeat === CTRL_NONE) {
          ctx.db.player.identity.update({ ...taker, kickTicks: BOT_SETTLE });
        }
      }
      match = clearGrace(ctx, match, taker.side);
    } else if (ball.hasOwner) {
      ball = { ...ball, hasOwner: false, ownerId: ZERO_ID };
    }
  }
  ball = { ...ball, x: clamp(ball.x, -PITCH_HALF_WID - 2, PITCH_HALF_WID + 2), y: clamp(ball.y, -PITCH_HALF_LEN - 3, PITCH_HALF_LEN + 3) };
  ctx.db.ball.matchId.update(ball);
  autoSwitch(ctx, match, ball);
  resolveOutOfPlay(ctx, match, ball, hooks);
}
