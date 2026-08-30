// ---------------------------------------------------------------------------
// Graphics options — the knobs that trade looks for frame rate.
//
// Everything here is pure state: load / save / notify. The WebGL side is
// applied by render.ts (which subscribes on init) and the DOM side — the VHS
// overlay — by main.ts, which also owns the options panel.
// ---------------------------------------------------------------------------

export interface GraphicsSettings {
  /** Internal render scale (1 = native canvas size). Biggest single win. */
  resolution: number;
  /** 0 off · 1 low (1024, hard edges) · 2 high (2048, filtered). */
  shadows: number;
  /** MSAA. Baked into the WebGL context, so changing it rebuilds it. */
  antialias: boolean;
  /** Impact sparks, dust puffs, screw-shot bursts. */
  particles: boolean;
  /** Motion trail spheres behind the ball. */
  trail: boolean;
  /** Crowd stands, hoardings, umpire chair, court surface noise. */
  detail: boolean;
  /** ACES tone mapping + the canvas color wash. */
  grade: boolean;
  /**
   * The VHS CSS overlay: scanlines, vignette, flicker, tracking band.
   * A look rather than a quality knob, and a divisive one — off in every
   * preset, so it only ever shows up because someone asked for it.
   */
  vhs: boolean;
  /**
   * Render-loop cap in frames per second; 0 = every display refresh.
   * The server ticks at 20 Hz, so extra frames only re-sample the same
   * interpolation — the cap keeps 144/240 Hz displays from burning GPU.
   */
  fpsCap: number;
}

export type PresetName = 'low' | 'medium' | 'high';

export const PRESETS: Record<PresetName, GraphicsSettings> = {
  high: {
    resolution: 1, shadows: 2, antialias: true,
    particles: true, trail: true, detail: true, grade: true, vhs: false, fpsCap: 120,
  },
  medium: {
    resolution: 0.75, shadows: 1, antialias: false,
    particles: true, trail: true, detail: true, grade: true, vhs: false, fpsCap: 120,
  },
  low: {
    resolution: 0.5, shadows: 0, antialias: false,
    particles: false, trail: false, detail: false, grade: false, vhs: false, fpsCap: 30,
  },
};

export const RESOLUTIONS = [1, 0.75, 0.5];
export const FPS_CAPS = [0, 120, 60, 30];

const STORE_KEY = 'dt_gfx';

// Default a notch down unless the machine is clearly beefy — every option is
// still one click away, this only picks where the slider starts. MEDIUM keeps
// all of the juice (particles, trail, crowd, grade); it only softens the
// pixel-pushing knobs.
function autoPreset(): PresetName {
  const cores = navigator.hardwareConcurrency ?? 8;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const mem = (navigator as any).deviceMemory ?? 8; // Chrome-only, capped at 8
  if (mem <= 2) return 'low';
  return coarse || cores <= 6 || mem <= 4 ? 'medium' : 'high';
}

function sanitize(raw: any, base: GraphicsSettings): GraphicsSettings {
  if (!raw || typeof raw !== 'object') return { ...base };
  const num = (v: any, allowed: number[], fallback: number) =>
    allowed.includes(Number(v)) ? Number(v) : fallback;
  const bool = (v: any, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    resolution: num(raw.resolution, RESOLUTIONS, base.resolution),
    shadows: num(raw.shadows, [0, 1, 2], base.shadows),
    antialias: bool(raw.antialias, base.antialias),
    particles: bool(raw.particles, base.particles),
    trail: bool(raw.trail, base.trail),
    detail: bool(raw.detail, base.detail),
    grade: bool(raw.grade, base.grade),
    vhs: bool(raw.vhs, base.vhs),
    fpsCap: num(raw.fpsCap, FPS_CAPS, base.fpsCap),
  };
}

function load(): GraphicsSettings {
  const base = PRESETS[autoPreset()];
  try {
    const stored = localStorage.getItem(STORE_KEY);
    return stored ? sanitize(JSON.parse(stored), base) : { ...base };
  } catch {
    return { ...base };
  }
}

let current: GraphicsSettings = load();

type Listener = (next: GraphicsSettings, prev: GraphicsSettings) => void;
const listeners: Listener[] = [];

export function getGraphics(): GraphicsSettings {
  return current;
}

/** Which preset the current settings match, or 'custom' for a mix. */
export function presetOf(s: GraphicsSettings = current): PresetName | 'custom' {
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    const p = PRESETS[name];
    if ((Object.keys(p) as (keyof GraphicsSettings)[]).every(k => p[k] === s[k])) return name;
  }
  return 'custom';
}

export function setGraphics(patch: Partial<GraphicsSettings>) {
  const prev = current;
  const next: GraphicsSettings = { ...prev, ...patch };
  if ((Object.keys(next) as (keyof GraphicsSettings)[]).every(k => next[k] === prev[k])) return;
  current = next;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — settings just don't persist */
  }
  for (const fn of listeners) fn(next, prev);
}

export function applyPreset(name: PresetName) {
  setGraphics(PRESETS[name]);
}

export function onGraphicsChange(fn: Listener) {
  listeners.push(fn);
}
