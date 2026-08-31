// Touch controls: a floating 8-way stick on the left, the three
// context-sensitive action buttons on the right, plus a SPRINT toggle. The
// buttons carry no fixed verb — main.ts renames them every frame with what a
// press does in the current situation (see setTouchActions).
//
// The stick is *floating* — it appears wherever the thumb lands inside the
// left zone rather than at a fixed spot, which is what makes it playable
// without looking down. Direction is quantised to the same 8 directions the
// keyboard produces, because the server takes sign(-1/0/1) per axis anyway
// (see sendDir in main.ts); analog magnitude would be thrown away.

type Handlers = {
  action: (button: number) => void;
  switchPlayer: () => void;
  chat: () => void;
};

const $ = (id: string) => document.getElementById(id)!;

let root: HTMLElement;
let stick: HTMLElement;
let knob: HTMLElement;
let home: HTMLElement;

// Live stick state. dir is what the frame loop reads every tick.
let stickPointer: number | null = null;
let originX = 0;
let originY = 0;
let dir: [number, number] = [0, 0];

// How far the knob travels, as a fraction of the stick's rendered diameter,
// and how far past centre counts as a direction. The stick is sized in CSS
// (cqmin, so it scales with the pitch), hence radius is measured, not fixed.
const TRAVEL = 0.4;
const DEADZONE = 0.38; // fraction of the travel radius
let radius = 46;

/** True once we're confident touch is how this device is being driven.
 * Strict on purpose: phones/tablets have a coarse primary pointer and no
 * fine pointer anywhere. A mouse-driven Windows PC often *reports* touch
 * (phantom digitizers make maxTouchPoints > 0, and a touchscreen makes
 * pointer:coarse match even with a mouse attached), so any machine with a
 * fine pointer starts without thumb controls and the first real touch
 * below turns them on. */
export let touchAvailable =
  matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;

/** Current 8-way direction from the stick, in game space (y up = +1). */
export function touchDir(): [number, number] {
  return dir;
}

let shown = false;

export function setTouchVisible(visible: boolean) {
  if (!root) return;
  const show = visible && touchAvailable;
  if (show === shown) return; // called every frame — don't disturb a held stick
  shown = show;
  root.classList.toggle('hidden', !show);
  document.body.classList.toggle('touch-playing', show);
  if (!show) {
    releaseStick();
    sprinting = false;
    sprintEl?.classList.remove('pressed');
  }
}

function releaseStick() {
  stickPointer = null;
  dir = [0, 0];
  if (stick) stick.classList.add('hidden');
  if (home) home.classList.remove('hidden');
}

function moveKnob(clientX: number, clientY: number) {
  let dx = clientX - originX;
  let dy = clientY - originY;
  const len = Math.hypot(dx, dy);
  if (len > radius) {
    dx = (dx / len) * radius;
    dy = (dy / len) * radius;
  }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;

  const t = radius * DEADZONE;
  // Screen y grows downward; the game's +y is away from the camera.
  dir = [Math.abs(dx) > t ? Math.sign(dx) : 0, Math.abs(dy) > t ? -Math.sign(dy) : 0];
}

function initStick() {
  const zone = $('touch-stick-zone');
  zone.addEventListener('pointerdown', e => {
    if (stickPointer !== null) return; // one thumb owns the stick
    stickPointer = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    const rect = root.getBoundingClientRect();
    stick.classList.remove('hidden'); // measurable only once displayed
    home.classList.add('hidden');
    const half = (stick.offsetWidth || 116) / 2;
    radius = half * 2 * TRAVEL;
    // Keep the ring inside the pitch even when the thumb lands on the very
    // edge — the origin moves with it, so the knob still reads true.
    const clamp = (v: number, max: number) => Math.min(Math.max(v, half), Math.max(half, max - half));
    const localX = clamp(e.clientX - rect.left, rect.width);
    const localY = clamp(e.clientY - rect.top, rect.height);
    originX = rect.left + localX;
    originY = rect.top + localY;
    stick.style.left = `${localX}px`;
    stick.style.top = `${localY}px`;
    knob.style.transform = 'translate(0px, 0px)';
    e.preventDefault();
  });
  zone.addEventListener('pointermove', e => {
    if (e.pointerId !== stickPointer) return;
    moveKnob(e.clientX, e.clientY);
    e.preventDefault();
  });
  for (const ev of ['pointerup', 'pointercancel'] as const) {
    zone.addEventListener(ev, e => {
      if (e.pointerId !== stickPointer) return;
      releaseStick();
      e.preventDefault();
    });
  }
}

// Every action fires on the press — there is no hold to time — but each
// button still tracks its own pointer id so a second thumb elsewhere can't
// leave this one stuck in its pressed state.
const releasers: Array<() => void> = [];

function initButton(el: HTMLElement, onDown: () => void) {
  let held: number | null = null;
  const release = () => {
    if (held === null) return;
    held = null;
    el.classList.remove('pressed');
  };
  releasers.push(release);
  el.addEventListener('pointerdown', e => {
    if (held !== null) return;
    held = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add('pressed');
    onDown();
    e.preventDefault();
  });
  for (const ev of ['pointerup', 'pointercancel'] as const) {
    el.addEventListener(ev, e => {
      if (e.pointerId !== held) return;
      release();
      e.preventDefault();
    });
  }
}

// The three action buttons, in button order.
let actionEls: HTMLElement[] = [];

/** Rename the action buttons to what a press does right now. */
export function setTouchActions(labels: readonly string[]) {
  for (let i = 0; i < actionEls.length; i++) {
    const text = labels[i] ?? '';
    if (actionEls[i].textContent !== text) actionEls[i].textContent = text;
  }
}

// SPRINT is a latch, not a hold: a thumb already busy with the stick and the
// action buttons has none left to keep a fourth one pressed. main.ts reads it
// every frame and folds it into setInput.
let sprinting = false;
let sprintEl: HTMLElement | null = null;

/** Is the touch SPRINT latch on? */
export function touchSprint(): boolean {
  return sprinting;
}

function initSprint(el: HTMLElement) {
  sprintEl = el;
  el.addEventListener('pointerdown', e => {
    sprinting = !sprinting;
    el.classList.toggle('pressed', sprinting);
    e.preventDefault();
  });
}

export function initTouch(h: Handlers) {
  root = $('touch-controls');
  stick = $('touch-stick');
  knob = $('touch-knob');
  home = $('touch-home');

  initStick();
  actionEls = [$('touch-act0'), $('touch-act1'), $('touch-act2')];
  actionEls.forEach((el, button) => initButton(el, () => h.action(button)));
  // Repeated taps on SWITCH cycle through your team-mates.
  initButton($('touch-switch'), h.switchPlayer);
  initSprint($('touch-sprint'));
  $('touch-chat').addEventListener('click', e => {
    e.preventDefault();
    h.chat();
  });

  // A touch-screen laptop reports a fine primary pointer while being
  // prodded at, so the first real touch flips the controls on; the frame
  // loop's setTouchVisible call picks the change up immediately.
  if (!touchAvailable) {
    window.addEventListener(
      'touchstart',
      () => {
        touchAvailable = true;
      },
      { once: true, passive: true }
    );
  }

  // Losing the window with a thumb down would otherwise leave a button stuck
  // lit and deaf to the next press.
  window.addEventListener('blur', () => {
    releaseStick();
    sprinting = false;
    sprintEl?.classList.remove('pressed');
    for (const release of releasers) release();
  });
}
