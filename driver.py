"""Resident browser that drives Microsoft 365 Copilot and reads its WebSocket.

Three ideas carry this file.

Playwright owns the browser but not the conversation. We type into the real
composer and press Enter, then read the reply off the Chathub WebSocket frames
the page already receives instead of scraping rendered HTML. The DOM can tell you
text stopped growing; the wire tells you the turn is *finished*, which is a
different and much more useful fact (`type: 3` closes the invocation).

Playwright's sync API objects belong to the thread that created them, so
everything browser-shaped runs on one dedicated worker thread and callers talk to
it over queues. That pattern comes from agentry's CopilotSDKBackend._call
(https://github.com/aweussom/agentry, backends.py:205), which does the same trick
to bridge an asyncio SDK onto a synchronous interface.

`tone` — the field carrying model choice — is **per conversation**. A new chat
resets to `Magic` no matter what was selected elsewhere. So changing model means
starting a fresh conversation and setting the picker before the first send, which
is why switch_tone() reloads the page.
"""

from __future__ import annotations

import json
import queue
import re
import threading
import time
from pathlib import Path
from typing import Iterator

from playwright.sync_api import sync_playwright

from capture import redact_url, split_records

CHAT_URL = "https://m365.cloud.microsoft/chat"
PROFILE_DIR = Path(__file__).parent / ".profile"

# Discovered with probe_dom.py, not guessed. The composer is a <span> with
# role="textbox"; tag-qualified selectors miss it. Match on role and
# contenteditable, which do not change with UI language.
COMPOSER_SELECTORS = (
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][aria-label*="Copilot"]',
    "textarea",
    '[contenteditable="true"]',
)

# The picker button's accessible name is localized ("Modellvelger" in Norwegian);
# its inner text is the current selection.
PICKER_SELECTORS = (
    '[aria-label*="odellvelger"]',
    '[aria-label*="odel"]',
    "button[aria-haspopup]",
)

# tone value -> the picker entry that selects it. Section 2 entries live behind a
# provider submenu that opens on hover.
TONES: dict[str, dict[str, str]] = {
    "Magic": {"label": "Auto", "title": "Auto", "owned_by": "microsoft"},
    "Chat": {"label": "Quick response", "title": "Quick response", "owned_by": "microsoft"},
    "Reasoning": {"label": "Think deeper", "title": "Think deeper", "owned_by": "microsoft"},
    "Gpt_5_6_Reasoning": {
        "label": "GPT 5.6 Think deeper",
        "title": "GPT 5.6 Think deeper",
        "owned_by": "openai",
    },
    "Gpt_5_5_Chat": {
        "label": "GPT 5.5 Quick response",
        "title": "GPT 5.5 Quick response",
        "owned_by": "openai",
    },
}
DEFAULT_TONE = "Magic"

# Bot messages that are progress chatter rather than the answer. The real reply
# arrives with no messageType at all and contentOrigin "DeepLeo".
PROGRESS_TYPES = {
    "Progress",
    "InternalLoaderMessage",
    "InternalSearchQuery",
    "InternalSearchResult",
    "RenderCardRequest",
    "SearchQuery",
    "GeneratedCode",
    "Disengaged",
}

CITATION_RE = re.compile(r"\[\^(\d+)\^\]")


def is_chathub(url: str) -> bool:
    low = url.lower()
    return "chathub" in low or ("substrate" in low and "copilot" in low)


class CopilotDriver:
    """Owns one browser on one thread; serialises turns."""

    def __init__(self, headless: bool = False, url: str = CHAT_URL,
                 profile: str | None = None) -> None:
        self._url = url
        self._headless = headless
        self._profile = profile or str(PROFILE_DIR)
        self._commands: queue.Queue = queue.Queue()
        self._events: queue.Queue = queue.Queue()
        self._turn_lock = threading.Lock()
        self._ready = threading.Event()
        self._error: BaseException | None = None
        self._socket_url: str | None = None
        self._current_tone: str = DEFAULT_TONE
        self._cancel_requested = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    # --- frame handling (runs on the browser thread) ----------------------

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
            if isinstance(parsed, dict):
                self._handle_record(parsed)

    def _handle_record(self, rec: dict) -> None:
        msg_type = rec.get("type")

        if msg_type == 1:
            for arg in rec.get("arguments") or []:
                if isinstance(arg, dict):
                    self._harvest(arg.get("messages"))
        elif msg_type == 2:
            item = rec.get("item")
            if isinstance(item, dict):
                self._harvest(item.get("messages"))
                result = item.get("result") or {}
                if result.get("value") not in (None, "Success"):
                    self._events.put(
                        ("error", f"{result.get('value')}: {result.get('message')}")
                    )
            self._events.put(("done", None))
        elif msg_type == 3:
            self._events.put(("done", None))

    def _harvest(self, messages: object) -> None:
        if not isinstance(messages, list):
            return
        for msg in messages:
            if not isinstance(msg, dict) or msg.get("author") != "bot":
                continue
            text = msg.get("text")
            if not isinstance(text, str) or not text:
                continue
            kind = msg.get("messageType")
            if kind in PROGRESS_TYPES:
                self._events.put(("progress", text))
            elif kind in (None, "Chat"):
                self._events.put(("text", (msg.get("messageId") or "answer", text)))

    # --- browser thread --------------------------------------------------

    def _attach(self, page) -> None:
        def on_websocket(ws) -> None:
            if is_chathub(ws.url):
                self._socket_url = redact_url(ws.url)
                print(f"[driver] chathub attached: {self._socket_url[:90]}", flush=True)
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

    def _wait_composer(self, page, attempts: int = 120):
        for _ in range(attempts):
            box = self._find_composer(page)
            if box is not None:
                return box
            page.wait_for_timeout(500)
        return None

    def _select_tone(self, page, tone: str) -> bool:
        """Set the picker. Returns True if the wanted entry was clicked."""
        wanted = TONES.get(tone, {}).get("label")
        if not wanted:
            return False

        trigger = None
        for selector in PICKER_SELECTORS:
            candidate = page.locator(selector).first
            try:
                if candidate.count() and candidate.is_visible():
                    trigger = candidate
                    break
            except Exception:
                continue
        if trigger is None:
            return False

        trigger.click(timeout=5000)
        page.wait_for_timeout(2500)   # the menu takes well over a second

        def items():
            found = []
            for role in ("menuitemradio", "menuitem", "option"):
                try:
                    for item in page.get_by_role(role).all():
                        try:
                            if item.is_visible():
                                flat = " ".join((item.inner_text() or "").split())
                                found.append((item, role, flat))
                        except Exception:
                            continue
                except Exception:
                    continue
            return found

        def click_match(collection) -> bool:
            for item, _role, text in collection:
                if wanted.lower() in text.lower():
                    try:
                        item.click(timeout=5000)
                        page.wait_for_timeout(900)
                        return True
                    except Exception:
                        continue
            return False

        current = items()
        if click_match(current):
            return True

        # Named models sit behind a provider submenu that opens on HOVER.
        # Clicking the parent collapses it and loses the nested entries.
        for item, role, text in current:
            if role == "menuitem" and ("gpt" in text.lower() or "openai" in text.lower()):
                try:
                    item.hover()
                    page.wait_for_timeout(2200)
                except Exception:
                    continue
                if click_match(items()):
                    return True

        try:
            page.keyboard.press("Escape")
        except Exception:
            pass
        return False

    def _run(self) -> None:
        try:
            with sync_playwright() as pw:
                context = pw.chromium.launch_persistent_context(
                    user_data_dir=self._profile,
                    headless=self._headless,
                    viewport={"width": 1500, "height": 950},
                    args=["--disable-blink-features=AutomationControlled"],
                )
                page = context.pages[0] if context.pages else context.new_page()
                self._attach(page)
                context.on("page", self._attach)
                page.goto(self._url, wait_until="domcontentloaded")

                if self._wait_composer(page) is None:
                    raise RuntimeError(
                        "No composer found. Sign in once with "
                        "`python capture.py --label signin` so the profile holds a session."
                    )
                page.wait_for_timeout(2000)
                self._ready.set()

                while True:
                    # Playwright's sync API dispatches event callbacks only while
                    # this thread is inside a Playwright call. Blocking on
                    # queue.get() here silently starves every "framereceived"
                    # handler, so the reply frames never arrive. Poll the queue
                    # and spend the idle time inside wait_for_timeout, which
                    # pumps the event loop.
                    try:
                        command = self._commands.get_nowait()
                    except queue.Empty:
                        try:
                            page.wait_for_timeout(150)
                        except Exception:
                            break
                        continue
                    if command is None:
                        break
                    text, tone = command

                    # tone is per-conversation, so a change needs a fresh chat.
                    if tone != self._current_tone:
                        page.goto(self._url, wait_until="domcontentloaded")
                        if self._wait_composer(page) is None:
                            self._events.put(("error", "composer lost after reload"))
                            self._events.put(("done", None))
                            continue
                        page.wait_for_timeout(2500)
                        print(f"[driver] switching tone -> {tone}", flush=True)
                        if self._select_tone(page, tone):
                            self._current_tone = tone
                            print(f"[driver] tone now {tone}", flush=True)
                        else:
                            self._events.put(
                                ("progress", f"[could not select {tone}; using current]\n")
                            )
                            self._current_tone = DEFAULT_TONE

                    composer = self._find_composer(page)
                    if composer is None:
                        self._events.put(("error", "composer vanished"))
                        self._events.put(("done", None))
                        continue
                    try:
                        composer.click()
                        try:
                            composer.fill("")
                        except Exception:
                            page.keyboard.press("Control+A")
                            page.keyboard.press("Delete")
                        composer.type(text, delay=8)
                        page.keyboard.press("Enter")
                    except Exception as exc:
                        self._events.put(("error", f"send failed: {exc!r}"))
                        self._events.put(("done", None))

                context.close()
        except BaseException as exc:
            self._error = exc
            self._ready.set()
            self._events.put(("error", repr(exc)))
            self._events.put(("done", None))

    # --- public API ------------------------------------------------------

    def wait_ready(self, timeout: float = 300.0) -> None:
        if not self._ready.wait(timeout):
            raise TimeoutError("browser did not become ready")
        if self._error is not None:
            raise self._error

    @property
    def socket_url(self) -> str | None:
        return self._socket_url

    @property
    def current_tone(self) -> str:
        return self._current_tone

    def is_alive(self) -> bool:
        return self._thread.is_alive() and self._error is None

    def cancel(self) -> bool:
        self._cancel_requested = True
        return True

    def prompt(self, text: str, tone: str = DEFAULT_TONE,
               timeout: float = 240.0) -> Iterator[tuple[str, str]]:
        """Send one prompt; yield ("text"|"reasoning", delta) as it arrives.

        Copilot re-sends the whole message body as it grows rather than emitting
        pure deltas, so the longest prefix seen per message id is tracked and only
        the new tail is yielded.
        """
        self.wait_ready()
        with self._turn_lock:
            self._cancel_requested = False
            while not self._events.empty():
                try:
                    self._events.get_nowait()
                except queue.Empty:
                    break

            self._commands.put((text, tone))
            deadline = time.monotonic() + timeout
            emitted: dict[str, str] = {}
            progress_seen: set[str] = set()
            got_answer = False

            while True:
                if self._cancel_requested:
                    return
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("no completion frame before timeout")
                try:
                    kind, value = self._events.get(timeout=min(remaining, 1.0))
                except queue.Empty:
                    continue

                if kind == "text":
                    message_id, full = value
                    full = CITATION_RE.sub("", full)
                    previous = emitted.get(message_id, "")
                    if full.startswith(previous):
                        tail = full[len(previous):]
                    else:
                        tail = full
                    if tail:
                        emitted[message_id] = full
                        got_answer = True
                        yield ("text", tail)
                elif kind == "progress":
                    if value not in progress_seen:
                        progress_seen.add(value)
                        yield ("reasoning", value + "\n")
                elif kind == "error":
                    if not got_answer:
                        raise RuntimeError(f"driver error: {value}")
                elif kind == "done":
                    return

    def close(self) -> None:
        self._commands.put(None)
