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

## One window, once you are signed in

The browser is only shown when it needs to be.

`start()` probes headless first, with a short fuse. A warm profile reaches the
composer in seconds -- measured at 8.4s, against roughly 45s when a window has to
be drawn and waited on. Tone discovery, model switching and streaming all work
hidden.

If no composer turns up inside that fuse, a sign-in page is almost certainly
showing, so the driver closes the hidden browser and relaunches it **visibly**
with the long timeout. That is the case worth designing for: an invisible browser
waiting on a login you cannot see is indistinguishable from a hang, and sessions
expire and Conditional Access re-prompts, so it is not hypothetical.

`COPILOT_HEADLESS=0` forces it visible; `=1` forbids the fallback. Closing the
app takes the browser with it either way.

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

## Chrome's warning bar, twice

Two rounds of *"Du bruker et kommandolinjeflagg som ikke håndteres"*, and neither
flag turned out to be needed.

**`--no-sandbox`** was Playwright's. It disables the Chromium sandbox by default,
which goes unremarked with its own bundled build but makes a branded Chrome object
— correctly, since this browser is signed into a real Microsoft account and
browsing the real web. Fixed with `chromiumSandbox: true`.

**`--disable-blink-features=AutomationControlled`** was mine, the usual trick for
hiding `navigator.webdriver`. It was a defensive reflex rather than a requirement:
removing it changed nothing about whether Copilot works, and it kept a warning bar
on screen for a speculative benefit. Gone.

The bar's absence is measurable rather than assumed. With `viewport: null`,
compare `window.outerHeight - window.innerHeight`:

| Launch args | Browser UI |
|---|---|
| `--disable-blink-features=AutomationControlled` | 151 px |
| none | 95 px |

That 56 px is the infobar. None of Playwright's own default flags trigger it.

## Reopening old conversations

`tone` is a property of the conversation, which turns out to cut both ways: it is
why switching model costs you a thread, and it is why reopening a thread restores
the model it was on.

```
GET  /v1/conversations           list them
POST /v1/conversations/open      {"id": "..."}  continue one
POST /v1/browser                 {"visible": true|false}  show/hide the browser
```

Listing uses the same `GetConversationPageHistoryList` action the sidebar uses,
issued from inside the page so the session comes along for free, and falls back to
reading the sidebar's `/chat/conversation/<id>` links when the action's payload
shape changes.

Verified end to end: seed a thread with a codeword on GPT 5.6, start an unrelated
conversation on Auto, reopen the first, ask for the codeword — it comes back.

The subtlety that made the first attempt fail: an **unspecified** `model` means
"whatever this conversation is on", not "my preferred default". Otherwise the
default differs from the reopened thread's tone, the tone-change path navigates to
the base chat URL to reach the picker, and the conversation you just restored is
silently abandoned. The default applies to *new* conversations. Asking explicitly
for a different model still starts a new thread, because it has to.

`readCurrentTone()` reads the picker trigger's own text rather than trusting what
we last set, which is also how a reopened thread's tone is recovered when the
listing does not carry it.

## Two flakiness bugs worth naming

Both only showed up when the same operation ran more than once, which is why the
first pass looked fine.

**The picker menu is a toggle.** `discoverTones()` clicked the trigger blindly. If
a previous call had left the menu open -- an Escape that did not land, a hover that
kept it alive -- the click *closed* it, the collector read an empty menu, and the
conclusion was "this account offers no models". Repeated runs alternated between
five tones and `NULL`. `aria-expanded` on the trigger is the authoritative state,
so `_openPickerMenu()` now reads it, escapes first if needed, and verifies the menu
actually opened. Four consecutive runs: 4/4.

**The picker button and the menu use different names.** The menu entry reads "GPT
5.6 Think deeper"; the button, once that is selected, reads the shortTitle "GPT
5.6 Think". Only the long form was in the alias list, so `readCurrentTone()`
returned `null` for exactly the named models -- selection worked and verification
silently disagreed, which then mis-reported the tone of a reopened conversation.
Repeated alternating selection: 2/6 before, 6/6 after.

## Where the message history actually comes from

No action fetches it. Three probes went looking — action-dispatch POSTs, then
every JSON response body and every WebSocket frame, then every *streamed* body via
the in-page `fetch` tap — and all three came back empty. The only match on a
needle search was the conversation **title**, which contains the prompt and is
therefore a red herring.

Copilot server-side renders the transcript into the page. It arrives in the React
Router hydration blob:

```js
window.__staticRouterHydrationData
  .loaderData['chat-history'].store.rawConversationResponse.messages
```

Entries have the same shape as a Chathub frame message, so the same filtering
applies:

| author | messageType | text |
|---|---|---|
| `user` | – | "Remember the codeword BERGEN…" |
| `bot` | `Progress` | "Working on it…" |
| `bot` | `MemoryUpdate` | "Codeword BERGEN" |
| `bot` | – | "OK" |

`MemoryUpdate` was a find in itself: Copilot records what it has decided to
remember as a bot message. It is bookkeeping, not an answer, and it was **not** in
`PROGRESS_TYPES` — so it would have been rendered as one. Added, along with
`TriggerPlugin`, `HintInvocation`, `DeveloperLogs`, `ReferencesListComplete` and
`EndOfRequest`, all of which appear in the invocation's `allowedMessageTypes` and
none of which are answers.

`readTranscript()` reads that path, and `openConversation()` returns the messages,
so reopening a thread now repopulates this window rather than explaining why it is
empty.
