"""Passive traffic recorder for Microsoft 365 Copilot (BizChat).

Opens a real Chromium with a persistent profile, lets you drive the Copilot UI
by hand, and records what the page sends and receives.

Nothing is automated on purpose: you pick the model, you type the prompt, you
hit send. The point is to learn the wire format without guessing at selectors,
and in particular to see which field changes when you change the model picker.

What it records, because the chat turns out not to live in one place:

  * WebSocket frames. The m365 chat page opens a Trouter socket
    (go-eu.trouter.teams.microsoft.com, socket.io framing, `ua=BizChat`) which
    carries auth and presence signalling but no chat content.
  * HTTP requests to Copilot-ish hosts, including POST bodies. This is where the
    prompt actually goes.
  * Server-sent events, via CDP's Network.eventSourceMessageReceived. Reading
    SSE this way is non-blocking, unlike awaiting a streaming response body.

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

# SignalR delimits JSON records with an ASCII record separator. Trouter instead
# uses socket.io framing (`5:1+::{...}`). Both appear on this page.
RECORD_SEPARATOR = "\x1e"
SOCKETIO_PREFIX = re.compile(r"^\d+:\d*\+?::?")

SECRET_PARAMS = ("access_token", "accesstoken", "token", "authorization", "sig")

# Hosts worth recording. Everything else on this page is telemetry noise.
INTERESTING_HOSTS = (
    "substrate.office.com",
    "substrate.svc.cloud.microsoft",
    "m365.cloud.microsoft",
    "copilot.microsoft.com",
    "office.com",
    "bing.com",
    "graph.microsoft.com",
)

SKIP_EXTENSIONS = (
    ".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".woff", ".woff2",
    ".ico", ".gif", ".map", ".webp", ".ttf",
)

# Telemetry sinks. These POST constantly and their bodies contain the words
# "message" and "text", which is enough to fool a naive prompt detector.
TELEMETRY_MARKERS = (
    "/events",
    "client_health_ping",
    "browser.pipe.aria",
    "events.data.microsoft.com",
    "/collect",
    "/telemetry",
    "/OneCollector",
    "aria.microsoft.com",
    "/diagnostics",
)

# A body has to look like somebody actually typed something.
PROMPT_HINTS = ('"text"', '"prompt"', '"query"', '"content"')


def is_telemetry(url: str) -> bool:
    low = url.lower()
    return any(marker.lower() in low for marker in TELEMETRY_MARKERS)

# --- redaction -----------------------------------------------------------
#
# Every line is passed through redact_text() immediately before it is written.
# An earlier version only scrubbed successfully-parsed JSON, so socket.io frames
# that failed json.loads() fell through to a raw branch and wrote a live
# `Authorization: Bearer eyJ...` to disk. Scrubbing at the write boundary means
# no parse path can bypass it.

JWT_RE = re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+")
BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]{20,}", re.IGNORECASE)
LONG_B64_RE = re.compile(r"\bey[A-Za-z0-9_\-]{200,}\b")
SKYPETOKEN_RE = re.compile(
    r'(?i)("?(?:skypetoken|skype_token|access_token|refresh_token|id_token)"?\s*[:=]\s*"?)'
    r'[A-Za-z0-9._\-]{20,}'
)


def redact_text(text: str) -> str:
    """Scrub credentials from arbitrary text. Last line of defence."""
    text = BEARER_RE.sub(r"\1<REDACTED>", text)
    text = JWT_RE.sub("<REDACTED-JWT>", text)
    text = LONG_B64_RE.sub("<REDACTED-TOKEN>", text)
    text = SKYPETOKEN_RE.sub(r"\1<REDACTED>", text)
    for param in SECRET_PARAMS:
        text = re.sub(
            rf"([?&]{param}=)[^&\"\\\s]*", r"\1<REDACTED>", text, flags=re.IGNORECASE
        )
    return text


def redact_url(url: str) -> str:
    for param in SECRET_PARAMS:
        url = re.sub(
            rf"([?&]{param}=)[^&]*", r"\1<REDACTED>", url, flags=re.IGNORECASE
        )
    return url


def redact_payload(obj: Any) -> Any:
    """Structural pass, so redacted values stay JSON rather than becoming text."""
    if isinstance(obj, dict):
        out = {}
        for key, value in obj.items():
            low = key.lower()
            if low in SECRET_PARAMS or low.endswith("token") or low == "authorization":
                out[key] = "<REDACTED>"
            else:
                out[key] = redact_payload(value)
        return out
    if isinstance(obj, list):
        return [redact_payload(item) for item in obj]
    if isinstance(obj, str):
        return redact_text(obj)
    return obj


def split_records(payload: str) -> list[str]:
    """Unpack a frame into individual records, handling both framings."""
    parts = [p for p in payload.split(RECORD_SEPARATOR) if p.strip()]
    out: list[str] = []
    for part in parts:
        stripped = SOCKETIO_PREFIX.sub("", part, count=1)
        out.append(stripped if stripped.strip() else part)
    return out


def interesting(url: str) -> bool:
    low = url.lower()
    if any(low.split("?")[0].endswith(ext) for ext in SKIP_EXTENSIONS):
        return False
    return any(host in low for host in INTERESTING_HOSTS)


class Recorder:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.handle = path.open("w", encoding="utf-8")
        self.count = 0
        self.chat_posts = 0
        self.stream_chunks = 0
        self.seen: set[str] = set()
        self.started = time.monotonic()

    def write(self, obj: dict) -> None:
        self.count += 1
        obj["seq"] = self.count
        obj["t"] = round(time.monotonic() - self.started, 3)
        line = json.dumps(obj, ensure_ascii=False)
        self.handle.write(redact_text(line) + "\n")
        self.handle.flush()

    # --- websocket ----------------------------------------------------

    def socket_open(self, url: str) -> None:
        safe = redact_url(url)
        if safe in self.seen:
            return
        self.seen.add(safe)
        print(f"\n[ws] {safe[:150]}\n", flush=True)
        self.write({"kind": "socket-open", "url": safe})

    def ws_frame(self, direction: str, url: str, payload: str | bytes) -> None:
        if isinstance(payload, bytes):
            try:
                payload = payload.decode("utf-8")
            except UnicodeDecodeError:
                self.write({"kind": "ws", "direction": direction, "binary_len": len(payload)})
                return
        for record in split_records(payload):
            entry: dict[str, Any] = {
                "kind": "ws",
                "direction": direction,
                "url": redact_url(url),
            }
            try:
                parsed = redact_payload(json.loads(record))
                entry["json"] = parsed
                entry["type"] = parsed.get("type") if isinstance(parsed, dict) else None
                name = parsed.get("name") if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                entry["raw"] = record[:4000]
                name = None
            self.write(entry)
            arrow = "-->" if direction == "sent" else "<--"
            tag = name or entry.get("type") or "raw"
            print(f"{arrow} [ws {tag}]", flush=True)

    # --- http ---------------------------------------------------------

    def http_request(self, method: str, url: str, post_data: str | None) -> None:
        entry: dict[str, Any] = {
            "kind": "http-request",
            "method": method,
            "url": redact_url(url),
        }
        if post_data:
            try:
                entry["body"] = redact_payload(json.loads(post_data))
            except json.JSONDecodeError:
                entry["body_raw"] = post_data[:8000]
            # A POST body carrying prompt text is the chat invocation.
            if any(hint in post_data for hint in PROMPT_HINTS):
                self.chat_posts += 1
                print(
                    f"\n*** candidate chat POST #{self.chat_posts}: "
                    f"{url.split('?')[0][:110]}\n",
                    flush=True,
                )
            else:
                print(f"--> [POST] {url.split('?')[0][:100]}", flush=True)
        self.write(entry)
        if not post_data:
            print(f"--> [http {method}] {url.split('?')[0][:100]}", flush=True)

    def tapped(self, payload: str) -> None:
        """Event forwarded from tap.js running inside the page."""
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            return
        phase = obj.get("phase", "?")
        url = str(obj.get("url", ""))
        entry = {"kind": "tap", "phase": phase, "url": redact_url(url)}
        for key in ("method", "ctype", "index", "chunks", "error"):
            if key in obj:
                entry[key] = obj[key]
        for key in ("body", "chunk", "data"):
            if key in obj and obj[key] is not None:
                raw = str(obj[key])
                try:
                    entry[key] = redact_payload(json.loads(raw))
                except json.JSONDecodeError:
                    entry[key] = redact_text(raw[:8000])
        self.write(entry)

        short = url.split("?")[0][:95]
        if phase in ("fetch-request", "xhr-request"):
            blob = str(obj.get("body") or "")
            if any(hint in blob for hint in PROMPT_HINTS):
                self.chat_posts += 1
                print(f"\n*** PROMPT SENT #{self.chat_posts} -> {short}\n", flush=True)
            else:
                print(f"--> [{phase}] {short}", flush=True)
        elif phase in ("stream-chunk", "xhr-chunk", "sse"):
            self.stream_chunks += 1
            body = str(obj.get("chunk") or obj.get("data") or "")
            print(f"<-- [{phase} {self.stream_chunks}] {body[:100]}", flush=True)
        else:
            print(f"    [{phase}] {short}", flush=True)

    def sse_event(self, url: str, event: str, data: str) -> None:
        entry: dict[str, Any] = {"kind": "sse", "url": redact_url(url), "event": event}
        try:
            entry["data"] = redact_payload(json.loads(data))
        except json.JSONDecodeError:
            entry["data_raw"] = data[:8000]
        self.write(entry)
        print(f"<-- [sse {event or 'message'}] {data[:110]}", flush=True)

    def close(self) -> None:
        self.handle.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    parser.add_argument("--url", default=CHAT_URL)
    parser.add_argument("--seconds", type=int, default=900)
    args = parser.parse_args()

    CAPTURE_DIR.mkdir(exist_ok=True)
    PROFILE_DIR.mkdir(exist_ok=True)
    out_path = CAPTURE_DIR / f"{args.label}.jsonl"
    rec = Recorder(out_path)

    print(f"profile : {PROFILE_DIR}")
    print(f"writing : {out_path}")
    print("\nThe browser is yours. Set the model picker, send a prompt.")
    print("Watch for a '*** chat POST' line -- that is the request we want.")
    print("Ctrl+C when done.\n")

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1500, "height": 950},
            args=["--disable-blink-features=AutomationControlled"],
        )
        # The in-page tap must be installed before any application script runs,
        # so both of these happen before the first navigation.
        context.expose_function("__wireTap", rec.tapped)
        tap_source = (Path(__file__).parent / "tap.js").read_text(encoding="utf-8")
        context.add_init_script(tap_source)

        page = context.pages[0] if context.pages else context.new_page()

        def attach(target_page) -> None:
            def on_ws(ws) -> None:
                rec.socket_open(ws.url)
                ws.on("framesent", lambda p: rec.ws_frame("sent", ws.url, p))
                ws.on("framereceived", lambda p: rec.ws_frame("recv", ws.url, p))

            target_page.on("websocket", on_ws)

            def on_request(req) -> None:
                if is_telemetry(req.url):
                    return
                # Record every POST regardless of host: the prompt may go to a
                # host we did not predict, and POSTs are rare next to asset GETs.
                # GETs are filtered hard or the log becomes unreadable.
                if req.method != "POST":
                    if not interesting(req.url) or "chat" not in req.url.lower():
                        return
                try:
                    body = req.post_data
                except Exception:
                    body = None
                rec.http_request(req.method, req.url, body)

            target_page.on("request", on_request)

            # CDP gives us SSE events without blocking on the response body.
            try:
                cdp = context.new_cdp_session(target_page)
                cdp.send("Network.enable")
                cdp.on(
                    "Network.eventSourceMessageReceived",
                    lambda e: rec.sse_event(
                        e.get("requestId", ""), e.get("eventName", ""), e.get("data", "")
                    ),
                )
            except Exception as exc:
                print(f"[warn] CDP attach failed: {exc}", flush=True)

        attach(page)
        context.on("page", attach)

        page.goto(args.url, wait_until="domcontentloaded")

        deadline = time.monotonic() + args.seconds
        try:
            while time.monotonic() < deadline:
                page.wait_for_timeout(500)
        except KeyboardInterrupt:
            print("\n[stop] interrupted", flush=True)
        finally:
            print(
                f"\n[done] {rec.count} records, {rec.chat_posts} chat POST(s)"
                f" -> {out_path}",
                flush=True,
            )
            rec.close()
            try:
                context.close()
            except Exception:
                pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
