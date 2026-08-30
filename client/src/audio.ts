// Tiny synthesized SFX — no assets needed. The context resumes on the
// first user gesture (browser autoplay policy).
let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  return ctx;
}

export function unlockAudio() {
  const a = ac();
  if (a && a.state === 'suspended') a.resume().catch(() => {});
}

// ---------------------------------------------------------------------------
// Audio settings — pure state like graphics.ts: load / save / notify. The
// values are applied to the mix buses below; main.ts owns the panel rows.
// ---------------------------------------------------------------------------
export interface AudioSettings {
  /** Overall volume 0..1; 0 = muted. */
  master: number;
  /** Game sounds: hits, bounces, jingles, UI. */
  sfx: number;
  /** Crowd ambience and reactions. */
  crowd: number;
}

export const VOLUME_STEPS = [0, 0.25, 0.5, 0.75, 1];
const AUDIO_STORE_KEY = 'df_audio';
const AUDIO_DEFAULTS: AudioSettings = { master: 1, sfx: 1, crowd: 1 };

function sanitizeAudio(raw: any): AudioSettings {
  const vol = (v: any, fallback: number) =>
    VOLUME_STEPS.includes(Number(v)) ? Number(v) : fallback;
  if (!raw || typeof raw !== 'object') return { ...AUDIO_DEFAULTS };
  return {
    master: vol(raw.master, AUDIO_DEFAULTS.master),
    sfx: vol(raw.sfx, AUDIO_DEFAULTS.sfx),
    crowd: vol(raw.crowd, AUDIO_DEFAULTS.crowd),
  };
}

let audioCur: AudioSettings = (() => {
  try {
    const stored = localStorage.getItem(AUDIO_STORE_KEY);
    return stored ? sanitizeAudio(JSON.parse(stored)) : { ...AUDIO_DEFAULTS };
  } catch {
    return { ...AUDIO_DEFAULTS };
  }
})();

const audioListeners: ((next: AudioSettings) => void)[] = [];

export function getAudio(): AudioSettings {
  return audioCur;
}

export function setAudio(patch: Partial<AudioSettings>) {
  const next = { ...audioCur, ...patch };
  if (next.master === audioCur.master && next.sfx === audioCur.sfx && next.crowd === audioCur.crowd)
    return;
  audioCur = next;
  try {
    localStorage.setItem(AUDIO_STORE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — settings just don't persist */
  }
  applyVolumes();
  for (const fn of audioListeners) fn(next);
}

export function onAudioChange(fn: (next: AudioSettings) => void) {
  audioListeners.push(fn);
}

let volBeforeMute = 1;
/** Master mute toggle (the M key). Returns true if now muted. */
export function toggleMute(): boolean {
  if (audioCur.master > 0) {
    volBeforeMute = audioCur.master;
    setAudio({ master: 0 });
    return true;
  }
  setAudio({ master: volBeforeMute || 1 });
  return false;
}

// ---------------------------------------------------------------------------
// Mix chain: everything routes through one master compressor so stacked
// moments (cheer + hit + jingle) glue together instead of clipping, then a
// master volume gain that the settings drive.
// ---------------------------------------------------------------------------
const CROWD_BASE = 1.6; // crowd bus level at full crowd volume

let masterNode: DynamicsCompressorNode | null = null;
let volumeNode: GainNode | null = null;
let sfxNode: GainNode | null = null;

function applyVolumes() {
  const a = ctx;
  if (!a) return;
  const t = a.currentTime;
  if (volumeNode) volumeNode.gain.setTargetAtTime(audioCur.master, t, 0.03);
  if (sfxNode) sfxNode.gain.setTargetAtTime(audioCur.sfx, t, 0.03);
  if (crowdBus) crowdBus.gain.setTargetAtTime(CROWD_BASE * audioCur.crowd, t, 0.03);
}

function master(a: AudioContext): DynamicsCompressorNode {
  if (!masterNode) {
    masterNode = a.createDynamicsCompressor();
    masterNode.threshold.value = -16;
    masterNode.knee.value = 12;
    masterNode.ratio.value = 5;
    volumeNode = a.createGain();
    volumeNode.gain.value = audioCur.master;
    masterNode.connect(volumeNode).connect(a.destination);
  }
  return masterNode;
}

function sfx(a: AudioContext): GainNode {
  if (!sfxNode) {
    sfxNode = a.createGain();
    sfxNode.gain.value = audioCur.sfx;
    sfxNode.connect(master(a));
  }
  return sfxNode;
}

// SFX outlet, optionally panned toward the event's pitch position (-1..1).
function out(a: AudioContext, pan: number): AudioNode {
  if (!pan) return sfx(a);
  const p = a.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(sfx(a));
  return p;
}

function noiseBurst(duration: number, gainV: number, filterHz: number, pan = 0) {
  const a = ac();
  if (!a || a.state !== 'running') return;
  const frames = Math.floor(a.sampleRate * duration);
  const buf = a.createBuffer(1, frames, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterHz;
  const gain = a.createGain();
  gain.gain.value = gainV;
  src.connect(filter).connect(gain).connect(out(a, pan));
  src.start();
}

function tone(
  freq: number,
  duration: number,
  gainV: number,
  type: OscillatorType = 'sine',
  slide = 0,
  pan = 0,
  delay = 0
) {
  const a = ac();
  if (!a || a.state !== 'running') return;
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + duration);
  const gain = a.createGain();
  gain.gain.setValueAtTime(gainV, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(out(a, pan));
  osc.start(t0);
  osc.stop(t0 + duration);
}

// One-shot noise with a filter sweep — whooshes, booms, splashes.
function sweep(
  dur: number,
  peak: number,
  filterType: BiquadFilterType,
  f0: number,
  f1: number,
  attack = 0.4,
  q = 1,
  pan = 0
) {
  const a = ac();
  if (!a || a.state !== 'running') return;
  const frames = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, frames, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = filterType;
  f.Q.value = q;
  const t0 = a.currentTime;
  f.frequency.setValueAtTime(f0, t0);
  f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + dur * attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(out(a, pan));
  src.start();
  src.stop(t0 + dur);
}

// ---------------------------------------------------------------------------
// Crowd — synthesized stadium ambience + reactions, all procedural.
//
// A looping "murmur" buffer (lowpassed noise, voice-band) feeds an always-on
// ambience bed whose volume/brightness follows a hype level 0..1 that main.ts
// recomputes every frame from match state. One-shot reactions (cheer, roar,
// ooh, groan) reuse the same murmur buffer through their own envelopes, plus
// a procedural applause buffer (random clap impulses) and whistle tones.
// ---------------------------------------------------------------------------
let crowdBus: GainNode | null = null;

function bus(a: AudioContext): GainNode {
  if (!crowdBus) {
    crowdBus = a.createGain();
    crowdBus.gain.value = CROWD_BASE * audioCur.crowd;
    crowdBus.connect(master(a));
  }
  return crowdBus;
}

// tone(), but into the crowd bus so the crowd volume setting governs it.
function crowdTone(freq: number, duration: number, gainV: number, type: OscillatorType, slide: number) {
  const a = ac();
  if (!a || a.state !== 'running') return;
  const t0 = a.currentTime;
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + duration);
  const gain = a.createGain();
  gain.gain.setValueAtTime(gainV, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(bus(a));
  osc.start(t0);
  osc.stop(t0 + duration);
}

// Voice-band noise loop — the raw material for murmur, oohs and cheers.
let murmurBuf: AudioBuffer | null = null;
function getMurmur(a: AudioContext): AudioBuffer {
  if (murmurBuf) return murmurBuf;
  const frames = Math.floor(a.sampleRate * 2);
  murmurBuf = a.createBuffer(1, frames, a.sampleRate);
  const d = murmurBuf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < frames; i++) {
    const w = Math.random() * 2 - 1;
    lp = lp * 0.96 + w * 0.04; // darken toward a vocal rumble
    d[i] = lp * 2.4 + w * 0.08;
  }
  // crossfade the tail into the head so the loop point doesn't click
  const xf = Math.min(400, frames >> 2);
  for (let i = 0; i < xf; i++) {
    const k = i / xf;
    d[frames - xf + i] = d[frames - xf + i] * (1 - k) + d[i] * k;
  }
  return murmurBuf;
}

// Applause: many short clap impulses, dense early, thinning toward the tail.
let applauseBuf: AudioBuffer | null = null;
function getApplause(a: AudioContext): AudioBuffer {
  if (applauseBuf) return applauseBuf;
  const dur = 2.6;
  const frames = Math.floor(a.sampleRate * dur);
  applauseBuf = a.createBuffer(1, frames, a.sampleRate);
  const d = applauseBuf.getChannelData(0);
  for (let c = 0; c < 200; c++) {
    const t = Math.pow(Math.random(), 1.6) * dur;
    const s = Math.floor(t * a.sampleRate);
    const len = Math.floor(a.sampleRate * (0.003 + Math.random() * 0.008));
    const amp = (0.25 + Math.random() * 0.5) * (1 - (t / dur) * 0.7);
    for (let i = 0; i < len && s + i < frames; i++) {
      d[s + i] += (Math.random() * 2 - 1) * amp * (1 - i / len);
    }
  }
  return applauseBuf;
}

// --- ambience bed ---------------------------------------------------------
const BED_MAX_GAIN = 0.085;
let bedGain: GainNode | null = null;
let bedFilter: BiquadFilterNode | null = null;
let curHype = 0;
let lastHypeAt = 0;
let bedWatchdog = 0;

function ensureBed(a: AudioContext) {
  if (bedGain) return;
  const src = a.createBufferSource();
  src.buffer = getMurmur(a);
  src.loop = true;
  bedFilter = a.createBiquadFilter();
  bedFilter.type = 'bandpass';
  bedFilter.frequency.value = 450;
  bedFilter.Q.value = 0.7;
  bedGain = a.createGain();
  bedGain.gain.value = 0;
  src.connect(bedFilter).connect(bedGain).connect(bus(a));
  src.start();
}

/**
 * Crowd energy 0..1, driven every frame while a match is on screen. The bed
 * fades itself out (watchdog) when the caller stops updating — menus, lobby,
 * leaving a match — so no explicit "stop" call is needed anywhere.
 */
export function crowdSetHype(level: number) {
  const a = ac();
  if (!a || a.state !== 'running') return;
  ensureBed(a);
  curHype = Math.min(1, Math.max(0, level));
  lastHypeAt = performance.now();
  bedGain!.gain.setTargetAtTime(0.014 + curHype * BED_MAX_GAIN, a.currentTime, 0.4);
  bedFilter!.frequency.setTargetAtTime(400 + curHype * 650, a.currentTime, 0.6);
  if (!bedWatchdog) {
    bedWatchdog = window.setInterval(() => {
      const stale = performance.now() - lastHypeAt > 600;
      if (stale && bedGain && a.state === 'running') {
        bedGain.gain.setTargetAtTime(0, a.currentTime, 0.8);
        curHype = 0;
      }
      // an excited crowd is never perfectly steady — random little surges
      if (!stale && curHype > 0.55 && Math.random() < 0.12) {
        crowdSwell(0.9, 0.03 + curHype * 0.05, 500, 750);
      }
      if (performance.now() - lastHypeAt > 6000) {
        clearInterval(bedWatchdog);
        bedWatchdog = 0;
      }
    }, 300);
  }
}

// --- one-shot reactions ---------------------------------------------------
function crowdSwell(dur: number, peak: number, f0: number, f1: number, attack = 0.25) {
  const a = ac();
  if (!a || a.state !== 'running') return;
  const t0 = a.currentTime;
  const src = a.createBufferSource();
  src.buffer = getMurmur(a);
  src.loop = true;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const filt = a.createBiquadFilter();
  filt.type = 'bandpass';
  filt.Q.value = 0.8;
  filt.frequency.setValueAtTime(f0, t0);
  filt.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + dur * attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(g).connect(bus(a));
  src.start();
  src.stop(t0 + dur + 0.05);
}

function playApplause(intensity: number, dur = 2.2) {
  const a = ac();
  if (!a || a.state !== 'running') return;
  const t0 = a.currentTime;
  const src = a.createBufferSource();
  src.buffer = getApplause(a);
  const hp = a.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1600;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.25 * intensity, t0 + 0.12);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(hp).connect(g).connect(bus(a));
  src.start();
  src.stop(t0 + dur + 0.05);
}

function whistle(delayMs: number) {
  setTimeout(() => {
    const a = ac();
    if (!a || a.state !== 'running') return;
    const t0 = a.currentTime;
    const osc = a.createOscillator();
    const base = 1700 + Math.random() * 400;
    osc.frequency.setValueAtTime(base, t0);
    osc.frequency.exponentialRampToValueAtTime(base * 1.4, t0 + 0.1);
    osc.frequency.exponentialRampToValueAtTime(base * 1.1, t0 + 0.32);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.035, t0 + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);
    osc.connect(g).connect(bus(a));
    osc.start();
    osc.stop(t0 + 0.4);
  }, delayMs);
}

let lastMurmurAt = 0;
/** Approving buzz for a bit of quality on the ball. intensity 0..1. */
export function crowdMurmur(intensity: number) {
  const t = performance.now();
  if (t - lastMurmurAt < 350) return;
  lastMurmurAt = t;
  crowdSwell(0.7, 0.03 + intensity * 0.06, 550, 850);
}

let lastOohAt = 0;
/** Sharp collective gasp — a near miss, a shot off the bar. */
export function crowdOoh(intensity = 0.7) {
  const t = performance.now();
  if (t - lastOohAt < 700) return;
  lastOohAt = t;
  crowdSwell(0.9, 0.05 + intensity * 0.1, 850, 460, 0.18);
  crowdTone(230, 0.5, 0.05 * intensity, 'sine', -70);
}

/** Sympathetic groan — a chance spurned, a goal conceded. */
export function crowdGroan() {
  crowdSwell(1.1, 0.09, 500, 300, 0.2);
  crowdTone(150, 0.7, 0.05, 'sawtooth', -55);
}

/** Chance/goal reaction. intensity 0..1 scales volume, length and applause. */
export function crowdCheer(intensity: number) {
  const i = Math.min(1, Math.max(0, intensity));
  crowdSwell(1.3 + i * 1.2, 0.08 + i * 0.16, 800 + i * 300, 600, 0.12);
  playApplause(0.35 + i * 0.65, 1.6 + i * 1.2);
  if (i > 0.6) whistle(150 + Math.random() * 250);
}

/** Full-throated eruption — a goal, or the final whistle. */
export function crowdRoar() {
  crowdSwell(2.8, 0.28, 950, 550, 0.1);
  crowdSwell(2.2, 0.12, 500, 350, 0.15);
  playApplause(1, 2.6);
  whistle(120);
  whistle(500 + Math.random() * 300);
}

// ---------------------------------------------------------------------------
// Game SFX
// ---------------------------------------------------------------------------

/** Boot on ball. power 0..1 scales thump + volume; pan follows the ball. */
export function playKick(pan = 0, power = 0.6) {
  const v = 0.92 + Math.random() * 0.16; // no two contacts sound identical
  noiseBurst(0.06, 0.35 + power * 0.35, (900 + power * 900) * v, pan);
  tone((150 + power * 120) * v, 0.1, 0.4, 'triangle', -70, pan);
  // a proper strike carries a chesty thump under the leather crack
  if (power > 0.5) tone(62, 0.13, 0.26 * power, 'sine', -22, pan);
}

/** Ball bouncing on the pitch. brightness ~ surface (grass duller than street). */
export function playBounce(pan = 0, brightness = 1) {
  const v = 0.9 + Math.random() * 0.2;
  noiseBurst(0.05, 0.25, 700 * brightness * v, pan);
  tone(110 * v, 0.07, 0.22, 'sine', -40, pan);
}

/** Studs-first slide across the turf. */
export function playSlide(pan = 0) {
  sweep(0.42, 0.22, 'bandpass', 1500, 260, 0.9, 1.4, pan);
  tone(80, 0.16, 0.22, 'sine', -30, pan);
}

/** GOAL! Stadium horn under the roar — the renderer fires the crowd itself. */
export function playGoal() {
  // air horn: two detuned saws holding, then a triumphant lift
  tone(196, 0.55, 0.16, 'sawtooth', 0);
  tone(294, 0.55, 0.12, 'sawtooth', 0);
  tone(392, 0.7, 0.14, 'sawtooth', 0, 0, 0.18);
  tone(784, 0.4, 0.07, 'sine', 0, 0, 0.34);
  noiseBurst(0.12, 0.2, 2200);
}

/** Result jingle when a goal lands — won: yours, else theirs. */
export function playGoalJingle(won: boolean) {
  if (won) {
    tone(523, 0.11, 0.22, 'triangle');
    tone(659, 0.11, 0.22, 'triangle', 0, 0, 0.09);
    tone(784, 0.22, 0.24, 'triangle', 0, 0, 0.18);
    tone(1568, 0.18, 0.06, 'sine', 0, 0, 0.18); // sparkle an octave up
  } else {
    tone(330, 0.13, 0.2, 'triangle');
    tone(262, 0.26, 0.2, 'triangle', -40, 0, 0.12);
  }
}

/** Air on a kick that found no ball. */
export function playWhoosh(power = 0.5) {
  sweep(0.22, 0.08 + power * 0.14, 'bandpass', 350, 1300, 0.45, 2);
}

/** Referee's whistle — kickoff, half-time, full time. */
export function playWhistle() {
  whistle(0);
}

/** Soft UI blip (settings auditions, menu feedback). */
export function playBlip() {
  noiseBurst(0.04, 0.1, 500);
  tone(480, 0.07, 0.06, 'sine', 70);
}

/** Match-start countdown blip (3-2-1)… */
export function playCountdown() {
  tone(440, 0.1, 0.18, 'square');
}

/** …and the GO. */
export function playGo() {
  tone(660, 0.09, 0.2, 'square');
  tone(880, 0.16, 0.2, 'square', 0, 0, 0.08);
}

/** Bright ring — a bet paying out, a level-up. */
export function playDing() {
  noiseBurst(0.02, 0.15, 4000);
  tone(1319, 0.4, 0.14, 'sine');
  tone(1985, 0.3, 0.08, 'sine'); // inharmonic partial = metallic ring
  tone(2637, 0.5, 0.05, 'sine', 0, 0, 0.02);
}

/** Ball off the woodwork. */
export function playPost() {
  noiseBurst(0.04, 0.4, 1800);
  tone(420, 0.35, 0.22, 'sine', -120);
  tone(1240, 0.2, 0.07, 'sine', -300);
}

/** Emote bubble pop. */
export function playEmote() {
  tone(740, 0.07, 0.07, 'sine', 140);
  tone(988, 0.09, 0.05, 'sine', 0, 0, 0.06);
}
