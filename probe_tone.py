"""Ask the server whether it still honours a `tone` the client no longer offers.

The premise of this repo was that the model picker sets one field, `tone`, on
the chat invocation. The picker has since been removed from the web client. That
raises a question the picker-driven tools cannot answer, because they work by
clicking a menu that is no longer there:

    Does the backend still accept `tone: "Gpt_5_6_Reasoning"` when the frontend
    has stopped offering it?

If yes, the removal was cosmetic and this repo is the only remaining way in.
If no, it is over regardless of client.

This script answers that by injecting `force_tone.js`, which rewrites `tone` on
the outbound frame, and never touching the picker at all. Everything else in the
invocation is whatever the real client built.

Three arms, and the third is the one that matters:

    python probe_tone.py --label t-control --tone Magic             --prompt "..."
    python probe_tone.py --label t-gpt56   --tone Gpt_5_6_Reasoning --prompt "..."
    python probe_tone.py --label t-bogus   --tone Not_A_Real_Tone   --prompt "..."

A successful reply on arm 2 proves nothing on its own: a server that ignores the
field entirely also returns a successful reply. Arm 3 is the falsification. If a
value that cannot possibly be valid behaves exactly like `Gpt_5_6_Reasoning`,
then `tone` is being discarded and arm 2 was measuring nothing. Only a *visible
difference* between arms 2 and 3 -- an error, a refusal, a different answer --
shows the field is still being read.

Diff two arms the usual way:

    python diff_frames.py captures/t-control.jsonl captures/t-gpt56.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

from capture import CAPTURE_DIR, PROFILE_DIR, Recorder

CHAT_URL = "https://m365.cloud.microsoft/chat"

# Shared with run_probe.py: the composer is a <span> with role="textbox", found
# by asking the DOM rather than guessing, and matched on language-independent
# attributes because this tenant's UI is Norwegian.
COMPOSER_SELECTORS = (
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][aria-label*="Copilot"]',
    "textarea",
    '[contenteditable="true"]',
)

# Cloudflare Turnstile sits in front of the composer and swallows the send. The
# dialog's text is localised ("Verifiser at du er et menneske"), so match the
# iframe instead, which is not. Detected rather than defeated: this is a bot
# check, and the line this project draws -- see TODONT.md on the automation flag
# -- is between automating your own session and evading detection. A human
# clicking the box is the honest resolution, so the probe waits for one.
# Detected via the FRAME TREE, not the DOM. Turnstile renders its iframe into a
# shadow root, so `document.querySelectorAll('iframe')` returns nothing while
# `page.frames` shows it plainly -- an earlier version of this selector matched
# on the DOM and silently never fired, losing two turns before probe_dom-style
# introspection showed why. Ask the page what it contains; do not guess.
CHALLENGE_FRAME_MARKER = "challenges.cloudflare.com"
# The wrapper is Microsoft's own Fluent dialog, whose aria-label is localised
# ("Sikkerhetskontroll kreves" here), so it is a fallback signal, never the test.
CHALLENGE_URL_MARKERS = ("cdn-cgi/challenge-platform", "challenges.cloudflare.com")

# Anything that looks like a named model value, wherever it turns up.
MODEL_RE = re.compile(r"\bGpt_\d+_\d+(?:_\w+)?\b", re.IGNORECASE)

# Keys whose value might name the model that actually served the turn. We do not
# know that any of these exist -- that is the point of dumping the final frame.
MODEL_KEY_RE = re.compile(r"(?i)(model|engine|deployment|tone|variant|sku)")

# Does the client still ship the named-model section? Commit b88d57e established
# that this config is server-side rendered into the document rather than fetched,
# so the document is the first place to look. The bounded window walk catches the
# case where it has been hydrated onto a global instead.
FIND_METADATA_JS = r"""
() => {
  const KEY = 'modelSelectorMetadata';
  const out = {html_hits: 0, html_samples: [], global_paths: [], tone_values: []};

  const html = document.documentElement.outerHTML;
  let idx = html.indexOf(KEY);
  while (idx !== -1 && out.html_hits < 3) {
    out.html_samples.push(html.slice(idx, idx + 4000));
    out.html_hits += 1;
    idx = html.indexOf(KEY, idx + 1);
  }

  // Bounded walk: depth 4, 20k nodes, cycle-safe, every access guarded. An
  // unbounded walk of `window` hangs on cycles and throws on live getters.
  const seen = new WeakSet();
  let budget = 20000;
  const walk = (node, path, depth) => {
    if (depth > 4 || budget-- <= 0 || !node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    let keys;
    try { keys = Object.keys(node); } catch (_) { return; }
    for (const k of keys) {
      let v;
      try { v = node[k]; } catch (_) { continue; }
      if (k === KEY) {
        out.global_paths.push(path + '.' + k);
        try { out.html_samples.push(JSON.stringify(v).slice(0, 4000)); } catch (_) {}
        continue;
      }
      if (v && typeof v === 'object') walk(v, path + '.' + k, depth + 1);
    }
  };
  try { walk(window, 'window', 0); } catch (_) {}

  const blob = out.html_samples.join(' ') || html;
  out.tone_values = Array.from(new Set(
    (blob.match(/\bGpt_\d+_\d+(?:_\w+)?\b/g) || []).concat(
      (blob.match(/"(Magic|Chat|Reasoning)"/g) || []).map(s => s.replace(/"/g, ''))
    )
  ));
  return out;
}
"""


def challenge_visible(page) -> bool:
    try:
        return any(CHALLENGE_FRAME_MARKER in (f.url or "") for f in page.frames)
    except Exception:
        return False


def wait_out_challenge(page, seconds: int) -> bool:
    """Block until a human clears the verification box, or time runs out."""
    if not challenge_visible(page):
        return True
    print("\n" + "!" * 68, flush=True)
    print("  Cloudflare is asking whether you are a human.", flush=True)
    print("  Tick the box in the browser window. Nothing is sent until you do,", flush=True)
    print(f"  and this will wait up to {seconds}s for you.", flush=True)
    print("!" * 68 + "\n", flush=True)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        page.wait_for_timeout(1000)
        if not challenge_visible(page):
            print("[challenge] cleared, carrying on", flush=True)
            page.wait_for_timeout(1500)
            return True
    print("[challenge] still up; giving up rather than guessing past it", flush=True)
    return False


def find_composer(page):
    for selector in COMPOSER_SELECTORS:
        box = page.locator(selector).first
        try:
            if box.count() and box.is_visible():
                return box
        except Exception:
            continue
    return None


def load_records(path: Path) -> list[dict]:
    records = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def is_chat_invocation(obj: Any) -> bool:
    return (
        isinstance(obj, dict)
        and obj.get("type") in (1, 4)
        and obj.get("target") == "chat"
        and isinstance(obj.get("arguments"), list)
        and obj["arguments"]
        and isinstance(obj["arguments"][0], dict)
    )


def collect_model_hints(obj: Any, path: str = "") -> list[tuple[str, Any]]:
    """Keys or values anywhere in the reply that might name the serving model.

    We do not assume a field name. The README documents the request side of this
    protocol; the response side was never mapped, so this reports candidates and
    lets a human decide, rather than inventing a field and trusting it.
    """
    hits: list[tuple[str, Any]] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            here = f"{path}.{key}" if path else key
            if MODEL_KEY_RE.search(key) and not isinstance(value, (dict, list)):
                hits.append((here, value))
            elif isinstance(value, str) and MODEL_RE.search(value):
                hits.append((here, value))
            else:
                hits.extend(collect_model_hints(value, here))
    elif isinstance(obj, list):
        for i, item in enumerate(obj[:40]):
            hits.extend(collect_model_hints(item, f"{path}[{i}]"))
    return hits


def analyse(path: Path, wanted: str) -> int:
    """Report what actually happened on the wire. Returns a process exit code."""
    records = load_records(path)

    forced = [r for r in records if r.get("kind") == "tap" and r.get("phase") == "tone-forced"]
    failed = [r for r in records if r.get("kind") == "tap" and r.get("phase") == "tone-force-failed"]

    sent_tones: list[Any] = []
    for rec in records:
        if rec.get("kind") == "ws" and rec.get("direction") == "sent":
            if is_chat_invocation(rec.get("json")):
                sent_tones.append(rec["json"]["arguments"][0].get("tone"))

    recv = [r for r in records if rec_is_recv_chat(r)]
    finals = [r for r in records
              if r.get("kind") == "ws" and r.get("direction") == "recv"
              and isinstance(r.get("json"), dict) and r["json"].get("type") == 2]

    print("\n" + "=" * 68)
    print(f"  tone probe: requested {wanted!r}")
    print("=" * 68)

    # 1. Did the override fire at all? A silent observer failure looks exactly
    #    like "the system doesn't do that", so this is checked before anything
    #    is concluded from the reply.
    if failed:
        print("\n[!] the override reported failures:")
        for rec in failed[:5]:
            print(f"    {rec.get('reason')}")
    if not forced:
        print("\n[FAIL] force_tone.js never rewrote a chat invocation.")
        print("       Nothing below is evidence about the server.")
        challenged = [r for r in records
                      if any(m in str(r.get("url", "")) for m in CHALLENGE_URL_MARKERS)]
        if challenged:
            print(f"\n       Cause, almost certainly: {len(challenged)} Cloudflare")
            print("       challenge requests are in this capture. A human-verification")
            print("       box was sitting on the composer, so the prompt was typed and")
            print("       Enter was pressed but no invocation ever left. Re-run and")
            print("       tick the box; --await-human controls how long it waits.")
        else:
            print("       Likely causes: the hub protocol changed, the send path is")
            print("       not WebSocket.prototype.send, or no prompt was actually sent.")
        return 2
    for rec in forced:
        print(f"\n[ok] rewrote tone {rec.get('from')!r} -> {rec.get('to')!r}"
              f"{' (already set)' if rec.get('noop') else ''}")

    # 2. Independent confirmation. force_tone.js patches JS; Playwright reads the
    #    frame below that, at CDP. If the two disagree, believe CDP -- it is what
    #    left the machine -- and treat the run as void.
    print(f"\n[wire] chat invocations sent: {len(sent_tones)}")
    for tone in sent_tones:
        mark = "==" if tone == wanted else "!="
        print(f"       tone on the wire: {tone!r}  {mark} requested")
    if sent_tones and all(t != wanted for t in sent_tones):
        print("\n[FAIL] the JS tap claims a rewrite but CDP saw a different value.")
        print("       The rewrite did not reach the socket. Run is void.")
        return 2
    if not sent_tones:
        print("       (none captured -- cannot confirm independently)")

    # 3. What came back. The response side of this protocol was never mapped, so
    #    dump the completion frame rather than asserting a field name.
    print(f"\n[reply] type-1 chat frames: {len(recv)}, type-2 completions: {len(finals)}")

    # The completion frame carries a result envelope. A non-Success value is the
    # server telling you it would not run this invocation -- which is a finding,
    # not a malfunction. An earlier version called this "the turn did not happen"
    # and returned a failure code, which got the single most informative run of
    # the investigation filed as a broken instrument. A refusal IS the signal:
    # a field that were being discarded could not produce one.
    outcomes = []
    for frame in finals:
        result = ((frame.get("json") or {}).get("item") or {}).get("result") or {}
        if result:
            outcomes.append(result)
    for result in outcomes:
        print(f"[result] {result.get('value')}"
              f"{'  ' + result.get('errorCode') if result.get('errorCode') else ''}"
              f"  {str(result.get('message', ''))[:110]}")

    if outcomes and all(r.get("value") != "Success" for r in outcomes):
        print(f"\n[REFUSED] the server rejected {wanted!r}: a completion frame with")
        print("          no deltas and no messages. It read the field and declined.")
        final_path = path.with_suffix(".final.json")
        final_path.write_text(
            json.dumps([f.get("json") for f in finals], indent=2, ensure_ascii=False),
            encoding="utf-8")
        print(f"          completion frame(s) -> {final_path}")
        return 0

    if not recv:
        print("[FAIL] no chat frames and no result envelope. The turn did not happen.")
        return 2

    final_path = path.with_suffix(".final.json")
    final_path.write_text(
        json.dumps([f.get("json") for f in finals] or [r.get("json") for r in recv[-3:]],
                   indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"[reply] completion frame(s) -> {final_path}")

    hints: dict[str, set[str]] = {}
    for rec in recv + finals:
        for key, value in collect_model_hints(rec.get("json")):
            hints.setdefault(key, set()).add(str(value)[:120])
    if hints:
        print("\n[hints] response fields that might name the serving model:")
        for key in sorted(hints)[:25]:
            print(f"    {key} = {', '.join(sorted(hints[key]))[:110]}")
    else:
        print("\n[hints] nothing in the reply names a model. The answer text is")
        print("        then the only discriminator -- which is why arm 3 exists.")

    answer = extract_answer(recv)
    if answer:
        print(f"\n[answer] {answer[:600]}")

    print("\n" + "-" * 68)
    print("A reply here does NOT mean the tone was honoured. Compare against the")
    print("bogus-tone arm before concluding anything:")
    print("    python probe_tone.py --label t-bogus --tone Not_A_Real_Tone --prompt ...")
    print("-" * 68 + "\n")
    return 0


def rec_is_recv_chat(rec: dict) -> bool:
    return (
        rec.get("kind") == "ws"
        and rec.get("direction") == "recv"
        and isinstance(rec.get("json"), dict)
        and rec["json"].get("type") == 1
    )


def extract_answer(recv: list[dict]) -> str:
    """Longest bot text carrying contentOrigin DeepLeo -- the real answer.

    Frames are cumulative rather than incremental, so the longest wins. Progress
    chatter carries a messageType; the answer has none.
    """
    best = ""
    for rec in recv:
        for message in walk_messages(rec.get("json")):
            if message.get("author") != "bot":
                continue
            if message.get("messageType"):
                continue
            text = message.get("text") or ""
            if len(text) > len(best):
                best = text
    return best


def walk_messages(obj: Any) -> list[dict]:
    found: list[dict] = []
    if isinstance(obj, dict):
        if "author" in obj and "text" in obj:
            found.append(obj)
        for value in obj.values():
            found.extend(walk_messages(value))
    elif isinstance(obj, list):
        for item in obj:
            found.extend(walk_messages(item))
    return found


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--tone", required=True,
                    help="wire value, e.g. Gpt_5_6_Reasoning -- not a menu label")
    ap.add_argument("--profile", default=str(PROFILE_DIR))
    ap.add_argument("--wait", type=int, default=180, help="seconds to wait for the reply")
    ap.add_argument("--await-human", type=int, default=120, metavar="SECONDS",
                    help="how long to wait for you to clear a Cloudflare check")
    ap.add_argument("--metadata", action="store_true",
                    help="also dump modelSelectorMetadata from the loaded page")
    ap.add_argument("--analyse-only", action="store_true",
                    help="re-read an existing capture instead of running the browser")
    args = ap.parse_args()

    CAPTURE_DIR.mkdir(exist_ok=True)
    out_path = CAPTURE_DIR / f"{args.label}.jsonl"

    if args.analyse_only:
        if not out_path.exists():
            print(f"no such capture: {out_path}", file=sys.stderr)
            return 1
        return analyse(out_path, args.tone)

    rec = Recorder(out_path)
    shot_path = CAPTURE_DIR / f"{args.label}.png"

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=args.profile,
            headless=False,
            viewport={"width": 1500, "height": 950},
        )
        context.expose_function("__wireTap", rec.tapped)
        here = Path(__file__).parent
        # Order matters: the tap provides __wireTap's transport, the constant
        # must exist before force_tone.js reads it, and all three must be in
        # place before the application's own scripts run.
        context.add_init_script((here / "tap.js").read_text(encoding="utf-8"))
        context.add_init_script(f"window.__forceTone = {json.dumps(args.tone)};")
        context.add_init_script((here / "force_tone.js").read_text(encoding="utf-8"))

        page = context.pages[0] if context.pages else context.new_page()

        def attach(target) -> None:
            def on_ws(ws) -> None:
                rec.socket_open(ws.url)
                ws.on("framereceived", lambda p: rec.ws_frame("recv", ws.url, p))
                ws.on("framesent", lambda p: rec.ws_frame("sent", ws.url, p))
            target.on("websocket", on_ws)

        attach(page)
        context.on("page", attach)

        page.goto(CHAT_URL, wait_until="domcontentloaded")

        print("waiting for composer...", flush=True)
        composer = None
        for _ in range(120):
            composer = find_composer(page)
            if composer is not None:
                break
            page.wait_for_timeout(500)
        if composer is None:
            print("ERROR: no composer. Is the session still signed in?", file=sys.stderr)
            rec.close()
            context.close()
            return 1
        print("composer ready", flush=True)
        page.wait_for_timeout(2500)

        if args.metadata:
            try:
                meta = page.evaluate(FIND_METADATA_JS)
                meta_path = CAPTURE_DIR / f"{args.label}.metadata.json"
                meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False),
                                     encoding="utf-8")
                print(f"[metadata] document hits: {meta['html_hits']}, "
                      f"globals: {meta['global_paths']}", flush=True)
                print(f"[metadata] tone values visible to the client: "
                      f"{meta['tone_values']}", flush=True)
                print(f"[metadata] -> {meta_path}", flush=True)
            except Exception as exc:
                print(f"[warn] metadata scan failed: {exc}", flush=True)

        # The picker is never touched. That is the whole point: on a client that
        # no longer offers the model, clicking is not an option, and going
        # through the menu would confound what is being tested.
        print(f"sending prompt with forced tone {args.tone!r}: {args.prompt!r}", flush=True)
        wait_out_challenge(page, args.await_human)
        composer.click()
        composer.type(args.prompt, delay=15)
        page.keyboard.press("Enter")

        # Turnstile can appear *on* the send rather than before it, which is how
        # the first run of this script lost a turn: the text went in, Enter was
        # pressed, and the invocation was simply swallowed. Check again, then
        # press Enter once more if a human cleared it.
        page.wait_for_timeout(1500)
        if challenge_visible(page):
            if wait_out_challenge(page, args.await_human):
                composer.click()
                page.keyboard.press("Enter")

        deadline = time.monotonic() + args.wait
        last_count = -1
        stable_since = None
        baseline = rec.count
        while time.monotonic() < deadline:
            page.wait_for_timeout(1000)
            current = rec.count
            if current != last_count:
                last_count = current
                stable_since = time.monotonic()
            elif stable_since and current > baseline and time.monotonic() - stable_since > 10:
                print("[reply] wire idle for 10s, treating as complete", flush=True)
                break

        try:
            page.screenshot(path=str(shot_path), full_page=False)
            print(f"screenshot -> {shot_path}", flush=True)
        except Exception as exc:
            print(f"[warn] screenshot failed: {exc}", flush=True)

        print(f"\n[done] {rec.count} records -> {out_path}", flush=True)
        rec.close()
        try:
            context.close()
        except Exception:
            pass

    return analyse(out_path, args.tone)


if __name__ == "__main__":
    raise SystemExit(main())
