"""Find how an image attachment reaches Copilot.

The chat invocation already advertises vision support (optionsSets include
`cwcfluxgptv`, `gptvnorm2048`,
`flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch`, `cwc_fileupload_odb`),
so the capability is clearly there. The open question is the transport: does the
image go inline as base64 in the SignalR frame, or to a separate upload endpoint
that returns a reference the frame then cites?

This attaches a file through Copilot's own file input, sends a prompt about it,
and records everything. `cwc_fileupload_odb` ("OneDrive for Business") hints at
an out-of-band upload, but hints are not evidence.

    python probe_image.py --image captures/test-image.png
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from capture import CAPTURE_DIR, PROFILE_DIR, Recorder
from run_probe import find_composer

CHAT_URL = "https://m365.cloud.microsoft/chat"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--image", default="captures/test-image.png")
    ap.add_argument("--label", default="image-upload")
    ap.add_argument("--prompt", default="Describe this image in one short sentence.")
    ap.add_argument("--wait", type=int, default=150)
    args = ap.parse_args()

    image_path = Path(args.image).resolve()
    if not image_path.exists():
        print(f"no such image: {image_path}")
        return 1

    CAPTURE_DIR.mkdir(exist_ok=True)
    rec = Recorder(CAPTURE_DIR / f"{args.label}.jsonl")

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1500, "height": 950},
            args=["--disable-blink-features=AutomationControlled"],
        )
        context.expose_function("__wireTap", rec.tapped)
        context.add_init_script((Path(__file__).parent / "tap.js").read_text(encoding="utf-8"))

        page = context.pages[0] if context.pages else context.new_page()

        def attach(target) -> None:
            def on_ws(ws) -> None:
                rec.socket_open(ws.url)
                ws.on("framesent", lambda p: rec.ws_frame("sent", ws.url, p))
                ws.on("framereceived", lambda p: rec.ws_frame("recv", ws.url, p))
            target.on("websocket", on_ws)

        attach(page)
        context.on("page", attach)
        page.goto(CHAT_URL, wait_until="domcontentloaded")

        composer = None
        for _ in range(120):
            composer = find_composer(page)
            if composer:
                break
            page.wait_for_timeout(500)
        if composer is None:
            print("ERROR: no composer")
            rec.close()
            context.close()
            return 1
        print("composer ready", flush=True)
        page.wait_for_timeout(3000)

        # Copilot keeps a hidden file input; set_input_files works on hidden ones.
        inputs = page.locator('input[type="file"]')
        count = inputs.count()
        print(f"file inputs on page: {count}", flush=True)
        if count == 0:
            print("no file input; would need the attach menu. Aborting.", flush=True)
            rec.close()
            context.close()
            return 1

        attached = False
        for index in range(count):
            try:
                inputs.nth(index).set_input_files(str(image_path))
                print(f"attached via input #{index}", flush=True)
                attached = True
                break
            except Exception as exc:
                print(f"  input #{index} rejected: {exc!r}"[:160], flush=True)
        if not attached:
            rec.close()
            context.close()
            return 1

        # Give the upload time to happen before the prompt goes out, so the
        # capture separates "upload" from "send" cleanly.
        print("waiting for upload traffic...", flush=True)
        page.wait_for_timeout(12000)

        composer = find_composer(page) or composer
        composer.click()
        composer.type(args.prompt, delay=15)
        page.keyboard.press("Enter")
        print("prompt sent", flush=True)

        deadline = time.monotonic() + args.wait
        last = -1
        stable = None
        while time.monotonic() < deadline:
            page.wait_for_timeout(1000)
            if rec.stream_chunks != last:
                last = rec.stream_chunks
                stable = time.monotonic()
            elif stable and time.monotonic() - stable > 10:
                break

        page.screenshot(path=str(CAPTURE_DIR / f"{args.label}.png"))
        print(f"\n[done] {rec.count} records -> {rec.path}", flush=True)
        rec.close()
        try:
            context.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
