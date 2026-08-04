# copilot-wire

Microsoft 365 Copilot's GUI has a model picker. Microsoft's official Copilot
Chat API has no model parameter.

That gap is why this repo exists. As of August 2026 you can open
`m365.cloud.microsoft/chat`, turn *off* the new design, and pick **GPT 5.6 Think
deeper** from a dropdown. There is no supported way to request that model
programmatically — the official `chatOverStream` endpoint accepts `message`,
`locationHint`, `additionalContext` and `contextualResources`, and nothing that
names a model. Microsoft also began removing named models from the picker on
7 July 2026, so the dropdown is on its way out.

So: wire-protocol archaeology on a button that is being deleted.

## The finding

Model choice travels in a field called **`tone`**, at the top level of the chat
invocation, a sibling of `message` rather than a property of it.

`tone` is inherited from Bing Chat, where it held *Creative* / *Balanced* /
*Precise*. Microsoft repurposed the same field to carry model and reasoning mode.
The default value is called `Magic`.

Two runs of `run_probe.py` with the same prompt, differing only in the picker:

```
$ python diff_frames.py captures/send-auto.jsonl captures/send-think.jsonl
captures\send-auto.jsonl: 1 chat invocation(s)
captures\send-think.jsonl: 1 chat invocation(s)

=== wire diff (send-auto -> send-think) ===
  ~ arguments[0].tone: "Magic" -> "Gpt_5_6_Reasoning"
```

One field. Everything else — 34 `optionsSets` flags, 31 `allowedMessageTypes`,
the whole `message` object — is byte-identical.

### The full enum

Taken from the client's own `clientPreferences.modelSelectorMetadata`, so this is
every value the app ships, not just the ones observed in traffic:

| `tone` value | Menu label | Section |
|---|---|---|
| `Magic` | Auto — "Decides how long to think" | 1 (default) |
| `Chat` | Quick response — "Answers right away" | 1 |
| `Reasoning` | Think deeper — "Think longer for better answers" | 1 |
| `Gpt_5_6_Reasoning` | GPT 5.6 Think deeper (short: "GPT 5.6 Think") | 2 |
| `Gpt_5_5_Chat` | GPT 5.5 Quick response | 2 |

Section 1 holds the generic modes that survived the July change; section 2 holds
the residual named models. Chat history on this tenant still contains
`Gpt_5_4_Reasoning` threads even though 5.4 is no longer offered in the menu —
the deprecation is visible in your own account.

`tone` is **per conversation**, not per profile. A new chat resets to `Magic`
regardless of what was selected in another thread, so the picker has to be set
before the first send.

## The transport

```
wss://substrate.office.com/m365Copilot/Chathub/{userObjectId}@{tenantId}
    ?chatsessionid=…&XRoutingParameterSessionKey=…&clientrequestid=…
    &X-SessionId=…&ConversationId=…
```

SignalR over WebSocket. The client sends a `type: 4` invocation to
`target: "chat"`; the server streams the reply back and closes the invocation.

```json
{"type": 4, "target": "chat", "invocationId": "0", "arguments": [{
  "tone": "Gpt_5_6_Reasoning",
  "source": "officeweb",
  "streamingMode": "ConciseWithPadding",
  "isStartOfSession": false,
  "message": {
    "author": "user", "inputMethod": "Keyboard", "messageType": "Chat",
    "text": "Reply with exactly the word OK and nothing else.",
    "locale": "no", "locationInfo": {"timeZone": "Europe/Oslo"}
  },
  "optionsSets": ["cwc_flux_v3", "flux_v3_references", "…31 more"],
  "allowedMessageTypes": ["Chat", "Suggestion", "Progress", "…28 more"]
}]}
```

**A correction.** An earlier version of this README claimed the public writeups
describing a substrate SignalR Chathub were documenting a surface that no longer
exists. That was wrong, and the mistake is instructive: the Chathub socket opens
**lazily, on the first message send**. Captures that only loaded the page saw
nothing but a Trouter socket (`go-eu.trouter.teams.microsoft.com`, socket.io
framing, `ua=BizChat`) carrying auth and presence signalling with no chat
content — so "no Chathub" was an artifact of never having sent a prompt. The
published descriptions are substantially correct. `tone` is the part they miss.

## Image attachments

Images do not travel in the chat frame. They go to a separate endpoint first,
and the frame that follows references them **not at all**.

```
POST https://substrate.office.com/m365Copilot/UploadFile
Content-Type: multipart/form-data

scenario      = UploadImage
conversationId = <guid>
FileBase64    = data:image/png;base64,iVBORw0KGgoAAAANSUhEUg…
optionsSets   = cwcgptvsan
optionsSets   = flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch
optionsSets   = gptvnorm2048
```

Response:

```json
{
  "fileName": "0588acdec7.png", "fileSize": 248736, "fileType": ".png",
  "tokenSize": 0, "isLongContext": false,
  "docId": "0-neu-d9-de6bf35cdb93dbfe0cd82615b0fcd808",
  "fileSanitizer": "ImageSanitizerBingAI",
  "conversationId": "eb6ec1d7-…",
  "result": {"value": "Success", "message": "Success"}
}
```

The interesting part: the subsequent `type: 4` invocation contains no `docId`, no
attachment array, and an empty `message.adaptiveCards`. The upload carries
`conversationId`, so the image is bound to the **conversation server-side** and
the prompt is just a prompt. Verified by generating a 256×256 gradient PNG,
uploading it, and asking for a description — the reply was "A smooth gradient
blending blue, green, yellow, orange, pink, and purple colors across the image."

So `driver.py` *could* support images: POST the base64 with the live
`conversationId`, then send text as usual. It does not do this yet.

A note on the sanitizer: a 77-byte 8×8 PNG was rejected with
`{"fileSanitizer": "None", "result": {"value": "InvalidRequest"}}`. Use a
realistically sized image when testing.

## Tools

| Script | Job |
|---|---|
| `capture.py` | Passive recorder. You drive; it records WebSocket frames, POST bodies, and streamed responses. |
| `tap.js` | Injected before page scripts; wraps `fetch`/`EventSource`/`XMLHttpRequest`. |
| `run_probe.py` | Automated: selects a model, sends a prompt, captures the whole turn. |
| `diff_frames.py` | Diffs two captures' chat invocations, filtering GUID noise. |
| `inspect_capture.py` | Summarises a capture: endpoints, streams, model-selector candidates. |
| `probe_dom.py` | Dumps the page's real inputs and buttons, so selectors are based on fact. |
| `find_tones.py` | Scrapes the tone enum from the app's own JavaScript bundles. |
| `serve.py` / `driver.py` | OpenAI-compatible endpoint over a resident browser. **Unfinished — see below.** |

Everything above `serve.py` has been run against a live tenant and produced the
result documented here. `serve.py` and `driver.py` have **never been executed**.
They were written before the reconnaissance was done and have not caught up:
`driver.py` still looks for a `div[role="textbox"]` composer, which does not
exist, so it fails at startup. Its frame-reading half should be sound — it
filters for the Chathub socket and its `extract_deltas()` matches the real
`type: 2` frames — but treat the pair as a sketch, not a working server. There is
no chat UI in this repo; `serve.py` serves `/health`, `/v1/models` and
`/v1/chat/completions` and nothing else.

### Reproducing the finding

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install playwright flask
.\.venv\Scripts\python.exe -m playwright install chromium

# Sign in once; the profile persists.
.\.venv\Scripts\python.exe capture.py --label signin --seconds 300

.\.venv\Scripts\python.exe run_probe.py --label send-auto  --tone "Auto" --prompt "Reply with exactly the word OK and nothing else."
.\.venv\Scripts\python.exe run_probe.py --label send-think --tone "GPT 5.6 Think deeper" --prompt "Reply with exactly the word OK and nothing else."
.\.venv\Scripts\python.exe diff_frames.py captures\send-auto.jsonl captures\send-think.jsonl
```

## Things learned the hard way

Three bugs, all found by checking output against reality rather than trusting it.
A silent observer failure looks exactly like "the system doesn't do that."

**Redact at the write boundary.** The first recorder scrubbed credentials only on
successfully-parsed JSON. Trouter's socket.io frames (`5:::{…}`) failed
`json.loads`, fell through to a raw branch, and wrote a live
`Authorization: Bearer eyJ…` to disk. Redaction now runs on every line
immediately before it is written, so no parse path can bypass it.

**`fetch()` takes three argument shapes.** A string, a `URL`, or a `Request`. The
tap only handled strings, so every record had an empty `url` and the send
endpoint was unidentifiable. Bodies on a `Request` live on the object, not in
`init.body`, and need `request.clone().text()`.

**CDP's `Network.eventSourceMessageReceived` only fires for real `EventSource`.**
An app streaming `text/event-stream` through `fetch` + `ReadableStream` is
invisible to it. Wrapping `fetch` in-page is the only reliable way to see those
chunks. Read `response.clone()` so the app's own stream is untouched.

And two selector lessons: the composer is a `<span>` with `role="textbox"`, not a
`div` or `textarea`, so tag-qualified selectors miss it. The named models sit
behind a submenu that opens on **hover** — clicking the parent collapses it.
`probe_dom.py` exists because guessing cost more time than asking.

## Security

`.gitignore` excludes `.profile/` and `captures/`, and both matter.

- **`.profile/`** holds live session cookies for whichever Microsoft account you
  signed into. Committing it is equivalent to publishing your credentials.
- **`captures/`** holds raw traffic. Bearer tokens and JWTs are redacted
  automatically, but frames still contain your prompts, the replies, your chat
  titles, your tenant ID and your user object ID. Read a capture before you paste
  any of it in public.

Signed into a **work or school** account, everything here runs against your
employer's tenant under your own identity, with tenant audit logging and whatever
your acceptable-use policy says about non-browser clients. A personal Microsoft
account is the safer thing to demo and publish against.

## Credit

The SSE chunk encoder in `serve.py` and the confine-Playwright-to-one-thread
pattern in `driver.py` come from [agentry](https://github.com/aweussom/agentry),
which wraps coding-agent CLIs as an OpenAI endpoint using only documented
protocols. This repo is the disreputable cousin: agentry's `TODONT.md` explains
at length why reverse-engineering a chat backend is a bad idea. It is right. That
was never the point.

## License

MIT
