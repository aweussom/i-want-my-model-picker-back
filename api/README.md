# api

An OpenAI-compatible endpoint in front of a real, signed-in Copilot browser
session. Node and Playwright, no Express, no Electron.

```powershell
cd api
npm install
npx playwright install chromium     # optional; it prefers Chrome or Edge

npm run signin                      # sign in once; waits 15 minutes
npm run serve                       # API on http://127.0.0.1:8791
npm test                            # unit checks, no browser needed
python smoke_test.py                # against the running API: 2 real prompts, checks the tone on the wire
```

`COPILOT_PROFILE` picks the profile directory, so keep work and personal apart.
`COPILOT_HISTORY=full` sends the whole conversation as one prompt in a new chat per
request. Aider needs it; [RUNBOOK.md](../RUNBOOK.md) has the rest. Those chats are
logged to `.api-chats.jsonl`, and `node src/cleanup-tests.js --api-chats` deletes
them. Stop the server first, both use the profile.
`COPILOT_CHANNEL=chrome|msedge` pins the browser.

## Layout

| File | Job |
|---|---|
| `src/driver.js` | Resident browser: injects the userscript, types, uploads, reads frames |
| `src/server.js` | `node:http`: test UI, `/health`, `/v1/models`, `/v1/chat/completions` |
| `src/signin.js` | Opens a browser and waits for you to log in |
| `src/*.spec.js` | Unit checks for the pure parts |
| `smoke_test.py` | End-to-end check over HTTP, standard-library Python, no Playwright |
| `src/probe-history.js`, `src/cleanup-tests.js` | Research and cleanup tools |

The test UI at `/` is `../templates` and `../static`, inherited from the archived
Python version.

## How the model gets picked

It does not touch Microsoft's menu. `driver.js` injects
[`../userscript/model-picker.user.js`](../userscript/model-picker.user.js) - the same file Tampermonkey users
install - with `addInitScript`, so it is in place before Copilot's own code. Before each
send the driver calls `window.__mpo.setTone(<tone>)`. After Enter it waits up to 15s for the userscript
to report the frame it rewrote, and fails the request if none went out or the
tone is wrong. A request that quietly answers as Auto is worse than one that
fails.

The driver logs every step:

```
[driver] userscript hook present, v20261104-125409
[driver] setting userscript tone to Gpt_5_6_Reasoning for this send
[driver] tone on the wire: Magic -> Gpt_5_6_Reasoning
```

Changing `model` between requests keeps the conversation. The server stores the
latest tone per message, so there is nothing to reload for. I tested it on
4 November 2026: a follow-up sent as `Gpt_5_6_Chat` in a thread started as
`Gpt_5_6_Reasoning` kept the same `conversationId` and remembered the earlier answer.

The earlier version clicked the menu, hovered the provider submenu and matched
localised labels. The "GPT-5.6 Sol" rename in November 2026 broke it silently.
It is in git history, and the Python one is in `../archive/python-api`.

`/v1/models` lists every tone in `TONES`. Nothing discovers what an account offers any
more. A personal account showed only Auto, Quick response and Think deeper;
what the server does with a GPT tone such an account does not have is untested.

## One window, once you are signed in

`start()` probes headless first, with a short fuse. A warm profile reaches the
composer in seconds, measured at 8.4s, against roughly 45s when a window has to
be drawn and waited on.

If no composer turns up inside that fuse, a sign-in page is almost certainly
showing, so the driver closes the hidden browser and relaunches it visibly with
the long timeout. An invisible browser waiting on a login you cannot see looks
exactly like a hang, and sessions do expire.

`COPILOT_HEADLESS=0` forces it visible; `=1` forbids the fallback.

## Chrome's warning bar, twice

Two rounds of "Du bruker et kommandolinjeflagg som ikke håndteres", and neither
flag was needed.

`--no-sandbox` was Playwright's. It disables the Chromium sandbox by default, which a
branded Chrome objects to, and it is right to: this browser is signed into a
real Microsoft account. Fixed with `chromiumSandbox: true`.

`--disable-blink-features=AutomationControlled` was mine, the usual trick for hiding `navigator.webdriver`. Removing it changed nothing
about whether Copilot works. Gone.

Measured with `viewport: null`, comparing `window.outerHeight - window.innerHeight`:

| Launch args | Browser UI |
|---|---|
| `--disable-blink-features=AutomationControlled` | 151 px |
| none | 95 px |

The 56 px difference is the infobar.

## Reopening old conversations

```
GET  /v1/conversations           list them
POST /v1/conversations/open      {"id": "..."}  continue one
POST /v1/browser                 {"visible": true|false}  show/hide the browser
```

Listing tries the `GetConversationPageHistoryList` action the sidebar uses, and falls back to reading the
sidebar's `/chat/conversation/<id>` links. The action returns nothing for every payload shape I
tried, so in practice it is the DOM fallback; see `../TODO.md`.

A reopened thread keeps its own tone. A request with no `model` sends the tone of
the last message this driver sent in that thread. If there was none, it switches
the override off so the page's picker (restored to the thread's tone on load)
decides.

## Where the message history comes from

No action fetches it. Three probes looked: action POSTs, every JSON response and
WebSocket frame, every streamed body through an in-page `fetch` tap. All empty.

Copilot renders the transcript server-side into the React Router hydration
blob:

```js
window.__staticRouterHydrationData
  .loaderData['chat-history'].store.rawConversationResponse.messages
```

Entries have the same shape as a Chathub frame message:

| author | messageType | text |
|---|---|---|
| `user` | - | "Remember the codeword BERGEN…" |
| `bot` | `Progress` | "Working on it…" |
| `bot` | `MemoryUpdate` | "Codeword BERGEN" |
| `bot` | - | "OK" |

`MemoryUpdate` is Copilot recording what it decided to remember. It is not an answer, so
it is in `PROGRESS_TYPES` with `TriggerPlugin`, `HintInvocation`, `DeveloperLogs`, `ReferencesListComplete` and `EndOfRequest`.

## Not done yet

`/v1/cancel` wired through to the page, and multi-image upload; see `../TODO.md`.
