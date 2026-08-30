// ---------------------------------------------------------------------------
// Player accounts.
//
// SpacetimeDB derives an identity by hashing a JWT's `iss` + `sub` and
// verifies the signature against the JWKS it fetches from
// `{iss}/.well-known/openid-configuration`. Firebase serves exactly that
// document, so a Firebase ID token needs NO server configuration — and the
// identity it yields is stable forever, which is what makes XP, MMR and
// reconnect mean anything.
//
// Everyone is signed in anonymously on load, so the game keeps its
// click-a-link-and-play feel. Signing in LINKS that guest to a real provider,
// which keeps the same Firebase uid and therefore the same identity and all
// its progress — the upgrade buys portability, not a new account.
// ---------------------------------------------------------------------------
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  isSignInWithEmailLink,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signOut as fbSignOut,
  type Auth,
  type User,
} from 'firebase/auth';

const env = (import.meta as any).env ?? {};
const cfg = {
  apiKey: env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: env.VITE_FIREBASE_APP_ID as string | undefined,
};

/** Firebase is optional: without a project the game falls back to anonymous
 *  SpacetimeDB tokens (see `localToken` below), so `npm run dev` needs no
 *  setup at all. */
export const firebaseEnabled = !!(cfg.apiKey && cfg.authDomain && cfg.projectId);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let user: User | null = null;
let ready: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** Firebase is configured but unreachable — blocked by a firewall or an
 *  extension, or just offline. Progress still accrues, but on a device-local
 *  identity rather than the player's account, so the UI has to say so. */
let degraded = false;
export const authDegraded = () => degraded;

export type AccountKind = 'guest' | 'linked' | 'local' | 'offline';

/** Local-token seat: two tabs of one browser share Firebase's IndexedDB (and
 *  localStorage), so they are ONE player. `?seat=2` namespaces the fallback
 *  token key to keep the old two-tabs-two-players test flow working. */
const seat = new URLSearchParams(location.search).get('seat') ?? '';
const TOKEN_KEY = seat ? `dt_token:${seat}` : 'dt_token';

/** The anonymous SpacetimeDB token, used only when Firebase is unconfigured.
 *  It lives in localStorage, NOT sessionStorage: an identity that dies with
 *  the tab can never reconnect into its own match. */
export const localToken = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? undefined,
  set: (tok: string) => localStorage.setItem(TOKEN_KEY, tok),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

function notify() {
  for (const cb of listeners) cb();
}

// Auth is best-effort, never a gate. If Firebase cannot be reached the SDK
// does not reliably reject — it can sit on an internal retry indefinitely —
// and anything awaiting it stalls with it. The game boots either way, so this
// caps how long the whole handshake may take before we carry on degraded.
const AUTH_BOOT_TIMEOUT = 6000;

/** Resolves once Firebase has restored (or created) a session — or once
 *  AUTH_BOOT_TIMEOUT says we are not waiting any longer. Never rejects, and
 *  never hangs: a stalled auth service must not cost the player the game. */
export function initAuth(): Promise<void> {
  if (!firebaseEnabled) return Promise.resolve();
  if (ready) return ready;
  app = initializeApp({
    apiKey: cfg.apiKey!,
    authDomain: cfg.authDomain!,
    projectId: cfg.projectId!,
    appId: cfg.appId,
  });
  auth = getAuth(app);
  const observed = new Promise<void>(resolve => {
    let settled = false;
    onAuthStateChanged(
      auth!,
      async u => {
        user = u;
        if (!u) {
          // No session yet (first visit, or a sign-out): become a guest. The
          // uid persists in IndexedDB, so this same account comes back on the
          // next visit — and on the next reconnect.
          //
          // Failing here is NOT harmless: with no Firebase token the client
          // would connect anonymously and be handed a BRAND NEW SpacetimeDB
          // identity on every load — silently losing the player's account and
          // breaking reconnect. So retry transient failures, and if it still
          // won't come up, fall back to a stable device-local identity and
          // flag the session as degraded rather than pretending all is well.
          for (let attempt = 0; ; attempt++) {
            try {
              await signInAnonymously(auth!);
              degraded = false;
              return; // onAuthStateChanged fires again with the new user
            } catch (err) {
              const transient = String((err as any)?.code ?? '').includes('network-request-failed');
              if (!transient || attempt >= 2) {
                console.error('[dt] anonymous sign-in failed', err);
                degraded = true;
                notify();
                if (!settled) { settled = true; resolve(); }
                return;
              }
              await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
            }
          }
        }
        degraded = false;
        if (!settled) { settled = true; resolve(); }
        notify();
      },
      err => {
        console.error('[dt] auth error', err);
        degraded = true;
        if (!settled) { settled = true; resolve(); }
      }
    );
  });
  ready = Promise.race([
    observed,
    new Promise<void>(resolve =>
      setTimeout(() => {
        if (!user) {
          console.warn('[dt] auth did not settle in time — continuing offline');
          degraded = true;
          notify();
        }
        resolve();
      }, AUTH_BOOT_TIMEOUT)
    ),
  ]);
  // The observer keeps running past the timeout: if Firebase turns up late,
  // onAuthChange fires and the client rebuilds the socket on the real
  // identity (see main.ts).
  return ready;
}

/** A fresh ID token. Firebase refreshes it past its one-hour expiry on its
 *  own, so this is safe to call before every (re)connection attempt. */
export async function getToken(): Promise<string | undefined> {
  if (!firebaseEnabled) return localToken.get();
  await initAuth();
  if (user) {
    try {
      return await user.getIdToken();
    } catch (err) {
      console.error('[dt] could not mint an ID token', err);
      degraded = true;
    }
  }
  // Degraded: reuse whatever identity this device connected with last time.
  // It is not the player's account, but it is STABLE — which keeps reconnect
  // working and stops every reload minting a fresh player.
  degraded = true;
  return localToken.get();
}

export function accountKind(): AccountKind {
  if (!firebaseEnabled) return 'local';
  if (degraded && !user) return 'offline';
  return user && !user.isAnonymous ? 'linked' : 'guest';
}

/** What to show on the account chip: the linked identity, or nothing. */
export function accountLabel(): string {
  if (!user || user.isAnonymous) return '';
  return user.email || user.displayName || 'SIGNED IN';
}

export function onAuthChange(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export type SignInResult =
  | { ok: true; switched: false }
  /** The provider was already a Digital Tennis account, so we signed into
   *  THAT one instead of linking. The identity changes — the caller has to
   *  reconnect, and should say plainly that the guest progress stayed behind. */
  | { ok: true; switched: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Email + password — the primary route.
//
// The two directions are genuinely different and the UI says so:
//   CREATE ACCOUNT links the credential onto the anonymous guest, so the uid
//     (and with it the identity, level and rating earned so far) carries over.
//   SIGN IN switches to an account that already exists, which is a DIFFERENT
//     uid — this device's guest progress stays where it is.
// ---------------------------------------------------------------------------
const MIN_PASSWORD = 6; // Firebase's own floor

function checkCredentials(email: string, password: string): string | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return "That doesn't look like an email address";
  }
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters`;
  }
  return null;
}

/** Make a new account out of the current guest, keeping everything it earned. */
export async function signUpWithPassword(email: string, password: string): Promise<SignInResult> {
  if (!firebaseEnabled || !auth) return { ok: false, error: 'Accounts are not configured' };
  const bad = checkCredentials(email, password);
  if (bad) return { ok: false, error: bad };
  await initAuth();
  const trimmed = email.trim();
  try {
    if (user && user.isAnonymous) {
      // Link, don't create: this is what carries the guest's XP and MMR into
      // the new account instead of stranding them on the anonymous uid.
      const cred = await linkWithCredential(user, EmailAuthProvider.credential(trimmed, password));
      user = cred.user;
      notify();
      return { ok: true, switched: false };
    }
    const cred = await createUserWithEmailAndPassword(auth, trimmed, password);
    user = cred.user;
    notify();
    return { ok: true, switched: false };
  } catch (err: any) {
    return { ok: false, error: friendly(String(err?.code ?? '')) };
  }
}

/** Sign in to an account that already exists. */
export async function signInWithPassword(email: string, password: string): Promise<SignInResult> {
  if (!firebaseEnabled || !auth) return { ok: false, error: 'Accounts are not configured' };
  const bad = checkCredentials(email, password);
  if (bad) return { ok: false, error: bad };
  await initAuth();
  try {
    // A different uid than the guest's, so anything earned on this device
    // stays with the guest — the caller warns about that.
    const hadGuest = !!user?.isAnonymous;
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    user = cred.user;
    notify();
    return { ok: true, switched: hadGuest };
  } catch (err: any) {
    return { ok: false, error: friendly(String(err?.code ?? '')) };
  }
}

export async function sendPasswordReset(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!firebaseEnabled || !auth) return { ok: false, error: 'Accounts are not configured' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return { ok: false, error: 'Enter your email address first' };
  }
  await initAuth();
  try {
    await sendPasswordResetEmail(auth, email.trim());
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: friendly(String(err?.code ?? '')) };
  }
}

/** Upgrade the current guest to a real account via Google, keeping its uid —
 *  and so its identity, XP and MMR. */
export async function signInWithGoogle(): Promise<SignInResult> {
  if (!firebaseEnabled || !auth) return { ok: false, error: 'Accounts are not configured' };
  await initAuth();
  const provider = new GoogleAuthProvider();
  try {
    if (user && user.isAnonymous) {
      const cred = await linkWithPopup(user, provider);
      user = cred.user;
      notify();
      return { ok: true, switched: false };
    }
    const cred = await signInWithPopup(auth, provider);
    user = cred.user;
    notify();
    return { ok: true, switched: false };
  } catch (err: any) {
    const code = String(err?.code ?? '');
    // That Google account already has a Digital Tennis account of its own.
    // Merging two identities is a non-goal, so sign into the existing one and
    // let the caller warn that this device's guest progress stays put.
    if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') {
      try {
        const cred = await signInWithPopup(auth, provider);
        user = cred.user;
        notify();
        return { ok: true, switched: true };
      } catch (inner: any) {
        return { ok: false, error: friendly(String(inner?.code ?? '')) };
      }
    }
    return { ok: false, error: friendly(code) };
  }
}

// ---------------------------------------------------------------------------
// Email link (passwordless). No popup at all, which matters: the desktop app
// is an Electron shell, and a redirect-free email link works there and on
// every locked-down browser that blocks popups outright.
//
// The link lands back on the game with Firebase's own query params. On that
// load we finish the sign-in — LINKING it to the anonymous guest if there is
// one, so the player keeps the level and rating they just earned.
// ---------------------------------------------------------------------------
const EMAIL_KEY = 'dt_signin_email';

/** Where the emailed link comes back to. Must be an authorized domain in the
 *  Firebase console, or Firebase refuses to send. Query is dropped so an
 *  invite link's ?lobby=CODE can't ride along and re-trigger a join. */
const linkReturnUrl = () => location.origin + location.pathname;

export async function sendEmailLink(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!firebaseEnabled || !auth) return { ok: false, error: 'Accounts are not configured' };
  const trimmed = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return { ok: false, error: "That doesn't look like an email address" };
  }
  await initAuth();
  try {
    // Same hazard as the boot handshake: an unreachable Firebase does not
    // reliably reject, it sits on an internal retry — which would leave the
    // button disabled on "SENDING…" forever. This is a pure network call with
    // no human in the loop, so a hard cap is safe (unlike the Google popup,
    // which legitimately takes as long as the player takes to pick an
    // account, and which they can always close themselves).
    await Promise.race([
      sendSignInLinkToEmail(auth, trimmed, {
        url: linkReturnUrl(),
        handleCodeInApp: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject({ code: 'auth/network-request-failed' }), 15000)
      ),
    ]);
    // Needed to finish the sign-in when the link comes back; if the link is
    // opened in a different browser we ask for it again instead.
    try { localStorage.setItem(EMAIL_KEY, trimmed); } catch { /* private mode */ }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: friendly(String(err?.code ?? '')) };
  }
}

/** True when THIS page load is the return leg of an emailed sign-in link. */
export function isEmailLinkReturn(): boolean {
  return !!(firebaseEnabled && auth && isSignInWithEmailLink(auth, location.href));
}

/** Strip Firebase's one-time params so a reload can't replay the sign-in,
 *  keeping any of the game's own (?lobby=CODE) intact. */
function cleanLinkParams() {
  const url = new URL(location.href);
  for (const k of ['apiKey', 'oobCode', 'mode', 'lang', 'continueUrl', 'tenantId']) {
    url.searchParams.delete(k);
  }
  history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
}

/** Finish an emailed sign-in. Returns null when this load isn't one, so the
 *  caller can run it unconditionally at boot. */
export async function completeEmailLink(
  askEmail: () => Promise<string | null>
): Promise<SignInResult | null> {
  if (!firebaseEnabled || !auth) return null;
  if (!isSignInWithEmailLink(auth, location.href)) return null;
  let email = '';
  try { email = localStorage.getItem(EMAIL_KEY) ?? ''; } catch { /* private mode */ }
  // Opened on a different device or browser than it was requested from: the
  // address isn't in this storage, so Firebase requires us to confirm it.
  if (!email) email = (await askEmail()) ?? '';
  if (!email) {
    cleanLinkParams();
    return { ok: false, error: 'Sign-in needs the email address the link was sent to' };
  }
  const href = location.href;
  try {
    if (user && user.isAnonymous) {
      // Link, don't sign in: this keeps the uid, so the XP and MMR earned as
      // a guest carry into the account.
      const cred = await linkWithCredential(user, EmailAuthProvider.credentialWithLink(email, href));
      user = cred.user;
      cleanLinkParams();
      try { localStorage.removeItem(EMAIL_KEY); } catch { /* ignore */ }
      notify();
      return { ok: true, switched: false };
    }
    const cred = await signInWithEmailLink(auth, email, href);
    user = cred.user;
    cleanLinkParams();
    try { localStorage.removeItem(EMAIL_KEY); } catch { /* ignore */ }
    notify();
    return { ok: true, switched: false };
  } catch (err: any) {
    const code = String(err?.code ?? '');
    // That address already has an account. Merging two identities is a
    // non-goal, so sign into the existing one and let the caller say plainly
    // that this device's guest progress stayed behind.
    if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') {
      try {
        const cred = await signInWithEmailLink(auth, email, href);
        user = cred.user;
        cleanLinkParams();
        try { localStorage.removeItem(EMAIL_KEY); } catch { /* ignore */ }
        notify();
        return { ok: true, switched: true };
      } catch (inner: any) {
        cleanLinkParams();
        return { ok: false, error: friendly(String(inner?.code ?? '')) };
      }
    }
    cleanLinkParams();
    return { ok: false, error: friendly(code) };
  }
}

/** Sign out and become a NEW guest. The old account is untouched — signing
 *  back in returns to it. */
export async function signOut(): Promise<void> {
  if (!firebaseEnabled || !auth) return;
  await fbSignOut(auth);
  user = null;
  // onAuthStateChanged creates the replacement guest.
}

function friendly(code: string): string {
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Sign-in cancelled';
  }
  if (code === 'auth/popup-blocked') return 'Your browser blocked the sign-in popup';
  if (code === 'auth/unauthorized-domain') {
    return 'This domain is not authorized in the Firebase project';
  }
  if (code === 'auth/network-request-failed') return 'Network error — try again';
  if (code === 'auth/invalid-email') return 'That email address is not valid';
  if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') {
    return 'That sign-in link has expired or was already used — send a new one';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'That sign-in method is not enabled in the Firebase project';
  }
  if (code === 'auth/too-many-requests') return 'Too many attempts — wait a minute and retry';
  if (code === 'auth/email-already-in-use') {
    return 'That email already has an account — sign in instead';
  }
  if (code === 'auth/weak-password') return 'Password must be at least 6 characters';
  // Firebase's email-enumeration protection collapses "no such user" and
  // "wrong password" into one code on purpose, so the message has to cover
  // both without leaking which it was.
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  ) {
    return 'Wrong email or password';
  }
  if (code === 'auth/user-disabled') return 'That account has been disabled';
  return code ? `Sign-in failed (${code})` : 'Sign-in failed';
}
