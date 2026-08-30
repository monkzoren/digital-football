# Digital Football — desktop client

A tiny Electron wrapper around https://tennis.dcz.app for players who keep
hardware acceleration disabled in their browser. Electron's bundled Chromium
has its own GPU settings, so the Three.js/WebGL renderer always runs on the
real GPU (`ignore-gpu-blocklist` + GPU rasterization are forced) — the
player's browser settings are irrelevant.

No game code lives here: the exe loads the deployed site, so it is always up
to date and the same-origin WebSocket setup keeps working.

## Downloads (built by CI on every published release)

- **DigitalFootball-Setup.exe** — one-click installer. Registers the
  `digitalfootball://` protocol, so the "open in desktop app" banner on a lobby
  invite page (`https://tennis.dcz.app/?lobby=CODE`) can launch the app
  straight into that lobby.
- **DigitalFootball.exe** — portable, no install. Works fine for playing, but
  can't own the invite-link protocol (it runs from a temp extraction).

Both are unsigned, so SmartScreen shows "More info → Run anyway" once.

## Updates

The exe has no game code, so game updates need nothing: every launch loads
the live site. The site also tells stale clients about updates
(`client/src/update-check.ts`):

- A page/app window open across a deploy gets a "new version — refresh"
  banner (it polls `/version.json`, stamped per build by vite.config.ts).
- The exe's version IS the GitHub release tag it was built for: CI writes
  it into `release.json` inside the package and the wrapper reports it in
  the user agent (`DigitalFootballDesktop/<tag>`). The site asks GitHub for
  the latest release tag and shows a "get the update" banner (with the
  download link) in any exe carrying a different one — so publishing a
  release is all it takes to notify players. Local `npm start` / `npm run
  dist` builds report `dev` and are never flagged. The `version` in
  package.json only feeds the Windows file metadata.

## How invite links launch the app

On `?lobby=` visits the web client's `index.html` shows a dismissible banner
linking to `digitalfootball://join?lobby=CODE`; the web game loads and joins
the lobby regardless. Clicking the link with the app installed makes the
browser ask "Open DigitalFootball?". (An automatic redirect was tried first,
but a failed protocol launch is not silent — Chrome logs an error and
Firefox replaces the page with one, breaking browser joins for anyone
without the app.) The app tags its user agent with `DigitalFootballDesktop` so
the banner never shows inside the app itself.

## Build locally

```bash
cd desktop
npm install
npm run dist        # → dist/DigitalFootball-Setup.exe + dist/DigitalFootball.exe
```

## Dev / testing

`npm start` runs it unpackaged. A `server.txt` next to the exe (or in this
folder during dev) overrides the server origin, e.g. `http://localhost:8080`.

F11 (or the in-game F key) toggles fullscreen. Gamepads work as in the
browser.
