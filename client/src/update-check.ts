// Out-of-date notices, both ways a running client can go stale:
//
//  1. STALE PAGE — this tab/app window was loaded before the newest deploy.
//     Every build bakes __BUILD_ID__ into the bundle and ships the same id
//     in /version.json (vite.config.ts); we re-fetch that file periodically
//     and on tab focus, and offer a refresh when it changes. Never a forced
//     reload: a banner mid-match would be rude enough already.
//
//  2. STALE DESKTOP EXE — CI stamps the GitHub release tag into each exe and
//     the wrapper reports it in the user agent (DigitalTennisDesktop/<tag>).
//     The latest release IS the current version, so we ask GitHub for its
//     tag and flag any exe carrying a different one.

declare const __BUILD_ID__: string;

const LATEST_RELEASE_API =
  'https://api.github.com/repos/monkzoren/digital-tennis/releases/latest';
const DESKTOP_DOWNLOAD_URL =
  'https://github.com/monkzoren/digital-tennis/releases/latest/download/DigitalTennis-Setup.exe';

const POLL_MS = 5 * 60_000;

// One fixed top bar, same slot as the invite banner in index.html (they can
// never show together: the invite banner is browser-only, the exe notice is
// app-only, and a page fresh enough to see ?lobby= isn't stale yet).
function showBanner(text: string, actionLabel: string, href: string | null, onClick: () => void) {
  if (document.getElementById('update-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'update-banner';
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99;display:flex;' +
    'align-items:center;justify-content:center;gap:1em;padding:.45em 1em;' +
    'background:var(--vt-blue);color:var(--vt-white);' +
    'font-family:var(--font),Arial,sans-serif;font-size:14px;';
  const link = document.createElement('a');
  if (href) {
    link.href = href;
    link.target = '_blank'; // in the app this routes to the real browser
  } else {
    link.href = '#';
  }
  link.textContent = `${text} — ${actionLabel}`;
  link.style.cssText = 'color:var(--vt-yellow);font-weight:bold;';
  link.onclick = onClick;
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText =
    'background:none;border:none;color:var(--vt-white);cursor:pointer;' +
    'font-size:18px;line-height:1;padding:0 .3em;transform:none;box-shadow:none;';
  close.onclick = () => bar.remove();
  bar.append(link, close);
  document.body.append(bar);
}

// --- 1. Stale page ---------------------------------------------------------

let newBuildSeen = false;
async function checkBuild() {
  if (newBuildSeen) return;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { buildId } = await res.json();
    if (buildId && buildId !== __BUILD_ID__) {
      newBuildSeen = true;
      showBanner('A new version of Digital Tennis is live', 'REFRESH', null, () => {
        location.reload();
      });
    }
  } catch {
    // offline / server restarting — the next tick will try again
  }
}

if (!(import.meta as any).env?.DEV) {
  setInterval(checkBuild, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkBuild();
  });
}

// --- 2. Stale desktop wrapper ----------------------------------------------

// The exe's UA carries the release tag it was built for ('dev' for local
// builds, a bare '1.0' for pre-stamping exes — those correctly mismatch).
const uaMatch = navigator.userAgent.match(/DigitalTennisDesktop\/(\S+)/);
const exeTag = uaMatch?.[1];
if (exeTag && exeTag !== 'dev') {
  void (async () => {
    try {
      const res = await fetch(LATEST_RELEASE_API);
      if (!res.ok) return; // rate-limited or offline — just skip this launch
      const { tag_name } = await res.json();
      if (tag_name && tag_name !== exeTag) {
        showBanner('Your desktop app is out of date', '⬇ GET THE UPDATE', DESKTOP_DOWNLOAD_URL, () => {
          // the download continues in the browser; the banner has done its job
          setTimeout(() => document.getElementById('update-banner')?.remove(), 500);
        });
      }
    } catch {
      // GitHub unreachable — the game doesn't care, try again next launch
    }
  })();
}
