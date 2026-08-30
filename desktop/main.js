// Digital Tennis desktop wrapper.
//
// The whole point of this exe is GPU rendering for people who keep hardware
// acceleration disabled in their browser: Electron's bundled Chromium has its
// own GPU settings, so the game's WebGL renderer always gets the real GPU.
//
// It also owns the digitaltennis:// protocol, so lobby invite pages opened in
// a browser can launch the installed app straight into the lobby.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_URL = 'https://tennis.dcz.app';
const PROTOCOL = 'digitaltennis';
// CI stamps the GitHub release tag this exe was built for into release.json
// (see .github/workflows/desktop-release.yml); local/dev builds have none.
let releaseTag = 'dev';
try {
  releaseTag = require('./release.json').tag || 'dev';
} catch {}
// The invite page skips its "open in app" redirect when it sees this tag,
// and the site compares the release tag against the repo's latest release
// to tell outdated exes to update (client/src/update-check.ts).
const UA_TAG = `DigitalTennisDesktop/${releaseTag}`;

// GPU rasterization even for devices on Chromium's software-fallback list.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// A server.txt next to the exe overrides the default server (handy for
// testing against a local or staging deployment).
function baseUrl() {
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  try {
    let txt = fs.readFileSync(path.join(exeDir, 'server.txt'), 'utf8').trim();
    if (txt && !/^https?:\/\//i.test(txt)) txt = 'https://' + txt;
    return txt ? new URL(txt).origin : DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

// digitaltennis://join?lobby=CODE  →  https://tennis.dcz.app/?lobby=CODE
function deepLinkToGameUrl(argv) {
  const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (!link) return null;
  try {
    const code = new URL(link).searchParams.get('lobby');
    return code ? `${baseUrl()}/?lobby=${encodeURIComponent(code)}` : baseUrl();
  } catch {
    return baseUrl();
  }
}

let win;

function loadGame(url) {
  win.loadURL(url, { userAgent: win.webContents.getUserAgent() + ' ' + UA_TAG });
}

function createWindow(startUrl) {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#0a0a14',
    autoHideMenuBar: true,
    title: 'Digital Tennis',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);

  // F11 fullscreen (the in-game F key still works too).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  // Any external link opens in the real browser, not this window — EXCEPT the
  // sign-in popup. Firebase's signInWithPopup hands the result back through
  // window.opener.postMessage, so a popup pushed out to the system browser
  // can never answer the page that opened it: Google sign-in would just hang.
  // Keep those two hosts in-app; everything else still leaves.
  const AUTH_POPUP_HOSTS = /(^|\.)firebaseapp\.com$|(^|\.)web\.app$|^accounts\.google\.com$/;
  win.webContents.setWindowOpenHandler(({ url }) => {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (AUTH_POPUP_HOSTS.test(host)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 480, height: 640, autoHideMenuBar: true, parent: win, modal: true,
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Offline / bad DNS etc: show a plain error with a retry.
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3 /* ERR_ABORTED: normal on redirects */) {
      const html =
        `<body style="background:#0a0a14;color:#f8f8f8;font-family:sans-serif;` +
        `display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
        `<div style="text-align:center"><h2>Can&#39;t reach the game server</h2>` +
        `<p style="color:#aaa">${desc} — ${failedUrl}</p>` +
        `<button style="padding:.6em 2em;font-size:1em" ` +
        `onclick="location.href='${failedUrl}'">RETRY</button></div></body>`;
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    }
  });

  loadGame(startUrl);
}

// Single instance: invite links while the app is running reuse the window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const url = deepLinkToGameUrl(argv);
    if (url) loadGame(url);
  });

  app.whenReady().then(() => {
    // The installer registers the protocol; this keeps the registration
    // pointed at the right exe (e.g. after the app moves). Skipped in dev.
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    createWindow(deepLinkToGameUrl(process.argv) || baseUrl());
  });

  app.on('window-all-closed', () => app.quit());
}
