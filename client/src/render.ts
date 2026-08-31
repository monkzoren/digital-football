import * as THREE from 'three';
import {
  PITCH_HALF_LEN,
  PITCH_HALF_WID,
  GOAL_HALF_W,
  GOAL_HEIGHT,
  BOX_DEPTH,
  BOX_HALF_W,
  CENTER_CIRCLE_R,
  BALL_RADIUS,
  PLAYER_SPEED,
  SPRINT_MUL,
  CONTROL_RADIUS,
  SQUAD_SIZE,
  ROLE_KEEPER,
  RK_KICKOFF,
  RK_CORNER,
} from './config';
import { CHARACTERS, type Character, type HairStyle } from './characters';
import {
  playKick,
  playBounce,
  playWhoosh,
  playSlide,
  playGoal,
  crowdOoh,
} from './audio';
import { getGraphics, onGraphicsChange, type GraphicsSettings } from './graphics';

// ---------------------------------------------------------------------------
// Real-3D broadcast-style renderer (Three.js / WebGL).
//
// Game world coords: x across the pitch, y along it (halfway line at y=0),
// z up. Three.js coords TRANSPOSE that, because football is watched side-on:
// (wy*flip, wz, wx*flip). Three-x runs the LENGTH of the pitch — screen
// horizontal, a goal at each edge — and three-z runs across it, +z toward the
// camera on the near touchline. `flip` is a 180° YAW about the vertical, never
// a mirror (the map's determinant is +1 either way), so faces, shirt numbers
// and hair keep their handedness while both players attack screen-right.
//
// Animation is event-driven: the server flips ball.lastTouchSide at the exact
// contact tick, so we key full kick cycles (plant → strike → follow-through)
// off that change and the ball visibly leaves a boot.
// ---------------------------------------------------------------------------

export interface RenderPlayer {
  x: number;
  y: number;
  serverX: number; // raw (un-smoothed) server position — slide target
  serverY: number;
  side: number;
  rigSlot?: number; // stable rig index: side*SQUAD_SIZE + seat (keeper last)
  kickTicks: number; // kick charge counter (0 = not charging)
  kickKind: number; // 0 normal · 1 chip
  kickHeld: boolean;
  slideTicks: number; // >0 = slide tackle lunge/recovery
  diveTicks?: number; // keeper only: >0 = airborne, committed to a save
  diveDirX?: number;
  diveDirY?: number;
  role: number; // 0 outfield · 1 keeper
  dirX: number;
  dirY: number;
  sprinting?: boolean;
  characterId?: number;
}

export interface RenderBall {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  lastTouchSide: number;
  hasOwner: boolean; // true = at somebody's feet, being dribbled
  // Side of the dribbler (only meaningful while hasOwner). A carried ball's
  // velocity snaps between stride and knock-on every few ticks, so the camera
  // leads with the direction he's ATTACKING, never with that velocity.
  ownerSide?: number;
}

export interface Scene {
  flip: number;
  pitch: number; // 0 grass day · 1 grass night · 2 street
  phase: number; // 1 kickoff · 2 live · 3 pause · 4 over
  kickoffSide: number;
  players: RenderPlayer[];
  ball: RenderBall | null;
  // Who just kicked, from the ball's lastTouchId. With a squad a side the
  // nearest body to the ball is a bad guess — it animates a bystander, or
  // the keeper stood behind the striker.
  strikerRigSlot?: number;
  // RK_* of the restart being set up (0 = none). A corner is framed with the
  // flag and the near post in shot; a goal cut needs RK_KICKOFF to fire.
  restartKind?: number;
  // The body THIS client is driving — after a player switch that is not
  // necessarily their own row. The camera always keeps it in frame, or a
  // switch to a man off-screen leaves you blind.
  focusSlot?: number;
  // The man just handed over on a switch, while the eye is still on him.
  ghostSlot?: number;
  // Bodies another human is driving — marked apart from the AI ones.
  otherPilotSlots?: number[];
  replayCam?: boolean; // replay playback cuts to the goal-end camera
}

// One rig per seat on both squads: rigSlot = side * SQUAD_SIZE + seat.
const RIG_COUNT = SQUAD_SIZE * 2;

const PHASE_KICKOFF = 1;
const PHASE_LIVE = 2;
const PHASE_PAUSE = 3;

// Stereo position for a sound at three-x (the along-pitch axis, which IS
// screen horizontal). Measured from where the camera is LOOKING, not from
// where it stands: the aim is centre of frame by construction, so this is
// screen position, and a kick centre-frame at the far end stays centred
// instead of hard-panning to one ear.
const panOf = (x: number) => Math.max(-1, Math.min(1, (x - aimS) / 34));
// Bounce timbre per PITCHES index: grass (soft), night grass (soft), street
// concrete (hard slap).
const BOUNCE_BRIGHT = [0.85, 0.85, 1.2];

// Ground extents, in the transposed frame: three-x along the pitch, three-z
// across it. The bowl (hoardings, stands, towers) is built on LEN x WID; the
// grass runs on past the camera to EXT, because portrait's tall FOV looks
// steeply down near the bottom edge and must always land on turf, never off
// the edge of the world.
const GROUND_LEN = 92; // along: 26 units of run-off past each goal line
const GROUND_WID = 54; // across: 20 units outside each touchline
const GROUND_EXT = 140; // across, grass only — well behind the camera rail

const COLORS = {
  sky: 0xbcd8ee,
  standDark: 0x232c4e,
  hoardingText: '#1a2a8c',
  netPost: 0xf2f4f8, // goal frame: white posts and crossbar
  shorts: 0xf5f5f5,
  skin: 0xe8ae7e,
  hair: 0x3a2414,
  shoe: 0xffffff,
  ball: 0xffffff,
};

let renderer: THREE.WebGLRenderer;
let scene3: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let ballMesh: THREE.Mesh;
let ballBlob: THREE.Mesh;
let ballDrop: THREE.Line; // hairline from an airborne ball down to its blob
const trailMeshes: THREE.Mesh[] = [];
const trailHistory: THREE.Vector3[] = [];
// SUPER FINISHER props: the flaming ball's light, the launch shockwave ring,
// and the charge-up aura ring under the striker's feet
let ballLight: THREE.PointLight;
let shockMesh: THREE.Mesh;
let shockStart = -1;
const shockPos = new THREE.Vector3();
// Control markers (see updateControlMarkers): the ring and chevron on the
// body this client drives, the ring fading on the one it just left, and a
// dimmer ring per body another human is driving.
let focusRing: THREE.Mesh;
let focusChevron: THREE.Mesh;
let ghostRing: THREE.Mesh;
let pilotRings: THREE.Mesh[] = [];
let sun: THREE.DirectionalLight;
let detailGroup: THREE.Group; // crowd stands + umpire chair — droppable scenery
// two-frame crowd animation: stands alternate between the A/B textures on a
// slow clock (offset by parity so the bowl never moves in lockstep)
let crowdMatA: THREE.MeshLambertMaterial | null = null;
let crowdMatB: THREE.MeshLambertMaterial | null = null;
let crowdStands: { mesh: THREE.Mesh; parity: number; cur: number }[] = [];
let hostCanvas: HTMLCanvasElement;
let gfx: GraphicsSettings = getGraphics();

// The canvas's CSS size, cached via ResizeObserver: reading clientWidth every
// frame forces a layout flush (DOM overlays are also written every frame),
// so per-frame consumers use this instead of touching layout.
let cssW = 0;
let cssH = 0;
let sizeObserver: ResizeObserver | null = null;

function observeCanvasSize() {
  cssW = hostCanvas.clientWidth;
  cssH = hostCanvas.clientHeight;
  sizeObserver?.disconnect();
  if (typeof ResizeObserver !== 'undefined') {
    sizeObserver = new ResizeObserver(() => {
      cssW = hostCanvas.clientWidth;
      cssH = hostCanvas.clientHeight;
    });
    sizeObserver.observe(hostCanvas);
  }
}

// World -> three. A cyclic permutation (determinant +1) with wx and wy BOTH
// negated for flip = -1, which keeps the determinant +1: `flip` is therefore
// a 180° yaw, not a mirror, and no model is ever turned inside out.
const toThree = (flip: number, wx: number, wy: number, wz: number) =>
  new THREE.Vector3(wy * flip, wz, wx * flip);

// Side 0 defends -y and attacks +y (mirrors the module); after the transpose
// that is three-x, so this is the direction a side attacks ON SCREEN. It is
// +1 for whoever the frame is flipped for — both players attack right.
const attackDir = (side: number, flip: number) => (side === 0 ? 1 : -1) * flip;

// ---------------------------------------------------------------------------
// JUICE: camera shake + particle bursts
// ---------------------------------------------------------------------------
let shakeAmp = 0;
// replay cam: smoothed look-at that trails the ball through the flight
let replayLook: THREE.Vector3 | null = null;

// Shake is seasoning, not the meal. The values the call sites pass are the
// EVENT's weight (a goal is worth more than a slide); this scales the whole
// system down to something a broadcast camera would plausibly do, and caps it
// well below the old ceiling so nothing can stack into a screen-shaker.
const SHAKE_SCALE = 0.22;
const SHAKE_MAX = 0.5;
export function addShake(strength: number) {
  shakeAmp = Math.min(SHAKE_MAX, shakeAmp + strength * SHAKE_SCALE);
}

// Screen-space anchor for DOM overlays (emote pops, speech bubbles): the
// point just above one rig's head, in CSS pixels relative to the canvas.
// depth is that point's projected z — it grows with distance from the camera,
// so callers can stack a near player's plate over a far one's.
const headProj = new THREE.Vector3();
export function headScreenPos(
  rigSlot: number
): { x: number; y: number; depth: number } | null {
  if (!renderer || !camera) return null;
  const rig = playerRigs[rigSlot];
  if (!rig || !rig.root.visible) return null;
  rig.head.getWorldPosition(headProj);
  headProj.y += 0.85; // clear the crown (and hair)
  headProj.project(camera);
  if (headProj.z > 1) return null; // behind the camera
  return {
    x: (headProj.x * 0.5 + 0.5) * cssW,
    y: (-headProj.y * 0.5 + 0.5) * cssH,
    depth: headProj.z,
  };
}

/** The live canvas's CSS size (render.ts may swap the element for MSAA
 *  changes, so callers can't cache their own reference to measure). */
export function canvasCssSize(): { w: number; h: number } {
  return { w: cssW, h: cssH };
}

/** True while transient FX (particles, camera shake) are still settling —
 *  lets an otherwise static scene stop re-rendering only once they're done. */
export function sceneIsAnimating(): boolean {
  if (shakeAmp > 0 || shockStart >= 0) return true;
  for (const p of particles) if (p.life > 0) return true;
  return false;
}

interface Particle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
}
const particles: Particle[] = [];

function initParticles() {
  if (!gfx.particles || particles.length) return;
  const geo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
  for (let i = 0; i < 220; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    scene3.add(mesh);
    particles.push({ mesh, mat, vel: new THREE.Vector3(), life: 0, maxLife: 1, gravity: -60 });
  }
}

function spawnBurst(
  pos: THREE.Vector3,
  color: number,
  count: number,
  speed: number,
  upBias = 0.5,
  gravity = -60
) {
  if (!gfx.particles) return;
  let spawned = 0;
  for (const p of particles) {
    if (spawned >= count) break;
    if (p.life > 0) continue;
    spawned++;
    p.mesh.visible = true;
    p.mesh.position.copy(pos);
    p.mat.color.setHex(color);
    p.mat.opacity = 1;
    p.maxLife = p.life = 0.25 + Math.random() * 0.35;
    p.gravity = gravity;
    const theta = Math.random() * Math.PI * 2;
    const up = Math.random() * upBias + (1 - upBias) * 0.3;
    p.vel.set(Math.cos(theta), up * 1.6, Math.sin(theta)).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
    const s = 0.5 + Math.random();
    p.mesh.scale.set(s, s, s);
  }
}

// The full impact package: sparks, golden burst on perfect, shake on hard
// hits, thwack, and toast event.
function impactFX(at: THREE.Vector3, power: number) {
  spawnBurst(at, 0xfff8a0, 16 + Math.floor(power * 26), 15 + power * 24, 0.7, -40);
  spawnBurst(at, 0xffffff, 10, 9 + power * 12, 0.9, -20);
  if (power > 0.8) {
    spawnBurst(at, 0xffd400, 26, 26, 0.8, -30);
    spawnBurst(at, 0xff8c1a, 14, 18, 0.5, -50);
  }
  if (power > 0.65) addShake((power - 0.65) * 2.6);
  playKick(panOf(at.x), power);
  window.dispatchEvent(new CustomEvent('df-kick', { detail: { power } }));
}

// Film grade: slightly washed, warm, a hair soft. Paired with ACES tone
// mapping under the FILM GRADE switch; the VHS overlay is its own option.
const BASE_FILTER = 'saturate(0.88) contrast(1.07) brightness(1.03)';

function updateParticles(dt: number) {
  if (!gfx.particles) return;
  for (const p of particles) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) {
      p.mesh.visible = false;
      continue;
    }
    p.vel.y += p.gravity * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    if (p.mesh.position.y < 0.1) {
      p.mesh.position.y = 0.1;
      p.vel.y = Math.abs(p.vel.y) * 0.4;
      p.vel.x *= 0.7;
      p.vel.z *= 0.7;
    }
    const k = p.life / p.maxLife;
    p.mat.opacity = k;
    p.mesh.rotation.x += dt * 9;
    p.mesh.rotation.y += dt * 7;
  }
}

// ---------------------------------------------------------------------------
// Player rig: articulated joints we pose procedurally every frame.
// ---------------------------------------------------------------------------
type KickKind = 'drive' | 'chip';

interface Pose {
  twist: number; // upper body Y twist
  leanF: number; // forward lean
  leanS: number; // sideways lean
  thighL: number; calfL: number; thighR: number; calfR: number;
  shLx: number; shLz: number; elL: number;
  shRx: number; shRz: number; elR: number;
  yawOff: number; // extra facing rotation (turn toward ball)
  crouch: number; // root lowering for low balls / ready stance
}

const POSE_KEYS = [
  'twist', 'leanF', 'leanS', 'thighL', 'calfL', 'thighR', 'calfR',
  'shLx', 'shLz', 'elL', 'shRx', 'shRz', 'elR', 'yawOff', 'crouch',
] as const;

// Rotation convention: arms hang along -Y; NEGATIVE X rotation swings the
// arm forward (+Z in model space), positive swings it behind the body.
const ZERO_POSE: Pose = {
  twist: 0, leanF: 0, leanS: 0,
  thighL: 0, calfL: 0, thighR: 0, calfR: 0,
  shLx: -0.2, shLz: 0.1, elL: -0.45,
  shRx: -0.2, shRz: -0.1, elR: -0.45,
  yawOff: 0, crouch: 0,
};

interface PlayerRig {
  root: THREE.Group;
  upper: THREE.Group;
  thighL: THREE.Group; calfL: THREE.Group;
  thighR: THREE.Group; calfR: THREE.Group;
  // The skeleton is permanent; the visible body meshes inside each joint are
  // rebuilt per character by buildBody (banana body, corgi body, ...).
  torsoGroup: THREE.Group; // physique: scaled wider with the power stat
  hipGroup: THREE.Group; // shorts/skirt/tail; physique: lifted with leg length
  shoulderL: THREE.Group; elbowL: THREE.Group;
  shoulderR: THREE.Group; elbowR: THREE.Group;
  torsoMat: THREE.MeshLambertMaterial;
  sleeveMatL: THREE.MeshLambertMaterial;
  sleeveMatR: THREE.MeshLambertMaterial;
  skinMat: THREE.MeshLambertMaterial;
  headMat: THREE.MeshLambertMaterial;
  hairMat: THREE.MeshLambertMaterial;
  accentMat: THREE.MeshLambertMaterial;
  hairGroup: THREE.Group;
  gloveL: THREE.Mesh; gloveR: THREE.Mesh; // keeper gloves — hidden otherwise
  charId: number; // character currently dressed on this rig
  keeperKit: boolean; // which kit that character is wearing
  kitSide: number; // team kit on it: 0 home, 1 away, -1 the character's own
  head: THREE.Mesh;
  pose: Pose;
  yaw: number; // current facing (blended toward movement / ball)
  runSeed: number;
  runPhase: number; // stride cycle, advanced by ground distance (not time)
  prevPX: number; // last frame's render position — measures that distance
  prevPZ: number;
  // locomotion: measured ground speed and the gait it selects. Both are
  // smoothed, because the raw per-frame step distance is noisy at 30 Hz and
  // an unsmoothed gait factor makes the legs flutter between jog and sprint.
  speed: number; // render units per second, smoothed
  gait: number; // 0 = jog, 1 = flat sprint — what runPose blends between
  turnBank: number; // smoothed yaw RATE, leaned into like a cyclist
  prevYaw: number;
  pivotUntil: number; // plant-and-turn timer: a hard reverse is a step, not a spin
  pivotDir: number;
  diveStart: number; // -1 = on his feet; else when this keeper left the ground
  diveDir: number; // which side he went, for the lean and the arm that leads
  prevDive: number;
  // animation state
  kickStart: number; // -1 = not kicking
  kickAnim: KickKind;
  kickLow: boolean; // chip: toe under the ball
  kickStretch: boolean; // stretching to reach it — full-body lean
  kickPower: number; // 0..1 from the outgoing ball speed
  kickMs: number; // strike duration (hard kicks whip faster)
  windupStart: number; // when the button went down (the backlift deepens)
  contactPoint: THREE.Vector3 | null; // frozen ball position at the strike
  prevKickTicks: number;
  // slide-tackle state
  slideStart: number; // -1 = not sliding
  slideDir: number; // which hip the player goes down on
  slideKindAnim: number; // 0 short, 1 full, 2 last-ditch
  slideMs: number;
  slideYaw: number; // world heading of the lunge
  slideFromX: number; // where the slide started (render space)
  slideFromZ: number;
  slideLanded: boolean;
  prevSlide: number;
}

// Flight time of a keeper's dive — mirrors DIVE_TICKS in the module.
const KEEPER_DIVE_MS = 550;
const SLIDE_MS = 1000; // matches the server's SLIDE_TOTAL window

// Piecewise channel evaluator with smoothstep easing between keys.
function ch(t: number, keys: [number, number][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      const k = (t - t0) / (t1 - t0);
      const s = k * k * (3 - 2 * k);
      return v0 + (v1 - v0) * s;
    }
  }
  return keys[keys.length - 1][1];
}

// Authored slide-tackle keyframes. The body goes down on its hip with the
// lead leg extended at the ball, trailing leg tucked under.
function slideFlightPose(): Pose {
  return {
    ...ZERO_POSE,
    leanF: -0.35, // torso laid back over the trailing hip
    thighL: -1.5, calfL: 0.15, // lead leg speared out at the ball
    thighR: -0.5, calfR: 1.5, // trailing leg tucked beneath
    shRx: 0.9, shRz: -0.5, elR: -0.4, // trailing arm braced on the turf
    shLx: -1.3, shLz: 0.5, elL: -0.5, // lead arm up for balance
    crouch: 0,
  };
}

// Scrambling back to your feet: the limbs gather under the body, amplitude
// decaying as the player recovers.
function slideRollPose(now: number, seed: number, decay: number): Pose {
  const f = (hz: number, ph: number) => Math.sin(now / hz + seed + ph) * decay;
  return {
    ...ZERO_POSE,
    thighL: -1.1 + f(47, 0) * 0.45, calfL: 1.3 + f(61, 2) * 0.4,
    thighR: -1.0 + f(53, 4) * 0.45, calfR: 1.4 + f(43, 1) * 0.4,
    shLx: -0.9 + f(39, 3) * 0.6, shLz: 0.35 + f(71, 5) * 0.25, elL: -1.3 + f(57, 1) * 0.4,
    shRx: 0.4 + f(49, 2) * 0.6, shRz: -0.35 + f(67, 0) * 0.25, elR: -1.0 + f(45, 4) * 0.4,
    twist: f(83, 2) * 0.25,
    crouch: 0.35 * (1 - decay),
  };
}

// Linear blend between two poses, channel by channel — the one primitive a
// blend tree needs. w = 0 is a, w = 1 is b.
function blendPose(a: Pose, b: Pose, w: number): Pose {
  const out = { ...a };
  for (const k of POSE_KEYS) out[k] = a[k] + (b[k] - a[k]) * w;
  return out;
}

const _dq1 = new THREE.Quaternion();
const _dq2 = new THREE.Quaternion();
const _dq3 = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
const _RIGHT = new THREE.Vector3(1, 0, 0);

function blendAngle(current: number, target: number, rate: number, dt: number): number {
  return current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));
}

function capsule(r: number, len: number, mat: THREE.Material, pivotTop = true): THREE.Mesh {
  const geo = new THREE.CapsuleGeometry(r, len, 4, 10);
  geo.translate(0, pivotTop ? -(len / 2 + r) : 0, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Character look: canvas-painted textures + per-character body dressing.
// Textures are drawn in near-white/grayscale where the material color tints
// them (shirt, ball) and in true color where they carry it (face).
// ---------------------------------------------------------------------------
const cssHex = (n: number) => '#' + n.toString(16).padStart(6, '0');

const faceTexCache = new Map<number, THREE.CanvasTexture>();

// Face painted onto the head sphere: eyes, brows, mouth, cheek shading.
// The sphere's forward (+Z, the rig's facing) is at u=0.25.
function makeFaceTexture(char: Character): THREE.CanvasTexture {
  const cached = faceTexCache.get(char.id);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = cssHex(char.skin);
  g.fillRect(0, 0, c.width, c.height);
  // top light and jaw shadow so the head reads as a form, not a flat ball
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, 'rgba(255,255,255,0.13)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.18)');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // skin grain
  for (let n = 0; n < 900; n++) {
    const s = Math.sin(n * 91.7) * 43758.5453;
    const r = s - Math.floor(s);
    const s2 = Math.sin(n * 271.3) * 12543.21;
    const r2 = s2 - Math.floor(s2);
    g.fillStyle = r > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(80,40,20,0.03)';
    g.fillRect(r * c.width, r2 * c.height, 2, 2);
  }
  const cx = c.width * 0.25;
  const eyeY = 122;
  const face = char.face ?? 'human';

  if (face === 'robot') {
    // one dark visor band with two glowing LED eyes and a speaker mouth
    g.fillStyle = 'rgba(12,14,20,0.92)';
    g.beginPath();
    g.roundRect(cx - 62, eyeY - 19, 124, 38, 12);
    g.fill();
    for (const s of [-1, 1]) {
      g.fillStyle = char.eyes;
      g.shadowColor = char.eyes;
      g.shadowBlur = 10;
      g.beginPath();
      g.roundRect(cx + s * 30 - 9, eyeY - 8, 18, 16, 4);
      g.fill();
      g.shadowBlur = 0;
    }
    g.fillStyle = 'rgba(12,14,20,0.85)';
    for (const dx of [-12, -4, 4, 12]) g.fillRect(cx + dx - 2, 172, 4, 16);
    // panel seams + rivets
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 2;
    g.strokeRect(cx - 78, 60, 156, 150);
    g.fillStyle = 'rgba(0,0,0,0.4)';
    for (const [rx, ry] of [[-70, 68], [70, 68], [-70, 200], [70, 200]] as const) {
      g.beginPath();
      g.arc(cx + rx, ry, 3, 0, Math.PI * 2);
      g.fill();
    }
  } else if (face === 'toon') {
    // huge glossy cartoon eyes (alien / octopus / yeti), no whites, no brows
    for (const s of [-1, 1]) {
      const ex = cx + s * 32;
      g.fillStyle = '#101010';
      g.beginPath();
      g.ellipse(ex, eyeY, 16, 22, s * 0.15, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = char.eyes === '#0c0c0c' || char.eyes === '#101010' ? '#101010' : char.eyes;
      g.beginPath();
      g.ellipse(ex, eyeY + 3, 10, 14, s * 0.15, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.beginPath();
      g.arc(ex - s * 4, eyeY - 7, 4.2, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(ex + s * 3, eyeY + 8, 1.8, 0, Math.PI * 2);
      g.fill();
    }
    // tiny content mouth
    g.strokeStyle = 'rgba(30,20,20,0.8)';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - 8, 182);
    g.quadraticCurveTo(cx, 188, cx + 8, 182);
    g.stroke();
  } else if (face === 'snout') {
    // dog face: light muzzle patch, round eyes, big nose, happy open mouth
    g.fillStyle = 'rgba(255,250,238,0.9)';
    g.beginPath();
    g.ellipse(cx, 172, 46, 40, 0, 0, Math.PI * 2);
    g.fill();
    // blaze up the forehead
    g.beginPath();
    g.ellipse(cx, 100, 14, 42, 0, 0, Math.PI * 2);
    g.fill();
    for (const s of [-1, 1]) {
      const ex = cx + s * 33;
      g.fillStyle = '#181008';
      g.beginPath();
      g.arc(ex, eyeY - 6, 7.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(ex - s * 2, eyeY - 9, 2.4, 0, Math.PI * 2);
      g.fill();
    }
    // nose
    g.fillStyle = '#181210';
    g.beginPath();
    g.ellipse(cx, 156, 12, 9, 0, 0, Math.PI * 2);
    g.fill();
    // mouth: the classic dog "w" + tongue
    g.strokeStyle = 'rgba(40,24,14,0.85)';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx, 158);
    g.lineTo(cx, 172);
    g.quadraticCurveTo(cx - 12, 184, cx - 22, 174);
    g.moveTo(cx, 172);
    g.quadraticCurveTo(cx + 12, 184, cx + 22, 174);
    g.stroke();
    g.fillStyle = '#e0656e';
    g.beginPath();
    g.ellipse(cx, 190, 9, 12, 0, 0, Math.PI);
    g.fill();
  } else {
    // human base (also under fangs / patch / specs accessories)
    for (const s of [-1, 1]) {
      const ex = cx + s * 30;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(ex, eyeY, 13, 8.5, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = char.eyes;
      g.beginPath();
      g.arc(ex + s * 1.5, eyeY, 5.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#101010';
      g.beginPath();
      g.arc(ex + s * 1.5, eyeY, 2.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(ex + s * 1.5 - 1.6, eyeY - 1.8, 1.3, 0, Math.PI * 2);
      g.fill();
      // upper lid crease
      g.strokeStyle = 'rgba(60,30,15,0.5)';
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(ex, eyeY, 13, 8.5, 0, Math.PI, Math.PI * 2);
      g.stroke();
      // brow in the hair color
      g.strokeStyle = cssHex(char.hair);
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(ex - s * 13, eyeY - 15);
      g.quadraticCurveTo(ex, eyeY - 22, ex + s * 13, eyeY - 16);
      g.stroke();
    }
    // cheek warmth
    g.fillStyle = 'rgba(220,90,70,0.10)';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * 42, 158, 14, 9, 0, 0, Math.PI * 2);
      g.fill();
    }
    if (face === 'fangs') {
      // open grin with two fangs — pale lips, red gleam in the smile
      g.fillStyle = 'rgba(60,10,20,0.9)';
      g.beginPath();
      g.moveTo(cx - 20, 178);
      g.quadraticCurveTo(cx, 196, cx + 20, 178);
      g.quadraticCurveTo(cx, 186, cx - 20, 178);
      g.fill();
      g.fillStyle = '#f4f6f8';
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx + s * 13 - 3, 180);
        g.lineTo(cx + s * 13 + 3, 180);
        g.lineTo(cx + s * 13, 192);
        g.closePath();
        g.fill();
      }
    } else {
      // mouth
      g.strokeStyle = 'rgba(120,50,40,0.85)';
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx - 16, 180);
      g.quadraticCurveTo(cx, 190, cx + 16, 180);
      g.stroke();
    }
    if (face === 'patch') {
      // eyepatch over the left eye, strap wrapping the head band
      g.strokeStyle = 'rgba(14,12,10,0.92)';
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(0, 118);
      g.lineTo(cx - 44, 108);
      g.moveTo(cx - 18, 104);
      g.lineTo(c.width * 0.75, 92);
      g.stroke();
      g.fillStyle = 'rgba(14,12,10,0.95)';
      g.beginPath();
      g.ellipse(cx - 30, eyeY, 17, 14, -0.12, 0, Math.PI * 2);
      g.fill();
    }
    if (face === 'specs') {
      // round granny glasses + chain hint
      g.strokeStyle = 'rgba(40,44,52,0.9)';
      g.lineWidth = 3.5;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.arc(cx + s * 30, eyeY, 17, 0, Math.PI * 2);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(cx - 13, eyeY - 3);
      g.quadraticCurveTo(cx, eyeY - 8, cx + 13, eyeY - 3);
      g.stroke();
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx - 47, eyeY + 4);
      g.quadraticCurveTo(cx - 62, eyeY + 26, cx - 70, eyeY + 20);
      g.moveTo(cx + 47, eyeY + 4);
      g.quadraticCurveTo(cx + 62, eyeY + 26, cx + 70, eyeY + 20);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  faceTexCache.set(char.id, tex);
  return tex;
}

const shirtTexCache = new Map<number, THREE.CanvasTexture>();

// Kit shirt for the torso lathe, drawn near-white so the material color
// tints it with the character color. u=0 is the front seam, u=0.5 the back
// (where the squad number goes); v=1 is the collar end.
function makeShirtTexture(id: number): THREE.CanvasTexture {
  const cached = shirtTexCache.get(id);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e2e2e2';
  g.fillRect(0, 0, c.width, c.height);
  // lit from above: bright shoulders fading toward the hem
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, 'rgba(255,255,255,0.20)');
  grad.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // underarm / side shading at u=0.25 and u=0.75
  for (const ux of [0.25, 0.75]) {
    const gx = g.createLinearGradient((ux - 0.12) * c.width, 0, (ux + 0.12) * c.width, 0);
    gx.addColorStop(0, 'rgba(0,0,0,0)');
    gx.addColorStop(0.5, 'rgba(0,0,0,0.17)');
    gx.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gx;
    g.fillRect((ux - 0.12) * c.width, 0, 0.24 * c.width, c.height);
  }
  // fabric weave
  for (let n = 0; n < 1400; n++) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    const r = s - Math.floor(s);
    const s2 = Math.sin(n * 311.7) * 12543.21;
    const r2 = s2 - Math.floor(s2);
    g.fillStyle = r > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
    g.fillRect(r * c.width, r2 * c.height, 2, 1);
  }
  // wrinkle hints above the hem
  g.strokeStyle = 'rgba(0,0,0,0.07)';
  g.lineWidth = 3;
  for (const [wx, wy, ww] of [[60, 214, 90], [230, 226, 120], [400, 210, 80]] as const) {
    g.beginPath();
    g.moveTo(wx, wy);
    g.quadraticCurveTo(wx + ww / 2, wy + 8, wx + ww, wy - 2);
    g.stroke();
  }
  // collar band + front placket at the u=0 seam
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, 16);
  g.fillRect(0, 0, 7, 110);
  g.fillRect(c.width - 7, 0, 7, 110);
  // squad number on the back — dark, since the tint caps how bright white
  // can get and a light number would wash out against the kit color
  g.font = '900 92px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(15,15,25,0.62)';
  g.fillText(String(id + 1), c.width * 0.5, 96);
  // hem shadow
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, c.height - 6, c.width, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  shirtTexCache.set(id, tex);
  return tex;
}

// Classic black-and-white football: white leather with a ring of pentagon
// patches. Drawn on an equirectangular map, so the poles stay clean and the
// patches band around the equator the way a real Telstar does.
function makeBallTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f6f6f2';
  g.fillRect(0, 0, c.width, c.height);
  // faint leather grain
  for (let n = 0; n < 900; n++) {
    const s1 = Math.sin(n * 127.1) * 43758.5453;
    const r = s1 - Math.floor(s1);
    const s2 = Math.sin(n * 311.7) * 12543.21;
    const r2 = s2 - Math.floor(s2);
    g.fillStyle = r > 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(120,120,110,0.05)';
    g.fillRect(r * c.width, r2 * c.height, 2, 2);
  }
  // pentagon patch, drawn as a rounded 5-gon at (cx, cy)
  const patch = (cx: number, cy: number, r: number, rot: number) => {
    g.fillStyle = '#1b1b20';
    g.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = rot + (i / 5) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.92;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
  };
  // one patch at each pole band, five around the equator, staggered
  for (let i = 0; i < 5; i++) {
    patch((i + 0.5) * (c.width / 5), 30, 15, Math.PI / 2);
    patch(i * (c.width / 5), 98, 15, -Math.PI / 2);
  }
  patch(c.width * 0.5, 64, 13, 0);
  patch(0, 64, 13, 0);
  patch(c.width, 64, 13, 0);
  // seams between the patches
  g.strokeStyle = 'rgba(60,60,66,0.5)';
  g.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    const x = i * (c.width / 5);
    g.beginPath();
    g.moveTo(x, 12);
    g.lineTo(x + c.width / 10, 64);
    g.lineTo(x, 116);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Human torso silhouette: waist → chest → shoulders, lathed and squashed
// front-to-back into an elliptical cross-section.
function makeTorsoGeometry(): THREE.BufferGeometry {
  const profile: [number, number][] = [
    [0.20, -0.10],
    [0.60, 0.02],
    [0.64, 0.38],
    [0.76, 0.88],
    [0.80, 1.28],
    [0.64, 1.56],
    [0.28, 1.72],
  ];
  const geo = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    20
  );
  geo.scale(1.08, 1, 0.66);
  return geo;
}

// Rebuild the hair meshes for a character's style (parented to the head so
// ball-watching reads through the hair too).
function buildHair(grp: THREE.Group, mat: THREE.MeshLambertMaterial, style: HairStyle) {
  for (const child of [...grp.children]) {
    grp.remove(child);
    (child as THREE.Mesh).geometry?.dispose();
  }
  const add = (geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    grp.add(m);
    return m;
  };
  // caps are tilted back so the hairline sits above the brows in front and
  // drops to the nape behind
  const cap = (r: number, cover: number, y: number, tilt = -0.35) =>
    add(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI * cover), 0, y, 0, tilt);
  switch (style) {
    case 'buzz':
      cap(0.615, 0.46, 0.05, -0.3);
      break;
    case 'spiky': {
      cap(0.63, 0.5, 0.04);
      const spike = () => new THREE.ConeGeometry(0.16, 0.45, 6);
      add(spike(), 0, 0.68, 0.05, -0.15, 0);
      add(spike(), 0.27, 0.58, 0.12, -0.25, -0.55);
      add(spike(), -0.27, 0.58, 0.12, -0.25, 0.55);
      add(spike(), 0.17, 0.6, -0.24, 0.6, -0.3);
      add(spike(), -0.17, 0.6, -0.24, 0.6, 0.3);
      break;
    }
    case 'ponytail': {
      cap(0.64, 0.55, 0.04, -0.4);
      add(new THREE.SphereGeometry(0.16, 10, 8), 0, 0.34, -0.52); // bun
      const tail = capsule(0.115, 0.5, mat); // pivot-top: hangs from the bun
      tail.position.set(0, 0.3, -0.56);
      tail.rotation.x = 0.55;
      grp.add(tail);
      break;
    }
    case 'bob':
      cap(0.65, 0.5, 0.03);
      // back + side shell leaving the face open (face is at phi=π/2)
      add(
        new THREE.SphereGeometry(0.65, 18, 12, Math.PI * 0.85, Math.PI * 1.3, 0, Math.PI * 0.68),
        0, 0.02, 0
      );
      break;
    // ---- wacky roster ---------------------------------------------------
    case 'peel': {
      // banana: a stem on top and four peel flaps curling out and down
      cap(0.63, 0.4, 0.05, -0.2);
      add(new THREE.CylinderGeometry(0.06, 0.09, 0.3, 8), 0, 0.72, 0);
      for (const a of [0.5, 2.1, -2.1, -0.5]) {
        add(
          new THREE.ConeGeometry(0.17, 0.52, 8),
          Math.sin(a) * 0.42, 0.5, Math.cos(a) * 0.42,
          Math.cos(a) * 1.25, -Math.sin(a) * 1.25
        );
      }
      break;
    }
    case 'corgi': {
      // fur cap + two big upright triangular ears
      cap(0.63, 0.42, 0.05, -0.25);
      add(new THREE.ConeGeometry(0.2, 0.46, 4), 0.34, 0.6, -0.02, -0.1, -0.35);
      add(new THREE.ConeGeometry(0.2, 0.46, 4), -0.34, 0.6, -0.02, -0.1, 0.35);
      break;
    }
    case 'antenna': {
      // robot: dome plate, boingy antenna, side bolts over the ears
      cap(0.62, 0.32, 0.1, -0.2);
      add(new THREE.CylinderGeometry(0.035, 0.035, 0.4, 6), 0, 0.78, 0);
      add(new THREE.SphereGeometry(0.08, 8, 8), 0, 1.0, 0);
      for (const s of [-1, 1]) {
        const bolt = add(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 8), s * 0.63, 0.02, 0);
        bolt.rotation.z = Math.PI / 2;
      }
      break;
    }
    case 'antennae': {
      // alien: two stalks with glowing-ish bobble tips
      for (const s of [-1, 1]) {
        add(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), s * 0.2, 0.72, 0, 0, -s * 0.45);
        add(new THREE.SphereGeometry(0.09, 8, 8), s * 0.36, 0.92, 0);
      }
      break;
    }
    case 'slick': {
      // slicked-back vampire do with a widow's peak on the forehead
      cap(0.62, 0.48, 0.05, -0.28);
      add(new THREE.ConeGeometry(0.13, 0.32, 3), 0, 0.36, 0.5, 2.7, 0);
      break;
    }
    case 'tricorn': {
      // pirate hat: wide brim + rounded crown, tipped back
      cap(0.62, 0.35, 0.06, -0.2);
      add(new THREE.CylinderGeometry(0.72, 0.72, 0.07, 18), 0, 0.34, 0, -0.12, 0);
      add(new THREE.SphereGeometry(0.52, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 0.34, 0, -0.12, 0);
      break;
    }
    case 'shag': {
      // yeti: oversized shaggy dome with tufts sticking out everywhere
      cap(0.68, 0.62, 0.0, -0.15);
      for (const [x, y, z] of [
        [0.4, 0.35, 0.3], [-0.4, 0.35, 0.3], [0.45, 0.3, -0.3],
        [-0.45, 0.3, -0.3], [0, 0.4, -0.45], [0, 0.66, 0.15],
      ] as const) {
        add(new THREE.SphereGeometry(0.16, 8, 6), x, y, z);
      }
      break;
    }
    case 'bun': {
      cap(0.63, 0.5, 0.04, -0.3);
      add(new THREE.SphereGeometry(0.19, 10, 8), 0, 0.62, -0.18);
      break;
    }
    case 'afro': {
      const fro = add(new THREE.SphereGeometry(0.62, 18, 14), 0, 0.34, -0.06);
      fro.scale.set(1.15, 1.0, 1.05);
      break;
    }
    case 'tentacles': {
      // octopus: mantle cap + tentacles hanging around the sides and back
      cap(0.64, 0.5, 0.03, -0.2);
      for (const a of [1.2, -1.2, 2.0, -2.0, 2.9, -2.9]) {
        const tent = capsule(0.09, 0.42, mat); // pivot-top: hangs like the ponytail
        tent.position.set(Math.sin(a) * 0.5, 0.28, Math.cos(a) * 0.5);
        tent.rotation.set(Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55);
        grp.add(tent);
      }
      break;
    }
    case 'flower': {
      // cactus: no hair, just the classic little flower on top
      add(new THREE.SphereGeometry(0.09, 8, 8), 0, 0.7, 0);
      for (const k of [0.4, 1.65, 2.9, 4.15, 5.4]) {
        add(new THREE.SphereGeometry(0.075, 8, 6), Math.sin(k) * 0.15, 0.72, Math.cos(k) * 0.15);
      }
      break;
    }
    case 'wizard': {
      // pointy hat with a brim, plus a long beard hanging under the chin
      add(new THREE.CylinderGeometry(0.78, 0.78, 0.06, 18), 0, 0.3, 0, -0.15, 0);
      add(new THREE.ConeGeometry(0.5, 0.95, 14), 0, 0.76, -0.05, -0.15, 0.06);
      add(new THREE.ConeGeometry(0.26, 0.62, 8), 0, -0.5, 0.3, Math.PI, 0);
      break;
    }
    default:
      cap(0.63, 0.52, 0.06);
  }
}

// Dress a rig as a character in a side's kit: skin tone, face, hair and body
// are the CHARACTER's, the shirt is the TEAM's. Kit and role are both part of
// the identity check — a rig is handed to the other side's seat, or to a
// keeper, mid-match, and has to be re-dressed even when the character on it
// hasn't changed. Side -1 = no team (the select-screen previews).
function applyCharacter(rig: PlayerRig, char: Character, keeper = false, side = -1) {
  if (rig.charId === char.id && rig.keeperKit === keeper && rig.kitSide === side) return;
  rig.charId = char.id;
  rig.kitSide = side;
  // Off the pitch there is no team to belong to, so the character wears its
  // own color — the one the select cards' own styling is keyed to.
  const kit: Kit | null = keeper ? KEEPER_KIT : KITS[side] ?? null;
  const shirt = kit ? kit.shirt : char.color;
  rig.torsoMat.color.setHex(shirt);
  rig.torsoMat.map = makeShirtTexture(char.id);
  rig.torsoMat.needsUpdate = true;
  rig.sleeveMatL.color.setHex(shirt);
  rig.sleeveMatR.color.setHex(shirt);
  rig.accentMat.color.setHex(kit ? kit.trim : char.color);
  rig.skinMat.color.setHex(char.skin);
  rig.headMat.map = makeFaceTexture(char);
  rig.headMat.needsUpdate = true;
  rig.hairMat.color.setHex(char.hair);
  buildBody(rig, char);
  buildHair(rig.hairGroup, rig.hairMat, char.hairStyle);
  applyPhysique(rig, char);
  applyKit(rig, kit, keeper); // after buildBody — it re-points its materials
}

// Body proportions mirror the stat sheet, so you can read an athlete at a
// glance: speed = longer legs, reach = longer arms (racket grows with
// them), power = broader torso and wider shoulders. Limbs get UNIFORM
// scales — their child joints rotate, and a non-uniform parent scale would
// shear a bent elbow/knee.
const HIP_Y = 2.25; // matches the thigh pivot height in makePlayerRig
function applyPhysique(rig: PlayerRig, char: Character) {
  const s = char.stats;
  // per-character overrides on top of the stat-derived shape (corgi legs,
  // octopus arms, yeti bulk — see Character.physique)
  const o = char.physique;
  const legK = (1 + (s.speed - 3) * 0.05) * (o?.legs ?? 1); // 0.90 (VOLT) … 1.10 (KAI)
  const armK = (1 + (s.tackle - 3) * 0.06) * (o?.arms ?? 1);
  const bulkK = (1 + (s.power - 3) * 0.05) * (o?.bulk ?? 1); // 0.90 (KAI) … 1.10 (BLAZE)

  // legs: scale the whole chain and raise the hips so the feet stay on
  // the floor — everything above rides up with them
  rig.thighL.scale.setScalar(legK);
  rig.thighR.scale.setScalar(legK);
  rig.thighL.position.y = HIP_Y * legK;
  rig.thighR.position.y = HIP_Y * legK;
  const lift = HIP_Y * (legK - 1);
  rig.hipGroup.position.y = lift;
  rig.upper.position.y = 2.62 + lift;

  // arms: longer AND proportionally beefier (uniform), racket included
  rig.shoulderL.scale.setScalar(armK);
  rig.shoulderR.scale.setScalar(armK);

  // torso: power broadens the chest and pushes the shoulders out
  rig.torsoGroup.scale.set(bulkK, 1, 1 + (bulkK - 1) * 0.6);
  rig.shoulderL.position.x = -0.98 * bulkK;
  rig.shoulderR.position.x = 0.98 * bulkK;
}

// ---------------------------------------------------------------------------
// Body builds: the skeleton (joint groups + racket) is permanent, and every
// visible mesh hangs off a joint inside a wrapper group marked as a body
// part. Swapping characters strips those wrappers and rebuilds them, so a
// banana, a corgi and a robot all animate through the exact same joints.
// ---------------------------------------------------------------------------

// Shared static materials — per-character colors live on the rig's own mats.
// SHORTS_MAT/SOCK_MAT are what every body build reaches for: they are the
// kit-piece PLACEHOLDERS, re-pointed to the wearer's real kit by applyKit.
const SHORTS_MAT = new THREE.MeshLambertMaterial({ color: COLORS.shorts });
const SOCK_MAT = new THREE.MeshLambertMaterial({ color: COLORS.shorts });
const SHOE_MAT = new THREE.MeshLambertMaterial({ color: COLORS.shoe });
const SOLE_MAT = new THREE.MeshLambertMaterial({ color: 0x50525a });
const WHITE_MAT = new THREE.MeshLambertMaterial({ color: 0xf0f2f4 });
const WOOD_MAT = new THREE.MeshLambertMaterial({ color: 0x7a4a26 });
const DARK_MAT = new THREE.MeshLambertMaterial({ color: 0x23252d });
const METAL_MAT = new THREE.MeshLambertMaterial({ color: 0xb8bcc4 });

// ---------------------------------------------------------------------------
// Team kits. The shirt belongs to the SIDE, never to the character: bot
// fillers all play the same character, so a shirt keyed off the roster puts
// both squads out in one color and nobody can follow their own match. The
// character still reads off everything else — face, hair, physique, body
// build and its squad number.
//
// The pair has to separate three ways at broadcast distance: from each other,
// from the turf (#4aa338 by day, #2f7a2c under lights) and from the keepers'
// lime. Red vs royal blue does all three, and survives red-green color
// blindness, where the two read as brown and blue rather than as one color.
// ---------------------------------------------------------------------------
interface Kit {
  shirt: number;
  trim: number; // collar band, belt, boot flash
  shorts: THREE.MeshLambertMaterial;
  socks: THREE.MeshLambertMaterial;
  marker: number; // control ring/chevron: the shirt, lifted to read on grass
}
const KIT_WHITE = 0xf1f4f8;
const KITS: Kit[] = [
  {
    // HOME — all red, the loudest thing that can stand on a green field
    shirt: 0xd8232f,
    trim: KIT_WHITE,
    shorts: new THREE.MeshLambertMaterial({ color: 0xc11e2a }),
    socks: new THREE.MeshLambertMaterial({ color: 0xd8232f }),
    marker: 0xff6152,
  },
  {
    // AWAY — royal blue over white shorts. Royal, not navy: under the night
    // pitch's floodlights a navy kit collapses into its own shadow.
    shirt: 0x2f62dc,
    trim: KIT_WHITE,
    shorts: new THREE.MeshLambertMaterial({ color: 0xeef1f6 }),
    socks: new THREE.MeshLambertMaterial({ color: 0x2f62dc }),
    marker: 0x6fb0ff,
  },
];
// Keeper kit — lime shirt, dark shorts, white gloves, so the one body per
// side that may handle the ball reads as the keeper from the halfway line.
// It overrides the team kit, which is why both sides' keepers look alike.
const KEEPER_KIT: Kit = {
  shirt: 0xc8f000,
  trim: 0x1b2030,
  shorts: new THREE.MeshLambertMaterial({ color: 0x1b2030 }),
  socks: new THREE.MeshLambertMaterial({ color: 0x1b2030 }),
  marker: 0xc8f000,
};
const GLOVE_MAT = new THREE.MeshLambertMaterial({ color: 0xf6f8fa });
const GLOVE_GEO = new THREE.BoxGeometry(0.38, 0.44, 0.36);

// Which materials count as a kit piece, whichever kit they came from. Bodies
// are always rebuilt against the placeholders, but matching the whole set
// keeps the swap correct even for a rig re-kitted without a rebuild.
const KIT_SHORTS = new Set<THREE.Material>([SHORTS_MAT, KEEPER_KIT.shorts, ...KITS.map(k => k.shorts)]);
const KIT_SOCKS = new Set<THREE.Material>([SOCK_MAT, KEEPER_KIT.socks, ...KITS.map(k => k.socks)]);

// Put a rig in a kit. The shirt colors are already on the rig's own
// materials by the time this runs; what's left is re-pointing the shared
// shorts/socks meshes and showing the keeper's gloves. Every one of these is
// a swap between materials and meshes that ALREADY EXIST — a rig changes
// side and role mid-match, and allocating here would leak one per change.
function applyKit(rig: PlayerRig, kit: Kit | null, keeper: boolean) {
  rig.keeperKit = keeper;
  const shorts = kit ? kit.shorts : SHORTS_MAT;
  const socks = kit ? kit.socks : SOCK_MAT;
  rig.root.traverse(o => {
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (!mat) return;
    if (KIT_SHORTS.has(mat)) (o as THREE.Mesh).material = shorts;
    else if (KIT_SOCKS.has(mat)) (o as THREE.Mesh).material = socks;
  });
  rig.gloveL.visible = keeper;
  rig.gloveR.visible = keeper;
}

function bodyPart(parent: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.userData.bodyPart = true;
  parent.add(g);
  return g;
}

function clearBodyParts(rig: PlayerRig) {
  const joints = [
    rig.torsoGroup, rig.hipGroup, rig.head,
    rig.thighL, rig.thighR, rig.calfL, rig.calfR,
    rig.shoulderL, rig.shoulderR, rig.elbowL, rig.elbowR,
  ];
  for (const joint of joints) {
    for (const child of [...joint.children]) {
      if (!child.userData.bodyPart) continue;
      child.traverse(o => (o as THREE.Mesh).geometry?.dispose());
      joint.remove(child);
    }
  }
}

function padd(
  g: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  g.add(m);
  return m;
}

interface LegOpts {
  r: number; len: number; calfR: number; calfLen: number; mat: THREE.Material;
  hem?: THREE.Material; // shorts hem over the thigh
  sock?: THREE.Material;
  foot?: 'shoe' | 'paw' | 'ball' | 'box' | 'none';
  footMat?: THREE.Material;
  flare?: THREE.Material; // bell-bottom cone over the calf
  curl?: boolean; // tentacle tip curling forward instead of a foot
}
function stdLeg(rig: PlayerRig, right: boolean, o: LegOpts) {
  const thigh = bodyPart(right ? rig.thighR : rig.thighL);
  const calf = bodyPart(right ? rig.calfR : rig.calfL);
  thigh.add(capsule(o.r, o.len, o.mat));
  if (o.hem) padd(thigh, new THREE.CylinderGeometry(o.r + 0.06, o.r + 0.1, 0.55, 12), o.hem, 0, -0.38, 0);
  calf.add(capsule(o.calfR, o.calfLen, o.mat));
  const footY = -(o.calfLen + o.calfR + 0.15);
  if (o.sock) padd(calf, new THREE.CylinderGeometry(o.calfR + 0.015, o.calfR + 0.025, 0.42, 10), o.sock, 0, footY + 0.18, 0);
  if (o.flare) padd(calf, new THREE.CylinderGeometry(o.calfR + 0.03, o.calfR + 0.3, 0.85, 12), o.flare, 0, -0.48, 0);
  if (o.curl) padd(calf, new THREE.CapsuleGeometry(o.calfR * 0.75, 0.3, 4, 8), o.mat, 0, footY + 0.1, 0.16, 1.15, 0, 0);
  const fm = o.footMat ?? SHOE_MAT;
  switch (o.foot ?? 'shoe') {
    case 'shoe': {
      const shoe = new THREE.Group();
      shoe.position.set(0, footY, 0.14);
      const up = padd(shoe, new THREE.SphereGeometry(0.32, 14, 10), fm);
      up.scale.set(0.82, 0.55, 1.55);
      padd(shoe, new THREE.BoxGeometry(0.55, 0.09, 0.44), rig.accentMat, 0, 0, 0.05);
      padd(shoe, new THREE.BoxGeometry(0.5, 0.09, 0.95), SOLE_MAT, 0, -0.1, 0);
      calf.add(shoe);
      break;
    }
    case 'paw': {
      const paw = padd(calf, new THREE.SphereGeometry(0.3, 12, 9), fm, 0, footY + 0.04, 0.12);
      paw.scale.set(0.9, 0.55, 1.35);
      break;
    }
    case 'ball': {
      const b = padd(calf, new THREE.SphereGeometry(0.32, 12, 9), fm, 0, footY + 0.04, 0.1);
      b.scale.set(1, 0.6, 1.5);
      break;
    }
    case 'box':
      padd(calf, new THREE.BoxGeometry(0.46, 0.24, 0.85), fm, 0, footY + 0.02, 0.14);
      break;
  }
}

interface ArmOpts {
  sleeve?: { r: number; len: number } | null; // null = bare (no kit sleeve)
  r: number; len: number; foreR: number; foreLen: number; mat: THREE.Material;
  wrist?: THREE.Material | null; // null = no wristband
  hand?: 'ball' | 'paw' | 'hook' | 'none';
  handR?: number; handMat?: THREE.Material;
  cuff?: THREE.Material; // wide flared sleeve cuff over the forearm (wizard)
}
function stdArm(rig: PlayerRig, right: boolean, o: ArmOpts) {
  const sh = bodyPart(right ? rig.shoulderR : rig.shoulderL);
  const el = bodyPart(right ? rig.elbowR : rig.elbowL);
  const sleeveMat = right ? rig.sleeveMatR : rig.sleeveMatL;
  if (o.sleeve !== null) {
    const s = o.sleeve ?? { r: 0.21, len: 0.28 };
    sh.add(capsule(s.r, s.len, sleeveMat));
  }
  const ua = capsule(o.r, o.len, o.mat);
  ua.position.y = -0.18;
  sh.add(ua);
  el.add(capsule(o.foreR, o.foreLen, o.mat));
  const handY = -(o.foreLen + o.foreR + 0.22);
  if (o.wrist !== null) {
    padd(el, new THREE.CylinderGeometry(o.foreR + 0.015, o.foreR + 0.015, 0.14, 10), o.wrist ?? SHOE_MAT, 0, handY + 0.14, 0);
  }
  if (o.cuff) padd(el, new THREE.CylinderGeometry(o.foreR + 0.02, o.foreR + 0.22, 0.55, 12), o.cuff, 0, -0.5, 0);
  const hm = o.handMat ?? o.mat;
  switch (o.hand ?? 'ball') {
    case 'ball':
      padd(el, new THREE.SphereGeometry(o.handR ?? 0.17, 10, 8), hm, 0, handY, 0);
      break;
    case 'paw': {
      const p = padd(el, new THREE.SphereGeometry(o.handR ?? 0.19, 10, 8), WHITE_MAT, 0, handY, 0);
      p.scale.set(0.9, 1.1, 0.9);
      break;
    }
    case 'hook':
      padd(el, new THREE.CylinderGeometry(0.17, 0.15, 0.22, 10), DARK_MAT, 0, handY + 0.05, 0);
      padd(el, new THREE.TorusGeometry(0.14, 0.04, 8, 14, Math.PI * 1.55), METAL_MAT, 0, handY - 0.2, 0, 0, Math.PI / 2, 0);
      break;
  }
}

// Classic lathe torso + skin neck (worn by all the human-ish bodies).
function stdTorso(rig: PlayerRig) {
  const t = bodyPart(rig.torsoGroup);
  padd(t, makeTorsoGeometry(), rig.torsoMat);
  padd(t, new THREE.CylinderGeometry(0.2, 0.24, 0.34, 12), rig.skinMat, 0, 1.8, 0);
  return t;
}

function stdShorts(rig: PlayerRig, mat: THREE.Material = SHORTS_MAT) {
  const hp = bodyPart(rig.hipGroup);
  const shorts = padd(hp, new THREE.CylinderGeometry(0.66, 0.71, 0.8, 16), mat, 0, 2.28, 0);
  shorts.scale.set(1.1, 1, 0.76);
  const belt = padd(hp, new THREE.CylinderGeometry(0.7, 0.7, 0.14, 16), rig.accentMat, 0, 2.6, 0);
  belt.scale.set(1.1, 1, 0.76);
  return hp;
}

function humanHead(rig: PlayerRig, band = true) {
  const hd = bodyPart(rig.head);
  const nose = padd(hd, new THREE.SphereGeometry(0.085, 8, 8), rig.skinMat, 0, -0.04, 0.58);
  nose.scale.set(0.75, 1.1, 1);
  for (const s of [-1, 1]) {
    const ear = padd(hd, new THREE.SphereGeometry(0.11, 8, 8), rig.skinMat, s * 0.58, -0.02, -0.02);
    ear.scale.set(0.45, 0.9, 0.7);
  }
  if (band) padd(hd, new THREE.CylinderGeometry(0.645, 0.645, 0.13, 20), rig.accentMat, 0, 0.24, 0);
}

// Build a character's body onto the shared skeleton. Every case must dress
// all four limbs, the torso, and the hips — the skeleton starts bare.
function buildBody(rig: PlayerRig, char: Character) {
  clearBodyParts(rig);
  rig.head.scale.set(0.94, 1.06, 0.97); // default skull; bodies may override
  const skin = rig.skinMat, kit = rig.torsoMat, acc = rig.accentMat, hair = rig.hairMat;
  const sides: boolean[] = [false, true];
  switch (char.body ?? 'athlete') {
    case 'banana': {
      // the body IS the banana: fat curved middle tapering toward the head,
      // with a kit-color sash so the team still reads
      const t = bodyPart(rig.torsoGroup);
      const mid = padd(t, new THREE.CapsuleGeometry(0.58, 1.0, 6, 14), skin, 0, 0.8, 0.04, 0.14, 0, 0);
      mid.scale.set(0.94, 1, 0.78);
      padd(t, new THREE.ConeGeometry(0.4, 0.7, 12), skin, 0, 1.75, -0.08, -0.22, 0, 0);
      const sash = padd(t, new THREE.CylinderGeometry(0.63, 0.69, 0.35, 14), kit, 0, 0.5, 0.05, 0.14, 0, 0);
      sash.scale.set(0.95, 1, 0.8);
      const hp = bodyPart(rig.hipGroup);
      const briefs = padd(hp, new THREE.CylinderGeometry(0.52, 0.56, 0.6, 14), kit, 0, 2.35, 0);
      briefs.scale.set(1, 1, 0.8);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.15, len: 0.78, calfR: 0.12, calfLen: 0.72, mat: skin, foot: 'ball', footMat: DARK_MAT });
        stdArm(rig, rt, { sleeve: null, r: 0.11, len: 0.55, foreR: 0.1, foreLen: 0.55, mat: skin, wrist: null, handR: 0.13 });
      }
      break;
    }
    case 'corgi': {
      const t = bodyPart(rig.torsoGroup);
      const fur = padd(t, new THREE.SphereGeometry(0.85, 16, 12), skin, 0, 0.8, 0);
      fur.scale.set(1.05, 1.1, 0.9);
      const chest = padd(t, new THREE.SphereGeometry(0.55, 14, 10), WHITE_MAT, 0, 0.6, 0.38);
      chest.scale.set(0.85, 1.0, 0.55);
      padd(t, new THREE.CylinderGeometry(0.24, 0.3, 0.4, 12), skin, 0, 1.75, 0);
      padd(t, new THREE.TorusGeometry(0.31, 0.07, 8, 16), acc, 0, 1.9, 0, Math.PI / 2, 0, 0); // collar
      const hp = bodyPart(rig.hipGroup);
      const rump = padd(hp, new THREE.SphereGeometry(0.6, 14, 10), skin, 0, 2.3, -0.05);
      rump.scale.set(1.05, 0.8, 0.9);
      const tail = padd(hp, new THREE.SphereGeometry(0.17, 10, 8), skin, 0, 2.5, -0.58);
      tail.scale.set(0.8, 0.8, 1.4);
      tail.rotation.x = -0.7;
      padd(hp, new THREE.SphereGeometry(0.1, 8, 6), WHITE_MAT, 0, 2.64, -0.76); // white tip
      const hd = bodyPart(rig.head);
      const muzzle = padd(hd, new THREE.SphereGeometry(0.3, 12, 9), WHITE_MAT, 0, -0.14, 0.42);
      muzzle.scale.set(0.85, 0.62, 0.95);
      padd(hd, new THREE.SphereGeometry(0.09, 8, 8), DARK_MAT, 0, -0.05, 0.66); // nose
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.22, len: 0.7, calfR: 0.18, calfLen: 0.62, mat: skin, foot: 'paw', footMat: WHITE_MAT });
        stdArm(rig, rt, { sleeve: null, r: 0.14, len: 0.5, foreR: 0.12, foreLen: 0.5, mat: skin, wrist: null, hand: 'paw' });
      }
      break;
    }
    case 'robot': {
      const t = bodyPart(rig.torsoGroup);
      padd(t, new THREE.BoxGeometry(1.2, 1.5, 0.72), skin, 0, 0.85, 0);
      padd(t, new THREE.BoxGeometry(0.72, 0.5, 0.1), kit, 0, 1.05, 0.38); // kit chest panel
      padd(t, new THREE.BoxGeometry(0.5, 0.26, 0.1), DARK_MAT, 0, 0.42, 0.38); // vent
      padd(t, new THREE.CylinderGeometry(0.16, 0.16, 0.4, 10), DARK_MAT, 0, 1.75, 0); // neck piston
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.BoxGeometry(1.0, 0.55, 0.62), DARK_MAT, 0, 2.32, 0);
      padd(hp, new THREE.BoxGeometry(1.04, 0.16, 0.66), acc, 0, 2.62, 0);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.16, len: 0.7, calfR: 0.13, calfLen: 0.64, mat: skin, foot: 'box', footMat: skin });
        stdArm(rig, rt, { sleeve: { r: 0.24, len: 0.16 }, r: 0.13, len: 0.55, foreR: 0.11, foreLen: 0.55, mat: skin, wrist: DARK_MAT, handR: 0.16, handMat: DARK_MAT });
      }
      break;
    }
    case 'alien': {
      rig.head.scale.set(1.22, 1.26, 1.16); // that famous cranium
      const t = bodyPart(rig.torsoGroup);
      padd(t, new THREE.CapsuleGeometry(0.34, 0.85, 6, 12), skin, 0, 0.85, 0);
      padd(t, new THREE.CylinderGeometry(0.42, 0.48, 0.7, 12), kit, 0, 0.8, 0); // tiny tank top
      padd(t, new THREE.CylinderGeometry(0.11, 0.14, 0.5, 10), skin, 0, 1.85, 0); // spindly neck
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.42, 0.46, 0.5, 12), kit, 0, 2.38, 0);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.11, len: 0.78, calfR: 0.09, calfLen: 0.7, mat: skin, foot: 'ball', footMat: skin });
        stdArm(rig, rt, { sleeve: null, r: 0.09, len: 0.58, foreR: 0.08, foreLen: 0.55, mat: skin, wrist: null, handR: 0.15 });
      }
      break;
    }
    case 'vampire': {
      const t = stdTorso(rig);
      // high collar + full-length cape (hair mat = jet black, double-sided)
      for (const s of [-1, 1]) {
        padd(t, new THREE.BoxGeometry(0.3, 0.44, 0.1), hair, s * 0.3, 1.72, -0.14, 0.18, 0, -s * 0.45);
      }
      padd(t, new THREE.CylinderGeometry(0.5, 1.45, 2.6, 14, 1, true, Math.PI / 2, Math.PI), hair, 0, 0.35, -0.12);
      stdShorts(rig, DARK_MAT);
      humanHead(rig, false);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.2, len: 0.75, calfR: 0.16, calfLen: 0.7, mat: hair, foot: 'shoe', footMat: DARK_MAT });
        stdArm(rig, rt, { sleeve: { r: 0.19, len: 0.45 }, r: 0.15, len: 0.5, foreR: 0.13, foreLen: 0.55, mat: hair, wrist: null, handR: 0.16, handMat: skin });
      }
      break;
    }
    case 'pirate': {
      const t = stdTorso(rig);
      padd(t, new THREE.CylinderGeometry(0.8, 1.05, 0.8, 14, 1, true), kit, 0, -0.25, 0); // coat skirt
      padd(t, new THREE.BoxGeometry(0.3, 0.22, 0.08), WHITE_MAT, 0, 0.08, 0.5); // buckle
      stdShorts(rig, DARK_MAT);
      humanHead(rig, false);
      // left leg in a boot; right leg ends in the peg
      stdLeg(rig, false, { r: 0.24, len: 0.75, calfR: 0.19, calfLen: 0.7, mat: skin, hem: DARK_MAT, sock: DARK_MAT, foot: 'shoe', footMat: DARK_MAT });
      const th = bodyPart(rig.thighR);
      th.add(capsule(0.24, 0.75, skin));
      padd(th, new THREE.CylinderGeometry(0.3, 0.34, 0.55, 12), DARK_MAT, 0, -0.38, 0);
      const cf = bodyPart(rig.calfR);
      padd(cf, new THREE.CylinderGeometry(0.1, 0.07, 0.95, 10), WOOD_MAT, 0, -0.5, 0);
      padd(cf, new THREE.CylinderGeometry(0.11, 0.11, 0.1, 10), WOOD_MAT, 0, -1.0, 0);
      stdArm(rig, false, { sleeve: { r: 0.2, len: 0.45 }, r: 0.16, len: 0.5, foreR: 0.14, foreLen: 0.5, mat: kit, wrist: null, hand: 'hook' });
      stdArm(rig, true, { sleeve: { r: 0.2, len: 0.45 }, r: 0.16, len: 0.5, foreR: 0.14, foreLen: 0.5, mat: kit, wrist: null, handR: 0.16, handMat: skin });
      break;
    }
    case 'yeti': {
      const t = bodyPart(rig.torsoGroup);
      const fur = padd(t, new THREE.SphereGeometry(0.95, 16, 12), skin, 0, 0.85, 0);
      fur.scale.set(1.1, 1.05, 0.85);
      const tank = padd(t, new THREE.CylinderGeometry(0.97, 1.02, 0.55, 16), kit, 0, 0.5, 0);
      tank.scale.set(1, 1, 0.85);
      padd(t, new THREE.CylinderGeometry(0.3, 0.36, 0.4, 12), skin, 0, 1.75, 0);
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.72, 0.78, 0.7, 14), skin, 0, 2.28, 0);
      padd(hp, new THREE.CylinderGeometry(0.76, 0.76, 0.14, 14), acc, 0, 2.6, 0);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.3, len: 0.62, calfR: 0.26, calfLen: 0.52, mat: skin, foot: 'ball', footMat: skin });
        stdArm(rig, rt, { sleeve: null, r: 0.24, len: 0.55, foreR: 0.2, foreLen: 0.55, mat: skin, wrist: acc, handR: 0.24 });
      }
      break;
    }
    case 'granny': {
      const t = stdTorso(rig);
      // string of pearls over the cardigan
      for (const a of [-0.9, -0.45, 0, 0.45, 0.9]) {
        padd(t, new THREE.SphereGeometry(0.055, 8, 6), WHITE_MAT, Math.sin(a) * 0.3, 1.62 - Math.cos(a) * 0.08, Math.cos(a) * 0.32);
      }
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.68, 1.05, 1.15, 16), kit, 0, 2.05, 0); // skirt
      padd(hp, new THREE.CylinderGeometry(0.7, 0.7, 0.14, 16), acc, 0, 2.62, 0);
      humanHead(rig, false);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.16, len: 0.72, calfR: 0.13, calfLen: 0.68, mat: skin, sock: SOCK_MAT, foot: 'shoe', footMat: DARK_MAT });
        stdArm(rig, rt, { sleeve: { r: 0.2, len: 0.4 }, r: 0.13, len: 0.5, foreR: 0.115, foreLen: 0.52, mat: skin, wrist: null, handR: 0.15 });
      }
      break;
    }
    case 'disco': {
      const t = stdTorso(rig);
      for (const s of [-1, 1]) {
        padd(t, new THREE.BoxGeometry(0.34, 0.16, 0.06), kit, s * 0.3, 1.62, 0.3, -0.2, 0, s * 0.55); // collar wings
      }
      padd(t, new THREE.TorusGeometry(0.24, 0.035, 8, 14), acc, 0, 1.42, 0.32, 1.25, 0, 0); // chain
      stdShorts(rig, kit);
      humanHead(rig, false);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.2, len: 0.72, calfR: 0.15, calfLen: 0.62, mat: kit, flare: kit, foot: 'shoe', footMat: WHITE_MAT });
        stdArm(rig, rt, { r: 0.17, len: 0.55, foreR: 0.15, foreLen: 0.55, mat: skin });
      }
      break;
    }
    case 'octopus': {
      const t = bodyPart(rig.torsoGroup);
      const mantle = padd(t, new THREE.CapsuleGeometry(0.55, 0.7, 6, 14), skin, 0, 0.9, 0);
      mantle.scale.set(1, 1.05, 0.9);
      padd(t, new THREE.CylinderGeometry(0.58, 0.64, 0.6, 14), kit, 0, 0.75, 0); // tank top
      // tentacle skirt hanging around the hips
      const hp = bodyPart(rig.hipGroup);
      for (const a of [0.45, -0.45, 1.25, -1.25, 2.1, -2.1, 2.9, -2.9]) {
        const tnt = capsule(0.12, 0.6, skin);
        tnt.position.set(Math.sin(a) * 0.45, 2.5, Math.cos(a) * 0.42);
        tnt.rotation.set(Math.cos(a) * 0.4, 0, -Math.sin(a) * 0.4);
        hp.add(tnt);
      }
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.16, len: 0.72, calfR: 0.13, calfLen: 0.62, mat: skin, foot: 'none', curl: true });
        stdArm(rig, rt, { sleeve: null, r: 0.13, len: 0.55, foreR: 0.1, foreLen: 0.55, mat: skin, wrist: acc, handR: 0.11 });
      }
      break;
    }
    case 'cactus': {
      const t = bodyPart(rig.torsoGroup);
      const barrel = padd(t, new THREE.CapsuleGeometry(0.6, 0.85, 6, 14), skin, 0, 0.8, 0);
      barrel.scale.set(1, 1, 0.85);
      for (const a of [0.5, 1.55, 2.6, -2.6, -1.55, -0.5]) { // ribs
        padd(t, new THREE.CapsuleGeometry(0.05, 1.0, 4, 8), skin, Math.sin(a) * 0.56, 1.35, Math.cos(a) * 0.48);
      }
      for (const [a, y] of [[0.3, 1.2], [-0.6, 0.9], [1.1, 0.6], [-1.4, 1.3], [2.4, 0.8], [-2.6, 1.15], [3.0, 1.35], [1.9, 1.05]] as const) {
        padd(t, new THREE.ConeGeometry(0.03, 0.16, 5), WHITE_MAT, Math.sin(a) * 0.6, y, Math.cos(a) * 0.52, Math.cos(a) * 1.4, 0, -Math.sin(a) * 1.4);
      }
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.62, 0.66, 0.6, 14), kit, 0, 2.34, 0);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.18, len: 0.68, calfR: 0.15, calfLen: 0.62, mat: skin, foot: 'shoe', footMat: WHITE_MAT });
        stdArm(rig, rt, { sleeve: null, r: 0.16, len: 0.5, foreR: 0.14, foreLen: 0.5, mat: skin, wrist: acc, handR: 0.14 });
      }
      break;
    }
    case 'wizard': {
      stdTorso(rig);
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.72, 1.2, 1.5, 16), kit, 0, 1.85, 0); // robe
      padd(hp, new THREE.TorusGeometry(0.72, 0.05, 8, 18), acc, 0, 2.58, 0, Math.PI / 2, 0, 0); // rope belt
      humanHead(rig, false);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.17, len: 0.72, calfR: 0.14, calfLen: 0.68, mat: DARK_MAT, foot: 'shoe', footMat: DARK_MAT });
        stdArm(rig, rt, { sleeve: { r: 0.2, len: 0.35 }, r: 0.14, len: 0.5, foreR: 0.12, foreLen: 0.5, mat: skin, wrist: null, handR: 0.15, cuff: kit });
      }
      break;
    }
    default: { // athlete — the classic pro build
      stdTorso(rig);
      stdShorts(rig);
      humanHead(rig);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.24, len: 0.75, calfR: 0.19, calfLen: 0.7, mat: skin, hem: SHORTS_MAT, sock: SOCK_MAT, foot: 'shoe' });
        stdArm(rig, rt, { r: 0.17, len: 0.55, foreR: 0.15, foreLen: 0.55, mat: skin });
      }
    }
  }
}

function makePlayerRig(side: number, intoScene: THREE.Scene = scene3): PlayerRig {
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xe8ae7e });
  const headMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  // double-sided: capes and coat skirts are open shells built from this mat
  const hairMat = new THREE.MeshLambertMaterial({ color: 0x3a2414, side: THREE.DoubleSide });
  const torsoMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const sleeveMatL = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const sleeveMatR = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const accentMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

  const root = new THREE.Group();

  // Bare skeleton: joint groups only — buildBody dresses them per character.
  const mkLeg = (x: number) => {
    const thigh = new THREE.Group();
    thigh.position.set(x, HIP_Y, 0);
    const calf = new THREE.Group();
    calf.position.set(0, -1.15, 0);
    thigh.add(calf);
    root.add(thigh);
    return { thigh, calf };
  };
  const legL = mkLeg(-0.42);
  const legR = mkLeg(0.42);

  const hipGroup = new THREE.Group();
  root.add(hipGroup);

  const upper = new THREE.Group();
  upper.position.y = 2.62;
  root.add(upper);

  const torsoGroup = new THREE.Group();
  upper.add(torsoGroup);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 18), headMat);
  head.position.y = 2.28;
  head.scale.set(0.94, 1.06, 0.97); // gentle oval — skull, not a ball
  head.castShadow = true;
  upper.add(head); // rotated at runtime to watch the ball

  const hairGroup = new THREE.Group();
  head.add(hairGroup);

  const mkArm = (x: number) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(x, 1.55, 0);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.95, 0);
    shoulder.add(elbow);
    upper.add(shoulder);
    return { shoulder, elbow };
  };
  const armL = mkArm(-0.98);
  const armR = mkArm(0.98);

  // Gloves sit where the athlete build puts its hands. Like the racket they
  // hang off the joint rather than a body-part wrapper, so a character
  // rebuild leaves them alone and the kit swap only toggles visibility.
  const mkGlove = (elbow: THREE.Group) => {
    const g = new THREE.Mesh(GLOVE_GEO, GLOVE_MAT);
    g.position.set(0, -0.92, 0.03);
    g.castShadow = true;
    g.visible = false;
    elbow.add(g);
    return g;
  };
  const gloveL = mkGlove(armL.elbow);
  const gloveR = mkGlove(armR.elbow);

  root.rotation.order = 'YZX'; // yaw first, then dive-roll about the local Z
  intoScene.add(root);
  return {
    root,
    upper,
    thighL: legL.thigh, calfL: legL.calf,
    thighR: legR.thigh, calfR: legR.calf,
    torsoGroup, hipGroup,
    shoulderL: armL.shoulder, elbowL: armL.elbow,
    shoulderR: armR.shoulder, elbowR: armR.elbow,
    torsoMat, sleeveMatL, sleeveMatR,
    skinMat, headMat, hairMat, accentMat,
    hairGroup,
    gloveL, gloveR,
    charId: -1,
    keeperKit: false,
    kitSide: -1,
    head,
    pose: { ...ZERO_POSE },
    yaw: side === 0 ? Math.PI : 0,
    runSeed: side * 2.7,
    runPhase: side * 2.7,
    prevPX: 0,
    prevPZ: 0,
    speed: 0,
    gait: 0,
    turnBank: 0,
    prevYaw: side === 0 ? Math.PI : 0,
    pivotUntil: -1e9,
    pivotDir: 1,
    diveStart: -1,
    diveDir: 1,
    prevDive: 0,
    kickStart: -1,
    kickAnim: 'drive',
    kickLow: false,
    kickStretch: false,
    kickPower: 0.5,
    kickMs: 520,
    windupStart: 0,
    contactPoint: null,
    prevKickTicks: 0,
    slideStart: -1,
    slideDir: 1,
    slideKindAnim: 1,
    slideMs: 800,
    slideYaw: 0,
    slideFromX: 0,
    slideFromZ: 0,
    slideLanded: false,
    prevSlide: 0,
  };
}

let playerRigs: PlayerRig[] = [];

function applyPose(
  rig: PlayerRig,
  target: Pose,
  rate: number,
  dt: number,
  finalYaw: number,
  now: number
) {
  const a = 1 - Math.exp(-rate * dt);
  const p = rig.pose as any;
  for (const k of POSE_KEYS) p[k] += ((target as any)[k] - p[k]) * a;

  // breathing / micro-motion layer: nothing is ever perfectly still
  const b1 = Math.sin(now / 820 + rig.runSeed * 7) * 0.02;
  const b2 = Math.sin(now / 640 + rig.runSeed * 3) * 0.025;
  const b3 = Math.sin(now / 710 + rig.runSeed * 5 + 2) * 0.025;

  rig.upper.rotation.set(p.leanF + b1, p.twist, p.leanS);
  rig.thighL.rotation.x = p.thighL;
  rig.calfL.rotation.x = p.calfL;
  rig.thighR.rotation.x = p.thighR;
  rig.calfR.rotation.x = p.calfR;
  rig.shoulderL.rotation.set(p.shLx + b2, 0, p.shLz);
  rig.elbowL.rotation.x = p.elL;
  rig.shoulderR.rotation.set(p.shRx + b3, 0, p.shRz);
  rig.elbowR.rotation.x = p.elR;
  rig.root.rotation.y = finalYaw;
  rig.root.position.y = -p.crouch;
}

// --- pose library -----------------------------------------------------------
// Standing in play. This used to be the tennis ready stance — a deep crouch
// with a two-handed grip out front — which on a football pitch reads as ten
// men holding invisible rackets. A footballer waiting for the ball stands
// tall, arms loose at his sides, shifting his weight and jogging on the spot
// between phases.
function readyPose(now: number, seed: number): Pose {
  const bob = Math.sin(now / 480 + seed);
  const shift = Math.sin(now / 900 + seed * 1.7); // weight rocking foot to foot
  return {
    ...ZERO_POSE,
    leanF: 0.06,
    leanS: shift * 0.05,
    twist: shift * 0.06,
    crouch: 0.07 + Math.abs(bob) * 0.025,
    // feet apart, knees only just off locked — an athletic stand, not a squat
    thighL: -0.1 + shift * 0.06, calfL: 0.16,
    thighR: -0.1 - shift * 0.06, calfR: 0.16,
    // arms hang and swing a little with the weight shift
    shLx: -0.12 + shift * 0.1, shLz: 0.17, elL: -0.3,
    shRx: -0.12 - shift * 0.1, shRz: -0.17, elR: -0.3,
  };
}

// A keeper between the sticks does not stand like an outfielder: knees bent,
// feet wide, hands up and open, bouncing on his toes as the play comes at him.
function keeperSetPose(now: number, seed: number): Pose {
  const bounce = Math.sin(now / 260 + seed);
  return {
    ...ZERO_POSE,
    leanF: 0.3,
    crouch: 0.34 + Math.abs(bounce) * 0.06,
    thighL: -0.5, calfL: 0.78,
    thighR: -0.5, calfR: 0.78,
    // gloves up and out, ready to spread
    shLx: -0.5, shLz: 0.95, elL: -1.25,
    shRx: -0.5, shRz: -0.95, elR: -1.25,
  };
}

// Hip height, and therefore leg length — the number that ties the stride
// animation to the ground. Mirrors HIP_Y.
const LEG_LEN = 2.25;

// A stride's length is set by how far the thigh swings: the foot lands about
// LEG_LEN*sin(amp) ahead of the hip and leaves it the same distance behind,
// so one step covers 2*LEG_LEN*sin(amp) and a full two-step cycle twice that.
// Turning that around gives the radians of cycle per unit of ground covered,
// which is how the phase is driven. Deriving the cadence from the amplitude
// instead of fixing it is what lets the gait change with speed WITHOUT the
// shoes starting to skate: a longer stride automatically means fewer of them.
function strideRateFor(thighAmp: number): number {
  return Math.PI / (2 * LEG_LEN * Math.sin(thighAmp));
}

// Gait shape. g = 0 is a jog, g = 1 is a flat sprint. Everything scales
// together the way it does on a real runner: the thigh swings further, the
// knee picks up higher behind, the trunk leans in, the arms drive instead of
// swinging, and the whole body drops a little onto its toes.
const JOG_AMP = 0.72;
const SPRINT_AMP = 1.32;
// Where the gait blend starts and tops out, in render units per second.
// PLAYER_SPEED is a run; PLAYER_SPEED * SPRINT_MUL is the flat sprint, so a
// player off the ball at walking pace jogs and a sprinter is fully extended.
const GAIT_JOG_SPEED = PLAYER_SPEED * 0.55;
const GAIT_SPRINT_SPEED = PLAYER_SPEED * SPRINT_MUL;
// Below this a player is standing, whatever the stick says.
const GAIT_IDLE_SPEED = PLAYER_SPEED * 0.14;
function thighAmpFor(g: number): number {
  return JOG_AMP + (SPRINT_AMP - JOG_AMP) * g;
}

function runPose(phase: number, lean: number, g: number): Pose {
  const t = phase;
  const s = Math.sin(t);
  const c = Math.sin(t + Math.PI);
  const amp = thighAmpFor(g);
  // knee tuck behind, and arm drive, both grow with the gait
  const tuck = 0.95 + 0.65 * g;
  const armAmp = 0.45 + 0.55 * g;
  return {
    ...ZERO_POSE,
    leanF: 0.16 + 0.34 * g, // upright jog → driving forward lean at a sprint
    leanS: lean,
    twist: s * (0.1 + 0.12 * g), // hips/shoulders counter-rotate with the stride
    crouch: 0.06 + 0.12 * g + Math.abs(s) * (0.03 + 0.04 * g),
    thighL: s * amp, calfL: Math.max(0, -s) * tuck + 0.12,
    thighR: c * amp, calfR: Math.max(0, -c) * tuck + 0.12,
    // elbows tighten as the arms start to drive rather than swing
    shLx: c * armAmp - 0.2 - 0.2 * g, shLz: 0.15, elL: -0.75 - 0.5 * g,
    shRx: s * armAmp - 0.2 - 0.2 * g, shRz: -0.15, elR: -0.75 - 0.5 * g,
  };
}

// How long a plant-and-turn takes. Short enough to stay responsive — the
// server never stops moving the body, this only changes what it looks like.
const PIVOT_MS = 260;

// Standing still: a keeper sets himself, everyone else stands like a
// footballer.
function idlePose(pl: { role?: number }, now: number, seed: number): Pose {
  return (pl.role ?? 0) === ROLE_KEEPER ? keeperSetPose(now, seed) : readyPose(now, seed);
}

// A keeper full stretch. He leaves the ground along the dive, body laid out
// flat, both arms thrown at the ball and the trailing leg extended behind for
// the counterweight. `k` runs 0 (take-off) to 1 (landing).
function keeperDivePose(k: number, dir: number): Pose {
  const air = Math.sin(clamp01(k) * Math.PI); // peak height mid-flight
  return {
    ...ZERO_POSE,
    leanF: 0.15,
    leanS: dir * 0.5 * air,
    twist: dir * 0.3 * air,
    crouch: k < 0.12 ? 0.45 * (1 - k / 0.12) : 0, // the coil before take-off
    // legs together and stretched out behind the line of the dive
    thighL: 0.15 - 0.5 * air, calfL: 0.35 * air,
    thighR: 0.15 - 0.35 * air, calfR: 0.55 * air,
    // both gloves thrown at the ball, the lead arm fully extended
    shLx: -1.5 * air - 0.3, shLz: (dir > 0 ? 1 : 0.35) * 1.15 * air, elL: -0.15,
    shRx: -1.5 * air - 0.3, shRz: -(dir < 0 ? 1 : 0.35) * 1.15 * air, elR: -0.15,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Plant-and-turn. A footballer reversing does not rotate on the spot like a
// turret: he plants the outside foot, drops his hips and pushes off it. This
// is the pose that plays over the pivot window, blended over the run.
function pivotPose(k: number, dir: number): Pose {
  const swing = Math.sin(Math.min(1, k) * Math.PI);
  return {
    ...ZERO_POSE,
    leanF: 0.1,
    leanS: -dir * 0.42 * swing, // hips dropped INTO the turn
    twist: dir * 0.4 * swing, // shoulders lead the feet round
    crouch: 0.18 + 0.24 * swing,
    // outside leg braced and straight, inside leg gathering under the body
    thighL: dir > 0 ? -0.55 * swing : 0.35 * swing,
    calfL: dir > 0 ? 0.25 : 0.85 * swing,
    thighR: dir > 0 ? 0.35 * swing : -0.55 * swing,
    calfR: dir > 0 ? 0.85 * swing : 0.25,
    shLx: -0.35 - 0.5 * swing, shLz: 0.4 * swing + 0.15, elL: -0.7,
    shRx: -0.35 + 0.9 * swing, shRz: -0.4 * swing - 0.15, elR: -0.7,
  };
}

// Cocked leg, held while the kick button is charging. The longer it is held
// the deeper the backlift — kickPose reads the same shape at t=0.
function kickWindup(kind: KickKind, charge: number): Pose {
  const c = THREE.MathUtils.clamp(charge, 0, 1);
  return {
    ...ZERO_POSE,
    leanF: 0.2 + c * 0.12,
    twist: -0.3 * c,
    crouch: 0.14,
    // plant leg under the body, kicking leg drawn back and cocked at the knee
    thighL: -0.25, calfL: 0.4,
    thighR: 0.55 + c * 0.7, calfR: 1.0 + c * 0.5,
    // arms open out for balance, harder on a big backlift
    shLx: -0.55 - c * 0.35, shLz: 0.6 + c * 0.25, elL: -0.75,
    shRx: 0.35 + c * 0.3, shRz: -0.45, elR: -0.5,
    // a chip drops the shoulders back to get the toe under the ball
    ...(kind === 'chip' ? { leanF: 0.02 - c * 0.16, crouch: 0.2 } : null),
  };
}

// Full kick cycle. t: 0 backlift → 0.3 CONTACT → 1 follow-through done.
// `power` (0..1) scales the whole strike: a tap is a compact side-foot pass,
// a full charge is a hip-driven laces shot with the standing foot leaving
// the ground.
function kickPose(kind: KickKind, t: number, chip: boolean, power = 0.5): Pose {
  const cnt = 0.3; // contact time
  const amp = 0.7 + 0.7 * power;
  const w = kickWindup(kind, power);
  if (t < cnt) {
    // whip the leg through: thigh drives forward, knee extends into the ball
    const k = (t / cnt) ** 2;
    return {
      ...w,
      twist: THREE.MathUtils.lerp(w.twist, 0.3 * amp, k),
      leanF: THREE.MathUtils.lerp(w.leanF, chip ? -0.05 : 0.3, k),
      thighR: THREE.MathUtils.lerp(w.thighR, chip ? -0.75 : -0.55, k),
      calfR: THREE.MathUtils.lerp(w.calfR, chip ? 0.35 : 0.05, k), // knee snaps straight
      thighL: THREE.MathUtils.lerp(w.thighL, -0.15, k),
      calfL: THREE.MathUtils.lerp(w.calfL, 0.25, k),
      crouch: THREE.MathUtils.lerp(w.crouch, 0.1 + power * 0.1, k),
      shLx: THREE.MathUtils.lerp(w.shLx, -1.1, k),
      shRx: THREE.MathUtils.lerp(w.shRx, 0.7, k),
    };
  }
  // follow-through: the leg keeps climbing and the body rotates over it;
  // a big strike hops off the standing foot
  const k = (t - cnt) / (1 - cnt);
  const ease = 1 - (1 - k) * (1 - k);
  const hop = power > 0.6 ? -(power - 0.6) * 0.7 * Math.sin(Math.min(1, k * 1.8) * Math.PI) : 0;
  return {
    ...ZERO_POSE,
    twist: THREE.MathUtils.lerp(0.3 * amp, 0.55 * amp, ease),
    leanF: chip ? -0.1 : 0.26,
    crouch: 0.12 + hop,
    thighR: THREE.MathUtils.lerp(chip ? -0.75 : -0.55, -1.15 * amp, ease),
    calfR: THREE.MathUtils.lerp(chip ? 0.35 : 0.05, 0.2, ease),
    thighL: THREE.MathUtils.lerp(-0.15, 0.3, ease),
    calfL: THREE.MathUtils.lerp(0.25, 0.75, ease),
    shLx: -1.2, shLz: 0.5, elL: -0.7,
    shRx: 0.8, shRz: -0.5, elR: -0.5,
  };
}

const KICK_MS = 420;
// Full charge, in ms — mirrors KICK_CHARGE_TICKS / TICK_HZ in the module.
const KICK_CHARGE_MS = 800;

function triggerKick(
  rig: PlayerRig,
  kind: KickKind,
  chip: boolean,
  now: number,
  stretch = false,
  power = 0.5,
  atContact = false
) {
  rig.kickAnim = kind;
  rig.kickLow = chip;
  rig.kickStretch = stretch;
  rig.kickPower = power;
  // a hard strike whips through faster than a side-foot pass
  rig.kickMs = KICK_MS + 160 * (1 - power);
  // A real kick fires at the server's contact instant — start the cycle just
  // before its contact phase (the backlift already happened while charging),
  // so the boot meets the ball NOW instead of after it has gone.
  rig.kickStart = atContact ? now - rig.kickMs * 0.3 : now;
}

// ---------------------------------------------------------------------------
// Environment (court, net, stands, hoardings)
// ---------------------------------------------------------------------------
// Pitch styles: 0 grass by day, 1 grass under floodlights, 2 street concrete.
// Mown stripes run across the pitch on both grass surfaces; the street cage
// is flat asphalt with painted lines.
const SURFACES = [
  { inner: '#4aa338', outer: '#419230', stripe: true, noise: 'rgba(0,60,0,0.05)' },
  { inner: '#2f7a2c', outer: '#296b26', stripe: true, noise: 'rgba(0,40,0,0.06)' },
  { inner: '#6b6f75', outer: '#5d6167', stripe: false, noise: 'rgba(20,20,25,0.07)' },
];

function makeGroundTexture(court: number): THREE.CanvasTexture {
  const surf = SURFACES[court] ?? SURFACES[0];
  const c = document.createElement('canvas');
  // Half-res surface (and no grain, below) when detail is off — less texture
  // for the GPU to sample on every court pixel.
  // The canvas is a plain top-down chart of the bowl floor: canvas x runs
  // ALONG the pitch (three-x), canvas y ACROSS it (three-z). Both helpers
  // still take world coords — wx across, wy along — so every drawing call
  // below reads in pitch terms and needs no transposing of its own.
  // The chart covers only ±GROUND_WID across; the plane runs on to
  // ±GROUND_EXT and clamps to this edge (see buildEnvironment), which is
  // plain outfield grass, so none of the texture is spent on ground nobody
  // can see past the hoardings.
  c.width = gfx.detail ? 2048 : 1024;
  c.height = Math.round((c.width * GROUND_WID) / GROUND_LEN); // square texels
  const g = c.getContext('2d')!;
  const PX = c.width / (2 * GROUND_LEN); // canvas pixels per world unit
  const toU = (wy: number) => (wy + GROUND_LEN) * PX;
  const toV = (wx: number) => (wx + GROUND_WID) * PX;
  const span = (n: number) => n * PX;

  g.fillStyle = surf.outer;
  g.fillRect(0, 0, c.width, c.height);

  if (surf.stripe) {
    // Mowing bands run ACROSS the pitch: side-on that reads as vertical
    // stripes crossing the screen, which is the broadcast look. Anchoring
    // them on multiples of STRIPE puts a seam on the halfway line and on
    // both goal lines.
    const STRIPE = PITCH_HALF_LEN / 7; // 14 bands between the goal lines
    for (let i = -Math.ceil(GROUND_LEN / STRIPE); i * STRIPE < GROUND_LEN; i++) {
      g.fillStyle = (((i % 2) + 2) % 2) === 0 ? surf.inner : surf.outer;
      const u0 = toU(i * STRIPE);
      g.fillRect(u0, 0, toU((i + 1) * STRIPE) - u0, c.height);
    }
  } else {
    const mx = PITCH_HALF_WID + 6;
    const my = PITCH_HALF_LEN + 8;
    g.fillStyle = surf.inner;
    g.fillRect(toU(-my), toV(-mx), toU(my) - toU(-my), toV(mx) - toV(-mx));
  }
  for (let n = 0; gfx.detail && n < 14000; n++) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    const r = s - Math.floor(s);
    const s2 = Math.sin(n * 311.7) * 12543.21;
    const r2 = s2 - Math.floor(s2);
    g.fillStyle = r > 0.5 ? 'rgba(255,255,255,0.03)' : surf.noise;
    g.fillRect(r * c.width, r2 * c.height, 2, 2);
  }

  const hw = PITCH_HALF_WID;
  const hl = PITCH_HALF_LEN;

  // baked ambient falloff toward the hoardings grounds the pitch in the bowl
  for (const s of [1, -1]) {
    const v0 = toV(s * GROUND_WID);
    const v1 = toV(s * (hw - 6));
    const vg = g.createLinearGradient(0, v0, 0, v1);
    vg.addColorStop(0, 'rgba(0,0,20,0.14)');
    vg.addColorStop(1, 'rgba(0,0,20,0)');
    g.fillStyle = vg;
    g.fillRect(0, Math.min(v0, v1), c.width, Math.abs(v1 - v0));
  }
  for (const s of [1, -1]) {
    const u0 = toU(s * GROUND_LEN);
    const u1 = toU(s * (hl - 8));
    const hg = g.createLinearGradient(u0, 0, u1, 0);
    hg.addColorStop(0, 'rgba(0,0,20,0.10)');
    hg.addColorStop(1, 'rgba(0,0,20,0)');
    g.fillStyle = hg;
    g.fillRect(Math.min(u0, u1), 0, Math.abs(u1 - u0), c.height);
  }

  // the grass dies in the goalmouths and around the penalty spots — the two
  // patches of a five-a-side pitch that never get a rest
  if (court !== 2) {
    for (const gs of [1, -1]) {
      for (const [wy, rAcross, rAlong, a] of [
        [gs * (hl - 1.5), GOAL_HALF_W + 1.5, 3.2, 0.09],
        [gs * (hl - BOX_DEPTH + 3), 4.5, 2.4, 0.06],
      ] as const) {
        g.fillStyle = `rgba(196,180,120,${a})`;
        g.beginPath();
        // the patch is wide across the goal and shallow along the pitch, so
        // the along radius drives canvas x and the across radius canvas y
        g.ellipse(toU(wy), toV(0), span(rAlong), span(rAcross), 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  // street concrete: expansion joints and the scuffs of a thousand slides
  if (court === 2 && gfx.detail) {
    g.strokeStyle = 'rgba(0,0,0,0.10)';
    g.lineWidth = 3;
    for (let wy = -hl - 6; wy <= hl + 6; wy += 13) {
      g.beginPath();
      g.moveTo(toU(wy), toV(-hw - 6));
      g.lineTo(toU(wy), toV(hw + 6));
      g.stroke();
    }
    for (let wx = -hw - 6; wx <= hw + 6; wx += 13) {
      g.beginPath();
      g.moveTo(toU(-hl - 6), toV(wx));
      g.lineTo(toU(hl + 6), toV(wx));
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 3;
    for (let n = 0; n < 90; n++) {
      const s1 = Math.sin(n * 91.7) * 43758.5453;
      const wx = ((s1 - Math.floor(s1)) * 2 - 1) * hw;
      const s2 = Math.sin(n * 271.3) * 12543.21;
      const wy = ((s2 - Math.floor(s2)) * 2 - 1) * (hl + 3);
      const s3 = Math.sin(n * 137.9) * 33421.13;
      const ang = (s3 - Math.floor(s3)) * Math.PI * 2;
      g.beginPath();
      g.moveTo(toU(wy), toV(wx));
      g.lineTo(toU(wy + Math.sin(ang) * 1.4), toV(wx + Math.cos(ang) * 2.6));
      g.stroke();
    }
  }

  g.lineCap = 'square';
  // All three take world coords (x across, y along) and place them on the
  // transposed chart, so the markings below are written in pitch terms.
  const line = (x1: number, y1: number, x2: number, y2: number, ox = 0, oy = 0) => {
    g.beginPath();
    g.moveTo(toU(y1) + ox, toV(x1) + oy);
    g.lineTo(toU(y2) + ox, toV(x2) + oy);
    g.stroke();
  };
  const arc = (
    cx: number, cy: number, r: number, a0: number, a1: number, ox: number, oy: number
  ) => {
    g.beginPath();
    // World angles run from +x (across) toward +y (along). The chart puts
    // along on canvas x and across on canvas y, so a world angle θ lands at
    // canvas angle π/2 − θ and the sweep reverses with it.
    g.ellipse(
      toU(cy) + ox, toV(cx) + oy,
      span(r), span(r),
      0, Math.PI / 2 - a1, Math.PI / 2 - a0
    );
    g.stroke();
  };
  const dot = (cx: number, cy: number, ox: number, oy: number) => {
    g.beginPath();
    g.ellipse(toU(cy) + ox, toV(cx) + oy, span(0.45), span(0.45), 0, 0, Math.PI * 2);
    g.fill();
  };
  // Real proportions off the goal: the six-yard box is 5.5 m deep against the
  // penalty area's 16.5, and reaches 1.5 goal-half-widths past each post.
  const SIX_DEPTH = BOX_DEPTH * 0.33;
  const SIX_HALF_W = GOAL_HALF_W + 6;
  const PEN_SPOT = BOX_DEPTH * 0.62;
  const paintLines = (ox: number, oy: number) => {
    // touchlines + goal lines
    line(-hw, -hl, hw, -hl, ox, oy);
    line(-hw, hl, hw, hl, ox, oy);
    line(-hw, -hl, -hw, hl, ox, oy);
    line(hw, -hl, hw, hl, ox, oy);
    // halfway line + center circle + spot
    line(-hw, 0, hw, 0, ox, oy);
    arc(0, 0, CENTER_CIRCLE_R, 0, Math.PI * 2, ox, oy);
    dot(0, 0, ox, oy);
    for (const gs of [1, -1]) {
      const gl = gs * hl; // this end's goal line
      // penalty area
      line(-BOX_HALF_W, gl, -BOX_HALF_W, gl - gs * BOX_DEPTH, ox, oy);
      line(BOX_HALF_W, gl, BOX_HALF_W, gl - gs * BOX_DEPTH, ox, oy);
      line(-BOX_HALF_W, gl - gs * BOX_DEPTH, BOX_HALF_W, gl - gs * BOX_DEPTH, ox, oy);
      // six-yard box
      line(-SIX_HALF_W, gl, -SIX_HALF_W, gl - gs * SIX_DEPTH, ox, oy);
      line(SIX_HALF_W, gl, SIX_HALF_W, gl - gs * SIX_DEPTH, ox, oy);
      line(-SIX_HALF_W, gl - gs * SIX_DEPTH, SIX_HALF_W, gl - gs * SIX_DEPTH, ox, oy);
      // penalty spot + the D outside the box
      dot(0, gl - gs * PEN_SPOT, ox, oy);
      const d = Math.acos(Math.min(1, (BOX_DEPTH - PEN_SPOT) / CENTER_CIRCLE_R));
      if (gs > 0) arc(0, gl - gs * PEN_SPOT, CENTER_CIRCLE_R, Math.PI + d, 2 * Math.PI - d, ox, oy);
      else arc(0, gl - gs * PEN_SPOT, CENTER_CIRCLE_R, d, Math.PI - d, ox, oy);
      // corner arcs
      for (const sx of [1, -1]) {
        const a0 = gs > 0 ? (sx > 0 ? Math.PI : Math.PI * 1.5) : (sx > 0 ? Math.PI * 0.5 : 0);
        arc(sx * hw, gl, 1.6, a0, a0 + Math.PI / 2, ox, oy);
      }
    }
  };
  // Paint is a fixed WIDTH ON THE GROUND (about 11 cm at this scale), so it
  // is derived from the texel density rather than fixed in pixels — the
  // half-res texture then draws the same lines, not fatter ones.
  const LW = Math.max(2, span(0.36));
  // the shadow falls with the sun (far side, over the far touchline): down
  // the canvas is toward the camera, right is up the pitch
  g.strokeStyle = 'rgba(0,10,0,0.22)';
  g.fillStyle = 'rgba(0,10,0,0.22)';
  g.lineWidth = LW * 1.5;
  paintLines(span(0.2), span(0.3));
  g.strokeStyle = '#fafafa';
  g.fillStyle = '#fafafa';
  g.lineWidth = LW;
  paintLines(0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = gfx.detail ? 8 : 1;
  tex.colorSpace = THREE.SRGBColorSpace;
  // The plane is GROUND_EXT deep but this chart only covers GROUND_WID; the
  // rest of the plane clamps to the outfield grass at its edge.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  const kv = GROUND_EXT / GROUND_WID;
  tex.repeat.set(1, kv);
  tex.offset.set(0, (1 - kv) / 2);
  return tex;
}

const texHash = (n: number) => {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
};

// Painted spectators: seated rows with real bodies (shirt, head, hair), empty
// seats in section colors, aisles with steps, a front wall, roof shadow.
// Two frames (0/1) with the same deterministic layout: frame 1 bobs half the
// crowd and raises extra arms, so swapping frames makes the crowd live.
function makeCrowdTexture(frame: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, 0, c.height);
  bg.addColorStop(0, '#1a2140');
  bg.addColorStop(1, '#262f54');
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);

  const WALL_H = 56; // front wall band at the bottom of the stand
  const top = 24;
  // aisles with steps, under the crowd
  for (let ax = 0; ax < c.width; ax += 128) {
    g.fillStyle = '#2c3454';
    g.fillRect(ax, top - 8, 13, c.height - WALL_H - top + 8);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    for (let sy = top; sy < c.height - WALL_H; sy += 9) g.fillRect(ax, sy, 13, 2);
  }

  const SEAT_COLS = ['#31479c', '#8f2d33', '#20745a', '#6a4aa0'];
  const SKIN = ['#f4d6b4', '#eec39c', '#d8a06e', '#b07848', '#8a5a34', '#6e452a'];
  const HAIR = ['#241812', '#4a3520', '#101014', '#6e6862', '#8a4a22'];
  const ROWS = 16;
  const rowH = (c.height - WALL_H - top) / ROWS;
  for (let row = 0; row < ROWS; row++) {
    const y = top + row * rowH + rowH * 0.72;
    const depth = row / (ROWS - 1); // 0 back … 1 front
    const s = 0.72 + 0.38 * depth; // people scale up toward the front
    // riser shadow separating the rows
    g.fillStyle = 'rgba(8,10,24,0.5)';
    g.fillRect(0, y + 6 * s, c.width, 3.5);
    const step = 15 * s;
    for (let x = 6 + step * texHash(row * 17.7); x < c.width; x += step) {
      if (x % 128 < 15) continue; // aisle
      const n = row * 997 + Math.floor(x / step) * 13;
      if (texHash(n * 1.01) < 0.15) {
        // empty seat
        g.fillStyle = SEAT_COLS[Math.floor(x / 128) % SEAT_COLS.length];
        g.fillRect(x - 5 * s, y - 9 * s, 10 * s, 10 * s);
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(x - 5 * s, y - 9 * s, 10 * s, 2);
        continue;
      }
      const bob = frame === 1 && texHash(n * 2.17) > 0.5 ? 2.6 * s : 0;
      const h2 = texHash(n * 3.33);
      const shirt =
        h2 < 0.14
          ? `hsl(${Math.floor(texHash(n * 4.4) * 360)}, 78%, 58%)` // superfans
          : `hsl(${150 + Math.floor(texHash(n * 4.4) * 120)}, ${22 + Math.floor(h2 * 30)}%, ${34 + Math.floor(texHash(n * 5.5) * 30)}%)`;
      const skin = SKIN[Math.floor(texHash(n * 6.6) * SKIN.length)];
      if (texHash(n * 7.7) < (frame === 1 ? 0.16 : 0.07)) {
        // arms up cheering
        g.strokeStyle = shirt;
        g.lineWidth = 2.6 * s;
        g.lineCap = 'round';
        for (const dir of [-1, 1]) {
          g.beginPath();
          g.moveTo(x + dir * 3 * s, y - 6 * s - bob);
          g.lineTo(x + dir * 6 * s, y - 17 * s - bob);
          g.stroke();
          g.fillStyle = skin;
          g.beginPath();
          g.arc(x + dir * 6 * s, y - 17.5 * s - bob, 1.7 * s, 0, Math.PI * 2);
          g.fill();
        }
      }
      // torso: round shoulders over a block body
      g.fillStyle = shirt;
      g.beginPath();
      g.arc(x, y - 6 * s - bob, 5 * s, Math.PI, 0);
      g.fill();
      g.fillRect(x - 5 * s, y - 6 * s - bob, 10 * s, 8 * s);
      // head + hair
      g.fillStyle = skin;
      g.beginPath();
      g.arc(x, y - 10.5 * s - bob, 3.8 * s, 0, Math.PI * 2);
      g.fill();
      if (texHash(n * 8.8) > 0.22) {
        g.fillStyle = HAIR[Math.floor(texHash(n * 9.9) * HAIR.length)];
        g.beginPath();
        g.arc(x, y - 11 * s - bob, 3.8 * s, Math.PI * 1.02, Math.PI * 1.98);
        g.fill();
      }
    }
  }
  // camera flashes twinkle on the alternate frame
  if (frame === 1) {
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 12; i++) {
      if (texHash(i * 3.7 + 1) > 0.4) continue;
      g.fillRect(texHash(i * 12.3) * c.width, top + texHash(i * 7.1) * (c.height - WALL_H - top - 30), 3, 3);
    }
  }
  // front wall below the first row, with the crowd's shadow falling on it
  g.fillStyle = '#e4e9f0';
  g.fillRect(0, c.height - WALL_H, c.width, WALL_H);
  g.fillStyle = 'rgba(20,26,52,0.28)';
  g.fillRect(0, c.height - WALL_H, c.width, 12);
  g.fillStyle = '#aeb6c4';
  g.fillRect(0, c.height - 6, c.width, 6);
  // roof shadow over the back rows
  const sh = g.createLinearGradient(0, 0, 0, 100);
  sh.addColorStop(0, 'rgba(0,0,12,0.5)');
  sh.addColorStop(1, 'rgba(0,0,12,0)');
  g.fillStyle = sh;
  g.fillRect(0, 0, c.width, 100);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Sponsor boards: a strip of distinct advertiser panels instead of one
// repeated wordmark, with a top sheen and ground shadow so they read as
// physical boxes.
function makeHoardingTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 64;
  const g = c.getContext('2d')!;
  const panels: [string, string, string][] = [
    ['DIGITAL FOOTBALL', '#101c54', '#ffffff'],
    ['BOOT ROOM', '#f4f6fa', '#12205a'],
    ['VOLT ENERGY', '#f2c018', '#221a06'],
    ['FIVE-A-SIDE FC', '#175c34', '#eafaf0'],
    ['TERRACE FM', '#b8241c', '#ffffff'],
    ['GOLDEN GOAL', '#f4f6fa', '#b8241c'],
  ];
  const pw = c.width / panels.length;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  panels.forEach(([label, bgCol, fg], i) => {
    g.fillStyle = bgCol;
    g.fillRect(i * pw, 0, pw, c.height);
    g.fillStyle = fg;
    g.font = 'italic 900 30px "Arial Black", Arial, sans-serif';
    g.fillText(label, i * pw + pw / 2, c.height / 2 + 2);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(i * pw, 0, 3, c.height); // panel joins
  });
  g.fillStyle = 'rgba(255,255,255,0.28)';
  g.fillRect(0, 0, c.width, 4);
  const sh = g.createLinearGradient(0, c.height - 14, 0, c.height);
  sh.addColorStop(0, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.30)');
  g.fillStyle = sh;
  g.fillRect(0, c.height - 14, c.width, 14);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Gradient sky with a sun glow (matching the key light's corner) and soft
// cumulus puffs — replaces the flat solid-color background.
function makeSkyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#2f6cb4');
  grad.addColorStop(0.4, '#6ea6d8');
  grad.addColorStop(0.75, '#b8d8ec');
  grad.addColorStop(1, '#eef2ea'); // warm haze at the horizon
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const glow = g.createRadialGradient(300, 110, 0, 300, 110, 280);
  glow.addColorStop(0, 'rgba(255,248,225,0.75)');
  glow.addColorStop(0.25, 'rgba(255,244,214,0.28)');
  glow.addColorStop(1, 'rgba(255,244,214,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 9; i++) {
    const cx = texHash(i * 3.1) * c.width;
    const cy = 120 + texHash(i * 5.7) * 210;
    const sc = 0.7 + texHash(i * 7.9);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    for (let p = 0; p < 6; p++) {
      const px = cx + (texHash(i * 11.3 + p) - 0.5) * 150 * sc;
      const py = cy + (texHash(i * 13.7 + p) - 0.5) * 34 * sc;
      const pr = (22 + texHash(i * 17.9 + p) * 26) * sc;
      g.beginPath();
      g.ellipse(px, py, pr, pr * 0.55, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Big screen above the far stand: glowing wordmark, LIVE bug, scanlines.
function makeJumbotronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 192;
  const g = c.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, 0, c.height);
  bg.addColorStop(0, '#0a1030');
  bg.addColorStop(1, '#101c48');
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.textAlign = 'center';
  const word = g.createLinearGradient(0, 34, 0, 96);
  word.addColorStop(0, '#fff8d0');
  word.addColorStop(1, '#f2c018');
  g.fillStyle = word;
  g.font = 'italic 900 38px "Arial Black", Arial, sans-serif';
  g.fillText('DIGITAL FOOTBALL', c.width / 2, 82);
  // a football dotting the tagline
  g.fillStyle = '#f6f6f2';
  g.beginPath();
  g.arc(c.width / 2 - 78, 134, 12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1b1b20';
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
    const x = c.width / 2 - 78 + Math.cos(a) * 4.5;
    const y = 134 + Math.sin(a) * 4.5;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  g.fillStyle = '#e83828';
  g.beginPath();
  g.arc(c.width / 2 - 34, 134, 7, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = '700 26px Arial, sans-serif';
  g.textAlign = 'left';
  g.fillText('LIVE', c.width / 2 - 18, 143);
  // scanlines + edge glow border
  g.fillStyle = 'rgba(0,0,0,0.16)';
  for (let y = 0; y < c.height; y += 4) g.fillRect(0, y, c.width, 1.5);
  g.strokeStyle = '#2fb4e0';
  g.lineWidth = 5;
  g.strokeRect(4, 4, c.width - 8, c.height - 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Woven net: a transparent canvas carrying the cord grid, so the net reads
// as mesh you can see through instead of a smoked-glass pane.
function makeNetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(16,20,18,0.95)';
  g.lineWidth = 1.6;
  for (let x = 0; x <= c.width; x += 9) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, c.height);
    g.stroke();
  }
  for (let y = 0; y <= c.height; y += 9) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(c.width, y);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

let groundMat: THREE.MeshLambertMaterial;
let currentCourt = -1;

function setCourt(court: number) {
  if (court === currentCourt) return;
  currentCourt = court;
  const old = groundMat.map;
  groundMat.map = makeGroundTexture(court);
  groundMat.needsUpdate = true;
  old?.dispose();
}

const HOARD_H = 3;
const STAND_TILT = 0.55;
const STAND_H = 34;

// The stadium bowl is an octagon: four main stands plus chamfered corner
// sections, so the arena closes into a seamless ring instead of four
// floating walls with sky gaps at the corners.
function bowlEdges() {
  const A = GROUND_LEN, B = GROUND_WID, cut = 24;
  const pts: [number, number][] = [
    [-A + cut, -B], [A - cut, -B], [A, -B + cut], [A, B - cut],
    [A - cut, B], [-A + cut, B], [-A, B - cut], [-A, -B + cut],
  ];
  return pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length];
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const len = Math.hypot(dx, dz);
    const nx = -dz / len; // unit normal pointing in at the court
    const nz = dx / len;
    return { mx: (p[0] + q[0]) / 2, mz: (p[1] + q[1]) / 2, len, nx, nz, yaw: Math.atan2(nx, nz) };
  });
}

// Bake a texture repeat into the geometry's UVs so every stand/hoarding can
// share one material (and the crowd frame-swap stays two materials total).
function scaleUv(geo: THREE.BufferGeometry, kx: number, ky = 1) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * kx, uv.getY(i) * ky);
  uv.needsUpdate = true;
}

function buildEnvironment() {
  crowdStands = [];
  groundMat = new THREE.MeshLambertMaterial();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_LEN * 2, GROUND_EXT * 2),
    groundMat
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene3.add(ground);

  // --- goals: white frame, sagging net, stanchions. One at each end; the
  // ball crosses the line at |y| = PITCH_HALF_LEN, so the frame sits there
  // and the netting hangs behind it. ---------------------------------------
  // Side-on both goals are in shot at once, so the netting has to be
  // something you see the pitch THROUGH, not a wall across the screen.
  const netMat = new THREE.MeshLambertMaterial({
    map: makeNetTexture(),
    transparent: true,
    side: THREE.DoubleSide,
    opacity: 0.45,
    depthWrite: false,
    color: 0xf4f8ff,
  });
  const frameMat = new THREE.MeshLambertMaterial({ color: COLORS.netPost });
  const POST_R = 0.22;
  const NET_DEPTH = 5.5; // how far the net is pulled back behind the line
  for (const gs of [1, -1]) {
    const goal = new THREE.Group();
    // The pitch runs along three-x, so a goal at world y = gs*HALF_LEN stands
    // at three-x = gs*HALF_LEN turned a quarter turn to face inward. Every
    // child then works in one local frame: +x across the mouth, +z BEHIND the
    // goal, whichever end this is.
    goal.position.set(gs * PITCH_HALF_LEN, 0, 0);
    goal.rotation.y = (gs * Math.PI) / 2;
    scene3.add(goal);

    for (const px of [-GOAL_HALF_W, GOAL_HALF_W]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(POST_R, POST_R, GOAL_HEIGHT, 12),
        frameMat
      );
      post.position.set(px, GOAL_HEIGHT / 2, 0);
      post.castShadow = true;
      goal.add(post);
    }
    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(POST_R, POST_R, GOAL_HALF_W * 2, 12),
      frameMat
    );
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, GOAL_HEIGHT, 0);
    bar.castShadow = true;
    goal.add(bar);

    // back stanchions, leaning away from the pitch
    const lean = -Math.atan2(NET_DEPTH, GOAL_HEIGHT);
    for (const px of [-GOAL_HALF_W, GOAL_HALF_W]) {
      const stay = new THREE.Mesh(
        new THREE.CylinderGeometry(POST_R * 0.6, POST_R * 0.6, Math.hypot(GOAL_HEIGHT, NET_DEPTH), 8),
        frameMat
      );
      stay.position.set(px, GOAL_HEIGHT / 2, NET_DEPTH / 2);
      stay.rotation.x = lean;
      goal.add(stay);
    }

    // netting: back panel, roof, two sides
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(GOAL_HALF_W * 2, Math.hypot(GOAL_HEIGHT, NET_DEPTH)),
      netMat
    );
    // tilted so its top edge meets the crossbar and its foot the net's back
    back.position.set(0, GOAL_HEIGHT / 2, NET_DEPTH / 2);
    back.rotation.x = lean;
    goal.add(back);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_HALF_W * 2, NET_DEPTH), netMat);
    roof.rotation.x = -Math.PI / 2;
    roof.position.set(0, GOAL_HEIGHT, NET_DEPTH / 2);
    goal.add(roof);
    for (const px of [-GOAL_HALF_W, GOAL_HALF_W]) {
      const sideNet = new THREE.Mesh(new THREE.PlaneGeometry(NET_DEPTH, GOAL_HEIGHT), netMat);
      sideNet.rotation.y = Math.PI / 2;
      sideNet.position.set(px, GOAL_HEIGHT / 2, NET_DEPTH / 2);
      goal.add(sideNet);
    }
  }

  // --- hoardings: sponsor boards ringing the whole octagon (always on — a
  // thin band that caps the court against the sky) ------------------------
  const edges = bowlEdges();
  const hoardMat = new THREE.MeshLambertMaterial({ map: makeHoardingTexture() });
  for (const e of edges) {
    const geo = new THREE.BoxGeometry(e.len + 0.6, HOARD_H, 0.4);
    scaleUv(geo, Math.max(1, Math.round(e.len / 56)));
    const m = new THREE.Mesh(geo, hoardMat);
    m.position.set(e.mx, HOARD_H / 2, e.mz);
    m.rotation.y = e.yaw;
    m.castShadow = true;
    scene3.add(m);
  }

  // Scenery: the fill-hungry decoration hangs off one group so the detail
  // option can drop it in a single flag.
  detailGroup = new THREE.Group();
  detailGroup.visible = gfx.detail;
  scene3.add(detailGroup);

  // --- stands: tilted crowd tiers rising from the hoarding tops, with a
  // roof + fascia. Edge 4 is the camera-side touchline (three-z = +WID): the
  // rail flies above it, so that stand is kept low and roofless or it would
  // sit across the bottom of every frame. Its corner neighbours step down to
  // meet it. -----------------------------------------------------------
  const cMatA = (crowdMatA = new THREE.MeshLambertMaterial({ map: makeCrowdTexture(0) }));
  const cMatB = (crowdMatB = new THREE.MeshLambertMaterial({ map: makeCrowdTexture(1) }));
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xdde3ea });
  const fasciaMat = new THREE.MeshLambertMaterial({ color: 0xf4f6fa });
  const sinT = Math.sin(STAND_TILT);
  const cosT = Math.cos(STAND_TILT);
  edges.forEach((e, i) => {
    const near = i === 4;
    const hs = near ? 0.34 : i === 3 || i === 5 ? 0.62 : 1;
    const H = STAND_H * hs;
    // widened by the lean-back offset so adjacent tiers overlap at the top
    // instead of opening sky wedges at the octagon corners
    const W = e.len + 0.6 + H * sinT * 0.83;
    const geo = new THREE.PlaneGeometry(W, H);
    // uv.y scaled by hs: shorter stands keep the front rows, crop the back
    scaleUv(geo, Math.max(0.5, W / (2 * STAND_H)), hs);
    const mesh = new THREE.Mesh(geo, i % 2 ? cMatB : cMatA);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = e.yaw;
    mesh.rotation.x = -STAND_TILT;
    mesh.position.set(
      e.mx - e.nx * (H / 2) * sinT,
      HOARD_H + (H / 2) * cosT,
      e.mz - e.nz * (H / 2) * sinT
    );
    detailGroup.add(mesh);
    crowdStands.push({ mesh, parity: i & 1, cur: i & 1 });

    if (!near) {
      const off = H * sinT;
      const topY = HOARD_H + H * cosT;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 1, 0.6, 8), roofMat);
      roof.rotation.y = e.yaw;
      roof.position.set(e.mx - e.nx * (off + 0.5), topY + 0.5, e.mz - e.nz * (off + 0.5));
      detailGroup.add(roof);
      const fascia = new THREE.Mesh(new THREE.BoxGeometry(e.len + 1.5, 1.5, 0.22), fasciaMat);
      fascia.rotation.y = e.yaw;
      fascia.position.set(e.mx - e.nx * (off - 3.4), topY - 0.2, e.mz - e.nz * (off - 3.4));
      detailGroup.add(fascia);
    }
  });

  // --- jumbotron, up in a far corner. Dead centre of frame is the worst
  // place for it: side-on that is exactly where the play is. ---------------
  const jumbo = new THREE.Group();
  jumbo.rotation.order = 'YXZ';
  const jFrame = new THREE.Mesh(
    new THREE.BoxGeometry(29.6, 11.4, 1),
    new THREE.MeshLambertMaterial({ color: 0x141a2e })
  );
  jumbo.add(jFrame);
  const jScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(28, 10),
    new THREE.MeshBasicMaterial({ map: makeJumbotronTexture() }) // self-lit
  );
  jScreen.position.z = 0.55;
  jumbo.add(jScreen);
  const jLegMat = new THREE.MeshLambertMaterial({ color: 0x30384a });
  for (const lx of [-9, 9]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 7, 8), jLegMat);
    leg.position.set(lx, -8, -0.4);
    jumbo.add(leg);
  }
  jumbo.position.set(-64, 33, -50);
  jumbo.rotation.y = Math.atan2(64, 50); // angled back at the middle
  jumbo.rotation.x = 0.1; // faces down at the pitch
  detailGroup.add(jumbo);

  // --- floodlight towers at the four corners ------------------------------
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x8a929e });
  const headMat = new THREE.MeshLambertMaterial({ color: 0x3a4148 });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xf0f7ff }); // self-lit
  const towerH = PITCH_HALF_WID * 1.15;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * (GROUND_LEN - 4);
      const pz = sz * (GROUND_WID - 4);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.75, towerH, 10),
        poleMat
      );
      pole.position.set(px, towerH / 2, pz);
      detailGroup.add(pole);
      const head = new THREE.Group();
      head.position.set(px, towerH, pz);
      head.rotation.order = 'YXZ';
      head.rotation.y = Math.atan2(-px, -pz); // aimed at center court
      head.rotation.x = 0.45;
      const back = new THREE.Mesh(new THREE.BoxGeometry(6.6, 4.4, 0.7), headMat);
      head.add(back);
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.8), lampMat);
      lamp.position.z = 0.4;
      head.add(lamp);
      detailGroup.add(head);
    }
  }

  // --- dugouts: the two benches in the technical area, on the CAMERA side of
  // the pitch, where television actually sees them ------------------------
  const benchSeatMat = new THREE.MeshLambertMaterial({ color: 0x2e6cb0 });
  const benchLegMat = new THREE.MeshLambertMaterial({ color: 0x9aa4b0 });
  const towelMat = new THREE.MeshLambertMaterial({ color: 0xf6f6f2 });
  for (const bz of [-14, 14]) {
    const bench = new THREE.Group();
    const seatB = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 6), benchSeatMat);
    seatB.position.y = 1.5;
    seatB.castShadow = true;
    bench.add(seatB);
    const backB = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.2, 6), benchSeatMat);
    backB.position.set(0.85, 2.2, 0);
    backB.castShadow = true;
    bench.add(backB);
    for (const lz of [-2.4, 2.4]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.35, 0.3), benchLegMat);
      leg.position.set(0, 0.68, lz);
      bench.add(leg);
    }
    const towel = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.1, 1.5), towelMat);
    towel.position.set(0, 1.7, bz > 0 ? -1.6 : 1.6);
    bench.add(towel);
    // the bench is modelled long along its local z with its back at local +x,
    // so a quarter turn lays it along the touchline facing the pitch
    bench.position.set(bz * 2.2, 0, PITCH_HALF_WID + 4);
    bench.rotation.y = -Math.PI / 2;
    detailGroup.add(bench);
  }

}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// The scene is framed for a 4:3 window with a ~46° vertical FOV. Narrower
// frames (portrait phones fill the whole screen) keep the same HORIZONTAL
// FOV — the full court width stays in view and the extra height shows
// stands above / foreground court below instead of cropping the sides.
const BASE_ASPECT = 4 / 3;

function fovForAspect(baseFov: number): number {
  if (camera.aspect >= BASE_ASPECT) return baseFov;
  const halfH = Math.tan(THREE.MathUtils.degToRad(baseFov / 2)) * BASE_ASPECT;
  return THREE.MathUtils.radToDeg(Math.atan(halfH / camera.aspect)) * 2;
}

// Match the drawing buffer to the canvas's on-screen size (the stage is
// 4:3 on desktop but fills the viewport on portrait phones), scaled by the
// resolution option — the browser stretches whatever we draw back over the
// same CSS box, so a smaller buffer is a straight fill-rate saving.
function resizeToDisplay(canvas: HTMLCanvasElement) {
  if (!sizeObserver) {
    // no ResizeObserver support: fall back to per-frame layout reads
    cssW = canvas.clientWidth;
    cssH = canvas.clientHeight;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * gfx.resolution;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

export function initRenderer(canvas: HTMLCanvasElement) {
  hostCanvas = canvas;
  observeCanvasSize();
  buildScene();
  onGraphicsChange(applyGraphics);
}

function buildScene() {
  renderer = new THREE.WebGLRenderer({
    canvas: hostCanvas,
    antialias: gfx.antialias,
    stencil: false, // nothing uses the stencil buffer — skip allocating it
    // Nothing here ever reads the canvas back, and preserving the drawing
    // buffer costs a full-frame copy on some drivers.
    preserveDrawingBuffer: false,
  });

  scene3 = new THREE.Scene();
  scene3.background = makeSkyTexture();
  // Side-on the far stand is only ~130 units off, so the haze has to start
  // inside the pitch to read at all.
  scene3.fog = new THREE.Fog(0xdce8f2, 90, 260);

  // resizeToDisplay corrects this on the first frame; the fallback only
  // covers a canvas that has not been laid out yet.
  const aspect =
    hostCanvas.clientHeight > 0 ? hostCanvas.clientWidth / hostCanvas.clientHeight : BASE_ASPECT;
  camera = new THREE.PerspectiveCamera(CAM_FOV, aspect, 0.8, 700);
  camReady = false; // updateBroadcastCamera snaps onto the play on frame one

  sun = new THREE.DirectionalLight(0xfff2df, 2.2); // late-afternoon warmth
  // over the FAR touchline: players are rim-lit and their shadows fall
  // toward the camera, which is what reads as depth side-on
  sun.position.set(-30, 70, -55);
  // the box is in light space, and the pitch is long: ±100 along, ±60 across
  sun.shadow.camera.left = -100;
  sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.camera.far = 320;
  scene3.add(sun);
  scene3.add(new THREE.HemisphereLight(0xcfe4ff, 0x3a6b32, 1.0));

  buildEnvironment();
  initParticles();

  // Ten rigs, one per seat: slots 0-4 are side 0, slots 5-9 side 1, and the
  // last seat of each (KEEPER_RIG_SEAT in config.ts) is that side's keeper.
  playerRigs = Array.from({ length: RIG_COUNT }, (_, i) =>
    makePlayerRig(Math.floor(i / SQUAD_SIZE))
  );
  playerRigs.forEach((rig, i) => {
    rig.root.visible = false;
    rig.runSeed = i * 2.7; // desync the teammates' idle/run cycles
    rig.runPhase = i * 2.7;
  });

  ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS, 20, 16),
    new THREE.MeshLambertMaterial({ map: makeBallTexture(), color: COLORS.ball })
  );
  ballMesh.castShadow = true;
  ballMesh.visible = false;
  scene3.add(ballMesh);

  ballBlob = new THREE.Mesh(
    new THREE.CircleGeometry(BALL_RADIUS + 0.05, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 })
  );
  ballBlob.rotation.x = -Math.PI / 2;
  ballBlob.visible = false;
  scene3.add(ballBlob);

  // Side-on, height is the one thing perspective hides: a ball six units up
  // and a ball on the deck project to nearly the same place. A hairline from
  // the ball down to its blob is what makes a chip read as a chip.
  ballDrop = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 })
  );
  ballDrop.visible = false;
  ballDrop.frustumCulled = false;
  scene3.add(ballDrop);

  for (let i = 0; i < 7; i++) {
    const t = new THREE.Mesh(
      new THREE.SphereGeometry(0.42 - i * 0.04, 8, 6),
      new THREE.MeshBasicMaterial({ color: COLORS.ball, transparent: true, opacity: 0.22 * (1 - i / 7) })
    );
    t.visible = false;
    scene3.add(t);
    trailMeshes.push(t);
  }

  // Super-finisher props. The point light stays in the scene permanently at
  // intensity 0 — adding/removing a light recompiles every material, which
  // would hitch exactly at the most dramatic moment.
  ballLight = new THREE.PointLight(0xff7722, 0, 34, 1.9);
  scene3.add(ballLight);
  shockStart = -1;
  shockMesh = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 1, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffa030, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    })
  );
  shockMesh.rotation.x = -Math.PI / 2;
  shockMesh.visible = false;
  scene3.add(shockMesh);

  // Control markers. Each ring carries its own material because they run at
  // different colors and opacities in the same frame; the geometry is small
  // enough that sharing it would only complicate disposal.
  const mkRing = (opacity: number) => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.78, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
      })
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene3.add(m);
    return m;
  };
  focusRing = mkRing(0.8);
  ghostRing = mkRing(0.5);
  pilotRings = Array.from({ length: RIG_COUNT }, () => mkRing(0.28));
  focusChevron = new THREE.Mesh(
    new THREE.ConeGeometry(0.52, 0.9, 4),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false })
  );
  focusChevron.rotation.set(Math.PI, Math.PI / 4, 0); // point down, corner-on
  focusChevron.visible = false;
  scene3.add(focusChevron);
  markerFocusSlot = -1;
  markerGhostSlot = -1;

  applyResolution();
  applyShadows();
  applyGrade();
}

// ---------------------------------------------------------------------------
// Graphics options
// ---------------------------------------------------------------------------
// Shadow-map and tone-mapping state is compiled into every shader, so those
// two switches need the whole scene's materials rebuilt.
function markMaterialsDirty() {
  scene3.traverse(obj => {
    const mat = (obj as THREE.Mesh).material;
    if (!mat) return;
    if (Array.isArray(mat)) for (const m of mat) m.needsUpdate = true;
    else mat.needsUpdate = true;
  });
}

// Render at a fraction of the canvas and let the browser scale it up: the
// cheapest big win there is, since the whole frame is fill-rate bound.
function applyResolution() {
  resizeToDisplay(hostCanvas); // takes effect now rather than on the next frame
}

function applyShadows() {
  const on = gfx.shadows > 0;
  renderer.shadowMap.enabled = on;
  renderer.shadowMap.type = gfx.shadows >= 2 ? THREE.PCFShadowMap : THREE.BasicShadowMap;
  sun.castShadow = on;
  const size = gfx.shadows >= 2 ? 2048 : 1024;
  if (!on || sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    sun.shadow.map?.dispose(); // hand the render target back — or re-make it
    sun.shadow.map = null;     // at the new size on the next shadow pass
  }
  renderer.shadowMap.needsUpdate = true;
  markMaterialsDirty();
}

function applyGrade() {
  renderer.domElement.style.filter = gfx.grade ? BASE_FILTER : '';
  renderer.toneMapping = gfx.grade ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.05;
  markMaterialsDirty();
}

function applyGraphics(next: GraphicsSettings, prev: GraphicsSettings) {
  gfx = next;
  if (next.antialias !== prev.antialias) {
    rebuildScene(); // MSAA is fixed when the WebGL context is created
    return;
  }
  if (next.resolution !== prev.resolution) applyResolution();
  if (next.shadows !== prev.shadows) applyShadows();
  if (next.grade !== prev.grade) applyGrade();
  if (next.detail !== prev.detail) {
    detailGroup.visible = next.detail;
    const court = currentCourt;
    currentCourt = -1; // re-bake the surface at the new detail level
    if (court >= 0) setCourt(court);
  }
  if (next.particles) {
    initParticles(); // no-op unless the pool was skipped at build time
  } else {
    for (const p of particles) {
      p.life = 0;
      p.mesh.visible = false;
    }
  }
  if (!next.trail) {
    trailHistory.length = 0;
    for (const t of trailMeshes) t.visible = false;
  }
}

// A context's attributes are fixed for the life of its canvas, so switching
// MSAA means a new canvas: swap the element, drop the old context, rebuild.
function rebuildScene() {
  const old = renderer;
  disposeScene();
  const next = hostCanvas.cloneNode(false) as HTMLCanvasElement; // keeps id/class
  hostCanvas.replaceWith(next);
  hostCanvas = next;
  observeCanvasSize();
  old.dispose();
  old.forceContextLoss();
  particles.length = 0;
  trailMeshes.length = 0;
  trailHistory.length = 0;
  playerRigs = [];
  currentCourt = -1;
  buildScene();
}

function disposeScene() {
  scene3.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      (m as THREE.MeshLambertMaterial).map?.dispose();
      m.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Broadcast camera: a rail along the near touchline
// ---------------------------------------------------------------------------
// Football is watched side-on from a gantry above the main stand. The body
// TRUCKS along the touchline more slowly than the head PANS, and the boom
// dollies in and out to hold the play in shot. Every distance here is a
// fraction of the pitch, so changing the geometry constants carries the whole
// framing with it.
const CAM_ELEV = THREE.MathUtils.degToRad(26);
const CAM_SIN = Math.sin(CAM_ELEV);
const CAM_COS = Math.cos(CAM_ELEV);
// Football is shot on a LONG LENS from well back, not a wide lens from the
// touchline, and the difference is not cosmetic. A close wide camera cannot
// aim at the far side of the pitch without the gantry ending up standing on
// it, so the aim stays pinned near its own touchline and the play piles into
// the top of the frame with half the screen empty grass. Backing off and
// zooming in fixes the geometry AND the look: bodies read bigger, the
// perspective flattens the way television does, and the aim is free to
// follow the play right across the width.
const CAM_FOV = 19;
const K_TRUCK = 0.72; // body pans slower than head: 1.0 would be a turntable
// How far the ball may drift from the aim before the camera moves at all.
const CAM_DEADZONE = 6;
const S_LIMIT = PITCH_HALF_LEN * 0.65; // the rail stops short of the goal ends
// Boom length. These were set so the whole width of the pitch stayed in
// shot, which on a 68-unit pitch put a footballer at about 8% of frame
// height — too small to read a body shape, a kit or a run. Football is shot
// tight enough to see who has it; the camera follows play across the width
// instead of trying to hold both touchlines.
// With a 19° lens the visible height at the aim is 2·R·tan(9.5°), so these
// are chosen from what a player has to be able to SEE, not from how the rig
// looks: the floor still shows ~36 units of pitch (enough to pick a pass),
// the default ~42, and the ceiling ~64 when play stretches.
const R_DEFAULT = PITCH_HALF_LEN * 1.9;
const R_MIN = PITCH_HALF_LEN * 1.63;
const R_MAX = PITCH_HALF_LEN * 2.9;
// How far outside the touchline the camera itself stands. The aim may travel
// across the pitch, but the gantry may never end up ON it.
const RAIL_MARGIN = 8;
// Base offset of the aim toward the camera's own touchline — a broadcast
// frame sits a little on the near side of the ball, not dead on it.
const CAM_AIM_W = PITCH_HALF_WID * 0.18;
const CAM_AIM_Y = 1.6;
// Past this the aim did not move, it TELEPORTED (a restart spot the far side
// of the pitch, the cut back from a replay). Easing across it would sweep the
// whole ground, so snap.
const SNAP_DIST = 22;
// SHOOT_RANGE in spacetimedb/src/index.ts. The module re-aims a forward kick
// at the goal mouth inside this radius, so the mouth has to be on screen for
// as long as that assist is armed — otherwise you cannot see what you are
// shooting at. Not in config.ts; keep the two in step by hand.
const SHOOT_RANGE = 34;
const PAD_H = 8; // world units of margin outside the outermost interest point
const PAD_V = 6; // ... vertically, which also has to cover a standing body
const GOAL_PUNCH_MS = 700;

let camS = 0; // where the body stands on the rail (three-x)
let aimS = 0; // where the head is pointed, along the pitch
let aimW = CAM_AIM_W; // ... and across it
let camR = R_DEFAULT; // boom length
let camReady = false; // first live frame snaps rather than sweeping in from 0
let goalPunchAt = -1;
let prevCamPhase = -1;

// At most eight points must be in shot; the array is reused so a 60 Hz
// camera allocates nothing.
const INTEREST_MAX = 8;
const interest: THREE.Vector3[] = Array.from(
  { length: INTEREST_MAX },
  () => new THREE.Vector3()
);
let interestN = 0;
const pushInterest = (x: number, y: number, z: number) => {
  if (interestN < INTEREST_MAX) interest[interestN++].set(x, y, z);
};
const _camF = new THREE.Vector3();
const _camRt = new THREE.Vector3();
const _camU = new THREE.Vector3();
const _camAim = new THREE.Vector3();
const _camEye = new THREE.Vector3();
const _camD = new THREE.Vector3();

// Shake is applied AFTER lookAt, as a LOCAL rotation. Displacing the eye and
// the look-at target together — what this used to do — mostly cancels into a
// dolly, which is why goals felt soft; on a tracking camera it would also
// feed straight back into the smoothing.
function applyShake(now: number) {
  if (shakeAmp < 0.005) return;
  const s1 = (Math.sin(now * 0.081) + Math.sin(now * 0.023)) * 0.5 * shakeAmp;
  const s2 = (Math.sin(now * 0.097 + 2) + Math.sin(now * 0.031 + 1)) * 0.5 * shakeAmp;
  camera.rotateX(s2 * 0.018);
  camera.rotateY(s1 * 0.018);
  camera.rotateZ(s1 * 0.01);
}

function updateBroadcastCamera(scene: Scene, dt: number, now: number) {
  const { flip, ball } = scene;

  // --- REPLAY: low and behind the goal that was attacked. Cutting from the
  // side rail to a near-ground goal-end shot is a real edit, and it is what
  // sells the goal — a replay on the live rig is the same shot again. ------
  if (scene.replayCam) {
    const fov = fovForAspect(40);
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    const sgn = ball && ball.y * flip < 0 ? -1 : 1;
    camera.position.set(sgn * (PITCH_HALF_LEN + 16), 7.5, 13);
    const bt = ball ? toThree(flip, ball.x, ball.y, Math.min(ball.z, 12)) : null;
    if (bt) {
      if (!replayLook) replayLook = bt.clone();
      else replayLook.lerp(bt, 1 - Math.exp(-6 * dt));
    } else if (!replayLook) {
      replayLook = new THREE.Vector3(0, 2.5, 0);
    }
    camera.lookAt(replayLook);
    camera.updateMatrixWorld();
    camReady = false; // the cut back to live snaps; it does not sweep
    // prevCamPhase is deliberately NOT touched here: replay frames are
    // recorded LIVE ones, and letting them rewrite it would re-arm the goal
    // punch the moment we cut back to the (still paused) live camera.
    return;
  }
  replayLook = null;

  const fovV = fovForAspect(CAM_FOV);
  if (Math.abs(camera.fov - fovV) > 0.05) {
    camera.fov = fovV;
    camera.updateProjectionMatrix();
  }

  // The play, in camera coordinates: s along the pitch, w across it. A
  // stoppage DEACTIVATES the ball, so with no ball to watch fall back to
  // where the bodies are — swinging back to the halfway line every time play
  // stops would be motion sickness, not television.
  let bs = 0;
  let bw = 0;
  if (ball) {
    bs = ball.y * flip;
    bw = ball.x * flip;
  } else if (scene.players.length) {
    for (const pl of scene.players) {
      bs += pl.y * flip;
      bw += pl.x * flip;
    }
    bs /= scene.players.length;
    bw /= scene.players.length;
  } else {
    bs = aimS; // an empty pitch (the pitch-select preview): hold
  }

  // Look-ahead comes from POSSESSION, not velocity. The ball sticks to its
  // owner and is knocked ahead of his run, so a dribbled ball's velocity
  // snaps between stride and knock-on every few ticks — leading on it would
  // jitter the entire frame at 30 Hz. In possession, lead a fixed distance
  // the way the carrier is attacking instead.
  const leadS = !ball
    ? 0
    : ball.hasOwner
      ? 6 * attackDir(ball.ownerSide ?? 0, flip)
      : THREE.MathUtils.clamp(ball.vy * flip * 0.3, -11, 11);

  // --- state ---------------------------------------------------------------
  // A goal is the frame the phase flips to PAUSE for a kick-off restart.
  if (
    scene.phase === PHASE_PAUSE &&
    prevCamPhase !== PHASE_PAUSE &&
    scene.restartKind === RK_KICKOFF
  ) {
    goalPunchAt = now;
  }
  prevCamPhase = scene.phase;
  const punch = goalPunchAt >= 0 && now - goalPunchAt < GOAL_PUNCH_MS;
  if (!punch) goalPunchAt = -1;
  const restart = !punch && scene.phase !== PHASE_LIVE;
  const spectating = scene.focusSlot === undefined;

  let tgtS = bs + (restart ? 0 : leadS);
  let tgtW = bw;
  if (punch) {
    // the scorer, not the ball: the ball is already in the back of the net
    const sc =
      scene.strikerRigSlot === undefined
        ? undefined
        : scene.players.find(p => (p.rigSlot ?? p.side * SQUAD_SIZE) === scene.strikerRigSlot);
    if (sc) {
      tgtS = sc.y * flip;
      tgtW = sc.x * flip;
    }
  } else if (spectating) {
    // nobody to follow through a goalless spell: drift, so 0-0 is not a
    // frozen frame
    tgtS += Math.sin(now / 4200) * 3;
  }

  // --- ease, or snap when the aim jumped -----------------------------------
  // Only a real ball can teleport: with none to watch the target is a slow
  // centroid, and cutting to it would turn every stoppage into an edit.
  const jump = !camReady || (!!ball && Math.abs(tgtS - aimS) > SNAP_DIST);
  if (jump) {
    aimS = tgtS;
  } else {
    // 2-unit deadzone: a ball shuffling at someone's feet must not drag the
    // whole ground with it
    // A wide deadzone plus a slow gain is what makes this read as a camera
    // operator rather than a servo bolted to the ball: small touches near the
    // aim move nothing at all, and real travel is followed gently.
    const d = tgtS - aimS;
    if (Math.abs(d) > CAM_DEADZONE) {
      const want = tgtS - Math.sign(d) * CAM_DEADZONE;
      aimS += (want - aimS) * (1 - Math.exp(-3.2 * dt));
    }
  }
  // The aim FOLLOWS THE PLAY across the pitch. This used to be pinned near
  // the camera's own touchline by a rule that kept that line inside the
  // bottom edge at any boom — a tennis instinct, where the whole court fits.
  // On a 68-unit pitch it meant that with play on the far side the camera was
  // aimed thirty units away from it, and every body piled up against the top
  // of the frame with half the screen empty grass.
  //
  // The one thing that genuinely constrains the aim is the gantry: the eye
  // sits at aimW + camR·cos(elev), so pushing the aim too far across would
  // stand the camera on the pitch. Solve for that and nothing else — and note
  // it is self-correcting, because a play the floor will not reach widens the
  // boom, which lowers the floor.
  const railFloor = PITCH_HALF_WID + RAIL_MARGIN - camR * CAM_COS;
  const wantW = Math.max(
    railFloor,
    CAM_AIM_W + THREE.MathUtils.clamp(tgtW * 0.8, -22, 12)
  );
  aimW = jump ? wantW : aimW + (wantW - aimW) * (1 - Math.exp(-3 * dt));
  const truck = THREE.MathUtils.clamp(K_TRUCK * aimS, -S_LIMIT, S_LIMIT);
  camS = jump ? truck : camS + (truck - camS) * (1 - Math.exp(-1.8 * dt));
  camReady = true;

  // --- the points that must be in shot -------------------------------------
  interestN = 0;
  pushInterest(aimS, CAM_AIM_Y, aimW);
  if (ball) pushInterest(bs, Math.min(ball.z, 14), bw);
  if (ball) {
    const gsn = bs >= 0 ? 1 : -1;
    const toGoal = Math.hypot(gsn * PITCH_HALF_LEN - bs, bw);
    const goalward =
      ball.vy * flip * gsn > 1 ||
      (ball.hasOwner && attackDir(ball.ownerSide ?? 0, flip) === gsn);
    // A corner is framed with the flag (which is where the ball sits) AND the
    // near post, so you can read the delivery.
    if (restart && scene.restartKind === RK_CORNER) {
      pushInterest(gsn * PITCH_HALF_LEN, GOAL_HEIGHT * 0.6, Math.sign(bw || 1) * GOAL_HALF_W);
    } else if (toGoal < SHOOT_RANGE && goalward) {
      pushInterest(gsn * PITCH_HALF_LEN, GOAL_HEIGHT * 0.6, GOAL_HALF_W);
      pushInterest(gsn * PITCH_HALF_LEN, GOAL_HEIGHT * 0.6, -GOAL_HALF_W);
    }
  }
  const focus =
    scene.focusSlot === undefined
      ? undefined
      : scene.players.find(p => (p.rigSlot ?? p.side * SQUAD_SIZE) === scene.focusSlot);
  if (focus) pushInterest(focus.y * flip, 3, focus.x * flip);
  if (ball) {
    for (const pl of scene.players) {
      if (pl === focus || pl.role === ROLE_KEEPER) continue;
      // only the bodies actually involved: at 30 units this was most of the
      // pitch, and holding all of them in shot is what forced the long boom
      if (Math.hypot(pl.x - ball.x, pl.y - ball.y) > 22) continue;
      pushInterest(pl.y * flip, 3, pl.x * flip);
    }
  }

  // --- dolly to fit (constant FOV, moving boom, so perspective and horizon
  // stay put and fovForAspect keeps its one job) ---------------------------
  _camAim.set(aimS, CAM_AIM_Y, aimW);
  _camEye.set(camS, CAM_AIM_Y + camR * CAM_SIN, aimW + camR * CAM_COS);
  _camF.copy(_camAim).sub(_camEye).normalize();
  _camRt.copy(_camF).cross(_UP).normalize();
  _camU.copy(_camRt).cross(_camF);
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovV / 2));
  const tanH = tanV * camera.aspect;
  let rNeed = R_MIN;
  for (let i = 0; i < interestN; i++) {
    _camD.copy(interest[i]).sub(_camAim);
    const a = Math.abs(_camD.dot(_camRt));
    const b = Math.abs(_camD.dot(_camU));
    // depth relative to the aim: a point BEYOND it sits in a wider slice of
    // the frustum and needs less boom, one this side of it needs more. That
    // term is what makes a near-touchline body actually fit rather than clip.
    const c = _camD.dot(_camF);
    const need = Math.max((a + PAD_H) / tanH, (b + PAD_V) / tanV) - c;
    if (need > rNeed) rNeed = need;
  }
  // On the goal line the mouth is the thing worth seeing: push in.
  const boxIn = THREE.MathUtils.clamp(
    (Math.abs(aimS) - (PITCH_HALF_LEN - BOX_DEPTH)) / BOX_DEPTH,
    0,
    1
  );
  rNeed *= 1 - 0.14 * boxIn;
  if (restart) rNeed = Math.max(rNeed, R_DEFAULT * 1.12); // a restart is read wide
  if (punch) rNeed *= 0.72;
  rNeed = THREE.MathUtils.clamp(rNeed, R_MIN, R_MAX);
  // Widen FAST so the play is never lost, tighten SLOWLY so the frame does
  // not pump on a dribble. The asymmetry is the whole trick.
  // Widen fast enough not to lose the play, tighten slowly so the frame does
  // not pump. Both rates are gentler than they were: at 5.5/2.2 the boom was
  // visibly breathing on every dribble.
  const rk = punch ? 9 : rNeed > camR ? 3.2 : 1.1;
  camR = jump ? rNeed : camR + (rNeed - camR) * (1 - Math.exp(-rk * dt));

  camera.position.set(camS, CAM_AIM_Y + camR * CAM_SIN, aimW + camR * CAM_COS);
  camera.lookAt(aimS, CAM_AIM_Y, aimW);
  // Portrait: the widened frame would spend the extra height on sky, so pitch
  // down through part of the gained angle and let the foreground (where the
  // touch controls sit) take the slack.
  if (fovV > CAM_FOV) {
    camera.rotateX(-THREE.MathUtils.degToRad((fovV - CAM_FOV) * 0.14));
  }
  applyShake(now);
  // Nameplates and emote bubbles project through this matrix, and the render
  // below is skipped on a hidden tab — without this they would stay pinned to
  // a stale one.
  camera.updateMatrixWorld();
}

// ---------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------
let prevLastTouchSide = -1;
let prevBallSpeed = 0;
let prevBallActive = false;
let prevBallVz = 0;
let prevPhase = -1;
let bouncesSinceHit = 0; // only the FIRST bounce of a shot can be a line call
let lastFrame = 0;

// ---------------------------------------------------------------------------
// Control markers
// ---------------------------------------------------------------------------
// Ten bodies and one stick: with nothing under your feet you cannot tell
// which pair of boots you are driving, and a switch looks like the button did
// nothing. So a ring in the team's color under the body you hold, a chevron
// over its head, a ring that fades on the body you just left so the eye
// follows the handoff, and a dimmer ring on any body ANOTHER human holds —
// the server will never hand those over, and unmarked they read as switch
// targets that silently refuse.
// Every mesh here is built once by buildScene and only ever toggled and
// re-colored: the markers move every frame, so allocating would cost a mesh
// a frame for a whole half.
const FOCUS_POP_MS = 200;
const GHOST_FADE_MS = 250;
let markerFocusSlot = -1; // the slot the ring is on — a change is the handoff
let markerFocusAt = -1;
let markerGhostSlot = -1;
let markerGhostAt = -1;

function markerRig(slot: number | undefined): PlayerRig | null {
  if (slot === undefined || slot < 0 || slot >= playerRigs.length) return null;
  const rig = playerRigs[slot];
  return rig && rig.root.visible ? rig : null;
}

// A marker is the TEAM's color, keeper or not — it answers "which of these
// are mine", not "what is this man's job". Dressing the rig already recorded
// its side, so this needs no second pass over the roster.
function markerColor(rig: PlayerRig): number {
  return (KITS[rig.kitSide] ?? KITS[0]).marker;
}

function placeRing(ring: THREE.Mesh, rig: PlayerRig, y: number, color: number, opacity: number, scale: number) {
  ring.visible = true;
  ring.position.set(rig.root.position.x, y, rig.root.position.z);
  ring.scale.set(scale, scale, scale);
  const mat = ring.material as THREE.MeshBasicMaterial;
  mat.color.setHex(color);
  mat.opacity = opacity;
}

function updateControlMarkers(scene: Scene, now: number) {
  focusRing.visible = false;
  focusChevron.visible = false;
  ghostRing.visible = false;
  for (const r of pilotRings) r.visible = false;
  // Both slot lists are optional and may arrive empty for a whole match
  // (spectating, a client that never sends them) — absent means no marker,
  // never a marker on slot 0.

  // other humans' bodies, dim
  let used = 0;
  for (const slot of scene.otherPilotSlots ?? []) {
    if (used >= pilotRings.length || slot === scene.focusSlot) continue;
    const rig = markerRig(slot);
    if (!rig) continue;
    placeRing(pilotRings[used++], rig, 0.05, markerColor(rig), 0.42, 0.95);
  }

  // the body just handed over: fade from the moment the value CHANGED, so a
  // client that holds the slot for longer than the fade still gets 250 ms
  const ghost = scene.ghostSlot ?? -1;
  if (ghost !== markerGhostSlot) {
    markerGhostSlot = ghost;
    markerGhostAt = now;
  }
  const ghostRigNow = markerRig(scene.ghostSlot);
  const ghostT = (now - markerGhostAt) / GHOST_FADE_MS;
  if (ghostRigNow && ghostT < 1) {
    // it lets go outward as it dies, which is what makes it read as a wake
    placeRing(ghostRing, ghostRigNow, 0.06, markerColor(ghostRigNow), 0.55 * (1 - ghostT), 1 + 0.45 * ghostT);
  }

  // the body this client is driving
  const focusSlot = scene.focusSlot ?? -1;
  if (focusSlot !== markerFocusSlot) {
    markerFocusSlot = focusSlot;
    markerFocusAt = now;
  }
  const focus = markerRig(scene.focusSlot);
  if (!focus) return;
  const col = markerColor(focus);
  // the pop: the ring lands oversized and snaps in over FOCUS_POP_MS, which
  // is what makes a switch between two identical shirts visible at all
  const pop = 1 - Math.min(1, Math.max(0, (now - markerFocusAt) / FOCUS_POP_MS));
  const eased = pop * pop;
  placeRing(
    focusRing, focus, 0.07, col,
    Math.min(1, 0.72 + 0.1 * Math.sin(now / 320) + 0.28 * eased),
    1 + 0.55 * eased
  );
  // The chevron rides the CROWN, and physique moves that: long legs lift the
  // whole body, so read the height off the rig rather than assuming one.
  focusChevron.visible = true;
  focusChevron.position.set(
    focus.root.position.x,
    focus.root.position.y + focus.upper.position.y + 3.5 + Math.sin(now / 340) * 0.12,
    focus.root.position.z
  );
  focusChevron.scale.setScalar(1 + 0.45 * eased);
  const cm = focusChevron.material as THREE.MeshBasicMaterial;
  cm.color.setHex(col);
}

export function drawScene(scene: Scene) {
  if (!renderer) return;
  resizeToDisplay(renderer.domElement);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;

  const { flip, ball } = scene;
  setCourt(scene.pitch);
  animateCrowd(now);

  // --- detect kick + bounce events (animations, VFX, SFX) -------------------
  const ballPos3 = ball ? toThree(flip, ball.x, ball.y, ball.z) : null;
  if (ball && ballPos3) {
    const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
    const power = THREE.MathUtils.clamp((speed - 18) / 46, 0.1, 1);
    // A kick is the moment a settled ball is suddenly moving fast, or the
    // moment the last touch changes sides — the server writes both on the
    // tick it strikes, so the boot meets the ball on screen.
    const struck =
      speed > 16 && (prevBallSpeed < 8 || ball.lastTouchSide !== prevLastTouchSide);
    if (struck && prevLastTouchSide !== -1) {
      // the striker is the body the server says touched it last; falling
      // back to the closest one on that side for scenes built without it
      const striker =
        scene.strikerRigSlot !== undefined
          ? scene.players.find(p => (p.rigSlot ?? p.side * SQUAD_SIZE) === scene.strikerRigSlot)
          : scene.players
              .filter(p => p.side === ball.lastTouchSide)
              .sort(
                (a, b) =>
                  Math.hypot(ball.x - a.x, ball.y - a.y) -
                  Math.hypot(ball.x - b.x, ball.y - b.y)
              )[0];
      const rig = striker ? playerRigs[striker.rigSlot ?? striker.side * SQUAD_SIZE] : undefined;
      if (rig && striker) {
        const sliding = (striker.slideTicks ?? 0) > 0;
        const chip = ball.vz > 9; // lofted: a chip, a cross, or a keeper's punt
        const contactDist = Math.hypot(ball.x - striker.x, ball.y - striker.y);
        const stretch = !sliding && contactDist > CONTROL_RADIUS + 0.8;
        triggerKick(rig, chip ? 'chip' : 'drive', chip, now, stretch, power, true);
        // a slide keeps its own timeline; a standing kick locks onto the ball
        rig.contactPoint = sliding ? null : ballPos3.clone();
      }
      impactFX(ballPos3, power);
      bouncesSinceHit = 0;
    }
    prevLastTouchSide = ball.lastTouchSide;
    prevBallSpeed = speed;

    // bounce: the server flips vz upward when the ball meets the turf
    if (prevBallVz < -8 && ball.vz > 1 && ball.z < 2) {
      const dust = SURFACES[scene.pitch] ?? SURFACES[0];
      spawnBurst(
        new THREE.Vector3(ballPos3.x, 0.15, ballPos3.z),
        new THREE.Color(dust.inner).getHex(),
        8, 8, 0.85, -30
      );
      playBounce(panOf(ballPos3.x), BOUNCE_BRIGHT[scene.pitch] ?? 1);
      bouncesSinceHit++;
    }
    prevBallVz = ball.vz;
    // a shot that whistles just past the frame gets a gasp from the stands
    if (
      scene.phase === PHASE_LIVE &&
      Math.abs(ball.y) > PITCH_HALF_LEN - 6 &&
      Math.abs(ball.vy) > 20 &&
      Math.abs(Math.abs(ball.x) - GOAL_HALF_W) < 2.5 &&
      ball.z < GOAL_HEIGHT + 3
    ) {
      crowdOoh(0.5);
    }
    prevBallActive = true;
  } else {
    prevBallActive = false;
    prevLastTouchSide = -1;
    prevBallVz = 0;
    prevBallSpeed = 0;
  }
  // a goal: the pause phase arriving with the ball dead behind a goal line
  if (
    scene.phase !== prevPhase &&
    scene.phase === PHASE_PAUSE &&
    ball &&
    Math.abs(ball.y) > PITCH_HALF_LEN - 2 &&
    Math.abs(ball.x) < GOAL_HALF_W + 1
  ) {
    playGoal();
    addShake(2.2);
    if (ballPos3) {
      spawnBurst(ballPos3, 0xffffff, 22, 24, 0.9, -20);
      spawnBurst(ballPos3, 0xffd040, 26, 28, 0.85, -25);
    }
  }
  prevPhase = scene.phase;

  // --- players --------------------------------------------------------------
  for (let slot = 0; slot < playerRigs.length; slot++) {
    const rig = playerRigs[slot];
    // no rigSlot (an older recorded scene): fall back to seat 0 of the side
    const pl = scene.players.find(p => (p.rigSlot ?? p.side * SQUAD_SIZE) === slot);
    if (!pl) {
      rig.root.visible = false;
      continue;
    }
    const side = pl.side;
    rig.root.visible = true;
    const character = CHARACTERS[pl.characterId ?? 0];
    if (character) applyCharacter(rig, character, pl.role === ROLE_KEEPER, side);
    const pos = toThree(flip, pl.x, pl.y, 0);
    rig.root.position.x = pos.x;
    rig.root.position.z = pos.z;
    // stride phase advances with the ground actually covered this frame, so
    // the foot cycle stays anchored to the floor at any speed (teleports —
    // serve resets, camera flips — are ignored rather than spinning the legs)
    const stepDist = Math.hypot(pos.x - rig.prevPX, pos.z - rig.prevPZ);
    rig.prevPX = pos.x;
    rig.prevPZ = pos.z;
    const teleported = stepDist >= 6; // restart snap, camera flip — not a stride
    // Measured ground speed, smoothed: a 30 Hz row read at 60+ fps gives a
    // step distance that alternates between a full tick and nothing, and an
    // unsmoothed gait factor off that makes the legs flutter.
    if (!teleported && dt > 0) {
      const inst = stepDist / dt;
      rig.speed += (inst - rig.speed) * (1 - Math.exp(-8 * dt));
    }
    // Gait: 0 at a jog, 1 at a flat sprint. Anything under a walk is idle and
    // never reaches runPose at all.
    const gTarget = THREE.MathUtils.clamp(
      (rig.speed - GAIT_JOG_SPEED) / (GAIT_SPRINT_SPEED - GAIT_JOG_SPEED), 0, 1
    );
    rig.gait += (gTarget - rig.gait) * (1 - Math.exp(-6 * dt));
    // Stride cadence follows the gait's amplitude, so the foot still plants
    // where the ground is: a longer stride is fewer of them, not faster ones.
    if (!teleported) rig.runPhase += stepDist * strideRateFor(thighAmpFor(rig.gait));
    // Idle facing is UP THE PITCH, toward the goal this side attacks. (Keying
    // it off which half of the world you stand in — side-on, that is which
    // touchline you are nearer — spins an idle player 180° as he walks
    // across the pitch.)
    const baseYaw = (attackDir(side, flip) * Math.PI) / 2;

    // air-kick: the charge was released with nothing at the player's feet
    if (rig.prevKickTicks > 0 && !pl.kickHeld && rig.kickStart < 0) {
      triggerKick(rig, pl.kickKind === 1 ? 'chip' : 'drive', pl.kickKind === 1, now, false, 0.4);
      rig.contactPoint = null;
      playWhoosh(0.5);
    }
    if (rig.prevKickTicks === 0 && pl.kickTicks > 0) rig.windupStart = now;
    rig.prevKickTicks = pl.kickTicks;

    // Moving means actually covering ground. Keying it off the stick alone
    // ran a player on the spot whenever he was blocked, held at a restart, or
    // pinned on the touchline — legs going, world still.
    const moving = rig.speed > GAIT_IDLE_SPEED;
    const striking = pl.kickHeld || rig.kickStart >= 0;

    // facing priority: ball while striking > movement direction > face upfield.
    // A keeper is the exception at every step — he shuffles sideways along his
    // line and must never turn his back on the ball to do it.
    let yawTarget = baseYaw;
    let yawRate = 10;
    const keeper = pl.role === ROLE_KEEPER;
    if ((striking || keeper) && ballPos3) {
      yawTarget = Math.atan2(ballPos3.x - pos.x, ballPos3.z - pos.z);
      yawRate = striking ? 18 : 12;
    } else if (moving) {
      const mv = toThree(flip, pl.dirX, pl.dirY, 0);
      yawTarget = Math.atan2(mv.x, mv.z);
      // You turn your shoulders faster at a jog than at a flat sprint — at
      // speed the body has to come round with the feet, and that reluctance
      // is what a hard change of direction is supposed to cost.
      yawRate = 16 - 7 * rig.gait;
    } else if (ballPos3) {
      // standing still: turn to face the play, the way a footballer does
      yawTarget = Math.atan2(ballPos3.x - pos.x, ballPos3.z - pos.z);
      yawRate = 6;
    }
    // A hard reverse while actually running is a plant-and-turn, not a spin:
    // arm the pivot, which both slows the yaw for its duration and plays the
    // braced step over the top of the run.
    const yawErr = wrapAngle(yawTarget - rig.yaw);
    if (
      moving && !striking && !keeper &&
      Math.abs(yawErr) > 1.9 && rig.speed > GAIT_JOG_SPEED && now > rig.pivotUntil + PIVOT_MS
    ) {
      rig.pivotUntil = now + PIVOT_MS;
      rig.pivotDir = Math.sign(yawErr) || 1;
    }
    const pivotK = rig.pivotUntil > now ? 1 - (rig.pivotUntil - now) / PIVOT_MS : -1;
    if (pivotK >= 0) yawRate *= 0.55;
    rig.prevYaw = rig.yaw;
    rig.yaw = blendAngle(rig.yaw, yawTarget, yawRate, dt);
    // Bank into the turn like a cyclist: the lean comes from how fast the
    // body is actually coming round, scaled by how fast it is travelling.
    const yawRateNow = dt > 0 ? wrapAngle(rig.yaw - rig.prevYaw) / dt : 0;
    const bankTarget = THREE.MathUtils.clamp(
      -yawRateNow * 0.09 * THREE.MathUtils.clamp(rig.speed / GAIT_SPRINT_SPEED, 0, 1), -0.5, 0.5
    );
    rig.turnBank += (bankTarget - rig.turnBank) * (1 - Math.exp(-9 * dt));

    let target: Pose;
    let rate = 12;
    let swingT = -1;
    if (rig.kickStart >= 0) {
      const t = (now - rig.kickStart) / rig.kickMs;
      if (t >= 1) {
        rig.kickStart = -1;
        rig.contactPoint = null;
        target = moving
          ? runPose(rig.runPhase, rig.turnBank, rig.gait)
          : idlePose(pl, now, rig.runSeed);
      } else {
        swingT = t;
        target = kickPose(rig.kickAnim, t, rig.kickLow, rig.kickPower);
        rate = 30; // snap through the strike
      }
    } else if (pl.kickHeld) {
      // the backlift deepens the longer the button is held, so the charge
      // reads on the body from across the pitch
      const charge = Math.min(1, (now - rig.windupStart) / (KICK_CHARGE_MS));
      target = kickWindup(pl.kickKind === 1 ? 'chip' : 'drive', charge);
      rate = 22;
    } else if (moving) {
      target = runPose(rig.runPhase, rig.turnBank, rig.gait);
      // the faster you are going the less the body can be re-posed per
      // second: a sprint is committed, a jog is not
      rate = 20 - 6 * rig.gait;
      // a plant-and-turn is blended OVER the run rather than replacing it,
      // so the legs keep their cycle while the body braces round
      if (pivotK >= 0) {
        const pv = pivotPose(pivotK, rig.pivotDir);
        const w = Math.sin(Math.min(1, pivotK) * Math.PI) * 0.85;
        target = blendPose(target, pv, w);
        rate = 26;
      }
    } else {
      target = idlePose(pl, now, rig.runSeed);
    }

    // keep the feet running while a kick is only being CHARGED — the strike
    // itself owns the legs, so it is never overwritten here
    if (moving && rig.kickStart < 0 && pl.kickHeld) {
      const legs = runPose(rig.runPhase, rig.turnBank, rig.gait);
      target.thighL = legs.thighL;
      target.calfL = legs.calfL;
      target.thighR = legs.thighR;
      target.calfR = legs.calfR;
      target.crouch = Math.max(target.crouch, legs.crouch);
    }

    // DIVE bookkeeping. The server owns the travel (it moves the keeper along
    // his dive every tick); the client owns leaving the ground, which is the
    // half of it you can actually see.
    const diveT_ = pl.diveTicks ?? 0;
    if (diveT_ > 0 && rig.prevDive === 0) {
      rig.diveStart = now;
      const dvx = toThree(flip, pl.diveDirX ?? 0, pl.diveDirY ?? 0, 0);
      rig.diveDir = dvx.x >= 0 ? 1 : -1;
    }
    rig.prevDive = diveT_;
    let diveK = rig.diveStart >= 0 ? (now - rig.diveStart) / KEEPER_DIVE_MS : -1;
    if (diveK > 1) {
      rig.diveStart = -1;
      diveK = -1;
    }

    // slide bookkeeping: a fresh tackle starts the lunge timeline. The server
    // drives the body along its slide direction, so the heading comes from
    // where the player is actually travelling.
    if (pl.slideTicks > 0 && rig.prevSlide === 0) {
      rig.slideStart = now;
      rig.slideDir = 1;
      rig.slideKindAnim = 1;
      rig.slideMs = SLIDE_MS;
      const sv = toThree(flip, pl.serverX, pl.serverY, 0);
      const ddx = sv.x - rig.root.position.x;
      const ddz = sv.z - rig.root.position.z;
      rig.slideYaw =
        ddx * ddx + ddz * ddz > 0.05 ? Math.atan2(ddx, ddz) : rig.yaw;
      rig.slideFromX = rig.root.position.x;
      rig.slideFromZ = rig.root.position.z;
      rig.slideLanded = false;
      playSlide(panOf(rig.root.position.x));
    }
    rig.prevSlide = pl.slideTicks;
    let slideT = rig.slideStart >= 0 ? (now - rig.slideStart) / rig.slideMs : -1;
    if (slideT > 1) {
      rig.slideStart = -1;
      slideT = -1;
    }

    // stretching for a ball at the edge of reach: lean the whole body in
    if (rig.kickStretch && rig.kickStart >= 0 && slideT < 0) {
      target.leanS = -0.5;
      target.crouch = Math.max(target.crouch, 0.3);
    }

    // The server's slide is SLIDE_ACTIVE_AFTER ticks of lunge then a stun, so
    // the body is down for the first ~40% and scrambling up after.
    const landT = 0.12; // the hip hits the turf almost immediately
    const slideEndT = 0.6;
    if (slideT >= 0 && slideT < slideEndT) {
      target = slideFlightPose();
      rate = slideT < landT ? 26 : 12;
    } else if (slideT >= slideEndT) {
      // scrambling back to their feet
      target = slideRollPose(now, rig.runSeed, Math.max(0, 1 - (slideT - slideEndT) / 0.4));
      rate = 12;
    }
    if (diveK >= 0) {
      target = keeperDivePose(diveK, rig.diveDir);
      rate = 30; // a dive is explosive; it does not ease into the shape
    }
    applyPose(rig, target, rate, dt, rig.yaw, now);
    // OFF THE GROUND. Without this he plays a dive animation while sliding
    // along the turf on his feet, which reads as a bug rather than a save.
    if (diveK >= 0) {
      const air = Math.sin(clamp01(diveK) * Math.PI);
      rig.root.position.y = air * 1.5;
      rig.root.rotateZ(-rig.diveDir * air * 1.15);
    } else {
      rig.root.position.y = 0;
    }

    // slide root motion: turn along the lunge, go down on the hip, skid, then
    // pick yourself up. The server owns the travel (it moves the player every
    // tick of the lunge), so here we only tilt and drop the body.
    if (slideT >= 0) {
      const pitchMax = Math.PI / 2.15; // laid out along the ground
      const pitch = ch(slideT, [
        [0, 0], [landT, pitchMax], [slideEndT, pitchMax], [0.85, 0], [1, 0],
      ]);
      const height = ch(slideT, [
        [0, 0], [landT, 0.35], [slideEndT, 0.25], [0.85, 0.02], [1, 0],
      ]);
      if (slideT >= landT && !rig.slideLanded) {
        rig.slideLanded = true;
        const dust = SURFACES[scene.pitch] ?? SURFACES[0];
        spawnBurst(
          new THREE.Vector3(rig.root.position.x, 0.3, rig.root.position.z),
          new THREE.Color(dust.inner).getHex(),
          16, 12, 0.8, -35
        );
        addShake(0.3);
      }
      _dq1.setFromAxisAngle(_UP, rig.slideYaw);
      _dq2.setFromAxisAngle(_RIGHT, pitch);
      rig.root.quaternion.copy(_dq1).multiply(_dq2);
      rig.root.position.y = height;
    } else {
      rig.root.rotation.x = 0;
      rig.root.rotation.z = 0;
    }

    // Contact: a footballer's boot has to meet the ball, so through the strike
    // window the body steps in toward the frozen contact point (never the
    // departing ball) until the kicking foot can plausibly reach it.
    if (swingT >= 0.05 && swingT <= 0.55 && ball && ballPos3 && pl.slideTicks === 0) {
      const ikTarget = rig.contactPoint ?? toThree(flip, ball.x, ball.y, ball.z);
      const peak = 1 - Math.abs(swingT - 0.3) / 0.27;
      const w = THREE.MathUtils.clamp(peak, 0, 1);
      if (w > 0.02) {
        const dx = ikTarget.x - rig.root.position.x;
        const dz = ikTarget.z - rig.root.position.z;
        const hDist = Math.hypot(dx, dz);
        const over = Math.min(2.0, Math.max(0, hDist - 1.6));
        if (over > 0 && hDist > 0.01) {
          rig.root.position.x += (dx / hDist) * over * w;
          rig.root.position.z += (dz / hDist) * over * w;
        }
      }
    }

    // eyes on the ball: the head smoothly tracks it (not while tumbling)
    if (ballPos3 && slideT < 0) {
      const hy = wrapAngle(
        Math.atan2(ballPos3.x - rig.root.position.x, ballPos3.z - rig.root.position.z) - rig.yaw
      );
      const targetY = THREE.MathUtils.clamp(hy - rig.pose.twist, -0.8, 0.8);
      const horiz = Math.hypot(
        ballPos3.x - rig.root.position.x,
        ballPos3.z - rig.root.position.z
      );
      const targetX = THREE.MathUtils.clamp(
        -Math.atan2(ballPos3.y - 4.5, Math.max(1.5, horiz)),
        -0.45, 0.4
      );
      const ha = 1 - Math.exp(-10 * dt);
      rig.head.rotation.y += (targetY - rig.head.rotation.y) * ha;
      rig.head.rotation.x += (targetX - rig.head.rotation.x) * ha;
    } else {
      const ha = 1 - Math.exp(-6 * dt);
      rig.head.rotation.y -= rig.head.rotation.y * ha;
      rig.head.rotation.x -= rig.head.rotation.x * ha;
    }
  }

  // markers go on last: they follow the rig roots, which the loop above has
  // just finished moving (the strike step-in included)
  updateControlMarkers(scene, now);

  // --- ball: ALWAYS its true trajectory — we never manipulate the ball ------
  if (ball) {
    const bp = toThree(flip, ball.x, ball.y, ball.z);
    ballMesh.visible = true;
    ballMesh.position.copy(bp);
    const ballMat = ballMesh.material as THREE.MeshLambertMaterial;
    ballMat.color.setHex(COLORS.ball);
    if (gfx.trail) {
      for (let i = 0; i < trailMeshes.length; i++) {
        const tm = trailMeshes[i].material as THREE.MeshBasicMaterial;
        tm.color.setHex(COLORS.ball);
        // only a properly struck ball leaves a streak
        tm.opacity = 0.18 * (1 - i / 7);
        trailMeshes[i].scale.setScalar(1);
      }
    }
    ballLight.intensity = 0;
    // A football ROLLS: spin it about the axis perpendicular to its travel,
    // at the rate its own circumference demands, so the panels track the
    // ground instead of skating over it.
    const vel3 = new THREE.Vector3(ball.vy * flip, ball.vz, ball.vx * flip);
    const spd = vel3.length();
    ballMesh.scale.set(1, 1, 1);
    if (spd > 0.5) {
      const axis = new THREE.Vector3(0, 1, 0).cross(vel3).normalize();
      if (axis.lengthSq() > 0.001) {
        _dq3.setFromAxisAngle(axis, (spd / BALL_RADIUS) * dt);
        ballMesh.quaternion.premultiply(_dq3);
      }
      // a screamer stretches a touch along its flight for a sense of pace
      if (spd > 40) {
        const st = 1 + Math.min(0.3, (spd - 40) / 160);
        ballMesh.scale.set(1 / Math.sqrt(st), 1 / Math.sqrt(st), st);
      }
    }
    ballBlob.visible = true;
    ballBlob.position.set(bp.x, 0.02, bp.z);
    // a chip only clears head height, so the blob has to shrink over the
    // first few units of lift, not over thirty
    const sc = Math.max(0.45, 1 - ball.z / 8);
    ballBlob.scale.set(sc, sc, sc);
    ballDrop.visible = ball.z > 0.9;
    if (ballDrop.visible) {
      const pts = ballDrop.geometry.attributes.position as THREE.BufferAttribute;
      pts.setXYZ(0, bp.x, 0.03, bp.z);
      pts.setXYZ(1, bp.x, bp.y - BALL_RADIUS * 0.5, bp.z);
      pts.needsUpdate = true;
    }

    if (gfx.trail) {
      trailHistory.unshift(bp.clone());
      if (trailHistory.length > trailMeshes.length + 1) trailHistory.pop();
      for (let i = 0; i < trailMeshes.length; i++) {
        const h = trailHistory[i + 1];
        trailMeshes[i].visible = !!h;
        if (h) trailMeshes[i].position.copy(h);
      }
    }
  } else {
    ballMesh.visible = false;
    ballBlob.visible = false;
    ballDrop.visible = false;
    ballLight.intensity = 0;
    trailHistory.length = 0;
    for (const t of trailMeshes) t.visible = false;
  }

  // --- juice: particles + camera shake --------------------------------------
  updateParticles(dt);
  shakeAmp *= Math.exp(-dt * 5.5);
  if (shakeAmp < 0.005) shakeAmp = 0;

  // launch shockwave: a ring racing out across the court from the contact
  if (shockStart >= 0) {
    const st = (now - shockStart) / 480;
    if (st >= 1) {
      shockMesh.visible = false;
      shockStart = -1;
    } else {
      shockMesh.visible = true;
      shockMesh.position.set(shockPos.x, 0.06, shockPos.z);
      const ss = 1 + st * st * 22;
      shockMesh.scale.set(ss, ss, ss);
      (shockMesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - st);
    }
  }

  updateBroadcastCamera(scene, dt, now);

  // Hidden tabs still run the 250ms keep-alive loop for game/UI state (and
  // hit/bounce sounds above) — but painting a frame nobody sees is pure GPU
  // waste. The compositor keeps showing the last presented frame.
  if (!document.hidden) renderer.render(scene3, camera);
}

// The crowd lives on a slow two-frame flip: each stand swaps between the A/B
// spectator textures, offset by parity so neighbors alternate.
function animateCrowd(now: number) {
  if (!detailGroup?.visible || !crowdStands.length || !crowdMatA || !crowdMatB) return;
  const f = Math.floor(now / 480);
  for (const s of crowdStands) {
    const fr = (f + s.parity) & 1;
    if (fr !== s.cur) {
      s.cur = fr;
      s.mesh.material = fr ? crowdMatB : crowdMatA;
    }
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ---------------------------------------------------------------------------
// Character-select live previews: every card shows its character as a real
// animated 3D rig. One shared WebGL canvas is laid over the select screen
// and scissored into a viewport per card (18 separate canvases would blow
// through the browser's WebGL context limit); rects are re-read every frame
// so scrolling and hover transforms stay aligned, and every draw is
// scissored to the scroll panel so characters vanish at its edges. The loop
// self-throttles: while the select screen is hidden every slot rect is
// zero and the frame exits before touching the GPU.
// ---------------------------------------------------------------------------
interface PreviewSlot {
  scene: THREE.Scene;
  rig: PlayerRig;
  el: HTMLElement;
  seed: number;
}
let previewRenderer: THREE.WebGLRenderer | null = null;
let previewCam: THREE.PerspectiveCamera | null = null;
let previewSlots: PreviewSlot[] = [];
// scroll container the characters are clipped to — without it they would
// keep drawing above/below the panel once their card scrolls out of it
let previewClip: HTMLElement | null = null;

export function initCharacterPreviews(
  canvas: HTMLCanvasElement,
  slots: { char: Character; el: HTMLElement }[],
  clipEl: HTMLElement
) {
  previewClip = clipEl;
  previewRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  previewCam = new THREE.PerspectiveCamera(40, 1, 0.5, 60);
  previewSlots = slots.map(({ char, el }, i) => {
    const scene = new THREE.Scene();
    const rig = makePlayerRig(0, scene);
    applyCharacter(rig, char);
    const sun = new THREE.DirectionalLight(0xfff2df, 2.4);
    sun.position.set(-3, 6, 5);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x39406b, 1.15));
    return { scene, rig, el, seed: i * 1.73 };
  });
  requestAnimationFrame(previewFrame);
}

let previewDrew = false; // last frame put pixels on the canvas
let previewHadVisible = false;
let previewShownAt = 0; // when slots (re)appeared — drives the entrance fade

function previewFrame() {
  requestAnimationFrame(previewFrame);
  const now = performance.now();
  const r = previewRenderer!;
  const canvas = r.domElement;
  const canvasRect = canvas.getBoundingClientRect();
  const clip = previewClip!.getBoundingClientRect();

  // slots collapse to zero rects while the select screen is display:none —
  // one final clear wipes the canvas, then frames become no-ops
  const visible = previewSlots.filter(s => {
    const rect = s.el.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.right > clip.left && rect.left < clip.right &&
      rect.bottom > clip.top && rect.top < clip.bottom
    );
  });
  if (visible.length === 0 && !previewDrew) {
    previewHadVisible = false;
    return;
  }

  // the cards stagger in over ~0.7s when the screen (re)opens; fade the
  // canvas alongside them so the characters don't pop in over empty cards
  if (visible.length > 0 && !previewHadVisible) previewShownAt = now;
  previewHadVisible = visible.length > 0;
  canvas.style.opacity = Math.min(1, Math.max(0, (now - previewShownAt - 100) / 450)).toFixed(3);

  const cw = canvas.clientWidth;
  const chh = canvas.clientHeight;
  if (cw === 0 || chh === 0) return;
  if (canvas.width !== Math.floor(cw * r.getPixelRatio()) || canvas.height !== Math.floor(chh * r.getPixelRatio())) {
    r.setSize(cw, chh, false);
  }

  // clear the whole canvas (transparent), then scissor per card
  r.setScissorTest(false);
  r.setClearColor(0x000000, 0);
  r.clear();
  r.setScissorTest(true);
  previewDrew = visible.length > 0;

  for (const s of visible) {
    const rect = s.el.getBoundingClientRect();

    // idle life: slow showcase sway (mostly front-facing), breathing, and a
    // relaxed arm hang with a tiny sway — the game's pose system is not
    // running here, so the joints are posed directly
    const t = now / 1000 + s.seed;
    const rig = s.rig;
    rig.root.rotation.y = Math.sin(t * 0.55) * 0.65;
    rig.root.position.y = Math.sin(t * 2.0) * 0.035;
    rig.upper.rotation.x = 0.04 + Math.sin(t * 2.0) * 0.02;
    rig.shoulderL.rotation.set(-0.22 + Math.sin(t * 1.7) * 0.05, 0, 0.14);
    rig.elbowL.rotation.x = -0.5;
    rig.shoulderR.rotation.set(-0.3 + Math.sin(t * 1.7 + 1.2) * 0.05, 0, -0.16);
    rig.elbowR.rotation.x = -0.55;

    // viewport spans the full slot (so a half-scrolled character clips
    // rather than squashes); scissor is the slot ∩ scroll panel ∩ canvas
    const sx0 = Math.max(rect.left, clip.left, canvasRect.left);
    const sx1 = Math.min(rect.right, clip.right, canvasRect.right);
    const sy0 = Math.max(rect.top, clip.top, canvasRect.top);
    const sy1 = Math.min(rect.bottom, clip.bottom, canvasRect.bottom);
    if (sx1 <= sx0 || sy1 <= sy0) continue;
    const left = rect.left - canvasRect.left;
    const bottom = canvasRect.bottom - rect.bottom;
    r.setViewport(left, bottom, rect.width, rect.height);
    r.setScissor(sx0 - canvasRect.left, canvasRect.bottom - sy1, sx1 - sx0, sy1 - sy0);
    previewCam!.aspect = rect.width / rect.height;
    previewCam!.updateProjectionMatrix();
    // frames the full height range: GRANNY's shoes up to MYSTO's hat tip
    previewCam!.position.set(0, 3.3, 9.4);
    previewCam!.lookAt(0, 2.85, 0);
    r.render(s.scene, previewCam!);
  }
}
