"""End-to-end probe: pick a model, send one prompt, capture the whole exchange.

This is capture.py plus automation. It reuses the same recorder and the same
in-page tap, then drives the UI itself so a full turn can be captured without a
human sitting there. That makes the result repeatable, which is the difference
between "I saw it once" and a proof somebody else can reproduce.

    python run_probe.py --label send-think --tone "GPT 5.6 Think" --prompt "Reply with OK"
    python run_probe.py --label send-auto  --tone "Auto"          --prompt "Reply with OK"

Two runs differing only in --tone are exactly the pair diff_frames.py wants.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from capture import CAPTURE_DIR, PROFILE_DIR, Recorder

CHAT_URL = "https://m365.cloud.microsoft/chat"

# Discovered with probe_dom.py rather than guessed. The composer is a <span>,
# not a div or textarea, so tag-qualified selectors miss it entirely. This
# tenant's UI is Norwegian ("Send melding til Copilot"), so match on role and
# contenteditable, which are language-independent.
COMPOSER_SELECTORS = (
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][aria-label*="Copilot"]',
    'textarea',
    '[contenteditable="true"]',
)

# The picker button's accessible name is the localized "model selector"
# (Norwegian: "Modellvelger"); its *inner text* is the current selection.
PICKER_SELECTORS = (
    '[aria-label*="odellvelger"]',
    '[aria-label*="odel"]',
    'button[aria-haspopup]',
)


def find_composer(page):
    for selector in COMPOSER_SELECTORS:
        box = page.locator(selector).first
        try:
            if box.count() and box.is_visible():
                return box
        except Exception:
            continue
    return None


def select_tone(page, wanted: str) -> bool:
    """Open the model picker and choose the entry matching `wanted`."""
    trigger = None
    for selector in PICKER_SELECTORS:
        candidate = page.locator(selector).first
        try:
            if candidate.count() and candidate.is_visible():
                trigger = candidate
                current = (candidate.inner_text() or "").strip()
                print(f"[picker] trigger found via {selector!r}, currently {current!r}",
                      flush=True)
                break
        except Exception:
            continue
    if trigger is None:
        print("[picker] no trigger found", flush=True)
        return False

    trigger.click(timeout=5000)
    # The menu needs well over a second to render; 1.2s was too short and made
    # an empty menu look like a missing one.
    page.wait_for_timeout(2500)

    def visible_items():
        """Current menu entries as (locator, role, text)."""
        found = []
        for role in ("menuitemradio", "menuitem", "option"):
            try:
                for item in page.get_by_role(role).all():
                    try:
                        if item.is_visible():
                            found.append((item, role, (item.inner_text() or "").strip()))
                    except Exception:
                        continue
            except Exception:
                continue
        return found

    def try_click(items) -> bool:
        for item, role, text in items:
            flat = " ".join(text.split())
            if wanted.lower() in flat.lower():
                try:
                    item.click(timeout=5000)
                    print(f"[picker] selected ({role}) {flat[:50]!r}", flush=True)
                    page.wait_for_timeout(900)
                    return True
                except Exception:
                    continue
        return False

    items = visible_items()
    print("[picker] top-level menu:", flush=True)
    for _, role, text in items[:10]:
        print(f"    ({role}) {' '.join(text.split())[:60]!r}", flush=True)

    if try_click(items):
        return True

    # Named models live behind a submenu ("GPT / OpenAI"), so the top level
    # never contains "GPT 5.6 Think". Expand any provider entry and look again.
    for item, role, text in items:
        flat = " ".join(text.split())
        if role == "menuitem" and ("gpt" in flat.lower() or "openai" in flat.lower()):
            try:
                # Hover only. Clicking the parent collapses the submenu and
                # loses the nested entries entirely.
                print(f"[picker] hovering submenu {flat[:40]!r}", flush=True)
                item.hover()
                page.wait_for_timeout(2200)
            except Exception:
                continue
            nested = visible_items()
            print("[picker] submenu offers:", flush=True)
            for _, r2, t2 in nested[:10]:
                print(f"    ({r2}) {' '.join(t2.split())[:60]!r}", flush=True)
            if try_click(nested):
                return True

    print(f"[picker] no entry matching {wanted!r}; leaving selection unchanged", flush=True)
    page.keyboard.press("Escape")
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--label", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--tone", default=None, help="picker entry to select, by visible text")
    ap.add_argument("--profile", default=str(PROFILE_DIR))
    ap.add_argument("--wait", type=int, default=120, help="seconds to wait for the reply")
    ap.add_argument("--new-chat", action="store_true",
                    help="reload the chat page first so the turn starts a fresh thread")
    args = ap.parse_args()

    CAPTURE_DIR.mkdir(exist_ok=True)
    out_path = CAPTURE_DIR / f"{args.label}.jsonl"
    rec = Recorder(out_path)
    shot_path = CAPTURE_DIR / f"{args.label}.png"

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=args.profile,
            headless=False,
            viewport={"width": 1500, "height": 950},
        )
        context.expose_function("__wireTap", rec.tapped)
        context.add_init_script((Path(__file__).parent / "tap.js").read_text(encoding="utf-8"))

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
        page.wait_for_timeout(2500)   # let the app settle before touching the picker

        if args.tone:
            select_tone(page, args.tone)
            composer = find_composer(page) or composer

        before_streams = rec.stream_chunks
        print(f"sending prompt: {args.prompt!r}", flush=True)
        composer.click()
        composer.type(args.prompt, delay=15)
        page.keyboard.press("Enter")

        # Wait for the reply to stop growing rather than for a fixed duration.
        deadline = time.monotonic() + args.wait
        last_count = -1
        stable_since = None
        while time.monotonic() < deadline:
            page.wait_for_timeout(1000)
            current = rec.stream_chunks
            if current != last_count:
                last_count = current
                stable_since = time.monotonic()
            elif stable_since and current > before_streams and time.monotonic() - stable_since > 8:
                print("[reply] stream idle for 8s, treating as complete", flush=True)
                break

        try:
            page.screenshot(path=str(shot_path), full_page=False)
            print(f"screenshot -> {shot_path}", flush=True)
        except Exception as exc:
            print(f"[warn] screenshot failed: {exc}", flush=True)

        print(f"\n[done] {rec.count} records, {rec.stream_chunks} stream chunks -> {out_path}",
              flush=True)
        rec.close()
        try:
            context.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
