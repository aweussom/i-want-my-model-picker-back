# TODONT

Things tried here that did not work, or that work but are not worth doing. Read
this before proposing anything structural. Open work lives in [TODO.md](TODO.md).

Entries carry the measurement or the concrete failure, not an opinion, because
the ones that get proposed again in six months are precisely the ones that sound
obviously sensible.

---

## Use the official Copilot Chat API instead of driving the browser

**Verdict: dead end. Paying would not have helped.**

The documented Copilot Chat API has no model parameter at all — the thing this
whole repo exists to reach is simply not in its surface. It also requires the
separate Copilot **add-on** licence, which this tenant does not have. So the
sanctioned route is both unavailable *and* insufficient: even buying it would
leave model selection unreachable. That is what sent us to the wire in the first
place.

## Reproduce everything on a personal Microsoft account

**Verdict: closed, unless you buy a Microsoft 365 subscription.**

The plan was to keep a work tenant out of the story entirely. Signing into
`m365.cloud.microsoft/chat` with a free consumer account returns an upsell wall:

> *"Oppgrader Microsoft 365 til å bruke Copilot Chat"*

Not a degraded experience — no access to the surface at all. Everything
documented in this repo therefore comes from one work tenant on
`licenseType=Starter`, and the README's Security section is written accordingly.

An earlier version of the README recommended the personal-account route. It was
wrong and has been corrected; this entry exists so the suggestion does not come
back a third time.

**Update 2026-09-15: the wall has moved, and this verdict is now wrong.** A free
consumer account reaches `m365.cloud.microsoft/chat` today, with chat history
and a working picker. The Chathub URL says so in plain text:

```
licenseType=Free   scenario=OfficeWebFreeConsumerCopilot   agentHost=Bizchat.FullScreen
```

Same host, same `m365Copilot/Chathub` endpoint, same `tone` field — the
server-side-rendered history for that account carries `tone: "Reasoning"` and
`tone: "Magic"` per conversation. So the surface is no longer work-only, and the
security story in the README changes with it: this *can* now be reproduced off a
work tenant.

What is not yet known is whether the free tier's server honours the named models,
because a different obstacle replaced the licensing one — see the Turnstile entry
below. Keep the original verdict visible rather than deleting it: "you cannot get
there from a personal account" was true for five weeks and will be quoted back.

Still untested, and a genuinely different question: the consumer product at
`copilot.microsoft.com`. Different backend, so `tone` may not exist there at all.

## Fetch the conversation list with `GetConversationPageHistoryList`

**Verdict: abandoned until a live `syncState` is captured.**

Every payload shape tried returned nothing: `{action}` alone; plus
`enableLastMessage` and `conversationHistoryFilter`; plus a minimal `state`. The
real client also sends `syncState`, a cursor we have no copy of, and that is the
likely requirement — guessing at the rest of the body cannot substitute for it.

The fallback is scraping the sidebar, which is measurably impoverished: no tone,
no preview, no timestamp, and a count that drifts between 18 and 36 as the list
lazy-loads. Worth revisiting only by capturing a real `syncState` from live
traffic and mirroring it, not by trying a seventh payload shape.

## Conclude the surface changed, from one client failing to find something

**Verdict: don't. Check which account the client was signed into first.**

On 2026-09-15 the Electron app reported
`[could not select Gpt_5_6_Reasoning; using current]` followed by
`no completion frame before timeout`. Read as evidence about Microsoft, that says
the named models have been withdrawn and the turn then died. Both readings were
wrong, and they were wrong for two *different* reasons:

- the app's profile was signed into a **free consumer account**, which has never
  offered section 2 — so discovery correctly found nothing to select;
- the timeout was a **Cloudflare human-verification box** swallowing the send,
  not a broken observer and not a slow model.

Measured the same afternoon on a work tenant, everything was intact: the picker
rendered, the GPT submenu opened on hover, `GPT 5.6 Think deeper` selected, the
invocation carried `tone: "Gpt_5_6_Reasoning"`, and the server answered
`{"value": "Success"}`.

The failure mode to watch for: **one client's "it isn't there" is evidence about
that client.** This repo already knows the version of this that bites — an
instrument reporting nothing looks exactly like a system doing nothing — and this
is the same error one level up, where the instrument is a whole signed-in
session. Before concluding a surface changed, check `licenseType` on the Chathub
URL. It is right there in the query string.

## Use a personal account so the work tenant stays out of it

**Verdict: does not work. Two independent reasons, either one fatal.**

This is the appealing idea — no employer's tenant, no audit log, no
acceptable-use question — and it has looked possible since 2026-08-06, when the
same free account that had hit an upsell wall signed in again and had Copilot
Chat, with nothing bought in between. That observation was recorded honestly as
unresolved, with the test that would settle it: read `licenseType` from
`GET /health` on that account.

Settled on 2026-09-15, and the answer is no. Reaching the surface is not the
same as the project working there:

```
availableTones:         ["Magic", "Chat", "Reasoning"]   <- no named models
modelSelectorMetadata:  not present in the document at all
```

1. **The named models are not offered.** What is left is Auto, Quick response
   and Think deeper — which the Copilot GUI already gives you, for free, without
   this repo. `model` would once again do nothing, which is the exact condition
   the project exists to fix.
2. **Turnstile blocks every send**, and the browser is hidden by default, so a
   turn cannot complete at all. See the entry below.

So `NEXT-STEPS.md`'s plan — "send one message, read /health, and if you see
`licenseType` and three tones, rewrite the ToS paragraph to *use a private
account, that's enough*" — inverts the test. **Three tones is the failure
signal.** The ToS paragraph stays a warning about the work account, because the
work tenant is the only place this does what it claims.

There is one genuinely open question underneath, and it is currently
unanswerable: would the *free* backend accept `tone: "Gpt_5_6_Reasoning"` if it
were forced onto the wire, the way `probe_tone.py` does on the tenant? If it did,
the absence would be client-side only. Turnstile prevents the experiment.

Worth being clear about what that experiment would be, if it ever became
possible. On the work tenant this project restores access to a model the tenant
is **licensed for** and the GUI already exposes — the API just omits the
parameter. On a free account there is no such entitlement: forcing the field
would be reaching for a model the tier does not include, which is a different
thing wearing the same code. The distinction is the repo's whole justification,
so it should not be blurred for convenience.

## Drive the free consumer surface with Playwright

**Verdict: blocked, 2026-09-15. Not by licensing — by a human-verification check.**

Every send on the free consumer surface raises a Cloudflare Turnstile box, in a
Microsoft dialog labelled "Sikkerhetskontroll kreves". The prompt types fine and
Enter presses fine; the invocation is simply never sent. Measured across two
runs: the Chathub socket opens, exchanges a handshake and two pings, and carries
**zero `type: 4` frames**. Six to seven `/cdn-cgi/challenge-platform` requests
appear in each capture.

This is why an automated turn on this surface ends in
`no completion frame before timeout` — a timeout that looks exactly like a
broken observer and is nothing of the kind.

Worse than slow: on this surface the app cannot finish a turn *at all* with its
default settings. The box needs a click, the Copilot browser is hidden by
default, and un-hiding it starts a new conversation — so the click would land on
a fresh thread. Show the browser first, then ask.

**The asymmetry is the interesting part, and it is not yet explained.** Same
machine, same Playwright automation, same afternoon:

| surface | licence | Turnstile |
|---|---|---|
| consumer | `licenseType=Free` | every send |
| work tenant | `licenseType=Starter` | not once, across four turns |

The obvious reading is that Microsoft is discouraging people from piggybacking
on the models. That fits badly: the named models live on the *licensed* tenant,
which is the surface with no challenge at all. Free-tier cost control — account
farming, burning free inference — fits the direction of the asymmetry better.

Untested confound, and it is the one that decides this: **every send measured
came from a Playwright-launched browser**, where `navigator.webdriver` is true.
"The free surface challenges automation" and "the free surface challenges
everyone" both fit the evidence. One human-driven send on that account from an
ordinary Chrome would separate them. Until someone runs it, this entry records a
correlation and not a cause.

`--disable-blink-features=AutomationControlled` would very likely make the box go
away, since it is what hides `navigator.webdriver`. **Do not restore it for this
purpose.** The entry below removed it partly because it was never needed, and
partly to keep this project on the "automating my own session" side of the line
rather than the "evading detection" side. A bot check is precisely where that
line is drawn; putting the flag back to defeat one would cross it deliberately.
The honest options are a human clicking the box, or a surface that does not ask.

## Detect a challenge dialog with `document.querySelectorAll('iframe')`

**Verdict: does not work. Ask the frame tree instead.**

Turnstile renders its iframe into a **shadow root**, so the main document's
`querySelectorAll('iframe')` returns only unrelated login frames while
`page.frames` shows `challenges.cloudflare.com/...turnstile/...` plainly. A
detector built on the DOM selector reported "no challenge" with the challenge
filling the screen, and cost two runs before `probe_dom.py`-style introspection
showed why.

The wrapper dialog is Microsoft's own Fluent component, and its `aria-label` is
localised ("Sikkerhetskontroll kreves" on a Norwegian tenant), so it is a
fallback signal at best and never the test. Match on the frame URL, which is not
translated.

Third instance in this repo of the same mistake: guessing at a selector instead
of asking the page. It has never once been cheaper.

## Read the streamed reply through CDP's SSE events

**Verdict: does not work, and fails silently — the worst combination.**

`Network.eventSourceMessageReceived` fires only for the real `EventSource` API.
An app streaming `text/event-stream` through `fetch` and a `ReadableStream` is
invisible to it. Measurement: **zero** SSE events recorded while the page was
visibly streaming text on screen.

Wrapping `fetch` in the page is the only reliable route (`tap.js`), reading
`response.clone()` so the app's own stream is untouched. Note the shape of this
failure — an instrument that reports nothing looks exactly like a system that
does nothing. Several entries here are the same mistake wearing different hats.

## Redact credentials per parse branch

**Verdict: never. Sanitise at the write boundary.**

The recorder scrubbed only JSON it could parse. Trouter's socket.io frames
(`5:::{…}`) failed `json.loads`, fell through to a raw branch, and wrote a live
`Authorization: Bearer eyJ…` to disk in cleartext. Redaction now runs on every
line immediately before it is written, so no parse path can skip it.

The bug was not a missing regex. It was a second code path that never got one.

## Pass `--disable-blink-features=AutomationControlled`

**Verdict: remove it. It was never needed, and it costs more than it buys.**

The usual trick for hiding `navigator.webdriver` — a defensive reflex, not a
requirement. Chrome complained about it by name ("Du bruker et
kommandolinjeflagg som ikke håndteres"), and removing it changed nothing: tone
discovery still found all five values and prompts still answered.

Measurement, with `viewport: null`, comparing `window.outerHeight` minus
`window.innerHeight`: **151px** of browser chrome with the flag, **95px**
without. Those 56px are the infobar, and none of Playwright's own default flags
trigger it. So the flag was *causing* the bar it was supposed to avoid.

It also keeps this on the right side of "automating my own session" rather than
"evading detection", which is the better place to be for a tool that ships as an
installer.

**Update 2026-09-15:** dropped from the Electron driver in `fca361c`, but the
six Python scripts kept it for another five weeks. Now removed from all of them.
When a verdict lands, propagate it the same day; a decision that lives in one of
two ports is a decision that gets re-litigated.
