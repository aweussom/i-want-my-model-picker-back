"""Tests for the tone-override probe. Run directly: `python test_probe_tone.py`.

Two halves, and both exist for the same reason.

`force_tone.js` is exercised in a real browser rather than a JS shim, because
the first version passed a shim and still broke: `WebSocket.prototype.url` is an
accessor that throws for anything that is not a live socket, the catch handler
read it a second time, and the re-throw escaped the catch and took the page's
own `send()` down with it. A shim with a plain `url` property never sees that.

`analyse()` is exercised mostly through its *failure* cases, because refusing to
report a verdict when the instrument failed is the whole job. This repo has been
burned twice by an observer that quietly saw nothing -- once by CDP's SSE events,
once by a redaction branch -- and a probe that cannot tell "the server said no"
from "my override never fired" would be the third.

No network, no Copilot session, no signed-in profile. The browser half uses a
throwaway profile directory; Chromium locks a profile, so pointing it at a real
one would collide with a live capture.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

import probe_tone
from capture import Recorder

HERE = Path(__file__).parent
TONE = "Gpt_5_6_Reasoning"
HUB = "wss://substrate.office.com/m365Copilot/Chathub/x@y"
RS = "\x1e"

FAILURES: list[str] = []


def check(name: str, ok: bool, extra: object = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + str(extra)[:120]) if extra else ''}")
    if not ok:
        FAILURES.append(name)


# --------------------------------------------------------------------------
# force_tone.js, in a real browser
# --------------------------------------------------------------------------

def browser_cases() -> None:
    """Everything force_tone.js must and must not touch, in a real page."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "inject.jsonl"
        rec = Recorder(out)
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=str(Path(tmp) / "throwaway-profile"), headless=True)
            ctx.expose_function("__wireTap", rec.tapped)
            # Order matters, and is the same order probe_tone.py uses: the tap
            # supplies __wireTap's transport, the constant must exist before
            # force_tone.js reads it, and all three precede any page script.
            ctx.add_init_script((HERE / "tap.js").read_text(encoding="utf-8"))
            ctx.add_init_script(f"window.__forceTone = {json.dumps(TONE)};")
            ctx.add_init_script((HERE / "force_tone.js").read_text(encoding="utf-8"))

            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto("about:blank")

            check("__forceTone reached the page", page.evaluate("window.__forceTone") == TONE)
            check("WebSocket.prototype.send was patched",
                  page.evaluate("WebSocket.prototype.send.toString().includes('rewrite')"))
            check("__wireTap binding exists",
                  page.evaluate("typeof window.__wireTap") == "function")

            invocation = {
                "type": 4, "target": "chat", "invocationId": "0",
                "arguments": [{
                    "tone": "Magic", "source": "officeweb",
                    "streamingMode": "ConciseWithPadding",
                    "message": {"author": "user", "text": "hi", "locale": "no"},
                    "optionsSets": ["cwc_flux_v3", "flux_v3_references"],
                    "allowedMessageTypes": ["Chat", "Progress"],
                }],
            }
            handshake = json.dumps({"protocol": "json", "version": 1}) + RS
            ping = json.dumps({"type": 6}) + RS
            chat = json.dumps(invocation) + RS
            multi = ping + chat

            results = page.evaluate(
                """(args) => {
                  const [frames, url] = args;
                  // `url` as an own data property shadows the prototype's
                  // accessor, which throws for anything but a live socket.
                  const fake = Object.create(WebSocket.prototype);
                  Object.defineProperty(fake, 'url', {value: url});
                  // The patch closes over the original send, so it cannot be
                  // spied on by reassigning the prototype. Let the real call
                  // throw instead, and read what was rewritten off the tap.
                  const patched = WebSocket.prototype.send;
                  return frames.map((f) => {
                    try { patched.call(fake, f); return {err: null}; }
                    catch (e) { return {err: String(e)}; }
                  });
                }""",
                [[handshake, ping, chat, multi], HUB],
            )
            # Every call ends in "Illegal invocation" from the real send, which
            # is expected and harmless: it happens after the rewrite, and proves
            # the patch does not swallow the original call.
            check("patch always reaches the original send",
                  all("Illegal invocation" in (r["err"] or "") for r in results), results)

            page.evaluate("""() => {
              const fake = Object.create(WebSocket.prototype);
              Object.defineProperty(fake, 'url', {value: 'wss://x/Chathub'});
              try { WebSocket.prototype.send.call(fake, new ArrayBuffer(8)); } catch (e) {}
            }""")

            # A socket-shaped object whose url getter throws must not break send.
            broke = page.evaluate("""() => {
              const hostile = Object.create(WebSocket.prototype);   // url throws
              try { WebSocket.prototype.send.call(hostile, 'noise'); }
              catch (e) { return String(e); }
              return null;
            }""")
            check("a throwing url getter does not break send",
                  broke is not None and "Illegal invocation" in broke, broke)

            page.wait_for_timeout(700)   # let the exposed binding drain
            ctx.close()
        rec.close()

        records = [json.loads(l) for l in out.read_text(encoding="utf-8").splitlines() if l.strip()]
        forced = [r for r in records if r.get("phase") == "tone-forced"]
        failed = [r for r in records if r.get("phase") == "tone-force-failed"]

        # Two chat invocations went past: the bare one and the one inside the
        # multi-record frame. The handshake and the ping must not have fired.
        check("exactly the chat invocations were rewritten", len(forced) == 2, forced)
        check("rewrite reports the old value and the new",
              bool(forced) and forced[0].get("from") == "Magic" and forced[0].get("to") == TONE,
              forced[:1])
        check("rewrite report survives the Recorder with the hub url",
              bool(forced) and "Chathub" in str(forced[0].get("url", "")))
        check("binary frame is reported rather than silently skipped",
              any("binary" in str(r.get("reason", "")) for r in failed), failed)


# --------------------------------------------------------------------------
# probe_tone.analyse(), against synthetic captures
# --------------------------------------------------------------------------

def invocation_record(tone: str) -> dict:
    return {"kind": "ws", "direction": "sent", "url": HUB, "type": 4, "json": {
        "type": 4, "target": "chat", "invocationId": "0",
        "arguments": [{"tone": tone, "source": "officeweb",
                       "message": {"author": "user", "text": "hi"}}]}}


def forced_record(frm: str, to: str) -> dict:
    return {"kind": "tap", "phase": "tone-forced", "url": HUB,
            "from": frm, "to": to, "noop": False}


def delta_record(text: str, message_type: str | None = None) -> dict:
    message = {"author": "bot", "text": text, "contentOrigin": "DeepLeo"}
    if message_type:
        message["messageType"] = message_type
    return {"kind": "ws", "direction": "recv", "url": HUB, "type": 1, "json": {
        "type": 1, "target": "update", "arguments": [{"messages": [message]}]}}


def completion_record(model: str | None = None) -> dict:
    item: dict = {"messages": [{"author": "bot", "text": "OK", "contentOrigin": "DeepLeo"}]}
    if model:
        item["telemetry"] = {"modelName": model}
    return {"kind": "ws", "direction": "recv", "url": HUB, "type": 2, "json": {
        "type": 2, "invocationId": "0", "item": item}}


def refusal_record() -> dict:
    """What the server actually sent for an invalid tone on 2026-09-15."""
    return {"kind": "ws", "direction": "recv", "url": HUB, "type": 2, "json": {
        "type": 2, "invocationId": "0", "item": {"messages": [], "result": {
            "value": "NotFound", "errorCode": "ConversationNotFound",
            "message": "Beklager, jeg kunne ikke svare på det."}}}}


def run_analyse(records: list[dict], want: str = TONE) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "arm.jsonl"
        path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        import io
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()):     # the report is noisy
            return probe_tone.analyse(path, want)


def analyse_cases() -> None:
    check("complete run reports a verdict", run_analyse([
        forced_record("Magic", TONE), invocation_record(TONE),
        delta_record("Getting things ready...", "Progress"),
        delta_record("OK"), completion_record("gpt-5.6-reasoning"),
    ]) == 0)

    check("an override that never fired voids the run", run_analyse([
        invocation_record("Magic"), delta_record("OK"), completion_record(),
    ]) == 2)

    # The JS tap and Playwright's CDP read the same frame at different layers.
    # If they disagree, the rewrite did not reach the socket.
    check("tap and CDP disagreeing voids the run", run_analyse([
        forced_record("Magic", TONE), invocation_record("Magic"),
        delta_record("OK"), completion_record(),
    ]) == 2)

    check("a rewrite with no reply voids the run", run_analyse([
        forced_record("Magic", TONE), invocation_record(TONE),
    ]) == 2)

    check("a reply naming no model is still a verdict", run_analyse([
        forced_record("Magic", TONE), invocation_record(TONE),
        delta_record("OK"), completion_record(),
    ]) == 0)

    # The falsification arm. A completion carrying a non-Success result and no
    # deltas is the server declining to run the invocation -- the single most
    # informative outcome the probe can produce, because a field being silently
    # discarded could not produce it. An earlier version filed this as
    # "the turn did not happen" and returned a failure code.
    check("a server refusal is a verdict, not an instrument failure", run_analyse([
        forced_record("Magic", "Not_A_Real_Tone"), invocation_record("Not_A_Real_Tone"),
        refusal_record(),
    ], want="Not_A_Real_Tone") == 0)


def main() -> int:
    print("--- force_tone.js in a real browser ---")
    browser_cases()
    print("\n--- probe_tone.analyse() ---")
    analyse_cases()
    print(f"\n{len(FAILURES)} failure(s): {', '.join(FAILURES)}" if FAILURES else "\nall green")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
