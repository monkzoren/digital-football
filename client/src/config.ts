// Default SpacetimeDB address:
// - Vite dev server (any port): SpacetimeDB runs separately on :3000.
// - Anything else (the nginx container, any deployment): SAME ORIGIN —
//   nginx proxies /v1 to SpacetimeDB, so one domain/port serves everything
//   and wss works automatically behind any TLS proxy.
const defaultUri = (import.meta as any).env?.DEV
  ? `ws://${location.hostname}:3000`
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
// Guard: a localhost URI can never work for remote visitors (it points at
// THEIR machine). If the page isn't served from localhost, ignore such a
// value and fall back to same-origin.
const envUri: string | undefined = (import.meta as any).env?.VITE_SPACETIMEDB_URI;
const pageIsLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const envPointsLocal = !!envUri && /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(envUri);
const usableEnvUri = envUri && !(envPointsLocal && !pageIsLocal) ? envUri : undefined;
if (envUri && !usableEnvUri) {
  console.warn(
    `[dt] Ignoring VITE_SPACETIMEDB_URI="${envUri}" (localhost is unreachable for remote players); using same-origin instead.`
  );
}
export const SPACETIMEDB_URI = usableEnvUri ?? defaultUri;
export const DATABASE_NAME =
  (import.meta as any).env?.VITE_DATABASE_NAME ?? 'digital-tennis';

// Simulation tick rate — must mirror TICK_HZ in spacetimedb/src/index.ts.
// Only used to convert server tick counts into seconds for the UI; the ball
// extrapolation is wall-clock based and needs no tick rate.
export const TICK_HZ = 30;

// Court geometry — must mirror spacetimedb/src/index.ts.
export const COURT_HALF_LEN = 39;
export const COURT_HALF_WID = 21.6;
export const SERVICE_LINE = 21;
export const LINE_MARGIN = 0.85; // ball may land this far past the line and still be IN
export const NET_HEIGHT = 3.2;
export const GRAVITY = -70;
export const PLAYER_SPEED = 26;
export const REACH = 3.36; // stand-and-hit radius; beyond it a hit is a stretch
// Run-speed stat only (movement prediction) — mirrors CHAR_STATS[].speed
// in spacetimedb/src/index.ts, same character order.
export const CHAR_SPEED = [
  1.0, 0.94, 1.12, 0.96, 1.03, 0.99, // BLAZE…LUNA
  0.96, 1.12, 0.96, 1.0, 1.0, 0.96, 0.94, 0.94, 1.06, 0.96, 0.94, 0.96, // wacky roster
];

// ---------------------------------------------------------------------------
// Progression — must mirror spacetimedb/src/index.ts.
// ---------------------------------------------------------------------------
export const MMR_START = 1000;
// Level L -> L+1 costs LEVEL_BASE + LEVEL_STEP*(L-1); totalXpFor is the sum,
// i.e. the XP needed to REACH a level (200, 500, 900 … 494,900 at 99).
const LEVEL_BASE = 200;
const LEVEL_STEP = 100;
export const LEVEL_MAX = 99;
export const totalXpFor = (level: number) =>
  ((level - 1) * (2 * LEVEL_BASE + LEVEL_STEP * (level - 2))) / 2;
export const levelFor = (xp: number) => {
  let lvl = 1;
  while (lvl < LEVEL_MAX && totalXpFor(lvl + 1) <= xp) lvl++;
  return lvl;
};

// Reconnect — mirrors GRACE_*/CLAIM_UNLOCK (seconds here, micros there).
export const CLAIM_UNLOCK_SECS = 60;

// Match end reasons (match_log.endedBy)
export const END_PLAYED = 0;
export const END_FORFEIT = 1;
export const END_TIMEOUT = 2;
