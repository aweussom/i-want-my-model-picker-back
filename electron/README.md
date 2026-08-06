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

## Not done yet

Packaging (`electron-builder`), `/v1/cancel` wired through to the page, and
multi-image upload — see `../TODO.md`.
