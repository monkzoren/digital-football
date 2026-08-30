import * as THREE from 'three';
import { COURT_HALF_LEN, COURT_HALF_WID, SERVICE_LINE, LINE_MARGIN, NET_HEIGHT, REACH } from './config';
import { CHARACTERS, type Character, type HairStyle } from './characters';
import {
  playHit,
  playBounce,
  playWhoosh,
  playToss,
  playScrew,
  playDiveLand,
  crowdOoh,
} from './audio';
import { getGraphics, onGraphicsChange, type GraphicsSettings } from './graphics';

// ---------------------------------------------------------------------------
// Real-3D Virtua Tennis-style renderer (Three.js / WebGL).
//
// Game world coords: x across the court, y along it (net at y=0), z up.
// Three.js coords:   (wx, wz, -wy) — the camera sits at positive Z behind
// the near baseline. scene.flip mirrors x/y so the local player is near.
//
// Animation is event-driven: the server flips ball.lastHitSide at the exact
// contact tick, and phase changes mark serves — we key full swing cycles
// (backswing → contact → follow-through) off those events so the character
// visibly strikes the ball.
// ---------------------------------------------------------------------------

export interface RenderPlayer {
  x: number;
  y: number;
  serverX: number; // raw (un-smoothed) server position — dive target
  serverY: number;
  side: number;
  rigSlot?: number; // stable rig index: side + teamSlot*2 (doubles adds 2/3)
  swingTicks: number;
  swingKind: number;
  lungeTicks: number;
  dirX: number;
  dirY: number;
  characterId?: number;
}

export interface RenderBall {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  lastHitSide: number;
  rallyHits: number;
  spinX: number; // nonzero = screw shot in flight
  freezeTicks?: number; // hitstop: >0 = ball pinned at the contact point
}

export interface SceneTarget {
  id: string;
  x: number;
  y: number;
  side: number;
  alive: boolean;
  radius: number;
}

// VAR review of the point replay: Hawk-Eye style ball track, bounce mark and
// line call. main.ts precomputes the final shot's flight once per replay and
// reveals it progressively behind the played-back ball.
export interface VarReview {
  trail: { x: number; y: number; z: number }[]; // world coords, final shot only
  progress: number; // 0..1 of the trail revealed
  mark: { x: number; y: number; dx: number; dy: number } | null; // bounce spot + travel dir
  call: 'IN' | 'OUT' | 'NET' | null; // colors the mark (null = neutral, no ruling)
  overhead: boolean; // Hawk-Eye verdict camera, straight down over the mark
}

export interface Scene {
  flip: number;
  court: number;
  phase: number;
  servingSide: number;
  serverRigSlot?: number; // doubles: which rig holds the toss (defaults to servingSide)
  players: RenderPlayer[];
  ball: RenderBall | null;
  replayCam?: boolean; // replay playback uses the broadcast side camera
  varReview?: VarReview; // Hawk-Eye trail/mark/verdict-cam during the replay
  ruleset?: number; // 0 tennis · 1 beer pong · 2 target practice
  targets?: SceneTarget[]; // beer pong cups / practice bullseyes
}

const PHASE_SERVE = 1;
const PHASE_RALLY = 2;

// Stereo position for a sound at world/three x (camera looks down -z, so
// screen left/right tracks x directly).
const panOf = (x: number) => Math.max(-1, Math.min(1, x / 45));
// Bounce timbre per SURFACES index: grass (soft), hard court (bright
// pock), clay (dull thud).
const BOUNCE_BRIGHT = [0.85, 1.15, 0.7];

const GROUND_X = 58; // generous side run-off, VT2 style
const GROUND_Y = 64; // hoarding / stand line
// The ground plane runs past the camera (z=84): portrait's tall FOV looks
// steeply down near the bottom edge, and must always land on grass, never
// off the edge of the world.
const GROUND_EXT_Y = 100;

const COLORS = {
  sky: 0xbcd8ee,
  standDark: 0x232c4e,
  hoardingText: '#1a2a8c',
  netPost: 0x2e4a2e,
  shorts: 0xf5f5f5,
  skin: 0xe8ae7e,
  hair: 0x3a2414,
  shoe: 0xffffff,
  ball: 0xd8f838,
};

let renderer: THREE.WebGLRenderer;
let scene3: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let ballMesh: THREE.Mesh;
let ballBlob: THREE.Mesh;
const trailMeshes: THREE.Mesh[] = [];
const trailHistory: THREE.Vector3[] = [];
// SUPER FINISHER props: the flaming ball's light, the launch shockwave ring,
// and the charge-up aura ring under the striker's feet
let ballLight: THREE.PointLight;
let shockMesh: THREE.Mesh;
let shockStart = -1;
const shockPos = new THREE.Vector3();
let auraRing: THREE.Mesh;
// VAR review props: the Hawk-Eye flight tube (rebuilt once per replay) and the
// elliptical bounce mark it lands on
let varTrailMesh: THREE.Mesh | null = null;
let varTrailFor: unknown = null; // trail array identity — one build per replay
let varTrailSegs = 0;
const VAR_TRAIL_RADIAL = 7;
let varMarkGroup: THREE.Group;
let varMarkDisc: THREE.Mesh;
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

const toThree = (flip: number, wx: number, wy: number, wz: number) =>
  new THREE.Vector3(wx * flip, wz, -wy * flip);

// ---------------------------------------------------------------------------
// JUICE: camera shake + particle bursts
// ---------------------------------------------------------------------------
// Dreamcast VT-style camera: a touch lower and wider, court filling the frame
const CAM_POS = new THREE.Vector3(0, 34, 84);
const CAM_TARGET = new THREE.Vector3(0, -3, -14);
let shakeAmp = 0;
// replay cam: smoothed look-at that trails the ball through the flight
let replayLook: THREE.Vector3 | null = null;
// VAR verdict cam: height above the bounce mark, easing down (0 = inactive)
let varCamH = 0;

export function addShake(strength: number) {
  shakeAmp = Math.min(2.2, shakeAmp + strength);
}

// Screen-space anchor for DOM overlays (emote pops, speech bubbles): the
// point just above a player's head, in CSS pixels relative to the canvas.
const headProj = new THREE.Vector3();
export function headScreenPos(side: number): { x: number; y: number } | null {
  if (!renderer || !camera) return null;
  const rig = playerRigs[side];
  if (!rig || !rig.root.visible) return null;
  rig.head.getWorldPosition(headProj);
  headProj.y += 0.85; // clear the crown (and hair)
  headProj.project(camera);
  if (headProj.z > 1) return null; // behind the camera
  return {
    x: (headProj.x * 0.5 + 0.5) * cssW,
    y: (-headProj.y * 0.5 + 0.5) * cssH,
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
  playHit(power, panOf(at.x));
  window.dispatchEvent(new CustomEvent('dt-hit', { detail: { power } }));
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
type SwingKind = 'fore' | 'back' | 'over';

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
  charId: number; // character currently dressed on this rig
  head: THREE.Mesh;
  pose: Pose;
  yaw: number; // current facing (blended toward movement / ball)
  runSeed: number;
  runPhase: number; // stride cycle, advanced by ground distance (not time)
  prevPX: number; // last frame's render position — measures that distance
  prevPZ: number;
  // animation state
  swingStart: number; // -1 = not swinging
  swingKind: SwingKind;
  swingLow: boolean;
  swingStretch: boolean; // reach-to-hit: full-body lean, no dive
  swingPower: number; // 0..1 from the outgoing ball speed
  swingMs: number; // stroke duration (power hits whip faster)
  windupStart: number; // when the button went down (coil deepens while held)
  contactPoint: THREE.Vector3 | null; // frozen ball position at the hit event
  prevSwingTicks: number;
  // dive/roll state
  diveStart: number; // -1 = not diving
  diveDir: number; // roll/spin direction sign
  diveKind: number; // 0 short hop, 1 full dive, 2 huge layout
  diveMs: number;
  diveYaw: number; // world heading of the leap (head-first direction)
  diveFromX: number; // where the leap started (render space)
  diveFromZ: number;
  diveLanded: boolean;
  prevLunge: number;
}

const DIVE_MS = 800; // matches the server's lunge recovery window

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

// Authored dive keyframes. The body launches into a horizontal "superman"
// reach, lands, barrel-rolls around its own long axis (which can never clip
// the floor), and scrambles up.
function diveFlightPose(): Pose {
  return {
    ...ZERO_POSE,
    leanF: -0.15,
    thighL: 0.12, calfL: 0.15, thighR: -0.08, calfR: 0.1, // legs extended behind
    shRx: -2.7, shRz: -0.15, elR: -0.05, // racket arm reaching past the head
    shLx: 0.5, shLz: 0.25, elL: -0.2, // trail arm along the body
    crouch: 0,
  };
}

// Loose half-tuck with flailing limbs: each limb oscillates at its own
// frequency with decaying amplitude, so the tumble reads as ragdoll momentum
// rather than a held pose.
function diveRollPose(now: number, seed: number, decay: number): Pose {
  const f = (hz: number, ph: number) => Math.sin(now / hz + seed + ph) * decay;
  return {
    ...ZERO_POSE,
    thighL: -1.2 + f(47, 0) * 0.55, calfL: 1.6 + f(61, 2) * 0.5,
    thighR: -1.2 + f(53, 4) * 0.55, calfR: 1.6 + f(43, 1) * 0.5,
    shLx: -1.0 + f(39, 3) * 0.7, shLz: 0.3 + f(71, 5) * 0.3, elL: -1.5 + f(57, 1) * 0.5,
    shRx: -1.4 + f(49, 2) * 0.7, shRz: -0.3 + f(67, 0) * 0.3, elR: -1.6 + f(45, 4) * 0.5,
    twist: f(83, 2) * 0.3,
    crouch: 0,
  };
}

const _dq1 = new THREE.Quaternion();
const _dq2 = new THREE.Quaternion();
const _dq3 = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
const _RIGHT = new THREE.Vector3(1, 0, 0);

// Arm chain lengths for the racket IK (shoulder→elbow, elbow→racket head).
const IK_UPPER = 0.95;
const IK_LOWER = 2.0;

// Two-bone IK: point the racket-arm chain at the ball so the strings meet it
// at contact. Blended by w so the procedural swing still provides the sweep.
const _ikV = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
const _ikQ2 = new THREE.Quaternion();
function solveArmIK(rig: PlayerRig, targetWorld: THREE.Vector3, w: number) {
  rig.root.updateWorldMatrix(true, true);
  rig.shoulderR.getWorldPosition(_ikV);
  const dir = targetWorld.clone().sub(_ikV);
  const dist = THREE.MathUtils.clamp(dir.length(), 0.6, IK_UPPER + IK_LOWER - 0.05);
  dir.normalize();
  rig.shoulderR.parent!.getWorldQuaternion(_ikQ);
  const dLocal = dir.applyQuaternion(_ikQ2.copy(_ikQ).invert());
  const qTarget = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dLocal);
  rig.shoulderR.quaternion.slerp(qTarget, w);
  const cosE = THREE.MathUtils.clamp(
    (IK_UPPER * IK_UPPER + IK_LOWER * IK_LOWER - dist * dist) / (2 * IK_UPPER * IK_LOWER),
    -1, 1
  );
  const bend = Math.PI - Math.acos(cosE);
  rig.elbowR.rotation.x = THREE.MathUtils.lerp(rig.elbowR.rotation.x, bend, w);
}

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

// Felt tennis ball with the classic curved seam, drawn near-white so the
// material color keeps providing the yellow (and screw-shot purple) tint.
function makeBallTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4ec';
  g.fillRect(0, 0, c.width, c.height);
  for (let n = 0; n < 1200; n++) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    const r = s - Math.floor(s);
    const s2 = Math.sin(n * 311.7) * 12543.21;
    const r2 = s2 - Math.floor(s2);
    g.fillStyle = r > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(90,90,60,0.05)';
    g.fillRect(r * c.width, r2 * c.height, 2, 2);
  }
  const seam = (color: string, w: number) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.lineJoin = 'round';
    g.beginPath();
    for (let x = 0; x <= c.width; x += 4) {
      const y = 64 + Math.sin((x / c.width) * Math.PI * 4) * 30;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  };
  seam('rgba(110,110,95,0.45)', 9); // fuzzy seam shadow
  seam('#ffffff', 3.5);
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

// Dress a rig as a character: kit colors, skin tone, face, hair, body.
function applyCharacter(rig: PlayerRig, char: Character) {
  if (rig.charId === char.id) return;
  rig.charId = char.id;
  rig.torsoMat.color.setHex(char.color);
  rig.torsoMat.map = makeShirtTexture(char.id);
  rig.torsoMat.needsUpdate = true;
  rig.sleeveMatL.color.setHex(char.color);
  rig.sleeveMatR.color.setHex(char.color);
  rig.accentMat.color.setHex(char.color);
  rig.skinMat.color.setHex(char.skin);
  rig.headMat.map = makeFaceTexture(char);
  rig.headMat.needsUpdate = true;
  rig.hairMat.color.setHex(char.hair);
  buildBody(rig, char);
  buildHair(rig.hairGroup, rig.hairMat, char.hairStyle);
  applyPhysique(rig, char);
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
  const armK = (1 + (s.reach - 3) * 0.06) * (o?.arms ?? 1); // 0.88 (KAI/ROSA) … 1.12 (VOLT)
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
const SHORTS_MAT = new THREE.MeshLambertMaterial({ color: COLORS.shorts });
const SHOE_MAT = new THREE.MeshLambertMaterial({ color: COLORS.shoe });
const SOLE_MAT = new THREE.MeshLambertMaterial({ color: 0x50525a });
const WHITE_MAT = new THREE.MeshLambertMaterial({ color: 0xf0f2f4 });
const WOOD_MAT = new THREE.MeshLambertMaterial({ color: 0x7a4a26 });
const DARK_MAT = new THREE.MeshLambertMaterial({ color: 0x23252d });
const METAL_MAT = new THREE.MeshLambertMaterial({ color: 0xb8bcc4 });

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
        stdLeg(rig, rt, { r: 0.16, len: 0.72, calfR: 0.13, calfLen: 0.68, mat: skin, sock: WHITE_MAT, foot: 'shoe', footMat: DARK_MAT });
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
        stdLeg(rig, rt, { r: 0.24, len: 0.75, calfR: 0.19, calfLen: 0.7, mat: skin, hem: SHORTS_MAT, sock: SHOE_MAT, foot: 'shoe' });
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

  // racket in the right hand, extending along the forearm
  const racket = new THREE.Group();
  racket.position.set(0, -0.95, 0);
  racket.rotation.x = -0.35;
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8),
    new THREE.MeshLambertMaterial({ color: 0x444444 })
  );
  handle.position.y = -0.35;
  racket.add(handle);
  const rHead = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.06, 8, 22),
    new THREE.MeshLambertMaterial({ color: 0xd8d8e0 })
  );
  rHead.position.y = -1.15;
  rHead.castShadow = true;
  racket.add(rHead);
  const strings = new THREE.Mesh(
    new THREE.CircleGeometry(0.47, 22),
    new THREE.MeshLambertMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
  );
  strings.position.y = -1.15;
  racket.add(strings);
  armR.elbow.add(racket); // permanent — survives body rebuilds

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
    charId: -1,
    head,
    pose: { ...ZERO_POSE },
    yaw: side === 0 ? Math.PI : 0,
    runSeed: side * 2.7,
    runPhase: side * 2.7,
    prevPX: 0,
    prevPZ: 0,
    swingStart: -1,
    swingKind: 'fore',
    swingLow: false,
    swingStretch: false,
    swingPower: 0.5,
    swingMs: 520,
    windupStart: 0,
    contactPoint: null,
    prevSwingTicks: 0,
    diveStart: -1,
    diveDir: 1,
    diveKind: 1,
    diveMs: 800,
    diveYaw: 0,
    diveFromX: 0,
    diveFromZ: 0,
    diveLanded: false,
    prevLunge: 0,
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
function readyPose(now: number, seed: number): Pose {
  const sway = Math.sin(now / 550 + seed) * 0.04;
  return {
    ...ZERO_POSE,
    leanF: 0.22,
    crouch: 0.22 + Math.sin(now / 275 + seed) * 0.03,
    thighL: -0.32, calfL: 0.5, thighR: -0.32, calfR: 0.5,
    // two-handed ready grip in front
    shLx: -0.85 + sway, shLz: 0.55, elL: -1.15,
    shRx: -0.85 + sway, shRz: -0.55, elR: -1.15,
  };
}

// Stride cadence: radians of run cycle per world unit of ground covered.
// One full cycle (two steps) then spans ~2π/0.85 ≈ 7.4 units — about what
// these legs actually cover at full extension, so the shoes grip instead
// of skating. The phase is fed from measured movement, not wall-clock time.
const RUN_STRIDE_RATE = 0.85;

function runPose(phase: number, lean: number): Pose {
  const t = phase;
  const s = Math.sin(t);
  const c = Math.sin(t + Math.PI);
  return {
    ...ZERO_POSE,
    leanF: 0.3,
    leanS: lean * 0.12,
    twist: s * 0.14, // hips/shoulders counter-rotate with the stride
    crouch: 0.12 + Math.abs(Math.sin(t)) * 0.05,
    thighL: s * 1.0, calfL: Math.max(0, -s) * 1.15 + 0.15,
    thighR: c * 1.0, calfR: Math.max(0, -c) * 1.15 + 0.15,
    shLx: c * 0.7 - 0.25, shLz: 0.15, elL: -0.9,
    shRx: s * 0.7 - 0.25, shRz: -0.15, elR: -0.9,
  };
}

// Wound-up backswing, held while the swing button is "live".
function windupPose(kind: SwingKind, low: boolean): Pose {
  if (kind === 'over') {
    return {
      ...ZERO_POSE,
      leanF: -0.12, twist: -0.35,
      crouch: 0.1,
      thighL: -0.2, calfL: 0.3, thighR: 0.15, calfR: 0.2,
      shLx: -2.4, shLz: 0.25, elL: -0.25, // left arm reaches up at the ball
      shRx: 2.2, shRz: -0.85, elR: 1.6, // racket cocked back behind the head
    };
  }
  const m = kind === 'fore' ? 1 : -1;
  return {
    ...ZERO_POSE,
    twist: -0.8 * m,
    leanF: 0.28,
    crouch: low ? 0.42 : 0.24,
    thighL: -0.35, calfL: 0.55, thighR: -0.35, calfR: 0.55,
    shLx: -0.55, shLz: 0.75, elL: -0.9,
    // racket arm taken back (across the body for backhand)
    shRx: low ? 0.65 : 0.45,
    shRz: kind === 'fore' ? -1.25 : 1.05,
    elR: kind === 'fore' ? 0.5 : 0.9,
  };
}

// Full swing cycle. t: 0 backswing → 0.3 CONTACT → 1 follow-through done.
// `power` (0..1) scales the whole stroke: weak = compact block, strong =
// big torso rotation, leg drive, and a huge follow-through.
function swingPose(kind: SwingKind, t: number, low: boolean, power = 0.5): Pose {
  const cnt = 0.3; // contact time
  const amp = 0.7 + 0.6 * power; // stroke amplitude
  if (kind === 'over') {
    // overhead smash / serve strike: whip from behind the head to out front
    const w = windupPose('over', false);
    if (t < cnt) {
      const k = t / cnt;
      return {
        ...w,
        shRx: THREE.MathUtils.lerp(2.2, -1.0, k * k),
        shRz: THREE.MathUtils.lerp(-0.85, -0.15, k),
        elR: THREE.MathUtils.lerp(1.6, -0.1, k * k),
        shLx: THREE.MathUtils.lerp(-2.4, -0.3, k),
        leanF: THREE.MathUtils.lerp(-0.12, 0.4, k),
        twist: THREE.MathUtils.lerp(-0.35, 0.15, k),
      };
    }
    const k = (t - cnt) / (1 - cnt);
    return {
      ...ZERO_POSE,
      leanF: THREE.MathUtils.lerp(0.4, 0.22, k),
      crouch: 0.15,
      shRx: THREE.MathUtils.lerp(-1.0, -0.3, k),
      shRz: -0.2,
      elR: THREE.MathUtils.lerp(-0.1, -0.6, k),
      shLx: -0.4, elL: -0.8,
    };
  }

  const m = kind === 'fore' ? 1 : -1;
  const w = windupPose(kind, low);
  if (t < cnt) {
    // explosive sweep to contact: arm extends forward, torso untwists;
    // power hits drive from the legs (deeper dip) and rotate further
    const k = (t / cnt) ** 2;
    return {
      ...w,
      twist: THREE.MathUtils.lerp(-0.8 * m * amp, 0.45 * m * amp, k),
      shRx: THREE.MathUtils.lerp(w.shRx, low ? -0.2 : -0.45, k),
      shRz: THREE.MathUtils.lerp(w.shRz, kind === 'fore' ? -0.3 : 0.2, k),
      elR: THREE.MathUtils.lerp(w.elR, -0.05, k), // arm extended at contact
      crouch: THREE.MathUtils.lerp(w.crouch, (low ? 0.3 : 0.15) + power * 0.12, k),
    };
  }
  // follow-through: weak hits check the racket short; power hits wrap it all
  // the way around with the body rotating through, back foot popping up
  const k = (t - cnt) / (1 - cnt);
  const ease = 1 - (1 - k) * (1 - k);
  const hop =
    power > 0.7 ? -(power - 0.7) * 0.9 * Math.sin(Math.min(1, k * 1.8) * Math.PI) : 0;
  return {
    ...ZERO_POSE,
    twist: THREE.MathUtils.lerp(0.45 * m * amp, 0.75 * m * amp, ease),
    leanF: 0.22,
    crouch: 0.18 + hop,
    shRx: THREE.MathUtils.lerp(-0.45, -0.7 - 0.5 * amp, ease),
    shRz: THREE.MathUtils.lerp(
      kind === 'fore' ? -0.3 : 0.2,
      (kind === 'fore' ? 0.55 : -0.5) * amp,
      ease
    ),
    elR: THREE.MathUtils.lerp(-0.05, -0.8, ease),
    thighL: kind === 'fore' ? 0.1 : -0.2, thighR: kind === 'fore' ? -0.2 : 0.1,
    shLx: -0.5, shLz: 0.4, elL: -0.9,
  };
}

// Serve toss: left arm releases the ball upward, racket cocked, watching it.
function tossPose(ballZ: number): Pose {
  const up = THREE.MathUtils.clamp((ballZ - 6) / 6, 0, 1);
  return {
    ...ZERO_POSE,
    leanF: -0.1 - up * 0.08,
    twist: -0.3,
    shLx: -1.4 - up * 1.3, shLz: 0.2, elL: -0.15, // toss arm follows the ball up
    shRx: 1.7 + up * 0.5, shRz: -0.8, elR: 1.5, // racket winding up behind
    thighL: -0.15, calfL: 0.25, thighR: 0.1, calfR: 0.15,
  };
}

const SWING_MS = 520;

function triggerSwing(
  rig: PlayerRig,
  kind: SwingKind,
  low: boolean,
  now: number,
  stretch = false,
  power = 0.5,
  atContact = false
) {
  rig.swingKind = kind;
  rig.swingLow = low;
  rig.swingStretch = stretch;
  rig.swingPower = power;
  // power hits whip through faster; weak hits are a slower, checked block
  rig.swingMs = 620 - 200 * power;
  // A real hit fires at the server's contact instant — start the stroke just
  // before its contact phase (the windup was the backswing), so the racket
  // meets the ball NOW instead of sweeping through empty air afterwards.
  rig.swingStart = atContact ? now - rig.swingMs * 0.26 : now;
}

// ---------------------------------------------------------------------------
// Environment (court, net, stands, hoardings)
// ---------------------------------------------------------------------------
const SURFACES = [
  { inner: '#4aa338', outer: '#419230', stripe: true, noise: 'rgba(0,60,0,0.05)' },
  // hard court in the classic Dreamcast mint-green
  { inner: '#8fbf9b', outer: '#649c78', stripe: false, noise: 'rgba(0,50,25,0.05)' },
  { inner: '#c86438', outer: '#b25830', stripe: false, noise: 'rgba(80,20,0,0.06)' },
];

function makeGroundTexture(court: number): THREE.CanvasTexture {
  const surf = SURFACES[court] ?? SURFACES[0];
  const c = document.createElement('canvas');
  // Half-res surface (and no grain, below) when detail is off — less texture
  // for the GPU to sample on every court pixel.
  c.width = gfx.detail ? 1024 : 512;
  c.height = c.width * 1.5; // taller plane (GROUND_EXT_Y), same texel density
  const g = c.getContext('2d')!;
  const toU = (wx: number) => ((wx + GROUND_X) / (2 * GROUND_X)) * c.width;
  const toV = (wy: number) => ((GROUND_EXT_Y - wy) / (2 * GROUND_EXT_Y)) * c.height;

  g.fillStyle = surf.outer;
  g.fillRect(0, 0, c.width, c.height);

  if (surf.stripe) {
    const STRIPE = 9.75;
    let i = 0;
    for (let y = -GROUND_EXT_Y; y < GROUND_EXT_Y; y += STRIPE, i++) {
      g.fillStyle = i % 2 === 0 ? surf.inner : surf.outer;
      g.fillRect(0, toV(Math.min(y + STRIPE, GROUND_EXT_Y)), c.width, toV(y) - toV(Math.min(y + STRIPE, GROUND_EXT_Y)));
    }
  } else {
    const mx = COURT_HALF_WID + 6;
    const my = COURT_HALF_LEN + 8;
    g.fillStyle = surf.inner;
    g.fillRect(toU(-mx), toV(my), toU(mx) - toU(-mx), toV(-my) - toV(my));
  }
  for (let n = 0; gfx.detail && n < 9000; n++) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    const r = s - Math.floor(s);
    const s2 = Math.sin(n * 311.7) * 12543.21;
    const r2 = s2 - Math.floor(s2);
    g.fillStyle = r > 0.5 ? 'rgba(255,255,255,0.03)' : surf.noise;
    g.fillRect(r * c.width, r2 * c.height, 2, 2);
  }

  const hw = COURT_HALF_WID;
  const hl = COURT_HALF_LEN;

  // baked ambient falloff toward the hoardings grounds the court in the bowl
  for (const [gy0, gy1, ry] of [
    [0, c.height * 0.2, 0],
    [c.height, c.height * 0.8, c.height * 0.8],
  ] as const) {
    const vg = g.createLinearGradient(0, gy0, 0, gy1);
    vg.addColorStop(0, 'rgba(0,0,20,0.14)');
    vg.addColorStop(1, 'rgba(0,0,20,0)');
    g.fillStyle = vg;
    g.fillRect(0, ry, c.width, c.height * 0.2);
  }
  for (const [gx0, gx1, rx] of [
    [0, c.width * 0.14, 0],
    [c.width, c.width * 0.86, c.width * 0.86],
  ] as const) {
    const vg = g.createLinearGradient(gx0, 0, gx1, 0);
    vg.addColorStop(0, 'rgba(0,0,20,0.10)');
    vg.addColorStop(1, 'rgba(0,0,20,0)');
    g.fillStyle = vg;
    g.fillRect(rx, 0, c.width * 0.14, c.height);
  }

  // grass wears thin where the players grind behind the baselines
  if (court === 0) {
    for (const wy of [hl - 2.5, -(hl - 2.5)]) {
      for (const [rx, ry, a] of [[8.5, 3.2, 0.07], [5, 2.2, 0.06]] as const) {
        g.fillStyle = `rgba(200,186,124,${a})`;
        g.beginPath();
        g.ellipse(toU(0), toV(wy), toU(rx) - toU(0), toV(0) - toV(ry), 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  // clay carries drag-net sweep lines and slide scuffs
  if (court === 2 && gfx.detail) {
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 2;
    for (let wy = -hl - 6; wy <= hl + 6; wy += 2.6) {
      g.beginPath();
      g.moveTo(toU(-hw - 5), toV(wy));
      g.lineTo(toU(hw + 5), toV(wy + 0.4));
      g.stroke();
    }
    g.strokeStyle = 'rgba(80,30,10,0.10)';
    g.lineWidth = 3;
    for (let n = 0; n < 90; n++) {
      const s = Math.sin(n * 91.7) * 43758.5453;
      const wx = ((s - Math.floor(s)) * 2 - 1) * hw;
      const s2 = Math.sin(n * 271.3) * 12543.21;
      const wy = ((s2 - Math.floor(s2)) * 2 - 1) * (hl + 3);
      const s3 = Math.sin(n * 137.9) * 33421.13;
      const ang = (s3 - Math.floor(s3)) * Math.PI * 2;
      g.beginPath();
      g.moveTo(toU(wx), toV(wy));
      g.lineTo(toU(wx + Math.cos(ang) * 2.2), toV(wy + Math.sin(ang) * 1.2));
      g.stroke();
    }
  }

  g.lineCap = 'square';
  const line = (x1: number, y1: number, x2: number, y2: number, ox = 0, oy = 0) => {
    g.beginPath();
    g.moveTo(toU(x1) + ox, toV(y1) + oy);
    g.lineTo(toU(x2) + ox, toV(y2) + oy);
    g.stroke();
  };
  const paintLines = (ox: number, oy: number) => {
    line(-hw, -hl, hw, -hl, ox, oy);
    line(-hw, hl, hw, hl, ox, oy);
    line(-hw, -hl, -hw, hl, ox, oy);
    line(hw, -hl, hw, hl, ox, oy);
    line(-hw, -SERVICE_LINE, hw, -SERVICE_LINE, ox, oy);
    line(-hw, SERVICE_LINE, hw, SERVICE_LINE, ox, oy);
    line(0, -SERVICE_LINE, 0, SERVICE_LINE, ox, oy);
    line(0, -hl, 0, -hl + 1.4, ox, oy);
    line(0, hl, 0, hl - 1.4, ox, oy);
  };
  // soft baked shadow under the tape lifts them off the surface
  g.strokeStyle = 'rgba(0,10,0,0.22)';
  g.lineWidth = 7;
  paintLines(2, 3);
  g.strokeStyle = '#fafafa';
  g.lineWidth = 5;
  paintLines(0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = gfx.detail ? 8 : 1;
  tex.colorSpace = THREE.SRGBColorSpace;
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
    ['DIGITAL TENNIS', '#101c54', '#ffffff'],
    ['ACE SPORTS', '#f4f6fa', '#12205a'],
    ['VOLT ENERGY', '#f2c018', '#221a06'],
    ['TOPSPIN TOUR', '#175c34', '#eafaf0'],
    ['SMASH! FM', '#b8241c', '#ffffff'],
    ['NET RUNNER', '#f4f6fa', '#b8241c'],
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
  g.font = 'italic 900 44px "Arial Black", Arial, sans-serif';
  g.fillText('DIGITAL TENNIS', c.width / 2, 82);
  // tennis ball dotting the tagline
  g.fillStyle = '#d8f838';
  g.beginPath();
  g.arc(c.width / 2 - 78, 134, 12, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(c.width / 2 - 84, 134, 12, -0.9, 0.9);
  g.stroke();
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
  const A = GROUND_X, B = GROUND_Y, cut = 24;
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
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_X * 2, GROUND_EXT_Y * 2), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene3.add(ground);

  // --- net: woven mesh with a real center sag, curved band, strap, posts ---
  const NW = COURT_HALF_WID + 3;
  const sagAt = (x: number) => 0.24 * (1 - (x / NW) ** 2);
  const netGeo = new THREE.PlaneGeometry(NW * 2, NET_HEIGHT, 48, 6);
  {
    const pos = netGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const yW = pos.getY(i) + NET_HEIGHT / 2; // 0 at the ground
      pos.setY(i, yW * (1 - sagAt(pos.getX(i)) / NET_HEIGHT) - NET_HEIGHT / 2);
    }
  }
  const netMat = new THREE.MeshLambertMaterial({
    map: makeNetTexture(),
    transparent: true,
    side: THREE.DoubleSide,
  });
  const net = new THREE.Mesh(netGeo, netMat);
  net.position.set(0, NET_HEIGHT / 2, 0);
  scene3.add(net);

  const bandGeo = new THREE.BoxGeometry(NW * 2, 0.3, 0.14, 48, 1, 1);
  {
    const pos = bandGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) - sagAt(pos.getX(i)));
    bandGeo.computeVertexNormals();
  }
  const band = new THREE.Mesh(bandGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }));
  band.position.set(0, NET_HEIGHT - 0.15, 0);
  band.castShadow = true;
  scene3.add(band);

  const strap = new THREE.Mesh(
    new THREE.PlaneGeometry(0.36, NET_HEIGHT - sagAt(0) - 0.02),
    new THREE.MeshLambertMaterial({ color: 0xf6f6f6, side: THREE.DoubleSide })
  );
  strap.position.set(0, (NET_HEIGHT - sagAt(0)) / 2, 0.075);
  scene3.add(strap);

  const capMat = new THREE.MeshLambertMaterial({ color: 0xe8e8e8 });
  for (const px of [-NW, NW]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.18, NET_HEIGHT + 0.3, 10),
      new THREE.MeshLambertMaterial({ color: COLORS.netPost })
    );
    post.position.set(px, (NET_HEIGHT + 0.3) / 2, 0);
    post.castShadow = true;
    scene3.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), capMat);
    cap.position.set(px, NET_HEIGHT + 0.32, 0);
    scene3.add(cap);
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
  // roof + fascia. The near stand is kept low (and roofless) so it never
  // pokes into the bottom of the frame; its corner neighbors step down to
  // meet it. -----------------------------------------------------------
  const cMatA = (crowdMatA = new THREE.MeshLambertMaterial({ map: makeCrowdTexture(0) }));
  const cMatB = (crowdMatB = new THREE.MeshLambertMaterial({ map: makeCrowdTexture(1) }));
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xdde3ea });
  const fasciaMat = new THREE.MeshLambertMaterial({ color: 0xf4f6fa });
  const sinT = Math.sin(STAND_TILT);
  const cosT = Math.cos(STAND_TILT);
  edges.forEach((e, i) => {
    const near = i === 4;
    const hs = near ? 0.55 : i === 3 || i === 5 ? 0.8 : 1;
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

  // --- jumbotron above the far stand --------------------------------------
  const jumbo = new THREE.Group();
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
  jumbo.position.set(0, 35.5, -88);
  jumbo.rotation.x = 0.1; // faces down at the court
  detailGroup.add(jumbo);

  // --- floodlight towers at the four corners ------------------------------
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x8a929e });
  const headMat = new THREE.MeshLambertMaterial({ color: 0x3a4148 });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xf0f7ff }); // self-lit
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * 53;
      const pz = sz * 59;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.75, 39, 10), poleMat);
      pole.position.set(px, 19.5, pz);
      detailGroup.add(pole);
      const head = new THREE.Group();
      head.position.set(px, 39.5, pz);
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

  // --- player benches flanking the umpire chair ---------------------------
  const benchSeatMat = new THREE.MeshLambertMaterial({ color: 0x2e6cb0 });
  const benchLegMat = new THREE.MeshLambertMaterial({ color: 0x9aa4b0 });
  const towelMat = new THREE.MeshLambertMaterial({ color: 0xf6f6f2 });
  for (const bz of [-13, 13]) {
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
    bench.position.set(GROUND_X - 25, 0, bz);
    detailGroup.add(bench);
  }

  // umpire chair: white frame, green seat, ladder rungs, and a parasol
  const chairMat = new THREE.MeshLambertMaterial({ color: 0xeef0ee });
  const chairGreen = new THREE.MeshLambertMaterial({ color: 0x1d6a38 });
  const chair = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 1.4), chairGreen);
  seat.position.y = 5.2;
  seat.castShadow = true;
  chair.add(seat);
  const pole = new THREE.Mesh(new THREE.BoxGeometry(1.1, 4.6, 1.1), chairMat);
  pole.position.y = 2.3;
  pole.castShadow = true;
  chair.add(pole);
  for (let s = 0; s < 4; s++) {
    const rung = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 1.1), chairMat);
    rung.position.set(-0.85, 1.0 + s * 1.1, 0);
    chair.add(rung);
  }
  const brollyPole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 8), chairMat);
  brollyPole.position.set(0.8, 8.3, 0);
  chair.add(brollyPole);
  const canopy = new THREE.Mesh(new THREE.ConeGeometry(2.7, 1.2, 8), chairGreen);
  canopy.position.set(0.4, 9.9, 0);
  canopy.castShadow = true;
  chair.add(canopy);

  // the REF: seated on the chair, navy blazer + cap, facing the court (-x).
  // Same stylized proportions as the players, built from primitives.
  const refSkin = new THREE.MeshLambertMaterial({ color: COLORS.skin });
  const refBlazer = new THREE.MeshLambertMaterial({ color: 0x24356e });
  const refSlacks = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 });
  const refPart = (mesh: THREE.Mesh, x: number, y: number, z: number, rz = 0) => {
    mesh.position.set(x, y, z);
    mesh.rotation.z = rz;
    mesh.castShadow = true;
    chair.add(mesh);
    return mesh;
  };
  const seatTop = 5.9;
  // torso leaning slightly over the court
  refPart(
    new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 1.3, 4, 10), refBlazer),
    -0.15, seatTop + 1.15, 0, -0.12
  );
  // head + cap with a forward brim
  refPart(new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 12), refSkin), -0.2, seatTop + 2.45, 0);
  refPart(
    new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.54, 0.26, 12), refBlazer),
    -0.2, seatTop + 2.85, 0
  );
  refPart(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.62), refBlazer), -0.7, seatTop + 2.78, 0);
  for (const s of [-1, 1]) {
    // thighs run forward along the seat, shins hang toward the footrest
    refPart(
      new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.75, 4, 8), refSlacks),
      -0.65, seatTop + 0.28, s * 0.34, Math.PI / 2
    );
    refPart(
      new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.85, 4, 8), refSlacks),
      -1.15, seatTop - 0.75, s * 0.34
    );
    refPart(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.3), refSlacks), -1.3, seatTop - 1.35, s * 0.34);
    // arms angled down to rest on the knees
    refPart(
      new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.85, 4, 8), refBlazer),
      -0.5, seatTop + 1.15, s * 0.68, 2.45
    );
  }
  chair.position.set(GROUND_X - 26, 0, 0.8);
  detailGroup.add(chair);
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
  scene3.fog = new THREE.Fog(0xdce8f2, 200, 340);

  // resizeToDisplay corrects this on the first frame; the fallback only
  // covers a canvas that has not been laid out yet.
  const aspect =
    hostCanvas.clientHeight > 0 ? hostCanvas.clientWidth / hostCanvas.clientHeight : BASE_ASPECT;
  camera = new THREE.PerspectiveCamera(46, aspect, 1, 400);
  camera.position.copy(CAM_POS);
  camera.lookAt(CAM_TARGET);

  sun = new THREE.DirectionalLight(0xfff2df, 2.2); // late-afternoon warmth
  sun.position.set(-40, 70, 30);
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 80;
  sun.shadow.camera.bottom = -80;
  sun.shadow.camera.far = 250;
  scene3.add(sun);
  scene3.add(new THREE.HemisphereLight(0xcfe4ff, 0x3a6b32, 1.0));

  buildEnvironment();
  initParticles();

  // six rigs: slots 0/1 are each side's first player (singles uses only
  // these), slots 2/3 the doubles partners and 4/5 the third teammates in
  // 3v3 (rigSlot = side + teamSlot*2)
  playerRigs = [0, 1, 0, 1, 0, 1].map(side => makePlayerRig(side));
  playerRigs.forEach((rig, i) => {
    rig.root.visible = false;
    rig.runSeed = i * 2.7; // desync the partners' idle/run cycles
    rig.runPhase = i * 2.7;
  });

  ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 18, 14),
    new THREE.MeshLambertMaterial({ map: makeBallTexture(), color: COLORS.ball, emissive: 0x556600 })
  );
  ballMesh.castShadow = true;
  ballMesh.visible = false;
  scene3.add(ballMesh);

  ballBlob = new THREE.Mesh(
    new THREE.CircleGeometry(0.6, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 })
  );
  ballBlob.rotation.x = -Math.PI / 2;
  ballBlob.visible = false;
  scene3.add(ballBlob);

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
  auraRing = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 2.4, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffd040, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
    })
  );
  auraRing.rotation.x = -Math.PI / 2;
  auraRing.visible = false;
  scene3.add(auraRing);

  // VAR bounce mark: colored ellipse + white rim, stretched along the travel
  // direction like a Hawk-Eye impact print
  varMarkGroup = new THREE.Group();
  varMarkDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 36),
    new THREE.MeshBasicMaterial({
      color: 0x30d860, transparent: true, opacity: 0.8, depthWrite: false,
    })
  );
  varMarkDisc.rotation.x = -Math.PI / 2;
  varMarkDisc.position.y = 0.05;
  const varMarkRim = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1.12, 36),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false,
    })
  );
  varMarkRim.rotation.x = -Math.PI / 2;
  varMarkRim.position.y = 0.06;
  varMarkGroup.add(varMarkDisc, varMarkRim);
  varMarkGroup.visible = false;
  scene3.add(varMarkGroup);

  buildTargetPools();
  applyResolution();
  applyShadows();
  applyGrade();
}

// ---------------------------------------------------------------------------
// Mode props: beer pong cups (red party cups) + practice bullseyes.
// Pooled meshes, repositioned every frame from scene.targets.
// ---------------------------------------------------------------------------
const cupPool: THREE.Group[] = [];
const ringPool: THREE.Group[] = [];
const prevTargetAlive = new Map<string, boolean>();

function buildTargetPools() {
  const cupMat = new THREE.MeshLambertMaterial({ color: 0xd82818 });
  const beerMat = new THREE.MeshBasicMaterial({ color: 0xe8b83a });
  const rimMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  for (let i = 0; i < 12; i++) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.78, 2.6, 14), cupMat);
    body.position.y = 1.3;
    body.castShadow = true;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.09, 6, 14), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 2.6;
    const beer = new THREE.Mesh(new THREE.CircleGeometry(0.95, 14), beerMat);
    beer.rotation.x = -Math.PI / 2;
    beer.position.y = 2.5;
    group.add(body, rim, beer);
    group.visible = false;
    scene3.add(group);
    cupPool.push(group);
  }
  for (let i = 0; i < 10; i++) {
    const group = new THREE.Group();
    const colors = [0xd82818, 0xffffff, 0xd82818];
    const fractions = [1, 0.62, 0.28];
    for (let j = 0; j < 3; j++) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(fractions[j], 24),
        new THREE.MeshBasicMaterial({ color: colors[j], transparent: true, opacity: 0.85 })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.04 + j * 0.02;
      group.add(disc);
    }
    group.visible = false;
    scene3.add(group);
    ringPool.push(group);
  }
}

function updateTargets(scene: Scene, now: number) {
  const targets = scene.targets ?? [];
  const cups = scene.ruleset === 1;
  const pool = cups ? cupPool : ringPool;
  const otherPool = cups ? ringPool : cupPool;
  for (const g of otherPool) g.visible = false;
  let i = 0;
  for (const t of targets) {
    // sink FX on the live view (replays would re-fire on old frames)
    const wasAlive = prevTargetAlive.get(t.id);
    if (!scene.replayCam) {
      if (wasAlive === true && !t.alive) {
        const at = toThree(scene.flip, t.x, t.y, 1.5);
        spawnBurst(at, cups ? 0xe8b83a : 0xffd400, 26, 22, 0.85, -40);
        spawnBurst(at, 0xffffff, 12, 14, 0.9, -25);
        addShake(0.9);
      }
      prevTargetAlive.set(t.id, t.alive);
    }
    if (!t.alive || i >= pool.length) continue;
    const g = pool[i++];
    const pos = toThree(scene.flip, t.x, t.y, 0);
    g.position.set(pos.x, 0, pos.z);
    if (!cups) {
      // bullseyes are drawn at their true hit radius
      const s = t.radius / 1;
      g.scale.set(s, 1, s);
    }
    g.visible = true;
  }
  for (; i < pool.length; i++) pool[i].visible = false;
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
  cupPool.length = 0; // buildScene → buildTargetPools refills these
  ringPool.length = 0;
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
// Per-frame update
// ---------------------------------------------------------------------------
let prevLastHitSide = -1;
let prevBallActive = false;
let prevBallVz = 0;
let prevPhase = -1;
let bouncesSinceHit = 0; // only the FIRST bounce of a shot can be a line call
let lastFrame = 0;
let lastChargeSpawn = 0; // throttles the finisher-windup particle crackle
let lastFlameSpawn = 0; // throttles the screw-ball flame spew

// screw-ball trail: white-gold at the head cooling to deep red at the tail
const FLAME_TRAIL = [0xfff2a8, 0xffd040, 0xffa020, 0xff7018, 0xf04810, 0xc03010, 0x902020];
const FLAME_COLORS = [0xffd040, 0xff8020, 0xff4010, 0xc060ff];

// charge-up aura palettes [flame, arc]: each finisher rolls one at random so
// no two buildups look alike — super-saiyan gold, electric storm, blood rage
const AURA_PALETTES: [number, number][] = [
  [0xffd040, 0xc060ff],
  [0x40d0ff, 0xf0ffff],
  [0xff4020, 0xffa020],
];
const chargePalette = [0, 0, 0, 0, 0, 0]; // per-rig palette rolled per charge
const lastChargeAt = [-1e9, -1e9, -1e9, -1e9, -1e9, -1e9]; // per-rig: detects a fresh charge

export function drawScene(scene: Scene) {
  if (!renderer) return;
  resizeToDisplay(renderer.domElement);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;

  const { flip, ball } = scene;
  const heat = 1 + Math.min(0.8, (ball?.rallyHits ?? 0) * 0.06);
  setCourt(scene.court);
  updateTargets(scene, now);
  animateCrowd(now);

  // --- detect hit + bounce events (animations, VFX, SFX) --------------------
  const ballPos3 = ball ? toThree(flip, ball.x, ball.y, ball.z) : null;
  if (ball && ballPos3) {
    const speed = Math.hypot(ball.vx, ball.vy);
    const power = THREE.MathUtils.clamp((speed - 40) / 60, 0.15, 1);
    if (scene.phase === PHASE_RALLY) {
      const rallyHit = prevLastHitSide !== -1 && ball.lastHitSide !== prevLastHitSide;
      const serveHit = prevPhase === PHASE_SERVE;
      if (rallyHit || serveHit) {
        const strikerSide = serveHit ? scene.servingSide : ball.lastHitSide;
        // doubles: the striker is whichever teammate is closest to the ball
        // (a serve is always the designated server's rig)
        const striker = serveHit
          ? scene.players.find(
              p => (p.rigSlot ?? p.side) === (scene.serverRigSlot ?? scene.servingSide)
            ) ?? scene.players.find(p => p.side === strikerSide)
          : scene.players
              .filter(p => p.side === strikerSide)
              .sort(
                (a, b) =>
                  Math.hypot(ball.x - a.x, ball.y - a.y) -
                  Math.hypot(ball.x - b.x, ball.y - b.y)
              )[0];
        const rig = striker ? playerRigs[striker.rigSlot ?? striker.side] : undefined;
        const diving = !serveHit && (striker?.lungeTicks ?? 0) > 0;
        if (rig && striker) {
          const kind: SwingKind =
            serveHit || ball.z > 5.5 ? 'over' : swingSideKind(striker, ball, flip);
          // reach-to-hit: contact beyond comfortable radius, but no dive
          const contactDist = Math.hypot(ball.x - striker.x, ball.y - striker.y);
          const stretch = !serveHit && !diving && contactDist > REACH + 0.2;
          triggerSwing(rig, kind, ball.z < 2.5, now, stretch, power, true);
          rig.swingMs /= Math.sqrt(heat); // hot rallies swing faster too
          // dives track the LIVE ball with the arm; grounded strokes lock
          // onto the frozen contact point
          rig.contactPoint = diving ? null : ballPos3.clone();
        }
        if (ball.spinX !== 0) {
          // SCREW SHOT launch: white-hot detonation — gold flame, purple
          // arcs, and a shockwave ring racing out across the court
          spawnBurst(ballPos3, 0xffffff, 18, 20, 0.9, -20);
          spawnBurst(ballPos3, 0xffd040, 28, 30, 0.8, -25);
          spawnBurst(ballPos3, 0xff7020, 20, 24, 0.7, -35);
          spawnBurst(ballPos3, 0xc060ff, 20, 34, 0.85, -30);
          shockStart = now;
          shockPos.set(ballPos3.x, 0, ballPos3.z);
          addShake(2.2);
          playScrew(panOf(ballPos3.x));
          window.dispatchEvent(new CustomEvent('dt-hit', { detail: { power: 1, screw: true } }));
        } else {
          impactFX(ballPos3, power);
        }
        // hitstop: a freeze-frame hit lands harder — extra crunch on top of
        // the impact package, scaled to how long the server holds the ball
        if ((ball.freezeTicks ?? 0) > 0) {
          addShake(0.6 + (ball.freezeTicks ?? 0) * 0.08);
          spawnBurst(ballPos3, 0xffffff, 18, 20, 0.9, -10);
        }
        bouncesSinceHit = 0;
      }
      prevLastHitSide = ball.lastHitSide;
    } else {
      prevLastHitSide = ball.lastHitSide;
    }
    // bounce: server flips vz to upward when the ball hits the court
    if (prevBallVz < -8 && ball.vz > 1 && ball.z < 2) {
      const dust = SURFACES[scene.court] ?? SURFACES[0];
      spawnBurst(
        new THREE.Vector3(ballPos3.x, 0.15, ballPos3.z),
        new THREE.Color(dust.inner).getHex(),
        10, 9, 0.85, -30
      );
      playBounce(panOf(ballPos3.x), BOUNCE_BRIGHT[scene.court] ?? 1);
      bouncesSinceHit++;
      // landed IN but within a racket's width of a line — the crowd gasps
      // at the close call (mirrors the server's in/out margins)
      if (scene.phase === PHASE_RALLY && bouncesSinceHit === 1 && ball.rallyHits > 0) {
        const mx = COURT_HALF_WID + LINE_MARGIN - Math.abs(ball.x);
        const my = COURT_HALF_LEN + LINE_MARGIN - Math.abs(ball.y);
        if (mx >= 0 && my >= 0 && Math.min(mx, my) < 1.6) crowdOoh(0.6);
      }
    }
    prevBallVz = ball.vz;
    // ball appearing during the serve phase = the toss going up
    if (!prevBallActive && scene.phase === PHASE_SERVE) playToss();
    prevBallActive = true;
  } else {
    prevBallActive = false;
    prevLastHitSide = -1;
    prevBallVz = 0;
  }
  prevPhase = scene.phase;

  // --- players --------------------------------------------------------------
  auraRing.visible = false; // re-shown below while a finisher is charging
  for (let slot = 0; slot < playerRigs.length; slot++) {
    const rig = playerRigs[slot];
    const pl = scene.players.find(p => (p.rigSlot ?? p.side) === slot);
    if (!pl) {
      rig.root.visible = false;
      continue;
    }
    const side = pl.side;
    rig.root.visible = true;
    const character = CHARACTERS[pl.characterId ?? 0];
    if (character) applyCharacter(rig, character);
    const pos = toThree(flip, pl.x, pl.y, 0);
    rig.root.position.x = pos.x;
    rig.root.position.z = pos.z;
    // stride phase advances with the ground actually covered this frame, so
    // the foot cycle stays anchored to the floor at any speed (teleports —
    // serve resets, camera flips — are ignored rather than spinning the legs)
    const stepDist = Math.hypot(pos.x - rig.prevPX, pos.z - rig.prevPZ);
    rig.prevPX = pos.x;
    rig.prevPZ = pos.z;
    if (stepDist < 6) rig.runPhase += stepDist * RUN_STRIDE_RATE;
    const near = pos.z > 0;
    const baseYaw = near ? Math.PI : 0;

    // whiff: swing window expired without a contact event
    if (rig.prevSwingTicks > 0 && pl.swingTicks === 0 && rig.swingStart < 0 && ball) {
      triggerSwing(rig, swingSideKind(pl, ball, flip), ball.z < 2.5, now, false, 0.4);
      rig.contactPoint = null;
      playWhoosh(0.5);
    }
    if (rig.prevSwingTicks === 0 && pl.swingTicks > 0) rig.windupStart = now;
    rig.prevSwingTicks = pl.swingTicks;

    const moving = pl.dirX !== 0 || pl.dirY !== 0;
    const isServer =
      scene.phase === PHASE_SERVE && (scene.serverRigSlot ?? scene.servingSide) === slot;
    const tossing = isServer && !!ball;
    const striking = pl.swingTicks > 0 || rig.swingStart >= 0 || tossing;

    // facing priority: ball while striking > movement direction > face the net
    let yawTarget = baseYaw;
    let yawRate = 10;
    if (striking && ballPos3) {
      const full = Math.atan2(ballPos3.x - pos.x, ballPos3.z - pos.z);
      // stay between net-facing and square-to-ball (tennis players turn ~halfway)
      yawTarget = baseYaw + wrapAngle(full - baseYaw) * 0.55;
      yawRate = 18;
    } else if (moving) {
      const mv = toThree(flip, pl.dirX, pl.dirY, 0);
      yawTarget = Math.atan2(mv.x, mv.z);
      yawRate = 12;
    }
    rig.yaw = blendAngle(rig.yaw, yawTarget, yawRate, dt);

    // hitstop: the hitter is locked in place server-side — hold their swing
    // at the contact frame for the whole freeze instead of following through
    if (ball && (ball.freezeTicks ?? 0) > 0 && ball.lastHitSide === side && rig.swingStart >= 0) {
      rig.swingStart += dt * 1000;
    }

    let target: Pose;
    let rate = 12;
    let swingT = -1;
    if (rig.swingStart >= 0) {
      const t = (now - rig.swingStart) / rig.swingMs;
      if (t >= 1) {
        rig.swingStart = -1;
        rig.contactPoint = null;
        target = moving ? runPose(rig.runPhase, pl.dirX) : readyPose(now, rig.runSeed);
      } else {
        swingT = t;
        target = swingPose(rig.swingKind, t, rig.swingLow, rig.swingPower);
        rate = 30; // snap through the stroke
      }
    } else if (tossing) {
      target = tossPose(ball ? ball.z : 6);
      rate = 14;
    } else if (pl.swingTicks > 0 && ball) {
      target = windupPose(ball.z > 5.5 ? 'over' : swingSideKind(pl, ball, flip), ball.z < 2.5);
      // the coil deepens the longer the button is held — never a frozen pose
      const coil = 0.85 + 0.25 * Math.min(1, (now - rig.windupStart) / 300);
      target.twist *= coil;
      target.shRz *= coil;
      rate = 22;
      // FINISHER armed (HIT+LOB on a full meter): full power-up flare —
      // a golden flame column, purple arcs, a pulsing ground ring, and a
      // low rumble, so the charge reads from across the court
      if (pl.swingKind === 2) {
        // a fresh charge rolls a random aura palette for this buildup
        if (now - lastChargeAt[slot] > 250) {
          chargePalette[slot] = Math.floor(Math.random() * AURA_PALETTES.length);
        }
        lastChargeAt[slot] = now;
        const [flameCol, arcCol] = AURA_PALETTES[chargePalette[slot]];
        if (now - lastChargeSpawn > 28) {
          lastChargeSpawn = now;
          spawnBurst(
            new THREE.Vector3(
              pos.x + Math.sin(now / 31 + side) * 0.9,
              0.6 + Math.abs(Math.sin(now / 53)) * 2.6,
              pos.z + Math.cos(now / 41 + side) * 0.9
            ),
            flameCol, 3, 7, 0.95, 42 // flames rise off the body
          );
          spawnBurst(
            new THREE.Vector3(
              pos.x + Math.cos(now / 23 + side * 2) * 1.1,
              1.4 + Math.abs(Math.sin(now / 67)) * 2.0,
              pos.z + Math.sin(now / 37 + side) * 1.1
            ),
            arcCol, 2, 9, 0.9, 30
          );
        }
        auraRing.visible = true;
        auraRing.position.set(pos.x, 0.12, pos.z);
        const ringPulse = 1 + 0.22 * Math.sin(now / 85);
        auraRing.scale.set(ringPulse, ringPulse, ringPulse);
        const auraMat = auraRing.material as THREE.MeshBasicMaterial;
        auraMat.opacity = 0.42 + 0.18 * Math.sin(now / 60);
        auraMat.color.setHex(Math.sin(now / 150) > 0 ? flameCol : arcCol);
        addShake(0.02);
      }
    } else if (moving) {
      target = runPose(rig.runPhase, pl.dirX);
      rate = 16;
    } else {
      target = readyPose(now, rig.runSeed);
    }

    // keep the feet running under an upper-body stroke (composite animation)
    if (moving && (rig.swingStart >= 0 || pl.swingTicks > 0 || tossing)) {
      const legs = runPose(rig.runPhase, pl.dirX);
      target.thighL = legs.thighL;
      target.calfL = legs.calfL;
      target.thighR = legs.thighR;
      target.calfR = legs.calfR;
      target.crouch = Math.max(target.crouch, legs.crouch);
    }

    // dive bookkeeping: a fresh lunge starts the jump timeline. The size
    // comes from the server's recovery ticks; the heading comes from where
    // the leap actually travels (toward the ball) — a ball out front means
    // a head-first forward dive, never a sideways flop.
    if (pl.lungeTicks > 0 && rig.prevLunge === 0) {
      rig.diveStart = now;
      rig.diveDir = rig.swingKind === 'back' ? 1 : -1;
      rig.diveKind = pl.lungeTicks >= 28 ? 2 : pl.lungeTicks >= 20 ? 1 : 0;
      rig.diveMs = [420, 800, 1000][rig.diveKind] / heat; // hot rallies: faster jumps
      const sv = toThree(flip, pl.serverX, pl.serverY, 0);
      const ddx = sv.x - rig.root.position.x;
      const ddz = sv.z - rig.root.position.z;
      rig.diveYaw =
        ddx * ddx + ddz * ddz > 0.05 ? Math.atan2(ddx, ddz) : rig.yaw;
      rig.diveFromX = rig.root.position.x;
      rig.diveFromZ = rig.root.position.z;
      rig.diveLanded = false;
    }
    rig.prevLunge = pl.lungeTicks;
    let diveT = rig.diveStart >= 0 ? (now - rig.diveStart) / rig.diveMs : -1;
    if (diveT > 1) {
      rig.diveStart = -1;
      diveT = -1;
    }

    // reach-to-hit: lean the whole body into the shot (no dive)
    if (rig.swingStretch && rig.swingStart >= 0 && diveT < 0) {
      target.leanS = rig.swingKind === 'back' ? 0.6 : -0.6;
      target.crouch = Math.max(target.crouch, 0.3);
      target.thighL = rig.swingKind === 'fore' ? -0.8 : 0.35;
      target.thighR = rig.swingKind === 'fore' ? 0.35 : -0.8;
    }

    const landT = rig.diveKind === 0 ? 0.5 : 0.34; // when the body touches down
    const slideEndT = 0.5; // brief slide only — back on their feet fast
    if (diveT >= 0 && diveT < landT) {
      // airborne: superman reach along the leap direction
      target = diveFlightPose();
      rate = 24;
    } else if (rig.diveKind > 0 && diveT >= landT && diveT < slideEndT) {
      // grounded slide: stay stretched, limbs settle with lag
      target = diveFlightPose();
      rate = 10;
    } else if (diveT >= landT) {
      // scrambling back to their feet
      target.crouch = Math.max(target.crouch, rig.diveKind === 0 ? 0.35 : 0.5);
      target.leanF = 0.45;
    }
    applyPose(rig, target, rate, dt, rig.yaw, now);

    // dive root motion: turn to the leap heading, pitch head-first along it,
    // slide briefly, then get up — no roll, motion stays continuous
    if (diveT >= 0) {
      const pitchMax = rig.diveKind === 0 ? 0.55 : Math.PI / 2;
      const pitch =
        rig.diveKind === 0
          ? ch(diveT, [[0, 0], [0.22, pitchMax], [0.5, pitchMax], [0.78, 0], [1, 0]])
          : ch(diveT, [[0, 0], [0.1, 0.4], [0.26, pitchMax], [slideEndT, pitchMax], [0.72, 0], [1, 0]]);
      const apex = [0.8, 1.3, 1.6][rig.diveKind];
      const height = ch(diveT, [
        [0, 0], [0.16, apex], [landT, 0.5], [slideEndT, 0.32], [0.68, 0.02], [1, 0],
      ]);

      // explosive leap travel: the body reaches the ball FAST (within the
      // first ~55% of the flight window), because we move the player to the
      // ball — never the ball to the player
      const svNow = toThree(flip, pl.serverX, pl.serverY, 0);
      if (diveT < landT) {
        const kRaw = Math.min(1, diveT / (landT * 0.55));
        const k = 1 - Math.pow(1 - kRaw, 2);
        rig.root.position.x = THREE.MathUtils.lerp(rig.diveFromX, svNow.x, k);
        rig.root.position.z = THREE.MathUtils.lerp(rig.diveFromZ, svNow.z, k);
      } else {
        rig.root.position.x = svNow.x;
        rig.root.position.z = svNow.z;
      }

      if (diveT >= landT && !rig.diveLanded) {
        rig.diveLanded = true;
        const dust = SURFACES[scene.court] ?? SURFACES[0];
        spawnBurst(
          new THREE.Vector3(rig.root.position.x, 0.3, rig.root.position.z),
          new THREE.Color(dust.inner).getHex(),
          rig.diveKind === 0 ? 8 : 14, rig.diveKind === 0 ? 8 : 11, 0.8, -35
        );
        if (rig.diveKind > 0) addShake(0.35); // only big layouts rattle the camera
        playDiveLand(panOf(rig.root.position.x));
      }
      _dq1.setFromAxisAngle(_UP, rig.diveYaw);
      _dq2.setFromAxisAngle(_RIGHT, pitch);
      rig.root.quaternion.copy(_dq1).multiply(_dq2);
      rig.root.position.y = height;

      // the racket chases the LIVE ball through the early flight — with the
      // explosive travel the strings meet it within the first frames
      if (ball && ballPos3 && diveT < 0.3) {
        const w = (1 - diveT / 0.3) * 0.95;
        if (w > 0.05) solveArmIK(rig, toThree(flip, ball.x, ball.y, ball.z), w);
      }
    } else {
      rig.root.rotation.x = 0;
      rig.root.rotation.z = 0;
    }

    // IK: through the contact window, pull the racket head onto the ball
    // Contact solve, grounded strokes only (the dive owns its own motion):
    // target the FROZEN contact point (not the departing ball), shift the
    // whole body toward it so the racket must reach, then IK the arm on.
    if (swingT >= 0.05 && swingT <= 0.55 && ball && ballPos3 && pl.lungeTicks === 0) {
      const ikTarget = rig.contactPoint ?? toThree(flip, ball.x, ball.y, ball.z);
      const peak = 1 - Math.abs(swingT - 0.28) / 0.27;
      const w = THREE.MathUtils.clamp(peak, 0, 1);
      if (w > 0.02) {
        const dx = ikTarget.x - rig.root.position.x;
        const dz = ikTarget.z - rig.root.position.z;
        const hDist = Math.hypot(dx, dz);
        const over = Math.min(2.5, Math.max(0, hDist - 2.4));
        if (over > 0 && hDist > 0.01) {
          // programmatic step-in: the body moves so the strings meet the ball
          rig.root.position.x += (dx / hDist) * over * w;
          rig.root.position.z += (dz / hDist) * over * w;
        }
        solveArmIK(rig, ikTarget, w * 0.95);
      }
    }

    // eyes on the ball: the head smoothly tracks it (not while tumbling)
    if (ballPos3 && diveT < 0) {
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

  // --- ball: ALWAYS its true trajectory — we never manipulate the ball ------
  if (ball) {
    const bp = toThree(flip, ball.x, ball.y, ball.z);
    ballMesh.visible = true;
    ballMesh.position.copy(bp);
    // screw shots burn white-hot with a flame tail; normal balls stay
    // tennis-yellow
    const screwing = ball.spinX !== 0;
    // hitstop: the pinned ball strobes white so the freeze reads as impact,
    // not lag
    const frozen = (ball.freezeTicks ?? 0) > 0;
    const strobe = frozen && Math.floor(now / 50) % 2 === 0;
    const ballMat = ballMesh.material as THREE.MeshLambertMaterial;
    ballMat.color.setHex(strobe ? 0xffffff : screwing ? 0xffc850 : COLORS.ball);
    ballMat.emissive.setHex(strobe ? 0xffffff : screwing ? 0xff4400 : 0x556600);
    if (gfx.trail) {
      for (let i = 0; i < trailMeshes.length; i++) {
        const tm = trailMeshes[i].material as THREE.MeshBasicMaterial;
        tm.color.setHex(screwing ? FLAME_TRAIL[i] : COLORS.ball);
        tm.opacity = screwing ? 0.55 * (1 - i / 8) : 0.22 * (1 - i / 7);
        trailMeshes[i].scale.setScalar(screwing ? 1.7 : 1);
      }
    }
    if (screwing) {
      // the fireball throws real light on the court and sheds flame as it flies
      ballLight.position.set(bp.x, bp.y + 0.2, bp.z);
      ballLight.intensity = 60 + Math.sin(now / 37) * 18;
      if (now - lastFlameSpawn > 26) {
        lastFlameSpawn = now;
        spawnBurst(
          bp,
          FLAME_COLORS[Math.floor(Math.random() * FLAME_COLORS.length)],
          3, 7, 0.85, 30 // positive "gravity": embers drift upward
        );
      }
    } else {
      ballLight.intensity = 0;
    }
    // stretch along velocity at speed for a sense of pace (not while frozen —
    // the loaded launch velocity would stretch a ball that isn't moving)
    const vel3 = new THREE.Vector3(ball.vx * flip, ball.vz, -ball.vy * flip);
    const spd = vel3.length();
    if (spd > 25 && !frozen) {
      ballMesh.lookAt(bp.clone().add(vel3));
      const st = 1 + Math.min(0.55, spd / 150);
      ballMesh.scale.set(1 / Math.sqrt(st), 1 / Math.sqrt(st), st);
    } else {
      ballMesh.rotation.set(0, 0, 0);
      ballMesh.scale.set(1, 1, 1);
    }
    // the fireball swells and throbs
    if (screwing) ballMesh.scale.multiplyScalar(1.22 + Math.sin(now / 45) * 0.08);
    // frozen ball swells and quivers in place for the whole hold
    if (frozen) ballMesh.scale.multiplyScalar(1.3 + Math.sin(now / 28) * 0.12);
    ballBlob.visible = true;
    ballBlob.position.set(bp.x, 0.02, bp.z);
    const sc = Math.max(0.4, 1 - ball.z / 30);
    ballBlob.scale.set(sc, sc, sc);

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

  // --- VAR review: Hawk-Eye flight tube + bounce mark -----------------------
  const vr = scene.varReview;
  if (vr && vr.trail.length >= 2) {
    if (varTrailFor !== vr.trail) {
      // one build per replay: the full path is known up front, playback just
      // reveals it via drawRange
      varTrailFor = vr.trail;
      if (varTrailMesh) {
        scene3.remove(varTrailMesh);
        varTrailMesh.geometry.dispose();
        (varTrailMesh.material as THREE.Material).dispose();
      }
      const pts = vr.trail.map(p => toThree(flip, p.x, p.y, Math.max(0.12, p.z)));
      varTrailSegs = Math.min(240, Math.max(16, pts.length * 3));
      varTrailMesh = new THREE.Mesh(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3(pts), varTrailSegs, 0.32, VAR_TRAIL_RADIAL, false
        ),
        new THREE.MeshBasicMaterial({
          color: 0x38c8ff, transparent: true, opacity: 0.8, depthWrite: false,
        })
      );
      scene3.add(varTrailMesh);
    }
    varTrailMesh!.visible = true;
    const seg = Math.floor(THREE.MathUtils.clamp(vr.progress, 0, 1) * varTrailSegs);
    varTrailMesh!.geometry.setDrawRange(0, seg * VAR_TRAIL_RADIAL * 6);
  } else if (varTrailMesh) {
    varTrailMesh.visible = false;
  }
  if (vr?.mark) {
    varMarkGroup.visible = true;
    const mp = toThree(flip, vr.mark.x, vr.mark.y, 0);
    varMarkGroup.position.set(mp.x, 0.02, mp.z);
    const dv = toThree(flip, vr.mark.dx, vr.mark.dy, 0);
    if (Math.hypot(dv.x, dv.z) > 0.01) varMarkGroup.rotation.y = Math.atan2(-dv.z, dv.x);
    varMarkGroup.scale.set(1.65, 1, 1); // impact print smears along the travel
    const mat = varMarkDisc.material as THREE.MeshBasicMaterial;
    mat.color.setHex(
      vr.call === 'OUT' ? 0xff4030
      : vr.call === 'NET' ? 0xffb020
      : vr.call === 'IN' ? 0x30d860
      : 0xf0f0f0
    );
    mat.opacity = 0.92 + 0.07 * Math.sin(now / 150); // near-solid print, subtle pulse
  } else {
    varMarkGroup.visible = false;
  }

  if (vr?.overhead && vr.mark) {
    // HAWK-EYE VERDICT CAM: cut to a near-top-down shot over the mark and
    // ease down toward it while the call holds on screen
    replayLook = null;
    const varFov = fovForAspect(38);
    if (Math.abs(camera.fov - varFov) > 0.05) {
      camera.fov = varFov;
      camera.updateProjectionMatrix();
    }
    const mp = toThree(flip, vr.mark.x, vr.mark.y, 0);
    if (varCamH <= 0) varCamH = 46; // fresh cut — start high
    varCamH += (24 - varCamH) * (1 - Math.exp(-1.5 * dt));
    // slight tilt (camera offset along z) keeps depth cues and a valid up axis
    camera.position.set(mp.x, varCamH, mp.z + varCamH * 0.3);
    camera.lookAt(mp.x, 0, mp.z);
  } else if (scene.replayCam) {
    // broadcast side camera for replays — steady, no shake
    const replayFov = fovForAspect(42);
    if (Math.abs(camera.fov - replayFov) > 0.05) {
      camera.fov = replayFov;
      camera.updateProjectionMatrix();
    }
    camera.position.set(64, 15, 8);
    // follow the ball: ease the look-at onto the flight so the landing —
    // and how close it came to the line — stays centered in frame
    const bt = scene.ball
      ? toThree(scene.flip, scene.ball.x, scene.ball.y, Math.min(scene.ball.z, 12))
      : null;
    if (bt) {
      if (!replayLook) replayLook = bt.clone();
      else replayLook.lerp(bt, 1 - Math.exp(-6 * dt));
    } else if (!replayLook) {
      replayLook = new THREE.Vector3(0, 2.5, 0);
    }
    camera.lookAt(replayLook);
    varCamH = 0;
  } else {
    replayLook = null;
    varCamH = 0;
    // rally heat subtly zooms the camera in for intensity
    const baseFov = 46 + (heat - 1) * 4;
    const targetFov = fovForAspect(baseFov);
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }
    const sx = (Math.sin(now * 0.081) + Math.sin(now * 0.023)) * 0.5 * shakeAmp;
    const sy = (Math.sin(now * 0.097 + 2) + Math.sin(now * 0.031 + 1)) * 0.5 * shakeAmp;
    camera.position.set(CAM_POS.x + sx, CAM_POS.y + sy, CAM_POS.z + sx * 0.4);
    camera.lookAt(CAM_TARGET.x + sx * 0.5, CAM_TARGET.y + sy * 0.5, CAM_TARGET.z);
    // Portrait: the widened frame centers on the landscape framing, leaving
    // most of the extra height as empty sky — pitch down through part of the
    // gained angle so the court rides high and the foreground (where the
    // touch controls sit) takes the slack instead.
    if (targetFov > baseFov) {
      camera.rotateX(-THREE.MathUtils.degToRad((targetFov - baseFov) * 0.14));
    }
  }

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

// Forehand or backhand, from which side the ball approaches in facing space.
function swingSideKind(pl: RenderPlayer, ball: RenderBall, flip: number): SwingKind {
  const facing = pl.y * flip < 0 ? -1 : 1; // near player faces -z
  const localX = (ball.x - pl.x) * flip * -facing;
  return localX >= 0 ? 'fore' : 'back';
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
