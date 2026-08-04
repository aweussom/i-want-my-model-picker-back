# copilot-wire

Microsoft 365 Copilot's GUI has a model picker. Microsoft's official Copilot
Chat API does not have a model parameter.

That gap is the whole reason this repo exists. As of August 2026 you can open
`m365.cloud.microsoft/chat`, turn *off* the new design, and choose **GPT 5.6
Think** from a dropdown. There is no supported way to ask for that model
programmatically — and Microsoft started removing named models from the picker
on 7 July 2026, so the dropdown itself is on the way out.

So this is wire-protocol archaeology on a button that is being deleted. It reads
the WebSocket frames the Copilot page already receives, works out which field
carries the model selection, and puts an OpenAI-compatible endpoint in front of
it.

## Status

| Piece | State |
|---|---|
| `capture.py` — passive frame recorder | works, self-tested end to end |
| `diff_frames.py` — find the model-selection field | works, validated on synthetic captures |
| `driver.py` — resident browser, frames to text | written, **frame shapes not yet confirmed against a live tenant** |
| `serve.py` — OpenAI-compatible endpoint | written, untested against a live tenant |

`extract_deltas()` in `driver.py` is built from publicly documented BizChat
frame shapes, not from a capture of a real session. Run the capture first; if
the shapes differ, that one function is the only thing that needs changing.

## Why read the WebSocket instead of the DOM

Scraping rendered HTML can tell you that text stopped growing. It cannot tell
you the turn is *finished* — those are different facts, and confusing them is
where DOM-driven chat wrappers get flaky. The wire carries an explicit
completion record, so `driver.py` uses Playwright for the things a browser is
genuinely good at (real SSO, MFA, device compliance, a persistent profile,
clicking the model picker like a human) and reads the frames for everything else.

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install playwright flask
.\.venv\Scripts\python.exe -m playwright install chromium
```

## 1. Capture the wire

Two runs, changing only the model picker between them:

```powershell
.\.venv\Scripts\python.exe capture.py --label auto
.\.venv\Scripts\python.exe capture.py --label gpt56think
```

A real Chromium opens. Sign in on the first run — the profile persists, so later
runs are already authenticated. Nothing is automated here on purpose: you pick
the model, you type the prompt, you press send. Every frame is echoed live and
written to `captures/<label>.jsonl`.

## 2. Find the field

```powershell
.\.venv\Scripts\python.exe diff_frames.py captures\auto.jsonl captures\gpt56think.jsonl
```

GUIDs, timestamps and the prompt text are filtered as noise, so what remains is
the actual difference:

```
=== wire diff (auto -> gpt56think) ===
  + arguments[0].optionsSets gained ["modelselection_gpt56think"]
```

If it prints `(identical after noise filtering)`, the selection is server-side
state rather than a per-message field — which is also a result, and it means the
browser has to stay resident.

## 3. Serve it

```powershell
.\.venv\Scripts\python.exe serve.py --port 8790
```

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"m365-copilot","stream":true,
       "messages":[{"role":"user","content":"Explain SignalR record separators"}]}'
```

One browser means one conversation at a time; turns serialise behind a lock.

## Security

`.gitignore` excludes two directories, and both exclusions matter:

- **`.profile/`** holds live session cookies for whichever Microsoft account you
  signed into. Committing it is equivalent to publishing your credentials.
- **`captures/`** holds raw wire logs. Bearer tokens and JWTs are redacted
  automatically, but frames still contain your prompts, the replies, file names
  and chat titles. Read a capture before you paste any of it in public.

If you are signed into a **work or school** account, everything here runs against
your employer's tenant under your own identity, with tenant audit logging and
whatever your acceptable-use policy says about non-browser clients. A personal
Microsoft account is the safer thing to demo and publish against.

## Credit

The SSE chunk encoder in `serve.py` and the confine-Playwright-to-one-thread
pattern in `driver.py` both come from [agentry](https://github.com/aweussom/agentry),
which wraps coding-agent CLIs as an OpenAI endpoint using only documented
protocols. This repo is the disreputable cousin: agentry's `TODONT.md` explains
at some length why reverse-engineering a chat backend is a bad idea. It is
right. That was never the point.

## License

MIT
