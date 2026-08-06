# electron

The Node port: same findings, same protocol, one language, one Chromium fewer to
reason about. The Python tree above is still the research toolkit — `capture.py`,
`probe_dom.py`, `diff_frames.py` and friends are how any of this was worked out.

```powershell
cd electron
npm install
npx playwright install chromium     # shared with the Python install

npm run signin                      # sign in once; waits 15 minutes
npm start                           # the app
npm run serve                       # API only, port 8791
node src/driver.spec.js             # 14 checks, no browser needed
node src/server.spec.js             # 13 checks, no browser needed
```

`COPILOT_PROFILE` picks the profile directory; keep work and personal apart.

## What the port deletes

Playwright's **synchronous** Python API dispatches event callbacks only while the
owning thread is inside a Playwright call. The Python driver therefore needs a
dedicated worker thread, two queues, and a command loop that must never block on
`queue.get()`. Getting that wrong starved every `framereceived` handler: the
browser answered correctly on screen while the API returned
`no completion frame before timeout`.

Node's Playwright is async by construction. There is no thread to confine and no
pump to starve, so that bug is not expressible. The whole apparatus collapses
into an async generator.

It is also measurably less laggy, though not where you would guess. A turn is
dominated by Copilot thinking — 17s here, same as Python. What changed is the
delta cadence: the Python browser thread pumps events in `wait_for_timeout(150)`
slices, so streamed text arrives in ~150ms steps. Node dispatches on the event
loop, so it arrives as it lands. Same total, smoother stream.

Measured on Node: first reasoning event 1.9s, first answer token 2.8s, total 17.1s.

## Layout

| File | Job |
|---|---|
| `src/driver.js` | Resident browser: picker, typing, uploads, frame reading |
| `src/server.js` | `node:http` — UI, `/health`, `/v1/models`, `/v1/chat/completions` |
| `src/main.js` | Electron shell; owns the driver and the server |
| `src/signin.js` | Opens a browser and waits for you to log in |
| `src/*.spec.js` | Unit checks for the pure parts |

No Express: three routes and a static directory do not justify a dependency. The
UI is served unchanged from `../templates` and `../static`, so it keeps talking
fetch + SSE and needed no rewrite. The renderer could use IPC instead, but then
the OpenAI surface would have to exist twice — and that surface is the point.

## Still two windows

The app, and the Playwright browser holding the Copilot session. That is
inherent: the session is what makes any of this work, and `headless` only works
once a profile is already warm. Closing the app takes the browser with it.

## Building a .exe

```powershell
npm run dist     # dist/model-picker-0.1.0-setup.exe, NSIS installer, ~98 MB
npm run pack     # dist/win-unpacked/, no installer, for testing
```

Verified: the packaged build serves the UI from its own resources, defaults to
`Gpt_5_6_Reasoning`, and answers.

Three things the first packaged build got wrong, all worth knowing if you package
something like this yourself:

**The UI lives outside the app directory.** `../templates` and `../static` are not
part of `electron/`, so electron-builder packaged an app with no interface.
Fixed with `extraResources`, and `server.js` now probes candidate roots instead of
assuming one — which also keeps it runnable outside Electron.

**`__dirname` is inside `app.asar`.** The default profile path resolved to a
location inside a read-only archive, so the browser started and silently
persisted nothing. Packaged builds now use `app.getPath('userData')`.

**Playwright's Chromium is not bundled.** It lives in `%LOCALAPPDATA%\ms-playwright`
and gets there via `playwright install`, which nobody running an installer has
done. So the driver now prefers a browser the machine already has — Chrome, then
Edge, then the bundled Chromium. Edge is always present on Windows 11, so a clean
box needs no 150 MB download. `COPILOT_CHANNEL=chrome|msedge` pins it;
`COPILOT_PROFILE` picks the profile directory.

### Caveats

The installer is **unsigned**, so SmartScreen will object. Signing needs a
certificate this project does not have.

First run on a clean machine needs an interactive sign-in, which happens in the
browser window the app opens. The loading screen reports how long it has been
waiting and tells you to look at the other window.

## Not done yet

`/v1/cancel` wired through to the page, and multi-image upload — see `../TODO.md`.

## The menu is not the same everywhere

Which tones exist depends on the account, and this cost a wrong assumption.

A work tenant on `licenseType=Starter` offers the three generic modes *and* named
models — GPT 5.6 Think deeper, GPT 5.5 Quick response. A **personal Microsoft
account offers only the generic three**: Auto, Quick response, Think deeper. No
named models at all.

Hardcoding the tone map from one tenant meant the app confidently defaulted to
`Gpt_5_6_Reasoning` on accounts that have never had it, failed to find the menu
entry, and silently answered as Auto. So `discoverTones()` now reads the real
picker at startup — including hovering the provider submenu — and `/v1/models`
lists only what the account actually offers, with that account's best available
tone first.

`GET /health` reports what was found, which is how you diagnose this from a
machine you cannot inspect:

```json
{"status":"ready","version":"0.1.2","browser":"chrome","sandbox":true,
 "defaultTone":"Gpt_5_6_Reasoning",
 "availableTones":["Magic","Chat","Reasoning","Gpt_5_6_Reasoning","Gpt_5_5_Chat"],
 "licenseType":"Starter"}
```

On an account without named models the same call reports
`"availableTones":["Magic","Chat","Reasoning"]` and `"defaultTone":"Reasoning"`.
Tenant and user object ids are deliberately not included.
