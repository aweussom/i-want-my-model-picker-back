"""Passive WebSocket frame recorder for Microsoft 365 Copilot (BizChat).

Opens a real Chromium with a persistent profile, lets you drive the Copilot UI
by hand, and records every WebSocket frame the page sends and receives.

Nothing is automated on purpose: you pick the model, you type the prompt, you
hit send. The point is to learn the wire format without guessing at selectors,
and in particular to see which field changes when you change the model picker.

Usage:
    python capture.py --label auto
    python capture.py --label gpt56think

Each run writes captures/<label>.jsonl. Compare two runs with:
    python diff_frames.py captures/auto.jsonl captures/gpt56think.jsonl
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

CHAT_URL = "https://m365.cloud.microsoft/chat"
PROFILE_DIR = Path(__file__).parent / ".profile"
CAPTURE_DIR = Path(__file__).parent / "captures"

# SignalR delimits JSON records with an ASCII record separator.
RECORD_SEPARATOR = "\x1e"

# Query-string and header values that must never reach a capture file. These are
# bearer credentials for a live session; a leaked capture is a leaked account.
SECRET_PARAMS = ("access_token", "accesstoken", "token", "authorization", "sig")


def redact_url(url: str) -> str:
    """Strip credential-bearing query parameters from a WebSocket URL."""
    for param in SECRET_PARAMS:
        url = re.sub(
            rf"([?&]{param}=)[^&]*",
            r"\1<REDACTED>",
            url,
            flags=re.IGNORECASE,
        )
    return url


def redact_payload(obj: Any) -> Any:
    """Recursively blank out anything that looks like a credential."""
    if isinstance(obj, dict):
        out = {}
        for key, value in obj.items():
            if key.lower() in SECRET_PARAMS or key.lower().endswith("token"):
                out[key] = "<REDACTED>"
            else:
                out[key] = redact_payload(value)
        return out
    if isinstance(obj, list):
        return [redact_payload(item) for item in obj]
    if isinstance(obj, str) and obj.startswith("ey") and len(obj) > 200:
        # Bare JWT sitting in a string field.
        return "<REDACTED-JWT>"
    return obj


def split_records(payload: str) -> list[str]:
    """SignalR packs multiple JSON records into one frame, separator-delimited."""
    return [part for part in payload.split(RECORD_SEPARATOR) if part.strip()]


class FrameRecorder:
    def __init__(self, path: Path, label: str) -> None:
        self.path = path
        self.label = label
        self.handle = path.open("w", encoding="utf-8")
        self.count = 0
        self.sockets: set[str] = set()
        self.started = time.monotonic()

    def note_socket(self, url: str) -> None:
        safe = redact_url(url)
        if safe not in self.sockets:
            self.sockets.add(safe)
            print(f"\n[ws] {safe}\n", flush=True)
            self._write({"kind": "socket-open", "url": safe})

    def record(self, direction: str, url: str, payload: str | bytes) -> None:
        if isinstance(payload, bytes):
            try:
                payload = payload.decode("utf-8")
            except UnicodeDecodeError:
                self._write(
                    {
                        "kind": "frame",
                        "direction": direction,
                        "url": redact_url(url),
                        "binary_len": len(payload),
                    }
                )
                return

        for record in split_records(payload):
            try:
                parsed: Any = json.loads(record)
                parsed = redact_payload(parsed)
                entry = {"json": parsed}
                msg_type = parsed.get("type") if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                entry = {"raw": record[:4000]}
                msg_type = None

            self.count += 1
            self._write(
                {
                    "kind": "frame",
                    "seq": self.count,
                    "t": round(time.monotonic() - self.started, 3),
                    "direction": direction,
                    "type": msg_type,
                    "url": redact_url(url),
                    **entry,
                }
            )
            self._echo(direction, msg_type, entry)

    def _echo(self, direction: str, msg_type: Any, entry: dict) -> None:
        """One terse line per frame so you can watch it happen live."""
        arrow = "-->" if direction == "sent" else "<--"
        if "raw" in entry:
            print(f"{arrow} [raw] {entry['raw'][:90]}", flush=True)
            return
        blob = json.dumps(entry["json"], ensure_ascii=False)
        print(f"{arrow} type={msg_type} {blob[:160]}", flush=True)

    def _write(self, obj: dict) -> None:
        self.handle.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.handle.flush()

    def close(self) -> None:
        self.handle.close()


def attach(page, recorder: FrameRecorder) -> None:
    def on_websocket(ws) -> None:
        recorder.note_socket(ws.url)
        ws.on("framesent", lambda p: recorder.record("sent", ws.url, p))
        ws.on("framereceived", lambda p: recorder.record("recv", ws.url, p))
        ws.on("close", lambda _: print("[ws] closed", flush=True))

    page.on("websocket", on_websocket)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--label",
        required=True,
        help="capture name, e.g. 'auto' or 'gpt56think' (becomes captures/<label>.jsonl)",
    )
    parser.add_argument("--url", default=CHAT_URL)
    parser.add_argument(
        "--seconds",
        type=int,
        default=900,
        help="how long to keep recording before closing (default 900)",
    )
    args = parser.parse_args()

    CAPTURE_DIR.mkdir(exist_ok=True)
    PROFILE_DIR.mkdir(exist_ok=True)
    out_path = CAPTURE_DIR / f"{args.label}.jsonl"
    recorder = FrameRecorder(out_path, args.label)

    print(f"profile : {PROFILE_DIR}")
    print(f"writing : {out_path}")
    print("\nThe browser is yours. Sign in if asked, set the model picker, send a")
    print("prompt. Every frame lands in the file above. Ctrl+C when done.\n")

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1500, "height": 950},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        attach(page, recorder)
        context.on("page", lambda p: attach(p, recorder))

        page.goto(args.url, wait_until="domcontentloaded")

        deadline = time.monotonic() + args.seconds
        try:
            while time.monotonic() < deadline:
                page.wait_for_timeout(500)
        except KeyboardInterrupt:
            print("\n[stop] interrupted", flush=True)
        finally:
            print(f"\n[done] {recorder.count} frames -> {out_path}", flush=True)
            recorder.close()
            context.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
