"""Resident browser that drives Microsoft 365 Copilot and reads its WebSocket.

Two ideas carry this file.

First, Playwright owns the browser but not the conversation. We type into the
real composer and press Enter, then we read the reply off the WebSocket frames
the page already receives instead of scraping rendered HTML. The DOM tells you
text stopped growing; the wire tells you the turn is *finished*, which is a
different and much more useful fact.

Second, Playwright's sync API objects belong to the thread that made them, so
everything browser-shaped runs on one dedicated worker thread and callers talk
to it over queues. That pattern is lifted from agentry's CopilotSDKBackend._call
(https://github.com/aweussom/agentry, backends.py), which does the same trick to
bridge an asyncio SDK onto a synchronous interface.
"""

from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from typing import Any, Iterator

from playwright.sync_api import sync_playwright

from capture import RECORD_SEPARATOR, redact_url, split_records

import json

CHAT_URL = "https://m365.cloud.microsoft/chat"
PROFILE_DIR = Path(__file__).parent / ".profile"

# Composer candidates, tried in order. The M365 chat surface has changed shape
# several times; these cover the variants seen in the wild.
COMPOSER_SELECTORS = (
    'div[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="melding"]',
    '[data-testid="chat-input"]',
    'div[contenteditable="true"]',
)

SENTINEL_DONE = object()


def extract_deltas(payload: dict[str, Any]) -> tuple[list[str], bool]:
    """Pull assistant text out of one parsed SignalR record.

    Returns (text_fragments, turn_finished).

    This is the only wire-format-specific function in the project. BizChat
    streams partial text in type=1 records and delivers the settled turn in a
    type=2 record; type=3 closes the invocation. Response shapes drift, so this
    reads defensively and treats anything unrecognised as "no text".
    """
    fragments: list[str] = []
    msg_type = payload.get("type")

    def harvest(messages: Any) -> None:
        if not isinstance(messages, list):
            return
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            if msg.get("author") != "bot":
                continue
            if msg.get("messageType") not in (None, "Chat"):
                continue  # skip Diagnostics / InternalSearchQuery chatter
            text = msg.get("text")
            if isinstance(text, str) and text:
                fragments.append(text)

    if msg_type == 1:
        for arg in payload.get("arguments") or []:
            if isinstance(arg, dict):
                harvest(arg.get("messages"))
    elif msg_type == 2:
        item = payload.get("item")
        if isinstance(item, dict):
            harvest(item.get("messages"))
        return fragments, True
    elif msg_type == 3:
        return fragments, True

    return fragments, False


class CopilotDriver:
    """Owns one browser on one thread; serialises turns."""

    def __init__(self, headless: bool = False, url: str = CHAT_URL) -> None:
        self._url = url
        self._headless = headless
        self._commands: queue.Queue = queue.Queue()
        self._events: queue.Queue = queue.Queue()
        self._turn_lock = threading.Lock()
        self._ready = threading.Event()
        self._error: BaseException | None = None
        self._socket_url: str | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    # --- browser thread ---------------------------------------------------

    def _on_frame(self, payload: str | bytes) -> None:
        if isinstance(payload, bytes):
            try:
                payload = payload.decode("utf-8")
            except UnicodeDecodeError:
                return
        for record in split_records(payload):
            try:
                parsed = json.loads(record)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict):
                continue
            fragments, finished = extract_deltas(parsed)
            for fragment in fragments:
                self._events.put(("text", fragment))
            if finished:
                self._events.put(("done", None))

    def _attach(self, page) -> None:
        def on_websocket(ws) -> None:
            if "chathub" in ws.url.lower() or "substrate" in ws.url.lower():
                self._socket_url = redact_url(ws.url)
                ws.on("framereceived", self._on_frame)

        page.on("websocket", on_websocket)

    def _find_composer(self, page):
        for selector in COMPOSER_SELECTORS:
            box = page.locator(selector).first
            try:
                if box.count() and box.is_visible():
                    return box
            except Exception:
                continue
        return None

    def _run(self) -> None:
        try:
            with sync_playwright() as pw:
                context = pw.chromium.launch_persistent_context(
                    user_data_dir=str(PROFILE_DIR),
                    headless=self._headless,
                    viewport={"width": 1500, "height": 950},
                    args=["--disable-blink-features=AutomationControlled"],
                )
                page = context.pages[0] if context.pages else context.new_page()
                self._attach(page)
                context.on("page", self._attach)
                page.goto(self._url, wait_until="domcontentloaded")

                # Wait for a composer, i.e. for the human to finish signing in.
                composer = None
                for _ in range(600):
                    composer = self._find_composer(page)
                    if composer is not None:
                        break
                    page.wait_for_timeout(500)
                if composer is None:
                    raise RuntimeError(
                        "No composer found. Sign in with capture.py first so the "
                        "profile holds a session."
                    )
                self._ready.set()

                while True:
                    command = self._commands.get()
                    if command is None:
                        break
                    text = command
                    composer = self._find_composer(page)
                    if composer is None:
                        self._events.put(("error", "composer vanished"))
                        self._events.put(("done", None))
                        continue
                    composer.click()
                    # Clear whatever is there. fill() works on contenteditable
                    # too, but throws on some rich composers, so fall back to a
                    # select-all delete.
                    try:
                        composer.fill("")
                    except Exception:
                        page.keyboard.press("Control+A")
                        page.keyboard.press("Delete")
                    composer.type(text, delay=8)
                    page.keyboard.press("Enter")

                context.close()
        except BaseException as exc:  # surfaced to callers
            self._error = exc
            self._ready.set()
            self._events.put(("error", repr(exc)))
            self._events.put(("done", None))

    # --- public API -------------------------------------------------------

    def wait_ready(self, timeout: float = 300.0) -> None:
        if not self._ready.wait(timeout):
            raise TimeoutError("browser did not become ready")
        if self._error is not None:
            raise self._error

    @property
    def socket_url(self) -> str | None:
        return self._socket_url

    def prompt(self, text: str, timeout: float = 180.0) -> Iterator[str]:
        """Send one prompt; yield assistant text as it arrives.

        BizChat re-sends the whole message body as it grows rather than emitting
        pure deltas, so we track the longest prefix seen and yield only the tail.
        """
        self.wait_ready()
        with self._turn_lock:
            while not self._events.empty():
                self._events.get_nowait()

            self._commands.put(text)
            deadline = time.monotonic() + timeout
            emitted = ""

            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("no completion frame before timeout")
                try:
                    kind, value = self._events.get(timeout=min(remaining, 1.0))
                except queue.Empty:
                    continue

                if kind == "text":
                    if value.startswith(emitted):
                        tail = value[len(emitted):]
                        if tail:
                            emitted = value
                            yield tail
                    elif len(value) > len(emitted):
                        emitted = value
                        yield value
                    else:
                        yield value
                elif kind == "error":
                    raise RuntimeError(f"driver error: {value}")
                elif kind == "done":
                    return

    def close(self) -> None:
        self._commands.put(None)
