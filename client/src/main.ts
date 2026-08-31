import './update-check';
import { DbConnection } from './module_bindings';
import type { Identity } from 'spacetimedb';
import {
  SPACETIMEDB_URI, DATABASE_NAME, GRAVITY, PLAYER_SPEED, SPRINT_MUL, CHAR_SPEED, TICK_HZ,
  PHASE_KICKOFF, PHASE_LIVE, PHASE_PAUSE, PHASE_OVER,
  STAMINA_MAX,
  RK_NONE, RK_KICKOFF, RK_THROWIN, RK_GOALKICK, RK_CORNER, RK_HALFTIME, RK_OVERTIME, RK_DROP,
  HALF_SECONDS, OT_SECONDS, ROLE_KEEPER, SQUAD_SIZE, KEEPER_RIG_SEAT, KICK_RANGE,
  totalXpFor, levelFor, LEVEL_MAX, CLAIM_UNLOCK_SECS,
} from './config';
import {
  firebaseEnabled,
  initAuth,
  getToken,
  localToken,
  accountKind,
  accountLabel,
  onAuthChange,
  authDegraded,
  signInWithGoogle,
  signInWithPassword,
  signUpWithPassword,
  sendPasswordReset,
  sendEmailLink,
  completeEmailLink,
  isEmailLinkReturn,
  signOut,
} from './auth';
import {
  initRenderer,
  initCharacterPreviews,
  drawScene,
  headScreenPos,
  sceneIsAnimating,
  canvasCssSize,
  type Scene,
} from './render';
import { CHARACTERS, PITCHES, STAT_LABELS, type Character } from './characters';
import {
  unlockAudio,
  playGoalJingle,
  playCountdown,
  playGo,
  playWhistle,
  playDing,
  playEmote,
  playBlip,
  getAudio,
  setAudio,
  onAudioChange,
  toggleMute,
  type AudioSettings,
  crowdSetHype,
  crowdCheer,
  crowdRoar,
  crowdMurmur,
} from './audio';
import {
  initTouch, touchDir, touchSprint, setTouchVisible, setTouchActions, touchAvailable,
} from './touch';
import {
  getGraphics,
  setGraphics,
  applyPreset,
  presetOf,
  onGraphicsChange,
  type GraphicsSettings,
  type PresetName,
} from './graphics';

// Restart kinds, as the banner names them (index = match.restartKind).
const RESTART_NAMES: Record<number, string> = {
  [RK_KICKOFF]: 'KICK OFF',
  [RK_THROWIN]: 'THROW-IN',
  [RK_GOALKICK]: 'GOAL KICK',
  [RK_CORNER]: 'CORNER',
  [RK_HALFTIME]: 'HALF-TIME',
  [RK_OVERTIME]: 'GOLDEN GOAL',
  [RK_DROP]: 'DROP BALL',
};

// Match lifecycle
const M_PENDING = 0;
const M_LIVE = 1;
const M_DONE = 2;
// A match nobody came back to has no winner at all (mirror: NO_WINNER).
const NO_WINNER = 255;

// Bot naming (mirrors insertBot in spacetimedb/src/index.ts): the first bot
// in a room is "ACE BOT", the rest are numbered from 2.
const BOT_NAME = 'ACE BOT';

// Lobby modes / status
const MODE_QUICK = 0;
const MODE_TOURNAMENT = 1;
const L_OPEN = 0;
const L_RUNNING = 1;
const L_FINISHED = 2;

// Betting (mirror spacetimedb/src/index.ts). The server is the authority on
// every rule here — these only shape what the UI offers.
const B_OPEN = 0;
const B_WON = 1;
const B_LOST = 2;
const BET_MIN_STAKE = 10;
const BET_WINDOW_SECS = 12;
const STAKE_PRESETS = [50, 100, 250, 500];
// The 3-2-1 the server puts in front of every match; anything above it on a
// tournament match is the betting window.
const COUNTDOWN_SECS = 3;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game-canvas') as HTMLCanvasElement;
initRenderer(canvas);
const overlays = {
  connecting: $('connecting'),
  menu: $('menu'),
  selectPlayer: $('select-player'),
  selectPitch: $('select-court'),
  waiting: $('waiting'),
  gameover: $('gameover'),
};
const hud = $('hud');
const plates = [$('plate0'), $('plate1')];
const banner = $('banner');
const help = $('help');
const statusMsg = $('status-msg');
const nameInput = $('name-input') as HTMLInputElement;
const codeInput = $('code-input') as HTMLInputElement;
const stageEl = $('stage');

type OverlayName = keyof typeof overlays;

// Broadcast-style screen wipe in two phases driven by animationend — no
// timing constants to keep in sync with the CSS. Phase "in" sweeps the slab
// to full cover; the screen swaps at its animationend (CSS restarts the new
// screen's child animations on the display:none → flex flip); phase "out"
// reveals it. A watchdog force-finishes if the events never arrive (e.g. a
// backgrounded tab suppressing animations).
const wipeEl = $('wipe');
const wipeBar1 = wipeEl.querySelector('.b1') as HTMLElement;
const reducedMotion =
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
let appliedOverlay: OverlayName | null | undefined;
let overlayTarget: OverlayName | null | undefined;
let wipeRunning = false;
let wipeWatchdog = 0;

function applyOverlay(name: OverlayName | null) {
  appliedOverlay = name;
  for (const [key, el] of Object.entries(overlays)) {
    el.classList.toggle('hidden', key !== name);
  }
  hud.classList.toggle('hidden', name === 'connecting' || name === 'menu');
  // entering the match view: replay the scoreboard fly-in, then drop the
  // class so the score-change bump animation can take over again
  if (name === null) {
    hud.classList.remove('enter');
    void (hud as HTMLElement).offsetWidth;
    hud.classList.add('enter');
    window.setTimeout(() => hud.classList.remove('enter'), 800);
  }
  // Any overlay covers the controls; the live match view re-shows them.
  if (name !== null) {
    setTouchVisible(false);
    $('spectate-exit').classList.add('hidden');
    $('spectate-chip').classList.add('hidden');
    $('bet-bar').classList.add('hidden');
    $('bet-pill').classList.add('hidden');
    $('bet-window-chip').classList.add('hidden');
    document.body.classList.remove('spectating');
  }
}

function runWipe() {
  if (wipeRunning) return; // one sweep at a time; the swap reads the target
  wipeRunning = true;
  wipeEl.classList.remove('out');
  wipeEl.classList.add('run', 'in');
  clearTimeout(wipeWatchdog);
  wipeWatchdog = window.setTimeout(finishWipe, 2000);
}

function finishWipe() {
  clearTimeout(wipeWatchdog);
  wipeEl.classList.remove('run', 'in', 'out');
  wipeRunning = false;
  // a late target change, or the watchdog fired before the swap — apply now
  if (overlayTarget !== appliedOverlay) applyOverlay(overlayTarget ?? null);
}

// The big slab (b1) is the bar that guarantees full cover, so its
// animationend marks both the swap moment and the end of the reveal.
wipeBar1.addEventListener('animationend', () => {
  if (wipeEl.classList.contains('in')) {
    applyOverlay(overlayTarget ?? null);
    wipeEl.classList.remove('in');
    wipeEl.classList.add('out');
  } else if (wipeEl.classList.contains('out')) {
    finishWipe();
  }
});

// Called every frame by the state machine, so the wipe only fires when the
// target screen actually changes.
function showOverlay(name: OverlayName | null) {
  if (name === overlayTarget) return;
  const firstShow = overlayTarget === undefined;
  overlayTarget = name;
  if (firstShow || reducedMotion || document.hidden) {
    applyOverlay(name);
    return;
  }
  runWipe();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
let conn: DbConnection;
let myIdentity: Identity | null = null;
let subscribed = false;

// Consecutive failed connection attempts, driving the reconnect backoff.
let connectFailures = 0;
// True from a dropped socket until we are back in — the server is holding a
// halted match for us for the whole of it.
let reconnecting = false;

// per-match latest ball snapshot for client-side extrapolation
const ballSnapshots = new Map<string, { row: any; at: number }>();

function noteBallRow(row: any) {
  ballSnapshots.set(String(row.matchId), { row, at: performance.now() });
}

// Reconnect backoff, shared by a failed attempt and a dropped socket. The
// server holds a seat for five minutes; the client should spend them trying.
const RECONNECT_STEPS = [2000, 4000, 8000];
const retryDelay = () => RECONNECT_STEPS[Math.min(connectFailures, RECONNECT_STEPS.length - 1)];
let reconnectTimer = 0;
// Every connection attempt gets a generation. A superseded attempt's
// callbacks still fire — a deliberate disconnect raises one immediately —
// and must not drive the UI or start a second reconnect loop.
let connectGen = 0;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    void connect();
  }, retryDelay());
}

/** Tear the socket down and build a new one — used when the identity itself
 *  changes (sign in, sign out), which the player row is keyed to. Bumping the
 *  generation FIRST stops the outgoing connection's onDisconnect from racing
 *  us with an automatic retry. */
function restartConnection() {
  connectGen++;
  try { conn?.disconnect(); } catch { /* already gone */ }
  void connect();
}

async function connect() {
  const gen = ++connectGen;
  // Always mint a fresh Firebase ID token: it expires hourly and the SDK
  // refreshes it for us, so the identity is stable without anything of ours
  // being cached. Without Firebase this falls back to the anonymous
  // SpacetimeDB token in localStorage.
  const token = await getToken();
  conn = DbConnection.builder()
    .withUri(SPACETIMEDB_URI)
    .withDatabaseName(DATABASE_NAME)
    .withToken(token)
    .onDisconnect(() => {
      if (gen !== connectGen) return; // a superseded attempt closing down
      // The socket dropped mid-session. The server has HALTED our match and
      // is holding it — keep trying until we get back in.
      if (!reconnecting) {
        reconnecting = true;
        subscribed = false;
        showOverlay('connecting');
        overlays.connecting.querySelector('.subtitle')!.textContent =
          'CONNECTION LOST — RECONNECTING...';
      }
      scheduleReconnect();
    })
    .onConnect((_c, identity, token) => {
      if (gen !== connectGen) return; // superseded while the socket opened
      console.log('[df] connected as', identity.toHexString());
      connectFailures = 0;
      reconnecting = false;
      myIdentity = identity;
      // With a working Firebase identity the ID token is the source of truth
      // and a cached SpacetimeDB one would fight it. Without one — Firebase
      // unconfigured, or configured but unreachable — this cached token IS
      // the identity, and persisting it is the only thing keeping the player
      // from becoming a different person on every reload.
      connectedDegraded = firebaseEnabled && authDegraded();
      if (!firebaseEnabled || connectedDegraded) localToken.set(token);
      try {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            console.log('[df] subscription applied');
            subscribed = true;
            onSubscribed();
          })
          .onError(e => {
            console.error('[df] subscription error', e);
            setStatus('SUBSCRIPTION ERROR — SERVER/CLIENT VERSION MISMATCH?');
          })
          .subscribe([
            'SELECT * FROM lobby',
            'SELECT * FROM match',
            'SELECT * FROM player',
            'SELECT * FROM ball',
            'SELECT * FROM chat',
            'SELECT * FROM goal_event',
            'SELECT * FROM team',
            'SELECT * FROM wallet',
            'SELECT * FROM bet',
            'SELECT * FROM book',
            'SELECT * FROM account',
            // a view: it filters to this caller server-side, so it needs an
            // explicit subscription like any other table
            'SELECT * FROM my_match_log',
          ]);
      } catch (err) {
        console.error('[df] subscribe threw', err);
      }
    })
    .onConnectError((_c, err) => {
      if (gen !== connectGen) return;
      connectFailures++;
      console.error('[df] connect error', err, `(attempt ${connectFailures})`);
      const rejected = /verify token|unauthorized|401/i.test(String((err as any)?.message ?? err));
      let hint = reconnecting ? 'RECONNECTING...' : 'IS THE SERVER RUNNING?';
      // Only the fallback path can hold a dead token: it is signed by the
      // server instance that issued it, so a redeploy that recreates the
      // volume invalidates it forever. A Firebase identity is derived from
      // iss+sub and survives any re-key, so there is nothing to reset.
      if (!firebaseEnabled && (rejected || connectFailures >= 2) && localToken.get()) {
        localToken.clear();
        console.warn('[df] stored token rejected — reconnecting anonymously');
        hint = 'RESETTING SESSION...';
      }
      showOverlay('connecting');
      overlays.connecting.querySelector('.subtitle')!.textContent =
        `CONNECTION FAILED — ${hint} RETRYING...`;
      scheduleReconnect();
    })
    .build();

  conn.db.ball.onInsert((_ctx, row) => noteBallRow(row));
  conn.db.ball.onUpdate((_ctx, _old, row) => noteBallRow(row));
  conn.db.ball.onDelete((_ctx, row) => {
    ballSnapshots.delete(String(row.matchId));
  });
  conn.db.player.onInsert((_ctx, row) =>
    playerStamp.set(row.identity.toHexString(), performance.now())
  );
  conn.db.player.onUpdate((_ctx, _old, row) =>
    playerStamp.set(row.identity.toHexString(), performance.now())
  );
  // any market movement (a price, a stack, a settled slip) redraws the book
  conn.db.book.onUpdate(() => { betPanelDirty = true; });
  conn.db.book.onInsert(() => { betPanelDirty = true; });
  conn.db.book.onDelete(() => { betPanelDirty = true; });
  conn.db.bet.onInsert(() => { betPanelDirty = true; });
  conn.db.wallet.onUpdate(() => { betPanelDirty = true; });
  // my bet settling is the payoff moment — call it out wherever I am
  conn.db.bet.onUpdate((_ctx, old, row) => {
    betPanelDirty = true;
    if (row.bettor.toHexString() !== myHex()) return;
    if (old.state !== B_OPEN || row.state === B_OPEN) return;
    if (row.state === B_WON) {
      showToast(`💰 BET WON +${fmtCr(row.payout)}`, '#ffd60a');
      playDing();
    } else {
      showToast(`BET LOST −${fmtCr(row.stake)}`, '#ff4b33');
    }
  });
}

// smoothed render positions (movement glides at 60fps between 30Hz ticks)
const playerStamp = new Map<string, number>();
const smoothPos = new Map<string, { x: number; y: number }>();

// Smoothed render position of the ball, so a dribble does not strobe.
let smoothBall: { x: number; y: number; z: number } | null = null;

function renderPosition(p: any, now: number, frameDt: number): { x: number; y: number } {
  const hex = p.identity.toHexString();
  const sliding = (p.slideTicks ?? 0) > 0;
  const stamped = playerStamp.get(hex) ?? now;
  const elapsed = sliding ? 0 : Math.min(0.1, (now - stamped) / 1000);
  const speed =
    PLAYER_SPEED * (CHAR_SPEED[p.characterId] ?? 1) * (p.sprinting ? SPRINT_MUL : 1);
  // Dead-reckon along the CURRENT VELOCITY the server is integrating, not
  // along the stick. dirX/dirY is the 8-way rendered facing and mv is only
  // the wanted heading; velX/velY is what actually moves the body, and it
  // ramps in and out. Predicting along anything else disagrees with the
  // server every tick, and the constant correction is what reads as jitter.
  const vx = p.velX ?? p.mvX ?? p.dirX;
  const vy = p.velY ?? p.mvY ?? p.dirY;
  const tx = p.x + vx * speed * elapsed;
  const ty = p.y + vy * speed * elapsed;
  let sp = smoothPos.get(hex);
  if (!sp || Math.hypot(sp.x - tx, sp.y - ty) > 12) sp = { x: tx, y: ty };
  // The smoother exists to hide the 30 Hz step in OTHER people's rows. On the
  // body my own stick is driving it is pure added latency: rate 11 is a ~90 ms
  // time constant, stacked on top of the tick and the round trip, and that is
  // what reads as floaty, unresponsive input. My own man gets a rate stiff
  // enough to absorb a one-tick correction inside a tick or two and no more.
  const mine = hex === controlBodyKey;
  const rate = sliding ? 4.5 : mine ? 34 : 11;
  const alpha = 1 - Math.exp(-frameDt * rate);
  sp = { x: sp.x + (tx - sp.x) * alpha, y: sp.y + (ty - sp.y) * alpha };
  smoothPos.set(hex, sp);
  return sp;
}

function myHex() {
  return myIdentity ? myIdentity.toHexString() : '';
}

function getMyPlayer(): any | null {
  if (!subscribed || !myIdentity) return null;
  for (const p of conn.db.player.iter()) {
    if (p.identity.toHexString() === myHex()) return p;
  }
  return null;
}

function getLobby(id: bigint): any | null {
  for (const l of conn.db.lobby.iter()) if (l.id === id) return l;
  return null;
}

function getMatch(id: bigint): any | null {
  for (const m of conn.db.match.iter()) if (m.id === id) return m;
  return null;
}

function lobbyMatchList(lobbyId: bigint): any[] {
  const out: any[] = [];
  for (const m of conn.db.match.iter()) if (m.lobbyId === lobbyId) out.push(m);
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function roomPlayers(lobbyId: bigint): any[] {
  const out: any[] = [];
  for (const p of conn.db.player.iter()) if (p.lobbyId === lobbyId) out.push(p);
  return out;
}

function matchPlayerList(matchId: bigint): any[] {
  const out: any[] = [];
  for (const p of conn.db.player.iter()) if (p.matchId === matchId) out.push(p);
  return out;
}

function getBall(matchId: bigint): any | null {
  for (const b of conn.db.ball.iter()) if (b.matchId === matchId) return b;
  return null;
}

// ---------------------------------------------------------------------------
// Accounts: the persistent profile behind an identity (level, XP, MMR, W-L).
// Cold rows — they change twice per match, never per tick.
// ---------------------------------------------------------------------------
function accountOf(id: any): any | null {
  const hex = typeof id === 'string' ? id : id.toHexString();
  for (const a of conn.db.account.iter()) {
    if (a.identity.toHexString() === hex) return a;
  }
  return null;
}

const myAccount = () => (myIdentity ? accountOf(myIdentity) : null);

/** A player's rating, for nameplates and roster chips. Null for a bot (no
 *  account) or before the account row has arrived. */
function mmrOf(p: any): number | null {
  if (!p || p.isBot) return null;
  return accountOf(p.identity)?.mmr ?? null;
}

/** My result for one match — the post-match reveal reads its deltas from here
 *  rather than diffing an account snapshot a reconnect would have thrown
 *  away. Absent for a match that paid nothing (abandoned, bye, spectated). */
function logForMatch(matchId: bigint): any | null {
  for (const row of conn.db.myMatchLog.iter()) {
    if (row.matchId === matchId) return row;
  }
  return null;
}

// Progress through the current level, for the XP bar.
function levelProgress(xp: number, level: number): { into: number; span: number } {
  const floor = totalXpFor(level);
  const ceil = totalXpFor(level + 1);
  return { into: Math.max(0, xp - floor), span: Math.max(1, ceil - floor) };
}

const fmtXp = (n: number) => n.toLocaleString('en-US');

// Team lobbies (2v2/3v3): membership rows keyed by the captain's identity —
// tournament brackets pair captains, so these resolve labels and "my team".
function teamRowList(lobbyId: bigint): any[] {
  const out: any[] = [];
  for (const r of conn.db.team.iter()) if (r.lobbyId === lobbyId) out.push(r);
  return out;
}

// Bracket label for a captain: the joined team names, or the lone player's.
function unitLabel(lobbyId: bigint, captainId: any): string {
  const members = teamRowList(lobbyId)
    .filter(r => r.captainId.toHexString() === captainId.toHexString())
    .sort((a, b) => a.slot - b.slot);
  if (!members.length) return playerByIdentity(captainId)?.name || '?';
  return members.map(r => playerByIdentity(r.memberId)?.name || 'PLAYER').join(' & ');
}

// Every seat on this side held by a bot? The server decides such matches on
// the spot rather than playing them out (simulateBotMatch), so the bracket
// labels them instead of pretending they were contested.
function unitIsAllBots(lobbyId: bigint, captainId: any): boolean {
  const members = teamRowList(lobbyId)
    .filter(r => r.captainId.toHexString() === captainId.toHexString())
    .map(r => r.memberId);
  const ids = members.length ? members : [captainId];
  return ids.every(id => playerByIdentity(id)?.isBot === true);
}

// The captain who represents ME in a team bracket (myself in 1v1 brackets).
function myCaptainHex(lobbyId: bigint): string {
  const mine = teamRowList(lobbyId).find(r => r.memberId.toHexString() === myHex());
  return mine ? mine.captainId.toHexString() : myHex();
}

// ----- betting accessors (rows are server-authoritative; we only read) -----
function myWallet(lobbyId: bigint): any | null {
  for (const w of conn.db.wallet.iter()) {
    if (w.lobbyId === lobbyId && w.identity.toHexString() === myHex()) return w;
  }
  return null;
}

function bookOf(matchId: bigint): any | null {
  for (const b of conn.db.book.iter()) if (b.matchId === matchId) return b;
  return null;
}

function betsFor(matchId: bigint): any[] {
  const out: any[] = [];
  for (const b of conn.db.bet.iter()) if (b.matchId === matchId) out.push(b);
  return out;
}

function myBetOn(matchId: bigint): any | null {
  for (const b of conn.db.bet.iter()) {
    if (b.matchId === matchId && b.bettor.toHexString() === myHex()) return b;
  }
  return null;
}

// Am I (or a teammate) playing in this match? Brackets pair captains, so the
// check runs over both units — same rule the server enforces.
function isMyMatch(lobbyId: bigint, m: any): boolean {
  const mine = myCaptainHex(lobbyId);
  return m.p0Id.toHexString() === mine || m.p1Id.toHexString() === mine;
}

const fmtOdds = (milli: number) => `${(milli / 1000).toFixed(2)}×`;
const fmtCr = (n: number) => n.toLocaleString('en-US');

// Every goal scored in a match, oldest first — the pause card lists scorers.
function goalsFor(matchId: bigint): any[] {
  const out: any[] = [];
  for (const g of conn.db.goalEvent.iter()) if (g.matchId === matchId) out.push(g);
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Menu / selection flow
// ---------------------------------------------------------------------------
function setStatus(msg: string) {
  statusMsg.textContent = msg;
}

function playerName(): string {
  const name = (localStorage.getItem('df_name') || nameInput.value || 'GUEST')
    .trim()
    .toUpperCase()
    .slice(0, 16);
  localStorage.setItem('df_name', name);
  return name || 'GUEST';
}

// ---------------------------------------------------------------------------
// Name modal — a required gate: every play/join flow goes through it until a
// name is stored, and it pops on first visit. The PLAYING AS chip reopens it.
// ---------------------------------------------------------------------------
const nameModal = $('name-modal');
let afterName: (() => void) | null = null;

function storedName(): string {
  return (localStorage.getItem('df_name') ?? '').trim();
}

function refreshNameTag() {
  $('name-edit').textContent = storedName() || 'ENTER NAME';
}

// ---------------------------------------------------------------------------
// Account chip + profile card
// ---------------------------------------------------------------------------
function refreshAccountChip() {
  const chip = $('account-chip') as HTMLButtonElement;
  if (!firebaseEnabled) {
    // No Firebase project configured — everyone is a local anonymous
    // identity, so there is nothing to sign into.
    chip.classList.add('hidden');
    return;
  }
  chip.classList.remove('hidden');
  const kind = accountKind();
  const linked = kind === 'linked';
  chip.classList.toggle('linked', linked);
  chip.classList.toggle('offline', kind === 'offline');
  if (kind === 'offline') {
    // Firebase is configured but we could not reach it. Say so: the player is
    // on a device-local identity, and anything they earn now is not going to
    // the account they may already have.
    chip.textContent = '⚠ OFFLINE — PROGRESS NOT SYNCED';
    chip.title =
      'Could not reach the account service (offline, or blocked by a firewall or extension). ' +
      'You can still play and this device keeps its own progress, but it is not saved to your account. ' +
      'Click to retry.';
    return;
  }
  chip.textContent = linked ? `✓ ${accountLabel()}` : 'SIGN IN TO SAVE PROGRESS';
  chip.title = linked
    ? 'Signed in — your level and rating follow you to any device. Click to sign out.'
    : 'Playing as a guest: progress lives in this browser only. Sign in to keep it.';
}

let profileKey = '';

function refreshProfileCard() {
  const card = $('profile-card');
  const acc = myAccount();
  if (!acc) {
    card.classList.add('hidden');
    profileKey = '';
    return;
  }
  card.classList.remove('hidden');
  const key = `${acc.xp}:${acc.level}:${acc.mmr}:${acc.ranked}:${acc.casual}:${acc.streak}`;
  if (key === profileKey) return;
  profileKey = key;
  const { into, span } = levelProgress(acc.xp, acc.level);
  $('pf-level').textContent = String(acc.level);
  $('pf-mmr').textContent = String(acc.mmr);
  ($('pf-bar-fill') as HTMLElement).style.width = `${Math.min(100, (into / span) * 100)}%`;
  $('pf-xp').textContent =
    acc.level >= LEVEL_MAX ? `${fmtXp(acc.xp)} XP · MAX` : `${fmtXp(into)} / ${fmtXp(span)} XP`;
  const wins = acc.rankedWins + acc.casualWins;
  const losses = acc.ranked + acc.casual - wins;
  const streak =
    acc.streak > 1 ? ` · ${acc.streak}W STREAK` : acc.streak < -1 ? ` · ${-acc.streak}L STREAK` : '';
  $('pf-record').textContent = `${wins}W · ${losses}L${streak}`;
}

$('account-chip').addEventListener('click', async () => {
  const chip = $('account-chip') as HTMLButtonElement;
  if (accountKind() === 'offline') {
    // A sign-in popup would only fail the same way; reload and try the whole
    // handshake again.
    setStatus('RETRYING THE ACCOUNT SERVICE…');
    location.reload();
    return;
  }
  if (accountKind() === 'linked') {
    if (!confirm('Sign out? You will play as a new guest — this account is kept, and signing back in returns to it.')) return;
    await signOut();
    setStatus('SIGNED OUT — PLAYING AS A GUEST');
    // A different identity means a different player row: rebuild the socket.
    restartConnection();
    return;
  }
  openSignInModal();
});

// ---------------------------------------------------------------------------
// Sign-in chooser: Google popup, or an emailed link (no popup — the only one
// that works in the desktop shell and behind popup blockers).
// ---------------------------------------------------------------------------
const signinModal = $('signin-modal');
const siEmail = $('si-email') as HTMLInputElement;
const siPassword = $('si-password') as HTMLInputElement;
// Creating an account LINKS onto the anonymous guest, so the level and rating
// earned so far carry over; signing in switches to an account that already
// exists, which leaves that progress behind. The copy has to be honest about
// which one is about to happen, so the form has an explicit mode.
let siMode: 'create' | 'signin' = 'create';

function siMessage(text: string, kind: 'ok' | 'err' | '' = '') {
  const el = $('si-msg');
  el.textContent = text;
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('err', kind === 'err');
}

function setSignInMode(mode: 'create' | 'signin') {
  siMode = mode;
  const creating = mode === 'create';
  $('si-title').textContent = creating ? 'SAVE YOUR PROGRESS' : 'WELCOME BACK';
  $('si-sub').textContent = creating
    ? 'YOUR LEVEL AND RATING STAY ON THIS ACCOUNT — KEEP THEM ON ANY DEVICE'
    : 'SIGNING IN SWITCHES TO THAT ACCOUNT — THIS DEVICE’S GUEST PROGRESS STAYS PUT';
  $('si-submit').textContent = creating ? 'Create Account' : 'Sign In';
  $('si-mode').textContent = creating
    ? 'Already have an account? Sign in'
    : 'New here? Create an account';
  // Resetting a password you are in the middle of choosing makes no sense.
  $('si-forgot').classList.toggle('hidden', creating);
  siPassword.autocomplete = creating ? 'new-password' : 'current-password';
}

function openSignInModal() {
  siMessage('');
  siPassword.value = '';
  setSignInMode('create');
  signinModal.classList.remove('hidden');
  siEmail.focus();
}
function closeSignInModal() {
  signinModal.classList.add('hidden');
  siPassword.value = '';
  siMessage('');
}
$('si-close').addEventListener('click', closeSignInModal);
$('si-mode').addEventListener('click', () => {
  setSignInMode(siMode === 'create' ? 'signin' : 'create');
  siMessage('');
});

/** Shared tail for any completed sign-in: report what happened, then rebuild
 *  the socket — linking keeps the uid (same identity), switching accounts
 *  does not, and either way the player row is keyed to it. */
function afterSignIn(res: { ok: true; switched: boolean } | { ok: false; error: string }) {
  refreshAccountChip();
  if (!res.ok) {
    siMessage(res.error, 'err');
    setStatus(res.error.toUpperCase());
    return;
  }
  closeSignInModal();
  setStatus(
    res.switched
      ? 'SIGNED IN TO YOUR EXISTING ACCOUNT — GUEST PROGRESS STAYED ON THIS DEVICE'
      : 'SIGNED IN — YOUR PROGRESS IS SAVED'
  );
  restartConnection();
}

// The primary route: email + password.
async function submitPassword() {
  const btn = $('si-submit') as HTMLButtonElement;
  btn.disabled = true;
  siMessage(siMode === 'create' ? 'CREATING…' : 'SIGNING IN…');
  const res =
    siMode === 'create'
      ? await signUpWithPassword(siEmail.value, siPassword.value)
      : await signInWithPassword(siEmail.value, siPassword.value);
  btn.disabled = false;
  // "That email already has an account" is not a dead end — it is a nudge to
  // the other mode, so flip the form there with the address still filled in.
  if (!res.ok && /already has an account/i.test(res.error)) {
    setSignInMode('signin');
    siPassword.focus();
  }
  afterSignIn(res);
}
$('si-submit').addEventListener('click', () => void submitPassword());
for (const input of [siEmail, siPassword]) {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); void submitPassword(); }
  });
}

$('si-forgot').addEventListener('click', async () => {
  const btn = $('si-forgot') as HTMLButtonElement;
  btn.disabled = true;
  const res = await sendPasswordReset(siEmail.value);
  btn.disabled = false;
  if (res.ok) siMessage(`RESET LINK SENT TO ${siEmail.value.trim().toUpperCase()}`, 'ok');
  else siMessage(res.error, 'err');
});

// Secondary routes.
$('si-google').addEventListener('click', async () => {
  const btn = $('si-google') as HTMLButtonElement;
  btn.disabled = true;
  siMessage('OPENING GOOGLE…');
  const res = await signInWithGoogle();
  btn.disabled = false;
  afterSignIn(res);
});

$('si-link').addEventListener('click', async () => {
  const btn = $('si-link') as HTMLButtonElement;
  btn.disabled = true;
  siMessage('SENDING…');
  const res = await sendEmailLink(siEmail.value);
  btn.disabled = false;
  if (!res.ok) {
    siMessage(res.error, 'err');
    return;
  }
  siMessage(`LINK SENT TO ${siEmail.value.trim().toUpperCase()} — OPEN IT ON THIS DEVICE`, 'ok');
});

function openNameModal(then: (() => void) | null = null) {
  afterName = then;
  nameInput.value = storedName();
  nameModal.classList.remove('hidden');
  nameInput.focus();
}

function closeNameModal() {
  afterName = null;
  nameModal.classList.add('hidden');
}

function confirmName() {
  const name = nameInput.value.trim().toUpperCase().slice(0, 16);
  if (!name) {
    nameInput.focus();
    return;
  }
  localStorage.setItem('df_name', name);
  refreshNameTag();
  // already in a lobby (name edited mid-session): push it to the server now
  if (getMyPlayer()) conn.reducers.setName({ name });
  nameModal.classList.add('hidden');
  const then = afterName;
  afterName = null;
  then?.();
}

$('name-confirm').addEventListener('click', confirmName);
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmName();
});
$('name-edit').addEventListener('click', () => openNameModal());

type PendingAction = 'create' | 'practice' | 'join' | 'tournament';
let pendingAction: PendingAction | null = null;
let pendingCode = '';
// the live match a spectator asked for; the view follows it until it ends,
// then falls back to whatever else is running in the room
let spectateMatchId: bigint | null = null;
let selectedChar = Math.min(CHARACTERS.length - 1, Number(localStorage.getItem('df_char') ?? 0) || 0);
let selectedPitch = 0;
let selectedConcurrent = 2;
let selectedFormat = Math.min(1, Number(localStorage.getItem('df_format') ?? 0) || 0);
let selectedBotLevel = Math.min(2, Number(localStorage.getItem('df_bot') ?? 1) || 0);
let selectedPublic = true;
let selectedTeamSize = Math.min(3, Number(localStorage.getItem('df_team') ?? 1) || 1);

const VISIBILITY_OPTIONS = [
  { id: 1, name: 'PUBLIC', desc: 'ANYONE CAN JOIN FROM THE MENU' },
  { id: 0, name: 'PRIVATE', desc: 'INVITE ONLY — SHARE THE LINK' },
];

const TEAM_SIZE_OPTIONS = [
  { id: 1, name: '1V1 SOLO', desc: 'ONE OUTFIELD PLAYER A SIDE (PLUS KEEPERS)' },
  { id: 2, name: '2V2', desc: 'FOUR PLAYERS · TWO PER SIDE' },
  { id: 3, name: '3V3', desc: 'SIX PLAYERS · THREE PER SIDE' },
];

// Custom rules — ball physics (percent sliders; 100 = standard)
interface PhysSlider {
  key: 'gravityMul' | 'frictionMul' | 'powerMul' | 'bounceMul';
  label: string;
  min: number;
  max: number;
  def: number;
}
const PHYS_SLIDERS: PhysSlider[] = [
  { key: 'gravityMul', label: 'BALL WEIGHT', min: 30, max: 250, def: 100 },
  { key: 'frictionMul', label: 'FRICTION', min: 30, max: 220, def: 100 },
  { key: 'powerMul', label: 'KICK POWER', min: 50, max: 180, def: 100 },
  { key: 'bounceMul', label: 'BOUNCE', min: 40, max: 160, def: 100 },
];
const PHYS_PRESETS: { name: string; v: [number, number, number, number] }[] = [
  { name: 'STANDARD', v: [100, 100, 100, 100] },
  { name: 'MOON BALL', v: [45, 70, 85, 125] },
  { name: 'CANNON', v: [140, 100, 165, 70] },
  { name: 'BEACH BALL', v: [55, 130, 80, 150] },
];
const physValues: Record<PhysSlider['key'], number> = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('df_phys') ?? '{}');
    return {
      gravityMul: Number(saved.gravityMul) || 100,
      frictionMul: Number(saved.frictionMul) || 100,
      powerMul: Number(saved.powerMul) || 100,
      bounceMul: Number(saved.bounceMul) || 100,
    };
  } catch {
    return { gravityMul: 100, frictionMul: 100, powerMul: 100, bounceMul: 100 };
  }
})();

function physPayload() {
  localStorage.setItem('df_phys', JSON.stringify(physValues));
  return {
    gravityMul: physValues.gravityMul / 100,
    frictionMul: physValues.frictionMul / 100,
    powerMul: physValues.powerMul / 100,
    bounceMul: physValues.bounceMul / 100,
  };
}

// Tournament formats (mirror spacetimedb/src/index.ts)
const FORMAT_SINGLE = 0;
const FORMAT_DOUBLE = 1;
const FORMAT_CARDS = [
  { id: FORMAT_SINGLE, name: 'SINGLE ELIM', desc: 'LOSE ONCE AND YOU\'RE OUT' },
  { id: FORMAT_DOUBLE, name: 'DOUBLE ELIM', desc: 'LOSERS BRACKET SECOND CHANCE' },
];
const FORMAT_NAMES = ['SINGLE ELIMINATION', 'DOUBLE ELIMINATION'];

const BOT_LEVEL_CARDS = [
  { id: 0, name: 'EASY', desc: 'SLOW · LOOSE TOUCH' },
  { id: 1, name: 'NORMAL', desc: 'FAIR GAME' },
  { id: 2, name: 'HARD', desc: 'FAST · TACKLES · PUNISHES' },
];

const cssHex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

// Async entrance cascade: each child gets its ripple index (--i) so the CSS
// itemIn animation staggers them whenever their screen is (re)shown.
function staggerChildren(container: HTMLElement) {
  let i = 0;
  for (const el of container.children) (el as HTMLElement).style.setProperty('--i', String(i++));
}

function buildSelectGrids() {
  const charGrid = $('char-grid');
  // each card carries a live 3D preview of its character: the empty slot
  // spans reserve layout space, and render.ts scissors a shared WebGL
  // canvas (fixed over the screen) into one animated viewport per slot
  const previewSlots: { char: Character; el: HTMLElement }[] = [];
  for (const c of CHARACTERS) {
    const card = document.createElement('button');
    card.className = 'sel-card';
    card.dataset.id = String(c.id);
    const statHtml = STAT_LABELS.map(([key, label]) => {
      const v = c.stats[key];
      let pips = '';
      for (let i = 1; i <= 5; i++) pips += `<i class="pip${i <= v ? ' on' : ''}"></i>`;
      return `<div class="stat-row"><span class="stat-name">${label}</span><span class="stat-pips">${pips}</span></div>`;
    }).join('');
    card.innerHTML =
      `<span class="preview-slot" style="--glow:${c.css}"></span>` +
      `<div class="cname">${c.name}</div><div class="cmeta">${c.flag} ${c.country} · ${c.style}</div>` +
      `<div class="stat-grid">${statHtml}</div>`;
    card.addEventListener('click', () => {
      selectedChar = c.id;
      refreshSelection();
    });
    charGrid.appendChild(card);
    previewSlots.push({ char: c, el: card.querySelector('.preview-slot')! });
  }
  staggerChildren(charGrid);
  initCharacterPreviews($('char-preview') as HTMLCanvasElement, previewSlots, charGrid);
  const pitchGrid = $('court-grid');
  for (const c of PITCHES) {
    const card = document.createElement('button');
    card.className = 'sel-card';
    card.dataset.id = String(c.id);
    card.innerHTML =
      `<span class="court-thumb" style="--surf:${c.css}"><span class="ct-lines"></span></span>` +
      `<div class="cname">${c.name}</div><div class="cmeta">${c.desc}</div>`;
    card.addEventListener('click', () => {
      selectedPitch = c.id;
      refreshSelection();
    });
    pitchGrid.appendChild(card);
  }
  staggerChildren(pitchGrid);
  const formatGrid = $('format-grid');
  for (const f of FORMAT_CARDS) {
    const card = document.createElement('button');
    card.className = 'sel-card';
    card.dataset.id = String(f.id);
    card.title = f.desc;
    card.innerHTML = `<div class="cname">${f.name}</div>`;
    card.addEventListener('click', () => {
      selectedFormat = f.id;
      localStorage.setItem('df_format', String(f.id));
      refreshSelection();
    });
    formatGrid.appendChild(card);
  }
  const concRow = $('concurrent-grid');
  for (const n of [1, 2, 3, 4]) {
    const card = document.createElement('button');
    card.className = 'sel-card conc-card';
    card.dataset.id = String(n);
    card.title = `${n} pitch${n > 1 ? 'es' : ''} at once`;
    card.innerHTML = `<div class="cname">${n}</div>`;
    card.addEventListener('click', () => {
      selectedConcurrent = n;
      refreshSelection();
    });
    concRow.appendChild(card);
  }
  const teamGrid = $('teamsize-grid');
  for (const opt of TEAM_SIZE_OPTIONS) {
    const card = document.createElement('button');
    card.className = 'sel-card';
    card.dataset.id = String(opt.id);
    card.title = opt.desc;
    card.innerHTML = `<div class="cname">${opt.id === 2 ? '👥' : '⚽'} ${opt.name}</div>`;
    card.addEventListener('click', () => {
      selectedTeamSize = opt.id;
      localStorage.setItem('df_team', String(opt.id));
      refreshSelection();
    });
    teamGrid.appendChild(card);
  }
  const diffGrid = $('difficulty-grid');
  for (const lvl of BOT_LEVEL_CARDS) {
    const card = document.createElement('button');
    card.className = 'sel-card';
    card.dataset.id = String(lvl.id);
    card.title = lvl.desc;
    card.innerHTML = `<div class="cname"><span class="tier-dot t${lvl.id}"></span>${lvl.name}</div>`;
    card.addEventListener('click', () => {
      selectedBotLevel = lvl.id;
      localStorage.setItem('df_bot', String(lvl.id));
      refreshSelection();
    });
    diffGrid.appendChild(card);
  }
  const presetRow = $('phys-presets');
  for (const preset of PHYS_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = preset.name;
    btn.addEventListener('click', () => {
      PHYS_SLIDERS.forEach((s, i) => {
        physValues[s.key] = preset.v[i];
      });
      refreshPhysSliders();
    });
    presetRow.appendChild(btn);
  }
  const sliderBox = $('phys-sliders');
  for (const s of PHYS_SLIDERS) {
    const row = document.createElement('div');
    row.className = 'phys-row';
    const label = document.createElement('label');
    label.textContent = s.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = '5';
    input.dataset.key = s.key;
    const val = document.createElement('span');
    val.className = 'phys-val';
    input.addEventListener('input', () => {
      physValues[s.key] = Number(input.value);
      val.textContent = `${input.value}%`;
      updateRulesSummary();
    });
    row.append(label, input, val);
    sliderBox.appendChild(row);
  }
  refreshPhysSliders();
  const visGrid = $('visibility-grid');
  for (const v of VISIBILITY_OPTIONS) {
    const card = document.createElement('button');
    card.className = 'sel-card';
    card.dataset.id = String(v.id);
    card.title = v.desc;
    card.innerHTML = `<div class="cname">${v.id === 1 ? '🌐' : '🔒'} ${v.name}</div>`;
    card.addEventListener('click', () => {
      selectedPublic = v.id === 1;
      refreshSelection();
    });
    visGrid.appendChild(card);
  }
  refreshSelection();
}

function refreshPhysSliders() {
  for (const input of document.querySelectorAll<HTMLInputElement>('#phys-sliders input')) {
    const key = input.dataset.key as PhysSlider['key'];
    input.value = String(physValues[key]);
    (input.nextElementSibling as HTMLElement).textContent = `${physValues[key]}%`;
  }
  updateRulesSummary();
}

// The Custom Rules row on the pitch screen shows what the submenu holds.
function physPresetName(): string {
  for (const p of PHYS_PRESETS) {
    if (PHYS_SLIDERS.every((s, i) => physValues[s.key] === p.v[i])) return p.name;
  }
  return 'CUSTOM';
}

function updateRulesSummary() {
  const bits = [`${physPresetName()} PHYSICS`];
  if ((pendingAction === 'create' || pendingAction === 'tournament') && selectedTeamSize > 1) {
    bits.unshift(TEAM_SIZE_OPTIONS.find(o => o.id === selectedTeamSize)?.name ?? '');
  }
  if (pendingAction === 'tournament') {
    bits.push(FORMAT_CARDS[selectedFormat]?.name ?? '');
    if (selectedConcurrent > 1) bits.push(`${selectedConcurrent} PITCHES`);
  }
  $('rules-summary').textContent = bits.filter(Boolean).join(' · ');
}

function refreshSelection() {
  for (const card of document.querySelectorAll('#char-grid .sel-card')) {
    card.classList.toggle('selected', card.getAttribute('data-id') === String(selectedChar));
  }
  for (const card of document.querySelectorAll('#court-grid .sel-card')) {
    card.classList.toggle('selected', card.getAttribute('data-id') === String(selectedPitch));
  }
  for (const card of document.querySelectorAll('#concurrent-grid .sel-card')) {
    card.classList.toggle('selected', card.getAttribute('data-id') === String(selectedConcurrent));
  }
  for (const card of document.querySelectorAll('#format-grid .sel-card')) {
    card.classList.toggle('selected', card.getAttribute('data-id') === String(selectedFormat));
  }
  for (const card of document.querySelectorAll('#difficulty-grid .sel-card')) {
    card.classList.toggle('selected', card.getAttribute('data-id') === String(selectedBotLevel));
  }
  for (const card of document.querySelectorAll('#visibility-grid .sel-card')) {
    card.classList.toggle('selected', card.getAttribute('data-id') === String(selectedPublic ? 1 : 0));
  }
  for (const card of document.querySelectorAll('#teamsize-grid .sel-card')) {
    card.classList.toggle('selected', card.getAttribute('data-id') === String(selectedTeamSize));
  }
  updateRulesSummary();
  const ch = CHARACTERS[selectedChar];
  $('char-style').textContent = ch ? `${ch.name} · ${ch.country} · ${ch.style}` : '';
}

function startFlow(action: PendingAction, code = '') {
  // no name yet — collect it first, then resume exactly this flow
  if (!storedName()) {
    openNameModal(() => startFlow(action, code));
    return;
  }
  pendingAction = action;
  pendingCode = code;
  showOverlay('selectPlayer');
}

$('create-btn').addEventListener('click', () => startFlow('create'));
$('practice-btn').addEventListener('click', () => startFlow('practice'));
$('tournament-btn').addEventListener('click', () => startFlow('tournament'));

$('char-back').addEventListener('click', () => {
  pendingAction = null;
  showOverlay('menu');
});
$('char-confirm').addEventListener('click', () => {
  localStorage.setItem('df_char', String(selectedChar));
  conn.reducers.setName({ name: playerName() });
  conn.reducers.setCharacter({ characterId: selectedChar });
  if (pendingAction === 'join') {
    doJoin(pendingCode);
    pendingAction = null;
  } else {
    $('format-section').classList.toggle('hidden', pendingAction !== 'tournament');
    $('concurrent-section').classList.toggle('hidden', pendingAction !== 'tournament');
    $('difficulty-section').classList.toggle('hidden', pendingAction !== 'practice');
    // 2v2/3v3 team play: quick matches AND tournaments pick a match type
    $('teamsize-section').classList.toggle(
      'hidden',
      pendingAction !== 'create' && pendingAction !== 'tournament'
    );
    // solo practice has nothing to list publicly
    $('visibility-section').classList.toggle('hidden', pendingAction === 'practice');
    updateRulesSummary();
    showOverlay('selectPitch');
  }
});
$('court-back').addEventListener('click', () => showOverlay('selectPlayer'));
$('rules-open').addEventListener('click', () => $('rules-modal').classList.remove('hidden'));
$('rules-done').addEventListener('click', () => $('rules-modal').classList.add('hidden'));
$('court-confirm').addEventListener('click', () => {
  const phys = physPayload();
  if (pendingAction === 'create') {
    conn.reducers.createLobby({
      pitch: selectedPitch, isPublic: selectedPublic,
      teamSize: selectedTeamSize, ...phys,
    });
  } else if (pendingAction === 'practice') {
    conn.reducers.createPractice({
      pitch: selectedPitch, botLevel: selectedBotLevel, ...phys,
    });
  } else if (pendingAction === 'tournament') {
    conn.reducers.createTournament({
      pitch: selectedPitch, concurrent: selectedConcurrent, isPublic: selectedPublic,
      format: selectedFormat, teamSize: selectedTeamSize, ...phys,
    });
  }
  pendingAction = null;
});

function doJoin(code: string) {
  conn.reducers.joinLobby({ code: code.toUpperCase() });
  setStatus('JOINING...');
  setTimeout(() => {
    const me = getMyPlayer();
    if (!me || me.lobbyId === 0n) {
      setStatus('COULD NOT JOIN — CHECK THE CODE');
      showOverlay('menu');
    }
  }, 2000);
}

function tryJoin(code: string) {
  if (code.length < 5) {
    setStatus('ENTER THE 5-LETTER LOBBY CODE');
    return;
  }
  startFlow('join', code);
}

// ---------------------------------------------------------------------------
// Public lobby browser (menu screen)
// ---------------------------------------------------------------------------
let lastLobbyListKey: string | null = null;

// One row builder for both menu lists — same chrome, different contents.
function lobbyRow(
  cls: string, badge: string, title: string, sub: string,
  action: string, btnCls: string, onClick: () => void, disabled = false
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lobby-row' + cls;
  const mode = document.createElement('span');
  mode.className = 'lobby-mode';
  mode.textContent = badge;
  const meta = document.createElement('span');
  meta.className = 'lobby-meta';
  const titleEl = document.createElement('span');
  titleEl.className = 'lobby-host';
  titleEl.textContent = title;
  const subEl = document.createElement('span');
  subEl.className = 'lobby-sub';
  subEl.textContent = sub;
  meta.append(titleEl, subEl);
  const btn = document.createElement('button');
  btn.className = 'lobby-join' + btnCls;
  btn.textContent = action;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  row.append(mode, meta, btn);
  return row;
}

function emptyRow(list: HTMLElement, text: string) {
  const empty = document.createElement('div');
  empty.className = 'lobby-empty';
  empty.textContent = text;
  list.appendChild(empty);
}

// Rooms you can still walk into as a PLAYER. Anything already under way is
// watchable instead, and lives in the live-match list below.
function updateLobbyBrowser() {
  const rows: any[] = [];
  for (const l of conn.db.lobby.iter()) {
    if (!l.isPublic || l.vsBot || l.status !== L_OPEN) continue;
    rows.push(l);
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // spectators hold no slot, so they don't count toward a room being full
  const counts = new Map<string, number>();
  for (const p of conn.db.player.iter()) {
    if (p.lobbyId === 0n || p.isBot || p.spectator) continue;
    const k = String(p.lobbyId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const key = rows
    .map(l => `${l.id}:${counts.get(String(l.id)) ?? 0}:${playerByIdentity(l.hostId)?.name ?? ''}`)
    .join('|');
  if (key === lastLobbyListKey) return;
  lastLobbyListKey = key;

  const list = $('lobby-list');
  list.innerHTML = '';
  if (!rows.length) {
    emptyRow(list, 'NO OPEN LOBBIES — CREATE ONE AND MAKE IT PUBLIC');
    return;
  }
  for (const l of rows) {
    const isTournament = l.mode === MODE_TOURNAMENT;
    const players = counts.get(String(l.id)) ?? 0;
    const host = playerByIdentity(l.hostId)?.name || 'PLAYER';
    const pitch = PITCHES[l.pitch ?? 0];
    const capacity = (l.teamSize ?? 1) * 2;
    const full = isTournament && players >= MAX_TOURNAMENT_PLAYERS;
    const slots = isTournament
      ? `${players}/${MAX_TOURNAMENT_PLAYERS}`
      : `${players}/${capacity}`;
    list.appendChild(
      lobbyRow(
        isTournament ? ' tourney' : '',
        isTournament
          ? '🏆 TOURNEY'
          : capacity > 2
            ? `👥 ${capacity / 2}V${capacity / 2}`
            : '⚽ 1V1',
        `${host}'S ${isTournament ? 'TOURNAMENT' : 'MATCH'}`,
        `${pitch?.name ?? '?'} · ${slots} PLAYERS`,
        full ? 'Full' : 'Join',
        '',
        () => startFlow('join', l.code),
        full
      )
    );
  }
  staggerChildren(list);
}

// ---------------------------------------------------------------------------
// Live match list (menu screen) — every match running in a public room
// ---------------------------------------------------------------------------
let lastLiveListKey: string | null = null;

function liveMatchRows(): { match: any; lobby: any }[] {
  const out: { match: any; lobby: any }[] = [];
  for (const m of conn.db.match.iter()) {
    if (m.state !== M_LIVE || !m.hasP1) continue;
    const lobby = getLobby(m.lobbyId);
    if (!lobby || !lobby.isPublic || lobby.status === L_FINISHED) continue;
    out.push({ match: m, lobby });
  }
  out.sort((a, b) => (a.match.id < b.match.id ? -1 : a.match.id > b.match.id ? 1 : 0));
  return out;
}

function scoreLine(m: any): string {
  return `${m.p0Goals}-${m.p1Goals} · ${halfLabel(m)} ${clockText(m)}`;
}

function updateLiveMatches() {
  const rows = liveMatchRows();

  const watchers = new Map<string, number>();
  for (const p of conn.db.player.iter()) {
    if (!p.spectator || p.lobbyId === 0n) continue;
    const k = String(p.lobbyId);
    watchers.set(k, (watchers.get(k) ?? 0) + 1);
  }

  const key = rows
    .map(({ match: m, lobby: l }) => {
      const p0 = playerByIdentity(m.p0Id)?.name ?? '';
      const p1 = playerByIdentity(m.p1Id)?.name ?? '';
      return `${m.id}:${p0}v${p1}:${scoreLine(m)}:${watchers.get(String(l.id)) ?? 0}`;
    })
    .join('|');
  if (key === lastLiveListKey) return;
  lastLiveListKey = key;

  const list = $('live-list');
  list.innerHTML = '';
  if (!rows.length) {
    emptyRow(list, 'NO MATCHES IN PLAY RIGHT NOW');
    return;
  }
  for (const { match: m, lobby: l } of rows) {
    const isTournament = l.mode === MODE_TOURNAMENT;
    const p0 = playerByIdentity(m.p0Id)?.name || 'PLAYER 1';
    const p1 = playerByIdentity(m.p1Id)?.name || 'PLAYER 2';
    const pitch = PITCHES[l.pitch ?? 0];
    const eyes = watchers.get(String(l.id)) ?? 0;
    const bits = [pitch?.name ?? '?', scoreLine(m)];
    if (eyes) bits.push(`👁 ${eyes}`);
    list.appendChild(
      lobbyRow(
        ' live',
        isTournament ? `🏆 ROUND ${m.round}` : '🔴 LIVE',
        `${p0} vs ${p1}`,
        bits.join(' · '),
        'Watch',
        ' alt',
        () => spectate(m.id)
      )
    );
  }
}

// Watch a live match: no character to pick, no pitch to choose — go straight
// to the touchline as a spectator.
function spectate(matchId: bigint) {
  // same required gate as startFlow: watchers chat under their name
  if (!storedName()) {
    openNameModal(() => spectate(matchId));
    return;
  }
  spectateMatchId = matchId;
  conn.reducers.setName({ name: playerName() });
  conn.reducers.spectateMatch({ matchId });
  setStatus('TAKING YOUR SEAT IN THE STAND…');
  setTimeout(() => {
    const me = getMyPlayer();
    if (!me || me.lobbyId === 0n) {
      spectateMatchId = null;
      setStatus('THAT MATCH IS NO LONGER RUNNING');
    }
  }, 2000);
}

$('join-btn').addEventListener('click', () => tryJoin(codeInput.value.trim()));
codeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') tryJoin(codeInput.value.trim());
});

$('leave-btn').addEventListener('click', () => leaveRoom());
$('spectate-exit').addEventListener('click', () => leaveRoom());
$('exit-btn').addEventListener('click', () => {
  leaveRoom();
  history.replaceState(null, '', location.pathname);
});

function leaveRoom() {
  spectateMatchId = null;
  conn.reducers.leaveLobby({});
}
$('rematch-btn').addEventListener('click', () => {
  // on the tournament result screen this button is CONTINUE, not a rematch
  if (tourneyResultShowing) {
    tourneyResultSeen = tourneyResultShowing;
    tourneyResultShowing = null;
    return;
  }
  conn.reducers.rematch({});
});
$('start-tournament-btn').addEventListener('click', () => conn.reducers.startTournament({}));

// Host-only tournament settings on the registration screen. Each button sends
// its own value plus the room's current value for the other setting.
for (const btn of document.querySelectorAll<HTMLButtonElement>('#tourney-settings .setting-btn')) {
  btn.addEventListener('click', () => {
    const me = getMyPlayer();
    const room = me && me.lobbyId !== 0n ? getLobby(me.lobbyId) : null;
    if (!room) return;
    conn.reducers.setTournamentSettings({
      format: btn.dataset.format != null ? Number(btn.dataset.format) : (room.format ?? 0),
      concurrent: btn.dataset.conc != null ? Number(btn.dataset.conc) : (room.concurrent ?? 1),
      teamSize: btn.dataset.team != null ? Number(btn.dataset.team) : (room.teamSize ?? 1),
    });
  });
}

let copyResetTimer = 0;
$('copy-link-btn').addEventListener('click', () => {
  const code = $('lobby-code').textContent ?? '';
  navigator.clipboard.writeText(`${location.origin}${location.pathname}?lobby=${code}`);
  const btn = $('copy-link-btn');
  btn.textContent = '✓ Copied!';
  btn.classList.add('copied');
  clearTimeout(copyResetTimer);
  copyResetTimer = window.setTimeout(() => {
    btn.textContent = 'Copy Link';
    btn.classList.remove('copied');
  }, 1500);
});

function onSubscribed() {
  nameInput.value = storedName();
  refreshNameTag();
  const linkCode = new URLSearchParams(location.search).get('lobby');
  const me = getMyPlayer();
  if (linkCode && me && me.lobbyId === 0n) {
    codeInput.value = linkCode.toUpperCase();
    startFlow('join', linkCode.trim()); // gated by the name modal if needed
  } else if (!storedName()) {
    // first visit: the name comes before anything else
    openNameModal();
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const pressed = new Set<string>();
let lastSent = { dirX: 0, dirY: 0, sprint: false };

const MOVE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};
// Three context-sensitive action buttons — the server decides what each one
// means from the situation (see actionLabels), so there is nothing to hold,
// charge or release: one press, one action. SPRINT is a held modifier folded
// into setInput.
const ACT_KEYS: Record<string, number> = {
  Space: 0, KeyJ: 0,
  KeyK: 1,
  KeyL: 2,
};
// Switch to another team-mate. Q and Tab are where football games put it;
// Tab needs preventDefault or the browser walks focus out of the canvas.
const SWITCH_KEYS = new Set(['KeyQ', 'Tab']);
const SPRINT_KEYS = new Set(['ShiftLeft']);

function doAction(button: number) {
  conn.reducers.action({ button });
}

/**
 * What the three action buttons mean RIGHT NOW.
 *
 * Mirrors the situation ladder in the module's `action` reducer — keeper
 * with the ball in its hands, then a set piece, then possession, then
 * everything else — because one press does a different thing in each of
 * them and a button whose meaning you have to guess is no better than no
 * button at all.
 */
type ActionLabels = [string, string, string];
const ACT_CHASING: ActionLabels = ['TACKLE', 'SLIDE', 'SWITCH'];
const ACT_ON_BALL: ActionLabels = ['PASS', 'LOB', 'SHOOT'];

function actionLabels(match: any, ball: any, body: any): ActionLabels {
  if (!match || !ball || !body) return ACT_CHASING;
  if ((body.role ?? 0) === ROLE_KEEPER && (body.holdTicks ?? 0) > 0)
    return ['THROW', 'LONG BALL', 'PUT DOWN'];
  // the restart is only yours to take once you have walked to the ball —
  // same test the reducer makes, so the labels can't promise a throw-in the
  // server would refuse
  const takingRestart =
    (match.graceTicks ?? 0) > 0 &&
    match.restartSide === body.side &&
    Math.hypot(ball.x - body.x, ball.y - body.y) < KICK_RANGE + 2;
  // A kickoff runs through the server's SET-PIECE branch, where button 2 is a
  // short ball, not a shot — you are 66 units from goal, so labelling it
  // SHOOT would promise something the reducer will not do.
  const atKickoff = match.phase === PHASE_KICKOFF && match.kickoffSide === body.side;
  if (atKickoff) return ['PASS', 'LOB', 'SHORT'];
  if (takingRestart) {
    switch (match.restartKind) {
      case RK_THROWIN: return ['THROW IN', 'LONG THROW', 'SHORT THROW'];
      case RK_CORNER: return ['CORNER', 'HIGH CORNER', 'SHORT CORNER'];
      case RK_GOALKICK: return ['GOAL KICK', 'LONG BALL', 'SHORT'];
      default: return ['PASS', 'LOB', 'SHORT'];
    }
  }
  if (ball.hasOwner && ball.ownerId.toHexString() === body.identity.toHexString())
    return ACT_ON_BALL;
  return ACT_CHASING;
}
const EMOTE_KEYS: Record<string, number> = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3,
  Digit5: 4, Digit6: 5, Digit7: 6, Digit8: 7,
};

function currentFlip(): number {
  const me = getMyPlayer();
  if (!me || me.matchId === 0n) return 1;
  return me.side === 1 ? -1 : 1;
}

function keyboardDir(): [number, number] {
  let dx = 0;
  let dy = 0;
  for (const key of pressed) {
    const v = MOVE_KEYS[key];
    if (v) {
      dx += v[0];
      dy += v[1];
    }
  }
  return [dx, dy];
}

// Browsers hand back a fixed 4-slot array with nulls: the pad is NOT
// guaranteed to sit at index 0 (Bluetooth pads and reconnects often land at
// 1-3), and Chrome fills a slot only after a button is pressed while the
// page has focus. Always scan for the first live pad.
function activePad(): Gamepad | null {
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (gp && gp.connected) return gp;
  }
  return null;
}
// Which device produced the last input? Drives the help-line hints.
let padUsedAt = 0;
let keysUsedAt = 0;
function usingPad(): boolean {
  return padUsedAt > keysUsedAt && !!activePad();
}
// Chrome fires this after the first button press — surface the menu focus
// ring right away so the controller visibly works.
window.addEventListener('gamepadconnected', () => {
  padUsedAt = performance.now();
});

// Ⓐ/Ⓑ/Ⓧ are action buttons 0/1/2 · right trigger SPRINT.
const GP_ACT = [0, 1, 2];
const GP_SPRINT = 7;
const GP_SWITCH = 4; // left bumper, where every football game puts it
const gpPrev: Record<number, boolean> = {};
// Read by the frame loop alongside the stick, so the sprint bit rides along
// on the same setInput the direction does.
let padSprint = false;

function pollGamepad(): [number, number] | null {
  const gp = activePad();
  if (!gp) {
    padSprint = false;
    return null;
  }
  const edge = (i: number) => {
    const down = gp.buttons[i]?.pressed ?? false;
    const was = gpPrev[i] ?? false;
    gpPrev[i] = down;
    if (down) padUsedAt = performance.now();
    return { down, pressed: down && !was };
  };
  GP_ACT.forEach((btn, button) => {
    if (edge(btn).pressed) doAction(button);
  });
  if (edge(GP_SWITCH).pressed) conn.reducers.switchPlayer({});
  padSprint = edge(GP_SPRINT).down || (gp.buttons[GP_SPRINT]?.value ?? 0) > 0.4;
  const ax = gp.axes[0] ?? 0;
  const ay = gp.axes[1] ?? 0;
  if (Math.hypot(ax, ay) < 0.35) return [0, 0];
  padUsedAt = performance.now();
  const dx = Math.abs(ax) > 0.35 ? Math.sign(ax) : 0;
  const dy = Math.abs(ay) > 0.35 ? -Math.sign(ay) : 0;
  return [dx, dy];
}

/**
 * Screen-space stick -> world direction.
 *
 * The renderer TRANSPOSES the world: `toThree(flip, wx, wy, wz)` is
 * `(wy*flip, wz, wx*flip)`, so screen-horizontal is world Y and screen-DEPTH
 * is world X, with the camera parked at +z looking toward -z. Sending the
 * stick straight through as (x, y) — which is what the old tennis camera,
 * looking down the length of the pitch, wanted — rotates every control by 90
 * degrees and makes the game unplayable.
 *
 * Right on screen  = +three.x = wy*flip increasing  -> dirY = +dx*flip
 * Up the screen    = -three.z = wx*flip decreasing  -> dirX = -dy*flip
 *
 * `flip` keeps both sides attacking screen-right, and it cancels correctly
 * here: it is applied to the same axes the renderer applies it to.
 */
function sendInput(dx: number, dy: number, sprint: boolean) {
  const flip = currentFlip();
  const dirX = -Math.sign(dy) * flip;
  const dirY = Math.sign(dx) * flip;
  // A handover gives me a different body, and this send is deduped against
  // the last one — so without re-arming here, the new man would never be
  // told what the stick is doing and would stand (or run) on whatever he
  // inherited until I physically changed direction.
  if (controlSeq !== lastSentSeq) {
    lastSentSeq = controlSeq;
    lastSent = { dirX: NaN, dirY: NaN, sprint: !sprint };
  }
  if (dirX !== lastSent.dirX || dirY !== lastSent.dirY || sprint !== lastSent.sprint) {
    lastSent = { dirX, dirY, sprint };
    conn.reducers.setInput({ dirX, dirY, sprint });
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('app').requestFullscreen().catch(() => {});
}
$('menu-fullscreen-btn').addEventListener('click', toggleFullscreen);

// ---------------------------------------------------------------------------
// Graphics options
// ---------------------------------------------------------------------------
// render.ts applies the WebGL side of these; here we own the panel, the DOM
// side (the VHS overlay is a CSS layer, not a WebGL pass) and the FPS readout
// so you can see what a switch actually bought you.
const gfxPanel = $('graphics');
const gfxRows = $('gfx-rows');
const vhsLayer = $('vhs');

interface GfxOption {
  label: string;
  value: number | boolean;
}
const ON_OFF: GfxOption[] = [
  { label: 'ON', value: true },
  { label: 'OFF', value: false },
];
const GFX_ROWS: {
  key: keyof GraphicsSettings;
  name: string;
  hint: string;
  opts: GfxOption[];
}[] = [
  {
    key: 'resolution', name: 'RESOLUTION', hint: 'internal render scale — the biggest win',
    opts: [
      { label: '100%', value: 1 },
      { label: '75%', value: 0.75 },
      { label: '50%', value: 0.5 },
    ],
  },
  {
    key: 'shadows', name: 'SHADOWS', hint: 'sun shadow map',
    opts: [
      { label: 'HIGH', value: 2 },
      { label: 'LOW', value: 1 },
      { label: 'OFF', value: 0 },
    ],
  },
  { key: 'antialias', name: 'ANTI-ALIASING', hint: 'smooth edges (MSAA)', opts: ON_OFF },
  { key: 'particles', name: 'PARTICLES', hint: 'impact sparks and dust', opts: ON_OFF },
  { key: 'trail', name: 'BALL TRAIL', hint: 'motion trail behind the ball', opts: ON_OFF },
  { key: 'detail', name: 'CROWD & DETAIL', hint: 'crowd stands, dugouts, pitch mow lines', opts: ON_OFF },
  { key: 'grade', name: 'FILM GRADE', hint: 'tone mapping and color wash', opts: ON_OFF },
  { key: 'vhs', name: 'VHS FILTER', hint: 'retro scanlines, flicker and tracking band', opts: ON_OFF },
  {
    key: 'fpsCap', name: 'FPS LIMIT', hint: 'caps GPU work — the game ticks at 20Hz anyway',
    opts: [
      { label: 'MAX', value: 0 },
      { label: '120', value: 120 },
      { label: '60', value: 60 },
      { label: '30', value: 30 },
    ],
  },
];
const GFX_PRESETS: { label: string; value: PresetName }[] = [
  { label: 'HIGH', value: 'high' },
  { label: 'MEDIUM', value: 'medium' },
  { label: 'LOW', value: 'low' },
];

const VOL_OPTS: GfxOption[] = [
  { label: '100%', value: 1 },
  { label: '75%', value: 0.75 },
  { label: '50%', value: 0.5 },
  { label: '25%', value: 0.25 },
  { label: 'OFF', value: 0 },
];
const AUDIO_ROWS: { key: keyof AudioSettings; name: string; hint: string }[] = [
  { key: 'master', name: 'MASTER VOLUME', hint: 'everything — OFF mutes (or press M)' },
  { key: 'sfx', name: 'GAME SFX', hint: 'kicks, bounces, whistles' },
  { key: 'crowd', name: 'CROWD', hint: 'stadium ambience and reactions' },
];

function gfxOptButton(label: string, pick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'gfx-opt';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    pick();
    btn.blur(); // Space is the kick key — never leave a button focused
  });
  return btn;
}

function gfxRow(name: string, hint: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'gfx-row';
  const label = document.createElement('div');
  label.className = 'gfx-name';
  label.textContent = name;
  const sub = document.createElement('div');
  sub.className = 'gfx-hint';
  sub.textContent = hint;
  label.appendChild(sub);
  const opts = document.createElement('div');
  opts.className = 'gfx-opts';
  row.append(label, opts);
  gfxRows.appendChild(row);
  return opts;
}

function buildGfxPanel() {
  // Display comes first — fullscreen lives here now, like a proper options
  // screen (F still toggles it anywhere).
  const fsOpts = gfxRow('FULLSCREEN', 'fill the whole screen (F)');
  for (const on of [true, false]) {
    const btn = gfxOptButton(on ? 'ON' : 'OFF', () => {
      if (!!document.fullscreenElement !== on) toggleFullscreen();
    });
    btn.dataset.fs = String(on);
    fsOpts.appendChild(btn);
  }
  document.addEventListener('fullscreenchange', refreshGfxPanel);
  const fsSep = document.createElement('div');
  fsSep.className = 'gfx-sep';
  gfxRows.appendChild(fsSep);

  const presetOpts = gfxRow('QUALITY', 'sets everything below in one click');
  for (const p of GFX_PRESETS) {
    const btn = gfxOptButton(p.label, () => applyPreset(p.value));
    btn.dataset.preset = p.value;
    presetOpts.appendChild(btn);
  }
  const sep = document.createElement('div');
  sep.className = 'gfx-sep';
  gfxRows.appendChild(sep);

  for (const row of GFX_ROWS) {
    const opts = gfxRow(row.name, row.hint);
    for (const opt of row.opts) {
      const btn = gfxOptButton(opt.label, () =>
        setGraphics({ [row.key]: opt.value } as Partial<GraphicsSettings>)
      );
      btn.dataset.key = row.key;
      btn.dataset.value = String(opt.value);
      opts.appendChild(btn);
    }
  }

  const audioSep = document.createElement('div');
  audioSep.className = 'gfx-sep';
  gfxRows.appendChild(audioSep);
  for (const row of AUDIO_ROWS) {
    const opts = gfxRow(row.name, row.hint);
    for (const opt of VOL_OPTS) {
      const btn = gfxOptButton(opt.label, () => {
        setAudio({ [row.key]: opt.value } as Partial<AudioSettings>);
        // audible feedback at the new level: the crowd row auditions the
        // crowd, everything else a soft SFX blip
        if (row.key === 'crowd') crowdCheer(0.5);
        else playBlip();
      });
      btn.dataset.akey = row.key;
      btn.dataset.value = String(opt.value);
      opts.appendChild(btn);
    }
  }
  refreshGfxPanel();
}

function refreshGfxPanel() {
  const fs = String(!!document.fullscreenElement);
  for (const btn of gfxRows.querySelectorAll<HTMLElement>('[data-fs]')) {
    btn.classList.toggle('selected', btn.dataset.fs === fs);
  }
  const s = getGraphics();
  const preset = presetOf(s);
  for (const btn of gfxRows.querySelectorAll<HTMLElement>('[data-preset]')) {
    btn.classList.toggle('selected', btn.dataset.preset === preset);
  }
  for (const btn of gfxRows.querySelectorAll<HTMLElement>('[data-key]')) {
    const key = btn.dataset.key as keyof GraphicsSettings;
    btn.classList.toggle('selected', String(s[key]) === btn.dataset.value);
  }
  const au = getAudio();
  for (const btn of gfxRows.querySelectorAll<HTMLElement>('[data-akey]')) {
    const key = btn.dataset.akey as keyof AudioSettings;
    btn.classList.toggle('selected', String(au[key]) === btn.dataset.value);
  }
}

function applyDomGraphics(s: GraphicsSettings) {
  vhsLayer.classList.toggle('hidden', !s.vhs);
}

const gfxPanelOpen = () => !gfxPanel.classList.contains('hidden');
function showGfxPanel(open: boolean) {
  gfxPanel.classList.toggle('hidden', !open);
}

$('menu-settings-btn').addEventListener('click', () => showGfxPanel(true));
$('waiting-settings-btn').addEventListener('click', () => showGfxPanel(true));
$('gfx-close').addEventListener('click', () => showGfxPanel(false));
onGraphicsChange(s => {
  applyDomGraphics(s);
  refreshGfxPanel();
  menuSceneKey = ''; // settings changed — the cached menu frame is stale
});
onAudioChange(refreshGfxPanel);
// coming back to a visible tab: force one redraw in case the last frame was
// skipped while hidden
document.addEventListener('visibilitychange', () => {
  menuSceneKey = '';
});
buildGfxPanel();
applyDomGraphics(getGraphics());

// Real rAF rate, sampled twice a second — only painted while the panel is up.
let fpsFrames = 0;
let fpsSince = performance.now();
function trackFps(now: number) {
  fpsFrames++;
  if (now - fpsSince < 500) return;
  const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
  fpsFrames = 0;
  fpsSince = now;
  if (gfxPanelOpen()) $('gfx-fps').textContent = `${fps} FPS`;
}

initTouch({
  action: button => {
    unlockAudio();
    doAction(button);
  },
  switchPlayer: () => {
    unlockAudio();
    conn.reducers.switchPlayer({});
  },
  chat: () => {
    const me = getMyPlayer();
    if (me && me.lobbyId !== 0n && !chatOpen) openChat();
  },
});

window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', e => {
  unlockAudio();
  if (e.target instanceof HTMLInputElement) return;
  keysUsedAt = performance.now();
  if (MOVE_KEYS[e.code]) {
    e.preventDefault();
    pressed.add(e.code);
  } else if (e.code in ACT_KEYS) {
    e.preventDefault();
    if (!e.repeat) doAction(ACT_KEYS[e.code]);
  } else if (SWITCH_KEYS.has(e.code)) {
    e.preventDefault();
    // repeats DO fire: holding switch cycles through your team-mates, which
    // is how you reach the man you actually want
    conn.reducers.switchPlayer({});
  } else if (SPRINT_KEYS.has(e.code)) {
    e.preventDefault();
    pressed.add(e.code); // held modifier — the frame loop reads it
  } else if (e.code === 'KeyF' && !e.repeat) {
    toggleFullscreen();
  } else if (e.code === 'KeyG' && !e.repeat) {
    showGfxPanel(!gfxPanelOpen());
  } else if (e.code === 'KeyM' && !e.repeat) {
    showToast(toggleMute() ? '🔇 MUTED' : '🔊 SOUND ON', '#8cf08c');
  } else if (e.code === 'Escape' && !e.repeat) {
    // pause-menu style: ESC opens/closes Settings anywhere, but first backs
    // out of whichever modal is on top
    if (!$('rules-modal').classList.contains('hidden')) {
      $('rules-modal').classList.add('hidden');
    } else if (!nameModal.classList.contains('hidden')) {
      if (storedName()) closeNameModal(); // no name yet? the modal stays
    } else if (!signinModal.classList.contains('hidden')) {
      closeSignInModal();
    } else if (matchMenuOpen()) {
      closeMatchMenu();
    } else if (inLiveMatch()) {
      // In a live match ESC is the match menu — the only route to forfeit,
      // so it can never be hit by accident mid-move.
      openMatchMenu();
    } else {
      showGfxPanel(!gfxPanelOpen());
    }
  } else if (e.code === 'KeyB' && !e.repeat) {
    bracketView = !bracketView;
  } else if (e.code === 'KeyN' && !e.repeat) {
    // watching a room with several live pitches: flip to the next one. Idle
    // tournament entrants get the same pitch hopping as menu watchers.
    const me = getMyPlayer();
    if (me && me.lobbyId !== 0n && me.matchId === 0n) {
      const live = lobbyMatchList(me.lobbyId).filter(m => m.state === M_LIVE);
      if (live.length > 1) {
        // the view falls back to the first live match when nothing is picked
        const cur =
          spectateMatchId !== null && live.some(m => m.id === spectateMatchId)
            ? spectateMatchId
            : live[0].id;
        const idx = live.findIndex(m => m.id === cur);
        spectateMatchId = live[(idx + 1) % live.length].id;
      }
    }
  } else if (e.code === 'Enter' && !e.repeat && !chatOpen) {
    const me = getMyPlayer();
    if (me && me.lobbyId !== 0n) {
      e.preventDefault();
      openChat();
    }
  } else if (e.code in EMOTE_KEYS && !e.repeat) {
    const me = getMyPlayer();
    if (me && me.lobbyId !== 0n && chatAllowed(true, ''))
      conn.reducers.sendEmote({ index: EMOTE_KEYS[e.code] });
  }
});
window.addEventListener('keyup', e => {
  if (MOVE_KEYS[e.code] || SPRINT_KEYS.has(e.code)) pressed.delete(e.code);
});

/** Is a sprint modifier down on any device? */
function sprintHeld(): boolean {
  for (const key of SPRINT_KEYS) if (pressed.has(key)) return true;
  return padSprint || touchSprint();
}
window.addEventListener('blur', () => pressed.clear());

// ---------------------------------------------------------------------------
// HUD: score plates, match clock, stamina / kick-power meters
// ---------------------------------------------------------------------------
const HALF_NAMES = ['1ST HALF', '2ND HALF', 'GOLDEN GOAL'];
const clockEl = $('matchclock');

/** 1ST HALF / 2ND HALF / GOLDEN GOAL. */
function halfLabel(match: any): string {
  return HALF_NAMES[Math.min(HALF_NAMES.length - 1, Math.max(0, (match.half ?? 1) - 1))];
}

/**
 * Football clocks count UP, and they do not reset at half time: the second
 * half starts where the first ended. The server counts DOWN within a half
 * (clockTicks), so elapsed is the half's length minus what is left, plus the
 * halves already played. Golden goal runs on past full time as sudden death.
 */
function clockText(match: any): string {
  const left = Math.ceil((match.clockTicks ?? 0) / TICK_HZ);
  const half = match.half ?? 1;
  const played = half >= 3 ? HALF_SECONDS * 2 : HALF_SECONDS * (half - 1);
  const lenOfThis = half >= 3 ? OT_SECONDS : HALF_SECONDS;
  // In sudden death the half's clock has expired but play continues, so this
  // simply holds at full time rather than ticking backwards.
  return fmtClock(played + Math.max(0, lenOfThis - left));
}

/**
 * The match minute a goal went in, the way a scoresheet writes it. The server
 * stores clockSecs as the seconds REMAINING in that half, so this converts to
 * elapsed and counts from 1 (football has no 0th minute).
 */
function goalMinute(g: any): number {
  const half = g.half ?? 1;
  const lenOfThis = half >= 3 ? OT_SECONDS : HALF_SECONDS;
  const played = half >= 3 ? HALF_SECONDS * 2 : HALF_SECONDS * (half - 1);
  const elapsed = played + Math.max(0, lenOfThis - (g.clockSecs ?? 0));
  return Math.floor(elapsed / 60) + 1;
}

const prevPlateScore = ['', ''];

// Odometer roll: a score cell whose value changed drops its new number in
// from above (scoreRoll keyframes; the plate's overflow clips the travel).
function rollScore(el: HTMLElement, text: string) {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('roll');
  void el.offsetWidth;
  el.classList.add('roll');
}

// Team play: the side's players sorted by seat, and the "A & B" scoreboard
// label (both mirror the server's naming in spacetimedb/src/index.ts).
// Keepers are bots the server spawns per match — they never carry the label.
function sidePlayers(players: any[], side: number): any[] {
  const outfield = players
    .filter(p => p.side === side && (p.role ?? 0) !== ROLE_KEEPER)
    .sort((a, b) => (a.teamSlot ?? 0) - (b.teamSlot ?? 0));
  // Name the PEOPLE. A 5-a-side lineup is mostly bot fillers, so listing every
  // body gives "ALICE & LM BOT & RM BOT & CB BOT". Fall back to named lobby
  // bots (the practice opponent, a bracket filler) when a side has no humans,
  // so "ACE BOT" still reads as an opponent rather than "TEAM 2".
  const humans = outfield.filter(p => !p.isBot);
  if (humans.length) return humans;
  return outfield.filter(p => !p.matchBot);
}
// Which rig draws a player: the renderer keeps SQUAD_SIZE rigs per side and
// parks every keeper on the last seat, because the module hands keepers
// teamSlot 0 — the first outfielder's seat.
// Remember the body control just left, for ~250 ms of fading ring.
const GHOST_MS = 250;
let ghostPrevSlot: number | undefined;
let ghostSlot: number | undefined;
let ghostAt = 0;
function ghostSlotNow(focus: number | undefined, now: number): number | undefined {
  if (focus !== ghostPrevSlot) {
    // only a HANDOFF leaves a ghost — arriving from nothing (match start,
    // leaving spectator mode) has no previous body to fade
    if (ghostPrevSlot !== undefined && focus !== undefined) {
      ghostSlot = ghostPrevSlot;
      ghostAt = now;
    }
    ghostPrevSlot = focus;
  }
  return ghostSlot !== undefined && now - ghostAt < GHOST_MS ? ghostSlot : undefined;
}

// Bumped whenever control lands on a different body, so sendInput knows to
// re-state the stick to the new man.
let controlSeq = 0;
let lastSentSeq = 0;
let controlBodyKey = '';
function noteControlBody(key: string) {
  if (key !== controlBodyKey) {
    controlBodyKey = key;
    controlSeq++;
  }
}

function rigSlotOf(p: any): number {
  // an outfielder never takes the keeper's seat: a teamSlot past the squad
  // would index a rig (and a head annotation) that doesn't exist
  const seat =
    (p.role ?? 0) === ROLE_KEEPER
      ? KEEPER_RIG_SEAT
      : Math.min(p.teamSlot ?? 0, KEEPER_RIG_SEAT - 1);
  return p.side * SQUAD_SIZE + seat;
}
function sideLabel(players: any[], side: number): string {
  return (
    sidePlayers(players, side)
      .map(p => p.name || 'PLAYER')
      .join(' & ') || `TEAM ${side + 1}`
  );
}

function updatePlates(match: any, players: any[], mySide: number) {
  for (const side of [0, 1] as const) {
    const plate = plates[side];
    const team = sidePlayers(players, side);
    // team play: the plate's meters track ME when I'm on this side, else seat 0
    const player = team.find(p => p.identity.toHexString() === myHex()) ?? team[0];
    const goals = String(side === 0 ? match.p0Goals : match.p1Goals);
    plate.querySelector('.pname')!.textContent = sideLabel(players, side);
    rollScore(plate.querySelector('.pgames') as HTMLElement, goals);
    // the kickoff side is the one restarting play — same convention the
    // kick-off dot carries
    plate.querySelector('.pserve')!.textContent =
      match.phase === PHASE_KICKOFF && match.kickoffSide === side ? '● KICK OFF' : '';
    plate.querySelector('.ppoints')!.textContent = '';

    // Stamina under the nameplate.
    const fill = plate.querySelector('.pmeter-fill') as HTMLElement;
    const mine = side === mySide;
    const stamina = mine ? (player?.stamina ?? STAMINA_MAX) / STAMINA_MAX : 0;
    fill.style.width = `${Math.max(0, Math.min(1, stamina)) * 100}%`;
    fill.classList.toggle('low', mine && stamina < 0.3);

    if (prevPlateScore[side] && prevPlateScore[side] !== goals) {
      plate.classList.remove('bump');
      void (plate as HTMLElement).offsetWidth;
      plate.classList.add('bump');
    }
    prevPlateScore[side] = goals;
  }
}

let prevClockKey = '';

function updateClock(match: any) {
  const left = Math.ceil((match.clockTicks ?? 0) / TICK_HZ);
  const key = `${left}|${match.half}`;
  if (key === prevClockKey) return;
  prevClockKey = key;
  // Counts UP, football-style — clockText does the conversion from the
  // server's remaining-in-this-half. `left` is still what decides urgency:
  // the red treatment belongs to the last half-minute of a half.
  $('mc-time').textContent = clockText(match);
  $('mc-half').textContent = halfLabel(match);
  clockEl.classList.toggle('urgent', left <= 30 && match.phase === PHASE_LIVE);
}

// Goal / restart card: the replay letterbox covers the top plates, so a
// broadcast lower third carries the score while the pause runs.
function updatePointCard(match: any, players: any[], goals: any[]) {
  const show = match.phase === PHASE_PAUSE;
  stageEl.classList.toggle('pcard', show);
  if (!show) return;
  const last = goals.length ? goals[goals.length - 1] : null;
  const scoredSide = last && match.pauseTicks > 0 ? last.side : -1;
  $('pc-tag').textContent = last && scoredSide >= 0
    ? `${last.ownGoal ? '● OWN GOAL' : '⚽ GOAL'} — ${last.scorerName} ${goalMinute(last)}'`
    : `● ${halfLabel(match)}`;
  for (const side of [0, 1] as const) {
    const row = $(`pc-row${side}`);
    row.querySelector('.pc-name')!.textContent = sideLabel(players, side);
    row.querySelector('.pc-games')!.textContent = String(
      side === 0 ? match.p0Goals : match.p1Goals
    );
    // the scorers this side has on the sheet, newest last
    row.querySelector('.pc-pts')!.textContent = goals
      .filter(g => g.side === side)
      .map(g => `${g.scorerName}${g.ownGoal ? ' (OG)' : ''} ${goalMinute(g)}'`)
      .slice(-2)
      .join(' · ');
    // whoever restarts play next — after a goal that's the side who conceded
    row.querySelector('.pc-serve')!.textContent =
      match.kickoffSide === side ? '● KICK OFF' : '';
    row.classList.toggle('win', scoredSide === side);
  }
}

let prevGoals: [number, number] | null = null;
const pointFlashEl = $('point-flash');
function goalSound(match: any, mySide: number) {
  const cur: [number, number] = [match.p0Goals, match.p1Goals];
  if (prevGoals && (cur[0] !== prevGoals[0] || cur[1] !== prevGoals[1])) {
    const iScored = mySide === 0 ? cur[0] > prevGoals[0] : cur[1] > prevGoals[1];
    playGoalJingle(mySide < 0 ? false : iScored);
    // rim flash on the goal — players only
    if (mySide >= 0) {
      pointFlashEl.className = '';
      void (pointFlashEl as HTMLElement).offsetWidth;
      pointFlashEl.className = (iScored ? 'win' : 'lose') + ' big';
    }
  }
  prevGoals = cur;
}

// ---------------------------------------------------------------------------
// Crowd audio: an ambience bed whose hype tracks match state, plus staged
// reactions keyed off phase transitions (goal, half-time, full time).
// ---------------------------------------------------------------------------
let crowdPrevPhase = -1;
let crowdPrevMatchId = -1n;
let crowdPrevGoals = 0;

function crowdFrame(match: any, ball: any) {
  const totalGoals = (match.p0Goals ?? 0) + (match.p1Goals ?? 0);
  if (match.id !== crowdPrevMatchId) {
    crowdPrevMatchId = match.id;
    // joining mid-match (or spectating): swallow the first transition so a
    // stale PAUSE/OVER doesn't fire a roar on entry
    crowdPrevPhase = match.phase;
    crowdPrevGoals = totalGoals;
  }

  // ----- reactions on phase transitions -----
  if (match.phase !== crowdPrevPhase) {
    if (match.phase === PHASE_OVER) {
      playWhistle();
      crowdRoar(); // full time
    } else if (match.phase === PHASE_PAUSE) {
      if (totalGoals > crowdPrevGoals) {
        crowdRoar(); // the renderer plays the horn; the stands do the rest
      } else {
        const msg: string = match.pointMsg ?? '';
        if (msg.startsWith('HALF-TIME')) playWhistle();
        else crowdMurmur(0.4); // a throw-in, a corner, a goal kick
      }
    }
    crowdPrevPhase = match.phase;
  }
  crowdPrevGoals = totalGoals;

  // ----- ambience hype: builds with the goals and with the ball's position -----
  const attacking = ball ? Math.min(0.4, Math.abs(ball.y) / 100) : 0;
  const late = match.half >= 2 ? 0.15 : 0;
  const tight = Math.abs((match.p0Goals ?? 0) - (match.p1Goals ?? 0)) <= 1 ? 0.12 : 0;
  let hype = Math.min(1, 0.15 + totalGoals * 0.06 + attacking + late + tight);
  if (match.phase !== PHASE_LIVE) hype *= 0.5; // the crowd settles at a restart
  crowdSetHype(hype);
}

// ---------------------------------------------------------------------------
// Chat + emotes
// ---------------------------------------------------------------------------
const chatFeed = $('chat-feed');
const chatInput = $('chat-input') as HTMLInputElement;
const lobbyChatFeed = $('lobby-chat-feed');
const lobbyChatInput = $('lobby-chat-input') as HTMLInputElement;
let chatOpen = false;
let lastRenderedChatId = -1n;
let lastBubbleChatId = -1n;

// Head-anchored bubbles: emote pops + speech bubbles pinned above each
// on-pitch player's head (repositioned every frame from headScreenPos).
// One column per rig seat — the pitch holds a squad a side, so the count
// belongs to the renderer, not to the page, and the markup is built here.
const RIG_COUNT = SQUAD_SIZE * 2;
const headAnnoEls: HTMLElement[] = [];
const emotePopEls: HTMLElement[] = [];
const speechEls: HTMLElement[] = [];
const nameTagEls: HTMLElement[] = [];
const headAnnoHost = $('head-annos');
for (let slot = 0; slot < RIG_COUNT; slot++) {
  const col = document.createElement('div');
  col.className = 'head-anno';
  const mk = (cls: string) => {
    const el = document.createElement('div');
    el.className = cls;
    col.appendChild(el);
    return el;
  };
  // order matters: the nameplate is last so bubbles stack above it
  emotePopEls.push(mk('emote-pop'));
  speechEls.push(mk('speech'));
  nameTagEls.push(mk('name-tag'));
  headAnnoHost.appendChild(col);
  headAnnoEls.push(col);
}
for (const el of [...emotePopEls, ...speechEls]) {
  el.addEventListener('animationend', () => el.classList.remove('show'));
}

const bubbleTimers = new Map<HTMLElement, number>();
function popBubble(el: HTMLElement, text: string, ms: number) {
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  // animationend doesn't fire in hidden tabs — a timer guarantees the
  // collapsed state either way
  clearTimeout(bubbleTimers.get(el));
  bubbleTimers.set(el, window.setTimeout(() => el.classList.remove('show'), ms));
}

function positionHeadAnnos(active: boolean) {
  for (let slot = 0; slot < RIG_COUNT; slot++) {
    const el = headAnnoEls[slot];
    const pos = active ? headScreenPos(slot) : null;
    if (!pos) {
      el.style.visibility = 'hidden';
      continue;
    }
    el.style.visibility = 'visible';
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    // bodies overlap on a crowded pitch: the nearer head's plate wins, and
    // depth grows with distance from the camera. #head-annos is the stacking
    // context, so these only order the plates against each other.
    el.style.zIndex = String(Math.round((1 - pos.depth) * 10000));
  }
}

// Local mirror of the server's chat rate limits (guardChat in
// spacetimedb/src/index.ts — keep in sync) so users get instant feedback;
// the server is still authoritative and rejects anything that slips through.
const CHAT_MIN_GAP_MS = 800;
const EMOTE_MIN_GAP_MS = 400;
const CHAT_WINDOW_MS = 10_000;
const CHAT_WINDOW_MAX = 8;
const CHAT_DUP_GAP_MS = 5_000;
let chatSentAt = -Infinity; // last locally-accepted send (chat or emote)
let chatWindowStart = -Infinity;
let chatWindowCount = 0;
let chatLastText = '';

function chatNotice(text: string) {
  for (const feed of [chatFeed, lobbyChatFeed]) {
    const line = document.createElement('div');
    line.className = 'chat-line notice';
    line.textContent = text;
    feed.appendChild(line);
    setTimeout(() => line.remove(), 2500);
  }
  lobbyChatFeed.scrollTop = lobbyChatFeed.scrollHeight;
}

// True when the send may go out; otherwise shows why (silently for emotes).
function chatAllowed(emote: boolean, text: string): boolean {
  const now = performance.now();
  const gap = now - chatSentAt;
  if (gap < (emote ? EMOTE_MIN_GAP_MS : CHAT_MIN_GAP_MS)) {
    if (!emote) chatNotice('Sending too fast — slow down');
    return false;
  }
  const norm = text.toLowerCase();
  if (!emote && norm === chatLastText && gap < CHAT_DUP_GAP_MS) {
    chatNotice('You just said that');
    return false;
  }
  const inWindow = now - chatWindowStart < CHAT_WINDOW_MS;
  if (inWindow && chatWindowCount >= CHAT_WINDOW_MAX) {
    const wait = Math.ceil((chatWindowStart + CHAT_WINDOW_MS - now) / 1000);
    if (!emote) chatNotice(`Chat rate limit — wait ${wait}s`);
    return false;
  }
  if (!inWindow) {
    chatWindowStart = now;
    chatWindowCount = 0;
  }
  chatWindowCount++;
  chatSentAt = now;
  if (!emote) chatLastText = norm;
  return true;
}

function openChat() {
  // On the lobby screen the corner chat sits under the overlay blur — the
  // lobby has its own visible chat box, so Enter focuses that instead.
  if (!overlays.waiting.classList.contains('hidden')) {
    lobbyChatInput.focus();
    return;
  }
  chatOpen = true;
  chatInput.classList.add('open');
  chatInput.focus();
}

function closeChat() {
  chatOpen = false;
  chatInput.value = '';
  chatInput.classList.remove('open');
  chatInput.blur();
}

chatInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const text = chatInput.value.trim();
    if (text) {
      // blocked sends keep the input open so the draft isn't lost
      if (!chatAllowed(false, text)) return;
      conn.reducers.sendChat({ text });
    }
    closeChat();
  } else if (e.key === 'Escape') {
    closeChat();
  }
});

function sendLobbyChat() {
  const text = lobbyChatInput.value.trim();
  if (!text) return;
  if (!chatAllowed(false, text)) return; // keep the draft
  conn.reducers.sendChat({ text });
  lobbyChatInput.value = '';
}
$('lobby-chat-send').addEventListener('click', sendLobbyChat);
lobbyChatInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') sendLobbyChat();
  else if (e.key === 'Escape') lobbyChatInput.blur();
});

// pitchSlotByName maps a player on the pitch to their rig seat; when a
// sender is on the pitch their messages surface as bubbles above their own
// head, and emotes stay out of the feed. Off-pitch senders (lobby,
// spectators) fall back to the corner feed for everything.
function updateChat(lobbyId: bigint, myName: string, pitchSlotByName?: Map<string, number>) {
  if (!pitchSlotByName) positionHeadAnnos(false); // overlay screens: nobody on the pitch
  const rows = [] as any[];
  for (const m of conn.db.chat.iter()) if (m.lobbyId === lobbyId) rows.push(m);
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const recent = rows.slice(-6);
  const newestId = recent.length ? recent[recent.length - 1].id : -1n;

  if (newestId !== lastRenderedChatId) {
    lastRenderedChatId = newestId;
    const chatLine = (m: any) => {
      const line = document.createElement('div');
      line.className = 'chat-line' + (m.senderName === myName ? ' mine' : '');
      const whoSpan = document.createElement('span');
      whoSpan.className = 'who';
      whoSpan.textContent = `${m.senderName}: `;
      line.appendChild(whoSpan);
      line.appendChild(document.createTextNode(m.text));
      return line;
    };
    chatFeed.innerHTML = '';
    for (const m of recent) {
      if (m.emote && pitchSlotByName?.has(m.senderName)) continue;
      chatFeed.appendChild(chatLine(m));
    }
    // the lobby's chat box shows a longer scrollback, pinned to the newest
    lobbyChatFeed.innerHTML = '';
    for (const m of rows.slice(-40)) lobbyChatFeed.appendChild(chatLine(m));
    lobbyChatFeed.scrollTop = lobbyChatFeed.scrollHeight;
    for (const m of recent) {
      if (m.id <= lastBubbleChatId) continue;
      lastBubbleChatId = m.id;
      const slot = pitchSlotByName?.get(m.senderName);
      if (slot === undefined) continue;
      if (m.emote) {
        popBubble(emotePopEls[slot], m.text, 2300);
        playEmote();
      } else popBubble(speechEls[slot], m.text, 4600);
    }
  }
}

// strike-quality toasts, fired by the renderer's contact events
const toastEl = $('toast');

function showToast(text: string, color: string) {
  toastEl.textContent = text;
  toastEl.style.color = color;
  toastEl.classList.remove('show');
  void (toastEl as HTMLElement).offsetWidth;
  toastEl.classList.add('show');
}

window.addEventListener('dt-hit', e => {
  const detail = (e as CustomEvent).detail ?? {};
  const power = detail.power ?? 0;
  // the crowd reads the contact too: a buzz for anything struck cleanly
  if (power > 0.82) crowdMurmur(0.7);
  else if (power > 0.68) crowdMurmur(0.35);
  const text = power > 0.9 ? 'THUNDERBOLT!' : power > 0.82 ? 'GREAT STRIKE!' : '';
  if (!text) return;
  showToast(text, power > 0.9 ? '#ffd400' : '#8cf08c');
});

let prevBannerText = '';
function setBanner(text: string) {
  if (text !== prevBannerText) {
    banner.textContent = text;
    if (text) {
      banner.classList.remove('pop');
      void (banner as HTMLElement).offsetWidth;
      banner.classList.add('pop');
    }
    prevBannerText = text;
  }
}

// ---------------------------------------------------------------------------
// Goal / restart replay
// ---------------------------------------------------------------------------
// Play stops on a goal or a ball out of play, and the pause is long enough to
// show it back: the last couple of seconds of live play, slowed down, on the
// broadcast cam.
const replayBuf: { t: number; scene: Scene }[] = [];
let replayFrames: { t: number; scene: Scene }[] = [];
let replayActive = false;
let replayStart = 0;
let replayIdx = 0;
let prevPhaseMain = -1;
let replayMatchId = 0n;
const REPLAY_WINDOW_MS = 2600;
const REPLAY_SPEED = 0.55;
// once playback catches up: rest on the finish for a beat, then cut to live
const REPLAY_TAIL_MS = 700;
let replayHoldAt = 0;
let replayEndScene: Scene | null = null;
// Play stops on the very frame the ball crosses the line, so the goal, the
// crowd's roar and the cut to the replay cam would all land in the same
// instant. Hold the live cam on the celebration for a beat first.
const REPLAY_CUT_DELAY_MS = 500;
// BUDGET: CUT_DELAY + WINDOW/SPEED + TAIL must stay under the server's
// GOAL_PAUSE (spacetimedb/src/index.ts), or the replay is cut off before the
// ball crosses the line — a goal replay that never shows the goal. Today:
// 500 + 2600/0.55 + 700 = 5927 ms against a 7500 ms pause.
let replayPendingAt = 0; // >0 while that beat runs; the cut is due at this time

// ---------------------------------------------------------------------------
// Match-start 3-2-1 countdown
// ---------------------------------------------------------------------------
const countdownEl = $('countdown');
let prevCountdown = 0;

// ---------------------------------------------------------------------------
// Tournament: my finished match shows a result screen until I hit CONTINUE
// ---------------------------------------------------------------------------
let tourneyResultShowing: string | null = null;
let tourneyResultSeen = '';

// ---------------------------------------------------------------------------
// Waiting / registration overlay
// ---------------------------------------------------------------------------
// mirror spacetimedb/src/index.ts
const MAX_TOURNAMENT_PLAYERS = 16;
// Match format blurb: two halves, then golden goal if it's still level.
const MATCH_FORMAT_TEXT =
  `2 × ${Math.round(HALF_SECONDS / 60)} MIN HALVES · ` +
  `GOLDEN GOAL (${Math.round(OT_SECONDS / 60)} MIN) IF LEVEL`;

let lastInfoKey = '';
let lastRosterKey = '';
let lastBracketKey = '';
let bracketView = false; // spectator toggled the bracket screen with B

function playerByIdentity(id: any): any | null {
  const hex = id.toHexString();
  for (const p of conn.db.player.iter()) if (p.identity.toHexString() === hex) return p;
  return null;
}

// hostControls: the host's FORMAT/PITCHES switches are on screen, so skip the
// pills that would repeat them right above.
function updateLobbyInfo(room: any, running: boolean, hostControls = false) {
  const isTournament = room.mode === MODE_TOURNAMENT;
  const pitch = PITCHES[room.pitch ?? 0];
  const pills: [string, string][] = [
    ['PITCH', pitch ? `${pitch.name} · ${pitch.desc}` : '?'],
  ];
  const ts = room.teamSize ?? 1;
  if (ts > 1) pills.push(['MODE', `👥 ${ts}V${ts}`]);
  pills.push(['MATCH', MATCH_FORMAT_TEXT]);
  if (room.vsBot) {
    pills.push(['BOT', BOT_LEVEL_CARDS[room.botLevel ?? 1]?.name ?? 'NORMAL']);
  }
  const physBits: string[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  if (Math.abs((room.gravityMul ?? 1) - 1) > 0.01) physBits.push(`BALL WEIGHT ${pct(room.gravityMul)}`);
  if (Math.abs((room.frictionMul ?? 1) - 1) > 0.01) physBits.push(`FRICTION ${pct(room.frictionMul)}`);
  if (Math.abs((room.powerMul ?? 1) - 1) > 0.01) physBits.push(`KICK POWER ${pct(room.powerMul)}`);
  if (Math.abs((room.bounceMul ?? 1) - 1) > 0.01) physBits.push(`BOUNCE ${pct(room.bounceMul)}`);
  if (physBits.length) pills.push(['PHYSICS', physBits.join(' · ')]);
  if (isTournament && !hostControls) {
    pills.push(['FORMAT', FORMAT_NAMES[room.format ?? 0] ?? FORMAT_NAMES[0]]);
    if ((room.concurrent ?? 1) > 1) {
      pills.push(['PITCHES', `${room.concurrent} MATCHES AT ONCE`]);
    }
  }
  const key = pills.map(p => p.join('=')).join('|') + (running ? '#r' : '');
  if (key === lastInfoKey) return;
  lastInfoKey = key;
  const box = $('lobby-info');
  box.innerHTML = '';
  for (const [label, value] of pills) {
    const pill = document.createElement('span');
    pill.className = 'info-pill';
    pill.append(`${label} `);
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = value;
    pill.appendChild(v);
    box.appendChild(pill);
  }
  staggerChildren(box);
}

function updateRoster(room: any, me: any, players: any[]) {
  const isTournament = room.mode === MODE_TOURNAMENT;
  const teams = !isTournament && (room.teamSize ?? 1) >= 2;
  const capacity = isTournament ? MAX_TOURNAMENT_PLAYERS : (room.teamSize ?? 1) * 2;
  const hostHex = room.hostId.toHexString();
  const sorted = [...players].sort((a, b) => {
    // team play: group by side so the 2v2 pairing reads at a glance
    if (teams && a.side !== b.side) return a.side - b.side;
    const ah = a.identity.toHexString() === hostHex ? 0 : 1;
    const bh = b.identity.toHexString() === hostHex ? 0 : 1;
    return ah - bh || (a.name || '').localeCompare(b.name || '');
  });
  const openSlot = players.length < capacity;
  const key =
    sorted
      .map(p => `${p.identity.toHexString()}:${p.name}:${p.characterId}:${p.side}:${mmrOf(p) ?? ''}`)
      .join('|') + `#${openSlot}#${myHex()}`;
  if (key === lastRosterKey) return;
  lastRosterKey = key;

  const tourneyTs = room.teamSize ?? 1;
  $('roster-head').textContent = isTournament
    ? `PLAYERS ${players.length}/${MAX_TOURNAMENT_PLAYERS}` +
      (tourneyTs > 1 ? ` · TEAMS OF ${tourneyTs}` : '')
    : teams
      ? `PLAYERS ${players.length}/${capacity}`
      : 'PLAYERS';
  const list = $('waiting-players');
  list.innerHTML = '';
  for (const p of sorted) {
    const chip = document.createElement('span');
    chip.className = 'player-chip';
    if (p.identity.toHexString() === hostHex) chip.classList.add('host');
    if (p.identity.toHexString() === myHex()) chip.classList.add('me');
    const ch = CHARACTERS[p.characterId ?? 0];
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = `${ch?.flag ?? ''} ${p.name || 'PLAYER'}${p.identity.toHexString() === myHex() ? ' (YOU)' : ''}`;
    const charLine = document.createElement('span');
    charLine.className = 'chip-char';
    const teamBit = teams ? `TEAM ${(p.side ?? 0) + 1} · ` : '';
    // Size up who you're playing: rating sits with the character line.
    const rating = mmrOf(p);
    const ratingBit = rating === null ? '' : ` · ${rating} MMR`;
    charLine.textContent = teamBit + (ch ? `${ch.name} · ${ch.style}` : '') + ratingBit;
    chip.append(name, charLine);
    list.appendChild(chip);
  }
  if (openSlot) {
    const slot = document.createElement('span');
    slot.className = 'player-chip open-slot';
    slot.textContent = isTournament
      ? '+ OPEN SLOT'
      : teams
        ? `WAITING FOR ${capacity - players.length} MORE…`
        : 'WAITING FOR OPPONENT…';
    list.appendChild(slot);
  }
  staggerChildren(list);
}

function roundTitle(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round;
  if (fromEnd <= 0) return 'FINAL';
  if (fromEnd === 1) return 'SEMIFINALS';
  if (fromEnd === 2) return 'QUARTERFINALS';
  return `ROUND ${round}`;
}

// the bracket panel is shared between the waiting and gameover overlays;
// the waiting screen has a dedicated main column for it, elsewhere it sits
// directly in the overlay above the button row
function mountBracket(overlay: HTMLElement) {
  const el = $('bracket');
  const main = overlay.querySelector<HTMLElement>('#waiting-main');
  if (main) {
    if (el.parentElement !== main) main.appendChild(el);
  } else if (el.parentElement !== overlay) {
    overlay.insertBefore(el, overlay.querySelector('.row'));
  }
}

function buildRoundCol(title: string): HTMLElement {
  const col = document.createElement('div');
  col.className = 'bracket-round';
  const t = document.createElement('div');
  t.className = 'round-title';
  t.textContent = title;
  col.appendChild(t);
  return col;
}

function buildLane(label: string | null): HTMLElement {
  const lane = document.createElement('div');
  lane.className = 'bracket-lane';
  if (label) {
    const l = document.createElement('div');
    l.className = 'bracket-lane-label';
    l.textContent = label;
    lane.appendChild(l);
  }
  return lane;
}

function buildTbdCard(text: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'bracket-match tbd';
  card.textContent = text;
  return card;
}

// In team brackets the match rows carry captains, so "my" card is the one
// holding my team's captain — updateBracket sets this before building.
let bracketMineHex = '';

function buildMatchCard(m: any, nameOf: (id: any) => string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'bracket-match';
  if (m.state === M_LIVE) card.classList.add('live');
  if (m.state === M_DONE) card.classList.add('done');
  const mineHexes = [m.p0Id.toHexString(), m.hasP1 ? m.p1Id.toHexString() : ''];
  if (mineHexes.includes(bracketMineHex || myHex())) card.classList.add('mine');

  const sides: [any, boolean][] = [
    [m.p0Id, true],
    [m.p1Id, m.hasP1],
  ];
  sides.forEach(([id, present], side) => {
    const row = document.createElement('div');
    row.className = 'bracket-row';
    const bname = document.createElement('span');
    bname.className = 'bname';
    const bscore = document.createElement('span');
    bscore.className = 'bscore';
    if (!present) {
      row.classList.add('bye');
      bname.textContent = 'BYE';
      bscore.textContent = '—';
    } else {
      bname.textContent = nameOf(id);
      bscore.textContent = String(side === 0 ? m.p0Goals : m.p1Goals);
      if (m.state === M_DONE && (m.winnerSide === side || !m.hasP1)) {
        row.classList.add('winner');
      }
    }
    row.append(bname, bscore);
    card.appendChild(row);
  });
  if (m.state === M_LIVE) {
    const tag = document.createElement('div');
    tag.className = 'live-tag';
    tag.textContent = '● LIVE';
    card.appendChild(tag);
  } else if (
    m.state === M_DONE &&
    m.hasP1 &&
    unitIsAllBots(m.lobbyId, m.p0Id) &&
    unitIsAllBots(m.lobbyId, m.p1Id)
  ) {
    // bots on both sides — the server settled it instead of playing it out
    const tag = document.createElement('div');
    tag.className = 'live-tag auto-tag';
    tag.textContent = 'AUTO-PLAYED';
    card.appendChild(tag);
  }
  return card;
}

// A lane of round columns; `rounds` is the distinct global round numbers this
// bracket played, in order — each becomes one column.
function buildBracketLane(
  label: string | null,
  matchesByRound: Map<number, any[]>,
  rounds: number[],
  titleOf: (idx: number) => string,
  nameOf: (id: any) => string
): HTMLElement {
  const lane = buildLane(label);
  rounds.forEach((r, idx) => {
    const col = buildRoundCol(titleOf(idx));
    for (const m of matchesByRound.get(r)!.sort((a: any, b: any) => a.slot - b.slot)) {
      col.appendChild(buildMatchCard(m, nameOf));
    }
    lane.appendChild(col);
  });
  return lane;
}

function groupByRound(matches: any[]): Map<number, any[]> {
  const by = new Map<number, any[]>();
  for (const m of matches) {
    if (!by.has(m.round)) by.set(m.round, []);
    by.get(m.round)!.push(m);
  }
  return by;
}

function updateBracket(room: any) {
  const el = $('bracket');
  const matches = lobbyMatchList(room.id);
  if (!matches.length) {
    el.classList.add('hidden');
    lastBracketKey = '';
    return;
  }
  el.classList.remove('hidden');

  const nameOf = (id: any) => unitLabel(room.id, id);
  bracketMineHex = myCaptainHex(room.id);
  const key =
    matches
      .map(
        m =>
          `${m.id}:${m.state}:${m.p0Goals}:${m.p1Goals}:${m.winnerSide}:${nameOf(m.p0Id)}:${m.hasP1 ? nameOf(m.p1Id) : ''}`
      )
      .join('|') + `#${myHex()}`;
  if (key === lastBracketKey) return;
  lastBracketKey = key;
  el.innerHTML = '';

  const isDouble = matches.some(m => (m.bracket ?? 0) > 0) || (room.format ?? 0) === FORMAT_DOUBLE;
  if (!isDouble) {
    // single elimination: one lane, expected round count from the entrants
    const firstRound = matches.filter(m => m.round === 1);
    const entrants = firstRound.reduce((n, m) => n + (m.hasP1 ? 2 : 1), 0);
    const totalRounds = Math.max(1, Math.ceil(Math.log2(Math.max(2, entrants))));
    const maxExisting = Math.max(...matches.map(m => m.round));
    const byRound = groupByRound(matches);
    const lane = buildLane(null);
    for (let r = 1; r <= Math.max(totalRounds, maxExisting); r++) {
      const col = buildRoundCol(roundTitle(r, totalRounds));
      const roundMatches = (byRound.get(r) ?? []).sort((a, b) => a.slot - b.slot);
      if (!roundMatches.length) col.appendChild(buildTbdCard('AWAITING WINNERS'));
      for (const m of roundMatches) col.appendChild(buildMatchCard(m, nameOf));
      lane.appendChild(col);
    }
    el.appendChild(lane);
    return;
  }

  // double elimination: winners lane (grand final appended), then losers lane
  const wb = matches.filter(m => (m.bracket ?? 0) === 0);
  const lb = matches.filter(m => m.bracket === 1);
  const gf = matches.filter(m => m.bracket === 2);
  const wbByRound = groupByRound(wb);
  const wbRounds = [...wbByRound.keys()].sort((a, b) => a - b);
  const wbLane = buildBracketLane(
    'WINNERS', wbByRound, wbRounds,
    idx => (idx === wbRounds.length - 1 && wbByRound.get(wbRounds[idx])!.length === 1
      ? 'WB FINAL'
      : `ROUND ${idx + 1}`),
    nameOf
  );
  const gfCol = buildRoundCol('GRAND FINAL');
  if (gf.length) for (const m of gf) gfCol.appendChild(buildMatchCard(m, nameOf));
  else gfCol.appendChild(buildTbdCard('AWAITING CHAMPS'));
  wbLane.appendChild(gfCol);
  el.appendChild(wbLane);

  const lbByRound = groupByRound(lb);
  const lbRounds = [...lbByRound.keys()].sort((a, b) => a - b);
  const lbLane = buildBracketLane(
    'LOSERS', lbByRound, lbRounds, idx => `LOSERS RD ${idx + 1}`, nameOf
  );
  if (!lbRounds.length) lbLane.appendChild(buildTbdCard('AWAITING FIRST LOSSES'));
  el.appendChild(lbLane);
}

// Registration-screen preview: the projected bracket for the players in the
// room right now (real seeding shuffles when the host starts).
function updateBracketPreview(room: any, players: any[]) {
  const el = $('bracket');
  el.classList.remove('hidden');
  const isDouble = (room.format ?? 0) === FORMAT_DOUBLE;
  // team tournaments: preview provisional teams in join order (the real
  // teams are drawn from a shuffle when the host starts)
  const ts = room.teamSize ?? 1;
  const entrantNames = players.map(p => p.name || 'PLAYER');
  // The server fills every empty seat with a bot when the host starts (see
  // start_tournament) — short teams get bot partners and the draw is padded
  // to a power of two — so the preview shows the same fillers, not byes.
  let botIndex = 0;
  const nextBotName = () => {
    const i = botIndex++;
    return i === 0 ? BOT_NAME : `${BOT_NAME} ${i + 1}`;
  };
  const fillTeam = (members: string[]) => {
    while (members.length < ts) members.push(nextBotName());
    return members.join(' & ');
  };
  let names: string[];
  if (ts > 1) {
    names = [];
    for (let i = 0; i < entrantNames.length; i += ts) {
      names.push(fillTeam(entrantNames.slice(i, i + ts)));
    }
  } else {
    names = [...entrantNames];
  }
  // units past this point are pure bots, padding the draw to a power of two
  const humanUnits = names.length;
  const size = 1 << Math.ceil(Math.log2(Math.max(2, humanUnits)));
  while (names.length < size) names.push(fillTeam([]));
  const key = `preview#${isDouble ? 'd' : 's'}#${ts}#${names.join('|')}`;
  if (key === lastBracketKey) return;
  lastBracketKey = key;
  el.innerHTML = '';

  const lane = buildLane(isDouble ? 'WINNERS' : null);
  const totalRounds = Math.round(Math.log2(size));
  for (let r = 1; r <= totalRounds; r++) {
    const col = buildRoundCol(roundTitle(r, totalRounds));
    const matchCount = size >> r;
    for (let s = 0; s < matchCount; s++) {
      if (r > 1) {
        col.appendChild(buildTbdCard('WINNERS TBD'));
        continue;
      }
      const card = document.createElement('div');
      card.className = 'bracket-match';
      for (const seed of [s, size - 1 - s]) {
        const row = document.createElement('div');
        row.className = 'bracket-row' + (seed >= humanUnits ? ' bot' : '');
        const bname = document.createElement('span');
        bname.className = 'bname';
        bname.textContent = names[seed];
        row.appendChild(bname);
        card.appendChild(row);
      }
      col.appendChild(card);
    }
    lane.appendChild(col);
  }
  if (isDouble) {
    const gfCol = buildRoundCol('GRAND FINAL');
    gfCol.appendChild(buildTbdCard('WB CHAMP VS LB CHAMP'));
    lane.appendChild(gfCol);
  }
  el.appendChild(lane);
  if (isDouble) {
    const lbLane = buildLane('LOSERS');
    lbLane.appendChild(
      buildTbdCard('LOSE ONCE → DROP DOWN HERE · LOSE TWICE → OUT')
    );
    el.appendChild(lbLane);
  }
  const note = document.createElement('div');
  note.className = 'bracket-note';
  note.textContent =
    (ts > 1
      ? 'PREVIEW · TEAMS AND SEEDING ARE DRAWN WHEN THE TOURNAMENT STARTS'
      : 'PREVIEW · SEEDING IS SHUFFLED WHEN THE TOURNAMENT STARTS') +
    (botIndex > 0 ? ' · EMPTY SEATS ARE FILLED BY BOTS — NO BYES' : '');
  el.appendChild(note);
}

// ---------------------------------------------------------------------------
// Tournament story: a label for any match, the updates feed between matches,
// the matchup intro card, and the post-match result card
// ---------------------------------------------------------------------------
function wbTotalRounds(matches: any[]): number {
  const wb = matches.filter(m => (m.bracket ?? 0) === 0);
  const entrants = wb.filter(m => m.round === 1).reduce((n, m) => n + (m.hasP1 ? 2 : 1), 0);
  const maxExisting = wb.length ? Math.max(...wb.map(m => m.round)) : 1;
  return Math.max(Math.ceil(Math.log2(Math.max(2, entrants))), maxExisting, 1);
}

function matchLabel(m: any, matches: any[]): string {
  if ((m.bracket ?? 0) === 2) return 'GRAND FINAL';
  if ((m.bracket ?? 0) === 1) {
    // losers rounds carry global round numbers — label by position instead
    const lbRounds = [...new Set(matches.filter(x => x.bracket === 1).map(x => x.round))].sort(
      (a, b) => a - b
    );
    return `LOSERS RD ${lbRounds.indexOf(m.round) + 1}`;
  }
  return roundTitle(m.round, wbTotalRounds(matches));
}

// The feed accumulates every frame (even mid-match) so the waiting screen
// always has the story so far; joining late seeds it from finished matches.
let tourneyFeedRoomId = '';
let tourneyChampSeen = '';
const tourneyMatchSeen = new Map<string, number>(); // match id -> last seen state
let tourneyUpdates: { icon: string; text: string; cls: string }[] = [];
let tourneyUpdatesDirty = false;

function resetTourneyFeed() {
  tourneyMatchSeen.clear();
  tourneyUpdates = [];
  tourneyChampSeen = '';
  tourneyUpdatesDirty = true;
}

function pushTourneyUpdate(icon: string, text: string, cls = '') {
  tourneyUpdates.unshift({ icon, text, cls });
  if (tourneyUpdates.length > 30) tourneyUpdates.length = 30;
  tourneyUpdatesDirty = true;
}

function updateTourneyFeed(room: any) {
  const roomKey = String(room.id);
  if (roomKey !== tourneyFeedRoomId) {
    tourneyFeedRoomId = roomKey;
    resetTourneyFeed();
  }
  const matches = lobbyMatchList(room.id);
  // bracket gone (tournament restarted) — the old story no longer applies
  if (!matches.length) {
    if (tourneyMatchSeen.size) resetTourneyFeed();
    return;
  }
  // brackets pair captains — unitLabel names the whole team behind one
  const nameOf = (id: any) => unitLabel(room.id, id);
  for (const m of matches) {
    const key = String(m.id);
    const prev = tourneyMatchSeen.get(key);
    if (m.state === prev) continue;
    tourneyMatchSeen.set(key, m.state);
    if (!m.hasP1) {
      if (prev === undefined && m.state === M_DONE)
        pushTourneyUpdate('▸', `${nameOf(m.p0Id)} advances on a bye`, 'dim');
      continue;
    }
    const label = matchLabel(m, matches);
    if (m.state === M_LIVE) {
      pushTourneyUpdate('⚽', `${label} — ${nameOf(m.p0Id)} VS ${nameOf(m.p1Id)} · KICKING OFF`, 'live');
    } else if (m.state === M_DONE) {
      const wId = m.winnerSide === 0 ? m.p0Id : m.p1Id;
      const lId = m.winnerSide === 0 ? m.p1Id : m.p0Id;
      const wg = m.winnerSide === 0 ? m.p0Goals : m.p1Goals;
      const lg = m.winnerSide === 0 ? m.p1Goals : m.p0Goals;
      let fate = '';
      if ((room.format ?? 0) === FORMAT_DOUBLE && (m.bracket ?? 0) === 0) {
        fate = ` · ${nameOf(lId)} drops to the losers bracket`;
      } else if ((m.bracket ?? 0) !== 2) {
        fate = ` · ${nameOf(lId)} is out`;
      }
      const auto = unitIsAllBots(room.id, m.p0Id) && unitIsAllBots(room.id, m.p1Id);
      pushTourneyUpdate(
        auto ? '🤖' : '🏆',
        `${label} — ${nameOf(wId)} DEF. ${nameOf(lId)} ${wg}–${lg}${fate}` +
          (auto ? ' · auto-played (bots only)' : ''),
        auto ? 'dim' : ''
      );
      // and what the book paid on it
      const bets = betsFor(m.id);
      if (bets.length) {
        const winners = bets.filter(b => b.state === B_WON);
        const paid = winners.reduce((n, b) => n + b.payout, 0);
        pushTourneyUpdate(
          winners.length ? '💰' : '💸',
          winners.length
            ? `${winners.length} BET${winners.length === 1 ? '' : 'S'} ON ${nameOf(wId)} PAY OUT ${fmtCr(paid)} CREDITS`
            : `NOBODY BACKED ${nameOf(wId)} — THE HOUSE KEEPS ${fmtCr(bets.reduce((n, b) => n + b.stake, 0))}`,
          'dim'
        );
      }
    }
  }
  if (room.status === L_FINISHED && room.championName && room.championName !== tourneyChampSeen) {
    tourneyChampSeen = room.championName;
    pushTourneyUpdate('👑', `${room.championName} WINS THE TOURNAMENT!`, 'champ');
    if (room.betWinnerName) {
      pushTourneyUpdate(
        '💰',
        `${room.betWinnerName} TAKES THE BETTING CROWN WITH ${fmtCr(room.betWinnerCredits)} CREDITS`,
        'champ'
      );
    }
  }
}

function renderTourneyUpdates(show: boolean) {
  const panel = $('tourney-updates');
  const visible = show && tourneyUpdates.length > 0;
  panel.classList.toggle('hidden', !visible);
  if (!visible || !tourneyUpdatesDirty) return;
  tourneyUpdatesDirty = false;
  const feed = $('tourney-updates-feed');
  feed.innerHTML = '';
  for (const u of tourneyUpdates) {
    const line = document.createElement('div');
    line.className = ('tu-line ' + u.cls).trim();
    const ico = document.createElement('span');
    ico.className = 'tu-ico';
    ico.textContent = u.icon;
    const text = document.createElement('span');
    text.className = 'tu-text';
    text.textContent = u.text;
    line.append(ico, text);
    feed.appendChild(line);
  }
}

// ----- matchup intro card (shown over the 3-2-1 of a tournament match) -----
let introShownFor = '';
let introOutTimer = 0;
let introHideTimer = 0;

function hideMatchIntro() {
  clearTimeout(introOutTimer);
  clearTimeout(introHideTimer);
  $('match-intro').classList.add('hidden');
  $('match-intro').classList.remove('out');
  introShownFor = '';
}

// One side of the intro card. Brackets pair captains: a 1v1 side gets the
// player's flag + character line, a team side gets the joined names.
function fillIntroSide(el: HTMLElement, room: any, captainId: any) {
  const cap = playerByIdentity(captainId);
  const ch = CHARACTERS[cap?.characterId ?? 0];
  const solo = (room.teamSize ?? 1) <= 1;
  (el.querySelector('.mi-name') as HTMLElement).textContent = solo
    ? `${ch?.flag ?? ''} ${cap?.name || 'PLAYER'}`
    : unitLabel(room.id, captainId);
  const rating = solo ? mmrOf(cap) : null;
  (el.querySelector('.mi-char') as HTMLElement).textContent = solo
    ? [ch ? `${ch.name} · ${ch.style}` : '', rating === null ? '' : `${rating} MMR`]
        .filter(Boolean)
        .join(' · ')
    : `${room.teamSize}V${room.teamSize} TEAM`;
  el.style.setProperty('--accent', ch?.css ?? 'var(--gold)');
}

function maybeShowMatchIntro(room: any, viewMatch: any) {
  if (room.mode !== MODE_TOURNAMENT || viewMatch.state !== M_LIVE || !viewMatch.hasP1) return;
  const key = String(viewMatch.id);
  if (key === introShownFor) return;
  // only introduce a match during its pre-kickoff countdown — reloading or
  // tuning in mid-match skips straight to the action
  if ((viewMatch.startTicks ?? 0) <= 0) {
    introShownFor = key; // don't re-check every frame
    return;
  }
  introShownFor = key;
  clearTimeout(introOutTimer);
  clearTimeout(introHideTimer);
  const introBook = bookOf(viewMatch.id);
  $('mi-round').textContent =
    `${matchLabel(viewMatch, lobbyMatchList(room.id))} · ${MATCH_FORMAT_TEXT}` +
    (introBook ? ` · ${fmtOdds(introBook.odds0Milli)} — ${fmtOdds(introBook.odds1Milli)}` : '');
  fillIntroSide($('mi-side0'), room, viewMatch.p0Id);
  fillIntroSide($('mi-side1'), room, viewMatch.p1Id);
  const el = $('match-intro');
  el.classList.remove('out');
  el.classList.add('hidden');
  void (el as HTMLElement).offsetWidth; // restart the entrance animation
  el.classList.remove('hidden');
  introOutTimer = window.setTimeout(() => el.classList.add('out'), 3400);
  introHideTimer = window.setTimeout(() => hideMatchIntro0(), 3850);
}
// hide without clearing introShownFor — the match was introduced already
function hideMatchIntro0() {
  $('match-intro').classList.add('hidden');
  $('match-intro').classList.remove('out');
}

// ----- post-match result card on the gameover overlay -----
let summaryShownFor = '';
// ---------------------------------------------------------------------------
// Post-match: what this result did to your level and rating.
// ---------------------------------------------------------------------------
// The newest match_log row for me. Read (rather than diffing an account
// snapshot) so it survives a mid-match reconnect, which would have thrown any
// client-side snapshot away.
let progressShownFor = '';

function showProgress(m: any) {
  const card = $('progress-card');
  // Strictly THIS match's row: a time window would replay the previous
  // result on a screen where this match earned nothing.
  const log = logForMatch(m.id);
  if (!log || m.winnerSide === NO_WINNER) {
    card.classList.add('hidden');
    progressShownFor = '';
    return;
  }
  card.classList.remove('hidden');
  const key = String(log.id);
  const { into, span } = levelProgress(log.xpBefore + log.xpGained, log.levelAfter);
  $('pg-xp').textContent = `+${fmtXp(log.xpGained)}`;
  const levelledUp = log.levelAfter > levelFor(log.xpBefore);
  const lvl = $('pg-level');
  lvl.textContent = levelledUp ? `LEVEL UP! → ${log.levelAfter}` : `LEVEL ${log.levelAfter}`;
  lvl.classList.toggle('pg-levelup', levelledUp);
  const fill = $('pg-bar-fill') as HTMLElement;
  const mmrEl = $('pg-mmr');
  const delta = log.mmrAfter - log.mmrBefore;
  $('pg-mmr-row').classList.toggle('hidden', !log.ranked);
  mmrEl.textContent = `${log.mmrBefore} → ${log.mmrAfter}  (${delta >= 0 ? '+' : ''}${delta})`;
  mmrEl.classList.toggle('up', delta > 0);
  mmrEl.classList.toggle('down', delta < 0);
  if (progressShownFor === key) return;
  progressShownFor = key;
  // Fill from where the bar stood before this match, so the gain is visible.
  const beforeLevel = levelFor(log.xpBefore);
  const beforeInto = levelledUp ? 0 : log.xpBefore - totalXpFor(beforeLevel);
  const beforeSpan = Math.max(1, totalXpFor(beforeLevel + 1) - totalXpFor(beforeLevel));
  fill.style.transition = 'none';
  fill.style.width = `${Math.min(100, (beforeInto / beforeSpan) * 100)}%`;
  void (fill as HTMLElement).offsetWidth;
  fill.style.transition = '';
  fill.style.width = `${Math.min(100, (into / span) * 100)}%`;
  if (levelledUp) playDing();
}

// ---------------------------------------------------------------------------
// Reconnect: waiting out a dropped opponent.
// ---------------------------------------------------------------------------
const nowMicros = () => BigInt(Date.now()) * 1000n;
const fmtClock = (secs: number) =>
  `${Math.floor(Math.max(0, secs) / 60)}:${String(Math.max(0, secs) % 60).padStart(2, '0')}`;

function updateHaltOverlay(m: any | null, me: any) {
  const panel = $('halt-overlay');
  // Only the side still ON COURT sees this — the dropped player is, by
  // definition, not looking at anything.
  const halted =
    !!m && m.state === M_LIVE && m.haltMask !== 0 && (m.haltMask & (1 << me.side)) === 0;
  panel.classList.toggle('hidden', !halted);
  if (!halted) return;
  const left = Number((m.haltUntil - nowMicros()) / 1_000_000n);
  const waited = Number((nowMicros() - m.haltedAt) / 1_000_000n);
  $('halt-name').textContent = m.haltName || 'OPPONENT';
  $('halt-clock').textContent = fmtClock(left);
  const claim = $('claim-btn') as HTMLButtonElement;
  const unlockIn = CLAIM_UNLOCK_SECS - waited;
  claim.disabled = unlockIn > 0;
  claim.textContent = unlockIn > 0 ? `Claim Win (${Math.ceil(unlockIn)}s)` : 'Claim Win';
  $('halt-hint').textContent =
    unlockIn > 0
      ? 'PLAY RESTARTS WITH A DROP BALL IF THEY MAKE IT BACK'
      : 'YOU WIN AUTOMATICALLY WHEN THE CLOCK RUNS OUT';
}

// Reducer calls resolve a promise, so a SenderError arrives as a REJECTION —
// a try/catch around the call would never see it. These two both have real
// failure modes worth showing (a claim raced by the opponent reconnecting, a
// forfeit on a match that just ended), so surface the message.
const reducerToast = (p: Promise<void>) =>
  p.catch((err: any) => showToast(String(err?.message ?? err).toUpperCase(), '#ff4b33'));

$('claim-btn').addEventListener('click', () => {
  reducerToast(conn.reducers.claimWin({}));
});

// ---------------------------------------------------------------------------
// In-match menu (ESC): settings, and the only way to forfeit.
// ---------------------------------------------------------------------------
const matchMenu = $('match-menu');
const matchMenuOpen = () => !matchMenu.classList.contains('hidden');

/** Am I actually on court right now? Watchers and idle entrants have nothing
 *  to pause and nothing to forfeit. */
function inLiveMatch(): boolean {
  const me = getMyPlayer();
  if (!me || me.matchId === 0n || me.spectator) return false;
  return getMatch(me.matchId)?.state === M_LIVE;
}

function openMatchMenu() {
  askForfeit(false);
  matchMenu.classList.remove('hidden');
}
function closeMatchMenu() {
  matchMenu.classList.add('hidden');
  askForfeit(false);
}
$('mm-resume').addEventListener('click', closeMatchMenu);
$('mm-settings').addEventListener('click', () => {
  closeMatchMenu();
  $('graphics').classList.remove('hidden');
});
function askForfeit(asking: boolean) {
  $('mm-confirm').classList.toggle('hidden', !asking);
  // one question on screen at a time: the confirm replaces the button that
  // raised it, so there are never two forfeit buttons to choose between
  $('mm-forfeit').classList.toggle('hidden', asking);
  $('mm-resume').classList.toggle('hidden', asking);
  $('mm-settings').classList.toggle('hidden', asking);
}
$('mm-forfeit').addEventListener('click', () => askForfeit(true));
$('mm-forfeit-no').addEventListener('click', () => askForfeit(false));
$('mm-forfeit-yes').addEventListener('click', () => {
  closeMatchMenu();
  reducerToast(conn.reducers.forfeit({}));
});

function showMatchSummary(room: any, m: any) {
  const el = $('match-summary');
  el.classList.remove('hidden');
  const key = `${m.id}:${m.p0Goals}:${m.p1Goals}`;
  if (key === summaryShownFor) return;
  summaryShownFor = key;
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ms-round';
  head.textContent = matchLabel(m, lobbyMatchList(room.id));
  el.appendChild(head);
  const solo = (room.teamSize ?? 1) <= 1;
  ([[m.p0Id, m.p0Goals, 0], [m.p1Id, m.p1Goals, 1]] as
    [any, number, number][]).forEach(([id, goals, side]) => {
    const cap = playerByIdentity(id);
    const ch = CHARACTERS[cap?.characterId ?? 0];
    const row = document.createElement('div');
    row.className = 'ms-row' + (m.winnerSide === side ? ' winner' : '');
    const who = document.createElement('span');
    who.className = 'ms-who';
    const name = document.createElement('span');
    name.className = 'ms-name';
    name.textContent = solo
      ? `${ch?.flag ?? ''} ${cap?.name || 'PLAYER'}`
      : unitLabel(room.id, id);
    const char = document.createElement('span');
    char.className = 'ms-char';
    char.textContent = solo
      ? ch ? `${ch.name} · ${ch.style}` : ''
      : `${room.teamSize}V${room.teamSize} TEAM`;
    who.append(name, char);
    const score = document.createElement('span');
    score.className = 'ms-games';
    score.textContent = String(goals);
    row.append(who, score);
    el.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Betting: the sidebar book, the courtside bar, and placing a bet. The server
// owns every rule — the UI just refuses to offer what it would reject.
// ---------------------------------------------------------------------------
// which (match, side) has its stake row open, and the stake chosen there
let betPick: { matchId: bigint; side: number; stake: number } | null = null;

// Seconds until the book locks — the countdown minus the 3-2-1 in front of
// the kickoff. Pending matches (still waiting for a pitch) never tick.
function betCloseSecs(m: any): number | null {
  if (m.state !== M_LIVE || m.phase !== PHASE_KICKOFF) return null;
  const secs = Math.ceil((m.startTicks ?? 0) / TICK_HZ) - COUNTDOWN_SECS;
  return secs > 0 ? secs : 0;
}

function placeBet(matchId: bigint, side: number, stake: number) {
  conn.reducers.placeBet({ matchId, side, stake });
  betPick = null;
  // The UI mirrors every server rule, so a rejection means the match moved
  // under us (window closed, someone else's bet, a round starting). Say so
  // rather than leaving a dead button — same pattern as spectate().
  setTimeout(() => {
    if (!myBetOn(matchId)) showToast('BET NOT ACCEPTED — THE MARKET MOVED', '#ff4b33');
  }, 1200);
}

// One side's odds button. Disabled buttons still show the price: the book is
// worth reading even when you can't (or already did) bet.
function oddsButton(
  room: any, m: any, side: number, book: any, enabled: boolean, mine: any | null
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'odds-btn';
  if (mine && mine.side === side) btn.classList.add('picked');
  if (betPick && betPick.matchId === m.id && betPick.side === side) {
    btn.classList.add('picked');
  }
  const name = document.createElement('span');
  name.className = 'o-name';
  name.textContent = unitLabel(room.id, side === 0 ? m.p0Id : m.p1Id);
  const price = document.createElement('span');
  price.className = 'o-price';
  price.textContent = fmtOdds(side === 0 ? book.odds0Milli : book.odds1Milli);
  btn.append(name, price);
  btn.disabled = !enabled;
  if (enabled) {
    btn.addEventListener('click', () => {
      const wallet = myWallet(room.id);
      const max = wallet?.balance ?? 0;
      betPick =
        betPick && betPick.matchId === m.id && betPick.side === side
          ? null // tapping the picked side again folds the stake row away
          : { matchId: m.id, side, stake: Math.min(STAKE_PRESETS[0], max) };
      betPanelDirty = true;
    });
  }
  return btn;
}

// Stake chips + PLACE, shown under the side you picked.
function stakeRow(room: any, m: any, book: any): HTMLElement {
  const wallet = myWallet(room.id);
  const balance = wallet?.balance ?? 0;
  const row = document.createElement('div');
  row.className = 'stake-row';
  const amounts = [...STAKE_PRESETS.filter(v => v <= balance), balance].filter(
    (v, i, a) => v >= BET_MIN_STAKE && a.indexOf(v) === i
  );
  for (const amt of amounts) {
    const chip = document.createElement('button');
    chip.className = 'stake-chip';
    if (betPick && betPick.stake === amt) chip.classList.add('selected');
    chip.textContent = amt === balance && !STAKE_PRESETS.includes(amt) ? 'MAX' : String(amt);
    chip.addEventListener('click', () => {
      if (betPick) betPick.stake = amt;
      betPanelDirty = true;
    });
    row.appendChild(chip);
  }
  const go = document.createElement('button');
  go.className = 'stake-go';
  const stake = betPick?.stake ?? 0;
  const odds = betPick?.side === 0 ? book.odds0Milli : book.odds1Milli;
  go.textContent = stake >= BET_MIN_STAKE
    ? `PLACE → ${fmtCr(Math.round((stake * odds) / 1000))}`
    : `MIN ${BET_MIN_STAKE}`;
  go.disabled = stake < BET_MIN_STAKE || stake > balance;
  go.addEventListener('click', () => {
    if (betPick) placeBet(betPick.matchId, betPick.side, betPick.stake);
  });
  row.appendChild(go);
  return row;
}

// One market: the label line, the two prices, the stake row when open, and
// my slip once I'm in.
function betRow(room: any, me: any, m: any, book: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'bet-row' + (m.state === M_LIVE ? ' live' : '');
  const mine = myBetOn(m.id);
  const myMatch = isMyMatch(room.id, m);
  const closes = betCloseSecs(m);

  const label = document.createElement('div');
  label.className = 'bet-label';
  const left = document.createElement('span');
  left.textContent = matchLabel(m, lobbyMatchList(room.id));
  const right = document.createElement('span');
  if (myMatch) {
    right.className = 'mine-tag';
    right.textContent = 'YOUR MATCH';
  } else if (!book.open) {
    right.textContent = 'CLOSED';
  } else if (closes !== null) {
    right.className = 'closing';
    right.textContent = closes > 0 ? `CLOSES IN ${closes}s` : 'CLOSING…';
  } else if (m.state === M_LIVE) {
    right.className = 'live-tag';
    right.textContent = 'LIVE';
  } else {
    right.textContent = 'UP NEXT';
  }
  label.append(left, right);
  row.appendChild(label);

  const wallet = myWallet(room.id);
  // the same conditions place_bet checks, so a live button always works
  const canBet =
    !!wallet && wallet.balance >= BET_MIN_STAKE && book.open && !myMatch && !mine &&
    me.matchId === 0n;
  const odds = document.createElement('div');
  odds.className = 'bet-odds';
  odds.append(
    oddsButton(room, m, 0, book, canBet, mine),
    oddsButton(room, m, 1, book, canBet, mine)
  );
  row.appendChild(odds);

  if (betPick && betPick.matchId === m.id && canBet) row.appendChild(stakeRow(room, m, book));

  if (mine) {
    const slip = document.createElement('div');
    slip.className =
      'bet-slip' + (mine.state === B_WON ? ' won' : mine.state === B_LOST ? ' lost' : '');
    const what = document.createElement('span');
    what.textContent =
      `${fmtCr(mine.stake)} ON ${unitLabel(room.id, mine.side === 0 ? m.p0Id : m.p1Id)} @${fmtOdds(mine.oddsMilli)}`;
    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent =
      mine.state === B_WON
        ? `WON +${fmtCr(mine.payout)}`
        : mine.state === B_LOST
          ? 'LOST'
          : `→ ${fmtCr(Math.round((mine.stake * mine.oddsMilli) / 1000))}`;
    slip.append(what, amt);
    row.appendChild(slip);
  }
  return row;
}

// The panel re-renders on any wallet/bet/book change (and on my own taps),
// not every frame — the odds only move when money does.
let betPanelDirty = true;
let betPanelKey = '';

function renderBetPanel(room: any, me: any) {
  const panel = $('bet-panel');
  const wallet = room.mode === MODE_TOURNAMENT ? myWallet(room.id) : null;
  if (!wallet || room.status !== L_RUNNING) {
    panel.classList.add('hidden');
    betPanelKey = '';
    return;
  }
  panel.classList.remove('hidden');
  // open books first (live before pending), then my settled slips
  const matches = lobbyMatchList(room.id);
  const books: { m: any; book: any }[] = [];
  for (const m of matches) {
    const book = bookOf(m.id);
    if (!book) continue;
    const mine = myBetOn(m.id);
    if (!book.open && !mine) continue; // a closed book I'm not in is history
    books.push({ m, book });
  }
  books.sort((a, b) => {
    const rank = (x: any) => (x.book.open ? (x.m.state === M_LIVE ? 0 : 1) : 2);
    return rank(a) - rank(b) || (a.m.id < b.m.id ? -1 : 1);
  });

  const key = [
    wallet.balance, wallet.staked,
    betPick ? `${betPick.matchId}:${betPick.side}:${betPick.stake}` : '',
    books
      .map(({ m, book }) => {
        const mine = myBetOn(m.id);
        return `${m.id}:${book.open ? 1 : 0}:${book.odds0Milli}:${book.odds1Milli}:${betCloseSecs(m) ?? -1}:${mine ? mine.state : -1}`;
      })
      .join(','),
  ].join('|');
  if (key === betPanelKey && !betPanelDirty) return;
  betPanelKey = key;
  betPanelDirty = false;

  $('bet-balance-text').textContent = `🪙 ${fmtCr(wallet.balance)}`;
  $('bet-staked-text').textContent = wallet.staked > 0 ? `${fmtCr(wallet.staked)} IN PLAY` : '';
  const list = $('bet-list');
  list.innerHTML = '';
  for (const { m, book } of books) list.appendChild(betRow(room, me, m, book));

  const note = $('bet-note');
  note.textContent = !books.length
    ? 'NO OPEN MARKETS — THE NEXT ROUND OPENS ITS BOOKS WHEN IT IS DRAWN'
    : me.matchId !== 0n
      ? "YOU'RE ON THE PITCH — THE BOOK IS READ-ONLY WHILE YOU PLAY"
      : wallet.balance < BET_MIN_STAKE
        ? 'OUT OF CREDITS — RIDE YOUR OPEN BETS HOME'
        : '';
}

// ----- pitchside: the book on the match in front of you -----
function renderBetBar(room: any, me: any, viewMatch: any, spectating: boolean) {
  const bar = $('bet-bar');
  const pill = $('bet-pill');
  const wallet =
    spectating && room.mode === MODE_TOURNAMENT && viewMatch ? myWallet(room.id) : null;
  const book = wallet ? bookOf(viewMatch.id) : null;
  if (!wallet || !book) {
    bar.classList.add('hidden');
    pill.classList.add('hidden');
    return;
  }
  // the broadcast introduces the matchup first (odds and all) — the book
  // comes up as the card clears, never on top of it
  if (!$('match-intro').classList.contains('hidden')) {
    bar.classList.add('hidden');
    pill.classList.add('hidden');
    return;
  }
  const mine = myBetOn(viewMatch.id);
  const myMatch = isMyMatch(room.id, viewMatch);
  const canBet =
    book.open && !mine && !myMatch && me.matchId === 0n && wallet.balance >= BET_MIN_STAKE;

  if (!canBet) {
    // nothing to offer: show the slip if I have one, else stay out of the way
    bar.classList.add('hidden');
    pill.classList.toggle('hidden', !mine);
    if (mine) {
      const side = unitLabel(room.id, mine.side === 0 ? viewMatch.p0Id : viewMatch.p1Id);
      pill.textContent =
        mine.state === B_WON
          ? `WON ${fmtCr(mine.payout)} ON ${side}`
          : mine.state === B_LOST
            ? `LOST ${fmtCr(mine.stake)} ON ${side}`
            : `YOU: ${fmtCr(mine.stake)} ON ${side} @${fmtOdds(mine.oddsMilli)}`;
    }
    return;
  }
  pill.classList.add('hidden');
  bar.classList.remove('hidden');
  const closes = betCloseSecs(viewMatch);
  const key = `${viewMatch.id}:${book.odds0Milli}:${book.odds1Milli}:${closes ?? -1}:${wallet.balance}:${betPick ? betPick.side + ':' + betPick.stake : ''}`;
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  bar.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'bet-label';
  const left = document.createElement('span');
  left.textContent = `🪙 ${fmtCr(wallet.balance)}`;
  const right = document.createElement('span');
  right.className = 'closing';
  right.textContent = closes !== null && closes > 0 ? `CLOSES IN ${closes}s` : 'BETS OPEN';
  head.append(left, right);
  bar.append(head);

  const odds = document.createElement('div');
  odds.className = 'bet-odds';
  odds.append(
    oddsButton(room, viewMatch, 0, book, true, null),
    oddsButton(room, viewMatch, 1, book, true, null)
  );
  bar.appendChild(odds);
  if (betPick && betPick.matchId === viewMatch.id) {
    bar.appendChild(stakeRow(room, viewMatch, book));
  }
}

// ----- the finish: two winners, the bracket's and the stands' -----
function crownCard(label: string, name: string, sub: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'crown-card';
  const l = document.createElement('div');
  l.className = 'c-label';
  l.textContent = label;
  const n = document.createElement('div');
  n.className = 'c-name';
  n.textContent = name;
  const su = document.createElement('div');
  su.className = 'c-sub';
  su.textContent = sub;
  card.append(l, n, su);
  return card;
}

function renderCrowns(room: any) {
  const el = $('crowns');
  const leaders = $('bet-leaders');
  el.classList.remove('hidden');
  el.innerHTML = '';
  el.appendChild(
    crownCard('🏆 CUP WINNER', room.championName || 'CHAMPION', 'WINS THE TOURNAMENT')
  );
  // no bet crown when nobody ever staked anything
  if (room.betWinnerName) {
    el.appendChild(
      crownCard('💰 BET WINNER', room.betWinnerName, `${fmtCr(room.betWinnerCredits)} CREDITS`)
    );
  }

  // the money table behind the crown: everyone who actually bet
  const bettors = [];
  for (const w of conn.db.wallet.iter()) {
    if (w.lobbyId !== room.id) continue;
    if (w.won === 0 && w.lost === 0 && w.staked === 0) continue;
    bettors.push(w);
  }
  bettors.sort((a, b) => b.balance - a.balance);
  leaders.classList.toggle('hidden', bettors.length < 2);
  if (bettors.length >= 2) {
    const medals = ['🥇', '🥈', '🥉'];
    leaders.textContent = bettors
      .slice(0, 3)
      .map(
        (w, i) =>
          `${medals[i] ?? '·'} ${playerByIdentity(w.identity)?.name || 'PLAYER'} ${fmtCr(w.balance)}`
      )
      .join('   ');
  }
}

function updateWaitingOverlay(room: any, me: any) {
  showOverlay('waiting');
  const isTournament = room.mode === MODE_TOURNAMENT;
  const running = room.status === L_RUNNING;
  const players = roomPlayers(room.id).filter(p => !p.isBot);
  const isHost = me && room.hostId.toHexString() === me.identity.toHexString();

  const watching = !!me?.spectator;
  $('waiting-title').textContent = isTournament
    ? 'TOURNAMENT'
    : watching
      ? 'SPECTATING'
      : 'LOBBY';
  $('lobby-code').textContent = room.code;
  $('lobby-link').textContent = `${location.origin}${location.pathname}?lobby=${room.code}`;
  // mid-tournament the bracket takes center stage; the share code has done its job
  $('lobby-code').classList.toggle('hidden', running);
  $('lobby-link').classList.toggle('hidden', running);
  $('copy-link-btn').classList.toggle('hidden', running);

  updateLobbyInfo(room, running, isTournament && !running && !!isHost);

  $('waiting-roster').classList.toggle('hidden', running);
  if (!running) updateRoster(room, me, players);
  renderTourneyUpdates(isTournament);
  renderBetPanel(room, me);

  if (isTournament && running) {
    mountBracket(overlays.waiting);
    updateBracket(room);
  } else if (isTournament && players.length >= 2) {
    mountBracket(overlays.waiting);
    updateBracketPreview(room, players);
  } else {
    $('bracket').classList.add('hidden');
    lastBracketKey = '';
  }

  // host can flip format / court count while registration is open
  const settings = $('tourney-settings');
  const canTweak = isTournament && !running && !!isHost;
  settings.classList.toggle('hidden', !canTweak);
  if (canTweak) {
    for (const btn of settings.querySelectorAll<HTMLButtonElement>('.setting-btn')) {
      const sel =
        btn.dataset.format != null
          ? Number(btn.dataset.format) === (room.format ?? 0)
          : btn.dataset.team != null
            ? Number(btn.dataset.team) === (room.teamSize ?? 1)
            : Number(btn.dataset.conc) === (room.concurrent ?? 1);
      btn.classList.toggle('selected', sel);
    }
  }

  const startBtn = $('start-tournament-btn') as HTMLButtonElement;
  startBtn.classList.toggle('hidden', !isTournament || !isHost || running || watching);
  // Two entrants is a tournament; the server fills the rest of the draw with
  // bots (short teams and empty bracket seats alike), so no count is invalid.
  const ts = room.teamSize ?? 1;
  const enough = players.length >= 2;
  const teams = Math.ceil(players.length / ts);
  startBtn.disabled = !enough;
  startBtn.textContent = !enough
    ? 'Need 2+ Players'
    : ts >= 2
      ? `Start Tournament (${teams} Team${teams === 1 ? '' : 's'} of ${ts})`
      : `Start Tournament (${players.length}/${MAX_TOURNAMENT_PLAYERS})`;

  const hostName = playerByIdentity(room.hostId)?.name || 'THE HOST';
  let sub: string;
  if (watching) {
    sub = isTournament
      ? 'WATCHING — THE NEXT MATCH IS BEING SCHEDULED…'
      : 'THAT MATCH HAS FINISHED — THANKS FOR WATCHING';
  } else if (running) {
    const capHex = myCaptainHex(room.id);
    const mine = lobbyMatchList(room.id).filter(
      m =>
        m.state === M_DONE && m.hasP1 &&
        (m.p0Id.toHexString() === capHex || m.p1Id.toHexString() === capHex)
    );
    const last = mine[mine.length - 1];
    const lostLast =
      last && last.winnerSide !== (last.p0Id.toHexString() === capHex ? 0 : 1);
    sub = me?.eliminated
      ? 'ELIMINATED — STICK AROUND AND WATCH THE BRACKET'
      : lostLast && (room.format ?? 0) === FORMAT_DOUBLE
        ? 'LOSERS BRACKET — YOUR NEXT MATCH IS BEING SCHEDULED…'
        : 'YOU ADVANCE! NEXT MATCH IS BEING SCHEDULED…';
  } else if (!isTournament) {
    const ts = room.teamSize ?? 1;
    sub =
      ts >= 2
        ? `${ts}V${ts} — SHARE THE LINK · ${players.length}/${ts * 2} PLAYERS IN`
        : 'SHARE THIS CODE OR LINK WITH A FRIEND';
  } else if (isHost) {
    sub =
      players.length < 2 * ts
        ? `SHARE THE LINK — NEED AT LEAST ${2 * ts} PLAYERS TO START`
        : ts >= 2
          ? 'SHARE THE LINK — TEAMS ARE DRAWN WHEN YOU START'
          : 'SHARE THE LINK — START WHEN EVERYONE IS IN';
  } else {
    sub = `WAITING FOR ${hostName} TO START…`;
  }
  $('waiting-sub').textContent = sub;
  $('waiting-foot').textContent = running && isTournament ? 'B — WATCH LIVE PLAY' : '';
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastFrameAt = performance.now();
// what the last-drawn menu backdrop looked like ('' = must redraw)
let menuSceneKey = '';

function frame() {
  if (!subscribed) return;
  const now = performance.now();
  const frameDt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  const me = getMyPlayer();
  const room = me && me.lobbyId !== 0n ? getLobby(me.lobbyId) : null;
  const myMatch = me && me.matchId !== 0n ? getMatch(me.matchId) : null;

  if (!me || !room) {
    if (!pendingAction) {
      showOverlay('menu');
      updateLobbyBrowser();
      updateLiveMatches();
      refreshProfileCard();
    }
    if (matchMenuOpen()) closeMatchMenu();
    updateHaltOverlay(null, me);
    setBanner('');
    help.textContent = '';
    countdownEl.textContent = '';
    prevCountdown = 0;
    betPick = null;
    betPanelKey = '';
    if (introShownFor) hideMatchIntro();
    if (chatFeed.childElementCount) chatFeed.innerHTML = '';
    if (chatOpen) closeChat();
    positionHeadAnnos(false);
    // The menu backdrop is a static scene (no players, no ball, camera at
    // rest) — render it once and only again when something it depends on
    // changes, instead of burning the GPU at full rate behind the menu.
    const size = canvasCssSize();
    const key = document.hidden
      ? menuSceneKey // hidden: renders are skipped, don't mark as drawn
      : `${selectedPitch}|${size.w}x${size.h}|${window.devicePixelRatio}`;
    if (key !== menuSceneKey || sceneIsAnimating()) {
      menuSceneKey = key;
      drawScene({
        flip: 1, pitch: selectedPitch, phase: 0, kickoffSide: 0, players: [], ball: null,
      });
    }
    return;
  }
  menuSceneKey = ''; // out of the menu — first frame back must redraw

  // keep the tournament story current even while a match is on screen, so
  // the waiting screen's updates panel is never behind
  if (room.mode === MODE_TOURNAMENT) updateTourneyFeed(room);

  // input flush (only meaningful while in a match). While an overlay is up
  // the controller drives menu focus instead — don't also kick with A/B.
  if (myMatch) {
    const gp = activeNavLayer() ? null : pollGamepad();
    const [kx, ky] = keyboardDir();
    const [tx, ty] = touchDir();
    const dir =
      tx !== 0 || ty !== 0
        ? [tx, ty]
        : gp && (gp[0] !== 0 || gp[1] !== 0)
          ? gp
          : [kx, ky];
    sendInput(dir[0], dir[1], sprintHeld());
  }

  // which match do we look at? mine, else my just-finished one (the server
  // clears matchId when a match ends — without this the gameover screen
  // would fall through to the lobby), else spectate the first live one
  const matches = lobbyMatchList(room.id);
  const liveMatches = matches.filter(m => m.state === M_LIVE);
  const lastMatch = matches.length ? matches[matches.length - 1] : null;
  const doneMine =
    !myMatch && room.mode === MODE_QUICK && lastMatch && lastMatch.state === M_DONE &&
    (lastMatch.p0Id.toHexString() === myHex() || lastMatch.p1Id.toHexString() === myHex())
      ? lastMatch
      : null;
  // tournament: my just-finished match (byes excluded) gets a result screen
  // too — until I press CONTINUE, or my next round pulls me in
  const capHexMine = room.mode === MODE_TOURNAMENT ? myCaptainHex(room.id) : myHex();
  const myDoneTourney =
    !myMatch && room.mode === MODE_TOURNAMENT
      ? matches
          .filter(
            m =>
              m.state === M_DONE && m.hasP1 &&
              (m.p0Id.toHexString() === capHexMine || m.p1Id.toHexString() === capHexMine)
          )
          .pop() ?? null
      : null;
  const doneTourney =
    myDoneTourney && String(myDoneTourney.id) !== tourneyResultSeen ? myDoneTourney : null;
  // a spectator watches the match they picked for as long as it runs; when it
  // ends the room's next live one takes over (a tournament rolls on by itself)
  const chosen =
    spectateMatchId !== null
      ? liveMatches.find(m => m.id === spectateMatchId) ?? null
      : null;
  const viewMatch =
    myMatch ?? doneMine ?? doneTourney ?? chosen ?? (liveMatches.length ? liveMatches[0] : null);
  const spectating = !myMatch && !doneMine && !doneTourney && !!viewMatch;
  if (!doneTourney) tourneyResultShowing = null;

  // ----- room-level screens -----
  if (room.status === L_OPEN && !viewMatch) {
    updateWaitingOverlay(room, me);
    updateChat(room.id, me.name);
    return;
  }

  if (room.mode === MODE_TOURNAMENT && room.status === L_FINISHED) {
    showOverlay('gameover');
    // team champions are stored as "A & B & C" — any member takes the crown,
    // and the betting crown is shared the same way on a tie
    const iAmChampion = (room.championName ?? '').split(' & ').includes(me.name);
    const iAmBetWinner = (room.betWinnerName ?? '').split(' & ').includes(me.name);
    $('gameover-title').textContent = iAmChampion
      ? iAmBetWinner
        ? '🏆 CHAMPION — AND THE BOOK!'
        : '🏆 CHAMPION!'
      : iAmBetWinner
        ? '💰 BETTING CHAMPION!'
        : '🏆 TOURNAMENT OVER';
    $('gameover-score').textContent = iAmBetWinner && !iAmChampion
      ? `YOU READ THE BRACKET BEST — ${fmtCr(room.betWinnerCredits)} CREDITS`
      : `${room.championName} WINS THE TOURNAMENT!`;
    renderCrowns(room);
    const btn = $('rematch-btn') as HTMLButtonElement;
    btn.textContent = 'Rematch';
    btn.classList.add('hidden');
    $('match-summary').classList.add('hidden');
    // final results bracket
    mountBracket(overlays.gameover);
    updateBracket(room);
    updateChat(room.id, me.name);
    return;
  }
  ($('rematch-btn') as HTMLButtonElement).classList.remove('hidden');

  if (!viewMatch) {
    // tournament running but between matches — show the live bracket
    updateWaitingOverlay(room, me);
    updateChat(room.id, me.name);
    return;
  }

  // spectators can flip to the bracket with B
  if (spectating && bracketView && room.mode === MODE_TOURNAMENT) {
    updateWaitingOverlay(room, me);
    updateChat(room.id, me.name);
    return;
  }

  // ----- match view -----
  const mSide = myMatch ? me.side : -1;
  const flip = myMatch ? (me.side === 1 ? -1 : 1) : 1;
  const players = matchPlayerList(viewMatch.id);

  // crowd reacts before any result-screen early return so the full-time
  // roar still fires on the frame the match flips to PHASE_OVER
  crowdFrame(viewMatch, getBall(viewMatch.id));
  if (viewMatch.state === M_DONE && !spectating && doneTourney) {
    // tournament match result: win → next round awaits; loss → eliminated
    showOverlay('gameover');
    $('bracket').classList.add('hidden');
    $('crowns').classList.add('hidden');
    $('bet-leaders').classList.add('hidden');
    const sideHere = viewMatch.p0Id.toHexString() === capHexMine ? 0 : 1;
    const iWon = viewMatch.winnerSide === sideHere;
    // double elim: a winners-bracket loss drops you down, it doesn't knock
    // you out — the server only flags `eliminated` when you're really done
    const droppedDown = !iWon && !me.eliminated && (room.format ?? 0) === FORMAT_DOUBLE;
    $('gameover-title').textContent = iWon
      ? '🏆 YOU WIN!'
      : droppedDown
        ? '↘ TO THE LOSERS BRACKET'
        : '❌ ELIMINATED';
    // the result card carries the score — this line carries what it means
    $('gameover-score').textContent = iWon
      ? 'GET READY FOR THE NEXT ROUND'
      : droppedDown
        ? "ONE MORE LOSS AND YOU'RE OUT"
        : 'STICK AROUND AND WATCH THE FINISH';
    showMatchSummary(room, viewMatch);
    showProgress(viewMatch);
    const cbtn = $('rematch-btn') as HTMLButtonElement;
    cbtn.textContent = 'Continue';
    cbtn.disabled = false;
    tourneyResultShowing = String(viewMatch.id);
    updateChat(room.id, me.name);
    return;
  }
  if (viewMatch.state === M_DONE && !spectating && room.mode === MODE_QUICK) {
    showOverlay('gameover');
    $('bracket').classList.add('hidden');
    $('match-summary').classList.add('hidden');
    $('crowns').classList.add('hidden');
    $('bet-leaders').classList.add('hidden');
    const abandoned = viewMatch.winnerSide === NO_WINNER;
    const iWon = viewMatch.winnerSide === me.side;
    showProgress(viewMatch);
    if (abandoned) {
      // Both sides dropped and neither came back: no winner, nothing awarded.
      $('gameover-title').textContent = 'MATCH ABANDONED';
      $('gameover-score').textContent = viewMatch.pointMsg;
    } else {
      $('gameover-title').textContent = iWon ? 'YOU WIN!' : 'YOU LOSE';
      $('gameover-score').textContent =
        `${viewMatch.pointMsg}  —  FULL TIME ${viewMatch.p0Goals}-${viewMatch.p1Goals}`;
    }
    const btn = $('rematch-btn') as HTMLButtonElement;
    const iVoted = (viewMatch.rematchVotes & (1 << me.side)) !== 0;
    const theyVoted = (viewMatch.rematchVotes & (1 << (1 - me.side))) !== 0;
    const rival = (room.teamSize ?? 1) >= 2 ? 'The Other Team' : 'Opponent';
    btn.textContent = room.vsBot
      ? 'Rematch'
      : iVoted
        ? `Waiting For ${rival}… (1/2)`
        : theyVoted
          ? `${rival} Wants A Rematch! (1/2)`
          : 'Vote Rematch';
    btn.disabled = iVoted && !room.vsBot;
    updateChat(room.id, me.name);
    return;
  }
  showOverlay(null);
  // Somebody dropped: the world is frozen server-side and this is the only
  // thing on screen that moves.
  updateHaltOverlay(myMatch, me);
  maybeShowMatchIntro(room, viewMatch);

  // ----- match-start 3-2-1 countdown (server-driven via startTicks) -----
  // A tournament match with bettors in the room opens with a betting window
  // in FRONT of the 3-2-1. That stretch gets a quiet chip, not a giant
  // number counting down from 15 with a beep every second.
  const cdTicks = viewMatch.phase === PHASE_KICKOFF ? (viewMatch.startTicks ?? 0) : 0;
  const rawCd = cdTicks > 0 ? Math.ceil(cdTicks / TICK_HZ) : 0;
  const betSecs = rawCd - COUNTDOWN_SECS;
  const windowChip = $('bet-window-chip');
  const showWindow = betSecs > 0 && !!bookOf(viewMatch.id)?.open;
  windowChip.classList.toggle('hidden', !showWindow);
  if (showWindow) {
    const txt = `BETS OPEN · KICK OFF IN ${betSecs}s`;
    if (windowChip.textContent !== txt) windowChip.textContent = txt;
  }
  const cdNum = betSecs > 0 ? 0 : rawCd;
  if (cdNum !== prevCountdown) {
    if (cdNum > 0) {
      countdownEl.textContent = String(cdNum);
      countdownEl.classList.remove('pop');
      void (countdownEl as HTMLElement).offsetWidth;
      countdownEl.classList.add('pop');
      playCountdown();
    } else {
      countdownEl.textContent = '';
      if (prevCountdown === 1) {
        showToast('KICK OFF!', '#8cf08c');
        playGo();
      }
    }
    prevCountdown = cdNum;
  }

  // ball with client-side extrapolation between server ticks. The ball rolls
  // on the ground most of the time, so this is plain velocity integration
  // with gravity applied only while it is airborne.
  const ball = getBall(viewMatch.id);
  let renderBall: Scene['ball'] = null;
  if (ball && ball.active) {
    let { x, y, z, vz } = ball;
    const snap = ballSnapshots.get(String(viewMatch.id));
    // a dribbled ball is pinned to its owner's feet server-side — the owner's
    // own smoothing already moves it, so don't extrapolate it away
    if (snap && !ball.hasOwner) {
      const dt = Math.min(0.1, (now - snap.at) / 1000);
      const r = snap.row;
      // custom rules can change the ball's weight — use the room's gravity
      const grav = GRAVITY * (room.gravityMul ?? 1);
      x = r.x + r.vx * dt;
      y = r.y + r.vy * dt;
      z = Math.max(0, r.z + r.vz * dt + (r.z > 0 ? 0.5 * grav * dt * dt : 0));
      vz = r.z > 0 ? r.vz + grav * dt : r.vz;
    }
    // whose feet it is at: the camera leads a carried ball the way its owner
    // is attacking, never on a dribble's stop-start velocity
    const ownerHex = ball.hasOwner ? ball.ownerId.toHexString() : '';
    const owner = ownerHex
      ? players.find(p => p.identity.toHexString() === ownerHex)
      : undefined;
    const bsm = smoothBall ?? { x, y, z };
    // a loose ball is already smooth (real velocity integration), so this only
    // has to take the stutter off a dribble — hence the fast gain
    const bAlpha = 1 - Math.exp(-frameDt * (ball.hasOwner ? 14 : 26));
    smoothBall = {
      x: bsm.x + (x - bsm.x) * bAlpha,
      y: bsm.y + (y - bsm.y) * bAlpha,
      z: bsm.z + (z - bsm.z) * bAlpha,
    };
    if (Math.hypot(smoothBall.x - x, smoothBall.y - y) > 10) smoothBall = { x, y, z };
    renderBall = {
      x: smoothBall.x, y: smoothBall.y, z: smoothBall.z,
      vx: ball.vx, vy: ball.vy, vz,
      lastTouchSide: ball.lastTouchSide,
      hasOwner: ball.hasOwner,
      ownerSide: owner ? owner.side : ball.lastTouchSide,
    };
  }

  // HUD
  const goals = goalsFor(viewMatch.id);
  const touchHex = ball ? ball.lastTouchId.toHexString() : '';
  const striker = ball ? players.find(p => p.identity.toHexString() === touchHex) : undefined;
  // Mirrors controlledBody() in the module: my stick drives whichever body on
  // my side has claimed my seat, which after a switch is not my own row.
  const focusBody =
    myMatch && !spectating
      ? // the same fallback the module uses: until my first input nothing
        // carries my seat yet, and a client that thinks it has no man to
        // follow would put the camera into its spectator wander
        // EVERY body, keeper included — filtering this to outfielders is what
        // makes the camera and the control marker lose the man the moment
        // control lands in goal.
        (players.find(
          p => p.side === me.side && p.ctrlSeat === (me.teamSlot ?? 0)
        ) ?? players.find(p => p.identity.toHexString() === myHex()))
      : undefined;
  noteControlBody(focusBody ? focusBody.identity.toHexString() : '');
  updatePlates(viewMatch, players, mSide);
  updateClock(viewMatch);
  updatePointCard(viewMatch, players, goals);
  const pitchSlotByName = new Map(players.map(p => [p.name, rigSlotOf(p)] as [string, number]));
  updateChat(room.id, me.name, pitchSlotByName);
  goalSound(viewMatch, mSide);
  setTouchVisible(!spectating);
  // spectator chrome: exit pill, the broadcast bug under the left plate, and
  // nameplates over the heads (they say who's who — no banner needed).
  // The exit pill is ONLY for menu watchers (me.spectator): a tournament
  // entrant watching between rounds must not get a one-click forfeit.
  $('spectate-exit').classList.toggle('hidden', !(spectating && me.spectator));
  $('spectate-chip').classList.toggle('hidden', !spectating);
  renderBetBar(room, me, viewMatch, spectating);
  document.body.classList.toggle('spectating', spectating);
  if (spectating) {
    const pitchIdx = liveMatches.findIndex(m => m.id === viewMatch.id);
    const pitchBit =
      liveMatches.length > 1 && pitchIdx >= 0
        ? ` · PITCH ${pitchIdx + 1}/${liveMatches.length}`
        : '';
    const chipText =
      room.mode === MODE_TOURNAMENT
        ? `WATCHING · ROUND ${viewMatch.round}${pitchBit}`
        : 'WATCHING LIVE';
    const chipEl = $('spectate-chip-text');
    if (chipEl.textContent !== chipText) chipEl.textContent = chipText;
    // A plate per head, so every body on the pitch says who it is; the ones
    // with no player are hidden with their column (see positionHeadAnnos).
    for (const p of players) {
      const tag = nameTagEls[rigSlotOf(p)];
      // Solo matches carry the rating on the nameplate; in team play the
      // seats are crowded enough without a rating on each one.
      const rating = sidePlayers(players, p.side).length === 1 ? mmrOf(p) : null;
      const name = (p.name || 'PLAYER') + (rating === null ? '' : ` · ${rating}`);
      if (tag && tag.textContent !== name) tag.textContent = name;
    }
  }
  // The three buttons are context-sensitive, so the hints have to be too:
  // both the thumb buttons and the help line say what a press does here and
  // now, and follow whichever device the player actually used last.
  const acts = actionLabels(viewMatch, ball, focusBody);
  setTouchActions(acts);
  help.textContent = spectating
    ? usingPad()
      ? ''
      : room.mode === MODE_TOURNAMENT
        ? (liveMatches.length > 1 ? 'N NEXT PITCH · ' : '') +
          'B BRACKET · ENTER CHAT · 1-8 EMOTES'
        : 'ENTER CHAT · 1-8 EMOTES'
    : usingPad()
      ? `STICK MOVE · Ⓐ ${acts[0]} · Ⓑ ${acts[1]} · Ⓧ ${acts[2]} · LB SWITCH · RT SPRINT`
      : touchAvailable
        ? `DRAG LEFT TO MOVE · ${acts.join(' · ')} · ⚡ SPRINT`
        : `WASD MOVE · SPACE ${acts[0]} · K ${acts[1]} · L ${acts[2]} · Q SWITCH · SHIFT SPRINT`;
  if (spectating) {
    // no standing banner — the nameplates and the bug carry the context, so
    // mid-pitch text stays reserved for goals and restarts
    setBanner(viewMatch.phase === PHASE_PAUSE ? viewMatch.pointMsg : '');
  } else if (viewMatch.phase === PHASE_KICKOFF) {
    const mine = viewMatch.kickoffSide === me.side;
    setBanner(
      cdTicks > 0 ? 'GET READY…' : mine ? 'YOUR KICK OFF — PLAY IT FORWARD' : 'THEIR KICK OFF…'
    );
  } else if (viewMatch.phase === PHASE_PAUSE) {
    setBanner(viewMatch.pointMsg);
  } else if (viewMatch.graceTicks > 0 && viewMatch.restartKind !== RK_NONE) {
    setBanner(
      viewMatch.restartSide === me.side
        ? `${RESTART_NAMES[viewMatch.restartKind] ?? 'RESTART'} — YOURS`
        : `${RESTART_NAMES[viewMatch.restartKind] ?? 'RESTART'} — THEIRS`
    );
  } else {
    setBanner('');
  }

  const sceneObj: Scene = {
    flip,
    pitch: room.pitch ?? 0,
    phase: viewMatch.phase,
    kickoffSide: viewMatch.kickoffSide ?? 0,
    players: players.map(p => {
      const pos = renderPosition(p, now, frameDt);
      return {
        x: pos.x,
        y: pos.y,
        serverX: p.x,
        serverY: p.y,
        side: p.side,
        rigSlot: rigSlotOf(p),
        kickTicks: p.kickTicks ?? 0,
        kickKind: p.kickKind ?? 0,
        kickHeld: !!p.kickHeld,
        slideTicks: p.slideTicks ?? 0,
        role: p.role ?? 0,
        dirX: p.dirX,
        dirY: p.dirY,
        sprinting: !!p.sprinting,
        characterId: p.characterId ?? 0,
      };
    }),
    ball: renderBall,
    // who struck it, so the renderer animates the boot that actually kicked
    // instead of guessing at the body nearest the ball
    strikerRigSlot: striker ? rigSlotOf(striker) : undefined,
    // how the camera frames a stoppage — a corner wants the flag and the near
    // post in shot, a kick-off restart is the cue for the goal cut
    restartKind: viewMatch.restartKind ?? RK_NONE,
    // the body my stick is actually driving (after a switch it is a
    // team-mate's): the camera has to keep it in frame or a switch to a man
    // off-screen leaves me blind. Spectators have none, and get the wander.
    focusSlot: focusBody ? rigSlotOf(focusBody) : undefined,
    // the man I just left, so the eye can follow the handoff
    ghostSlot: ghostSlotNow(focusBody ? rigSlotOf(focusBody) : undefined, now),
    // Bodies a TEAM-MATE is driving. Marked differently because the server
    // will never hand them over, and without the distinction you mash switch
    // at one and conclude the button is broken.
    //
    // Keyed on the control token, not on isBot: a team-mate who has switched
    // is driving a FILLER's row, so an isBot test would miss exactly the case
    // this exists for. Restricted to my own side — an opponent's controlled
    // man is not something I could ever switch to.
    otherPilotSlots:
      spectating || !me
        ? []
        : players
            .filter(
              p =>
                p.side === me.side &&
                (p.ctrlSeat ?? 255) !== 255 &&
                p !== focusBody
            )
            .map(p => rigSlotOf(p)),
  };

  // ----- replay recording + playback -----
  if (replayMatchId !== viewMatch.id) {
    replayMatchId = viewMatch.id;
    replayBuf.length = 0;
    replayActive = false;
    replayPendingAt = 0;
    replayHoldAt = 0;
    stageEl.classList.remove('replay');
    prevPhaseMain = -1;
  }
  if (viewMatch.phase === PHASE_LIVE) {
    replayBuf.push({ t: now, scene: sceneObj });
    while (replayBuf.length && replayBuf[0].t < now - 6000) replayBuf.shift();
  }
  // Only a real stoppage is worth showing back — a goal or the end of a half.
  // Kick-ins, corners and goal kicks come and go too fast for a cut.
  const worthReplay =
    viewMatch.restartKind === RK_KICKOFF ||
    viewMatch.restartKind === RK_HALFTIME ||
    viewMatch.restartKind === RK_OVERTIME;
  if (
    prevPhaseMain === PHASE_LIVE && viewMatch.phase === PHASE_PAUSE &&
    worthReplay && replayBuf.length > 10
  ) {
    replayFrames = replayBuf.filter(f => f.t >= now - REPLAY_WINDOW_MS);
    if (replayFrames.length > 5) {
      replayPendingAt = now + REPLAY_CUT_DELAY_MS;
      replayIdx = 0;
      replayHoldAt = 0;
      // freeze-frame for the hold at the end of playback: the ball sits where
      // the server left it when play stopped
      replayEndScene = ball
        ? {
            ...sceneObj,
            ball: {
              x: ball.x, y: ball.y, z: Math.max(0, ball.z),
              vx: 0, vy: 0, vz: 0,
              lastTouchSide: ball.lastTouchSide,
              hasOwner: false,
            },
          }
        : null;
    }
  }
  // beat's up — now cut to the broadcast replay cam
  if (replayPendingAt > 0 && now >= replayPendingAt) {
    replayPendingAt = 0;
    replayActive = true;
    replayStart = now;
    stageEl.classList.add('replay');
  }
  if (viewMatch.phase !== PHASE_PAUSE && (replayActive || replayPendingAt > 0)) {
    replayActive = false;
    replayPendingAt = 0;
    replayHoldAt = 0;
    stageEl.classList.remove('replay');
  }
  if (viewMatch.phase === PHASE_KICKOFF) replayBuf.length = 0;
  prevPhaseMain = viewMatch.phase;

  if (replayActive && viewMatch.phase === PHASE_PAUSE) {
    const pt = replayFrames[0].t + (now - replayStart) * REPLAY_SPEED;
    while (replayIdx < replayFrames.length - 1 && replayFrames[replayIdx + 1].t <= pt) {
      replayIdx++;
    }
    if (replayIdx >= replayFrames.length - 1) {
      // playback caught up — rest on the finish for a beat, then cut to live
      if (replayHoldAt === 0) replayHoldAt = now;
      if (now - replayHoldAt >= REPLAY_TAIL_MS) {
        replayActive = false;
        replayHoldAt = 0;
        stageEl.classList.remove('replay');
        drawScene(sceneObj);
      } else {
        drawScene({
          ...(replayEndScene ?? replayFrames[replayFrames.length - 1].scene),
          replayCam: true,
        });
      }
    } else {
      // slow-mo playback on the broadcast cam
      drawScene({ ...replayFrames[replayIdx].scene, replayCam: true });
    }
  } else if (replayPendingAt > 0 && replayEndScene) {
    // the beat before the cut: still the live cam, but the ball rests where
    // play stopped rather than blinking out with the whistle
    drawScene({ ...sceneObj, ball: replayEndScene.ball });
  } else {
    drawScene(sceneObj);
  }
  // pin emote/speech bubbles above the freshly-drawn heads (hidden in replay
  // slow-mo — the broadcast cam re-frames the players)
  positionHeadAnnos(!replayActive);
}

// ---------------------------------------------------------------------------
// Controller menu navigation: d-pad / left stick moves a focus ring across the
// active screen, A activates, B backs out of sub-screens, Start jumps to the
// primary action. Active only while an overlay or modal is up — in-match
// gamepad input stays with pollGamepad().
// ---------------------------------------------------------------------------
const NAV_INITIAL_DELAY = 380; // ms held before focus starts repeating
const NAV_REPEAT = 140;
const NAV_BTN_A = 0;
const NAV_BTN_B = 1;
const NAV_BTN_START = 9;
const NAV_BACK_TARGETS: Record<string, string> = {
  'rules-modal': 'rules-done',
  graphics: 'gfx-close',
  'select-player': 'char-back',
  'select-court': 'court-back',
};

let navLayerPrev: HTMLElement | null = null;
let navFocus: HTMLElement | null = null;
let navHeld: string | null = null;
let navRepeatAt = 0;
const navPrevBtn: Record<number, boolean> = {};

// Topmost interactive surface: modals sit above the menu overlays.
function activeNavLayer(): HTMLElement | null {
  for (const id of ['name-modal', 'rules-modal', 'graphics']) {
    const el = $(id);
    if (!el.classList.contains('hidden')) return el;
  }
  for (const el of Object.values(overlays)) {
    if (!el.classList.contains('hidden')) return el;
  }
  return null;
}

// Buttons and sliders only — text inputs need a keyboard anyway.
function navCandidates(layer: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of layer.querySelectorAll<HTMLElement>('button, input[type="range"]')) {
    if (el.closest('.hidden')) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push(el);
  }
  return out;
}

function navDefault(cands: HTMLElement[]): HTMLElement | null {
  return (
    cands.find(c => c.hasAttribute('data-nav-default')) ??
    cands.find(c => c.classList.contains('primary') || c.classList.contains('gold')) ??
    cands[0] ??
    null
  );
}

function setNavFocus(el: HTMLElement | null) {
  if (navFocus === el) return;
  navFocus?.classList.remove('gp-focus');
  navFocus = el;
  if (el) {
    el.classList.add('gp-focus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function navMove(dir: string, layer: HTMLElement) {
  const cands = navCandidates(layer);
  if (!cands.length) return;
  if (!navFocus || !cands.includes(navFocus)) {
    setNavFocus(navDefault(cands));
    return;
  }
  // left/right on a focused slider adjusts it instead of moving focus
  if (
    navFocus instanceof HTMLInputElement &&
    navFocus.type === 'range' &&
    (dir === 'left' || dir === 'right')
  ) {
    const step = Number(navFocus.step) || 5;
    navFocus.value = String(Number(navFocus.value) + (dir === 'right' ? step : -step));
    navFocus.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const from = navFocus.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const c of cands) {
    if (c === navFocus) continue;
    const r = c.getBoundingClientRect();
    const dx = r.left + r.width / 2 - fx;
    const dy = r.top + r.height / 2 - fy;
    const primary =
      dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
    const ortho = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    if (primary < 4) continue; // must actually lie in that direction
    const score = primary + ortho * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best) setNavFocus(best);
}

function gamepadMenuNav() {
  const layer = activeNavLayer();
  if (layer !== navLayerPrev) {
    navLayerPrev = layer;
    // auto-focus the default action only for controller players — a mouse
    // user shouldn't see a stray focus ring
    setNavFocus(layer && usingPad() ? navDefault(navCandidates(layer)) : null);
  }
  if (!layer) return;
  const gp = activePad();
  if (!gp) return;
  const now = performance.now();

  const ax = gp.axes[0] ?? 0;
  const ay = gp.axes[1] ?? 0;
  const dir = gp.buttons[12]?.pressed || ay < -0.6
    ? 'up'
    : gp.buttons[13]?.pressed || ay > 0.6
      ? 'down'
      : gp.buttons[14]?.pressed || ax < -0.6
        ? 'left'
        : gp.buttons[15]?.pressed || ax > 0.6
          ? 'right'
          : null;
  if (
    dir ||
    gp.buttons[NAV_BTN_A]?.pressed ||
    gp.buttons[NAV_BTN_B]?.pressed ||
    gp.buttons[NAV_BTN_START]?.pressed
  ) {
    padUsedAt = now;
  }
  if (dir) {
    if (dir !== navHeld) {
      navHeld = dir;
      navRepeatAt = now + NAV_INITIAL_DELAY;
      navMove(dir, layer);
    } else if (now >= navRepeatAt) {
      navRepeatAt = now + NAV_REPEAT;
      navMove(dir, layer);
    }
  } else {
    navHeld = null;
  }

  const pressedEdge = (i: number) => {
    const down = gp.buttons[i]?.pressed ?? false;
    const was = navPrevBtn[i] ?? false;
    navPrevBtn[i] = down;
    return down && !was;
  };
  if (pressedEdge(NAV_BTN_A) && navFocus && layer.contains(navFocus)) {
    navFocus.click();
  }
  if (pressedEdge(NAV_BTN_B)) {
    const backId = NAV_BACK_TARGETS[layer.id];
    if (backId) $(backId).click();
  }
  if (pressedEdge(NAV_BTN_START)) {
    const cands = navCandidates(layer);
    const primary = cands.find(
      c => c.classList.contains('primary') || c.classList.contains('gold')
    );
    primary?.click();
  }
}

// Switching back to mouse/touch drops the controller focus ring.
window.addEventListener('pointerdown', () => setNavFocus(null));

buildSelectGrids();
showOverlay('connecting');
// Auth first: the identity SpacetimeDB derives from the Firebase token is
// what the player row, the account and any halted match are keyed to.
void initAuth()
  .then(async () => {
    // Returning from an emailed sign-in link? Finish it BEFORE connecting —
    // it may change the identity the player row is keyed to.
    if (!isEmailLinkReturn()) return;
    setStatus('FINISHING SIGN-IN…');
    const res = await completeEmailLink(async () =>
      // The link was opened on a different device or browser than it was
      // requested from, so this storage has no address to confirm against.
      window.prompt('Confirm the email address the sign-in link was sent to:')
    );
    if (res && !res.ok) setStatus(res.error.toUpperCase());
    else if (res?.switched) {
      setStatus('SIGNED IN TO YOUR EXISTING ACCOUNT — GUEST PROGRESS STAYED ON THIS DEVICE');
    } else if (res) setStatus('SIGNED IN — YOUR PROGRESS IS SAVED');
  })
  .then(() => {
    refreshAccountChip();
    void connect();
  });
// Auth can turn up LATE — the boot timeout gives up after a few seconds, but
// the observer keeps trying. If a real Firebase identity arrives after we
// already connected on the degraded fallback, move onto it: the account the
// player actually owns is the one their progress belongs on.
let connectedDegraded = false;
onAuthChange(() => {
  refreshAccountChip();
  if (connectedDegraded && !authDegraded()) {
    connectedDegraded = false;
    setStatus('ACCOUNT SERVICE RECONNECTED — SYNCING YOUR PROFILE');
    restartConnection();
  }
});
// FPS cap: skip rAF callbacks until the next slot on a fixed 1/cap grid. The
// grid snap (rather than `last = t`) matters on displays whose refresh rate
// isn't a multiple of the cap — e.g. 144Hz capped to 60 would otherwise
// settle at ~48fps.
let lastRenderAt = 0;
function loop(t: number) {
  requestAnimationFrame(loop);
  gamepadMenuNav(); // outside the fps cap: menu focus must stay responsive
  const cap = getGraphics().fpsCap;
  if (cap > 0) {
    const interval = 1000 / cap;
    if (t - lastRenderAt < interval - 0.5) return;
    lastRenderAt = t - ((t - lastRenderAt) % interval);
  }
  frame();
  trackFps(performance.now());
}
requestAnimationFrame(loop);
// rAF stops in hidden/occluded tabs; keep lobby/score UI fresh regardless.
setInterval(frame, 250);
