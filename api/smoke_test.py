"""Smoke test for the running API. Standard library only, no Playwright.

Talks HTTP to `npm run serve` the way any OpenAI client would, and checks the
one thing this project exists for: the model you ask for is the tone that went
out on the wire. The driver reports that tone back through /health, read off
the userscript after each send, so this test does not have to trust the reply.

    cd api
    npm run serve                    # in another terminal; profile signed in
    python smoke_test.py             # or: python smoke_test.py --base http://127.0.0.1:8791

It sends TWO real prompts into the browser's current Copilot conversation (a
new one if the server was just started), prefixed
"mpo-smoke" so you can find and delete them (src/cleanup-tests.js).
Exit 0 means every check passed; anything else says which check and why.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import urllib.error
import urllib.request

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(filename)s:%(lineno)d %(funcName)s — %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)

PROMPT_TIMEOUT_S = 300  # a reasoning turn can take a while; the driver's own limit is 300s


def get_json(base: str, path: str) -> dict:
    with urllib.request.urlopen(base + path, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post(base: str, path: str, body: bytes) -> urllib.request.Request:
    return urllib.request.Request(
        base + path,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )


def fail(message: str) -> None:
    log.error("FAIL: %s", message)
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:8791", help="API base URL")
    parser.add_argument("--wait", type=int, default=120, help="seconds to wait for /health to say ready")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    # --- 1. server is up and the driver is ready --------------------------------
    log.info("waiting up to %ss for %s/health to report ready, because nothing else works before it", args.wait, base)
    deadline = time.time() + args.wait
    health = None
    while time.time() < deadline:
        try:
            health = get_json(base, "/health")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as err:
            log.info("not answering yet (%s); is `npm run serve` running?", err)
            time.sleep(3)
            continue
        if health.get("status") == "ready":
            break
        log.info("status=%s, waiting", health.get("status"))
        time.sleep(3)
    if not health or health.get("status") != "ready":
        fail(f"/health never said ready within {args.wait}s; last answer: {health}")
    log.info("ready: version=%s browser=%s headless=%s", health.get("version"), health.get("browser"), health.get("headless"))

    # --- 2. the model list carries the tones we are about to ask for ------------
    log.info("checking /v1/models lists Gpt_5_6_Reasoning and Gpt_5_6_Chat")
    models = get_json(base, "/v1/models")
    model_ids = [m.get("id") for m in models.get("data", [])]
    for wanted in ("Gpt_5_6_Reasoning", "Gpt_5_6_Chat"):
        if wanted not in model_ids:
            fail(f"/v1/models does not list {wanted}; got {model_ids}")
    log.info("models: %s", model_ids)

    # --- 3. a broken request fails fast, without touching Copilot --------------
    log.info("sending invalid JSON, expecting HTTP 400 and no Copilot traffic")
    try:
        urllib.request.urlopen(post(base, "/v1/chat/completions", b"{not json"), timeout=10)
        fail("invalid JSON was accepted; expected HTTP 400")
    except urllib.error.HTTPError as err:
        if err.code != 400:
            fail(f"invalid JSON gave HTTP {err.code}; expected 400")
    log.info("invalid JSON refused with 400")

    # --- 4. non-streaming, no model: the default must go out on the wire --------
    body = {
        "stream": False,
        "messages": [{"role": "user", "content": "mpo-smoke 1: reply with the single word OK"}],
    }
    log.info("non-streaming prompt with no model, expecting the default tone on the wire (can take a minute)")
    started = time.time()
    try:
        with urllib.request.urlopen(post(base, "/v1/chat/completions", json.dumps(body).encode()), timeout=PROMPT_TIMEOUT_S) as resp:
            reply = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        fail(f"prompt 1 failed with HTTP {err.code}: {err.read().decode('utf-8', 'replace')}")
    content = reply["choices"][0]["message"]["content"]
    log.info("prompt 1 answered in %.1fs: %r", time.time() - started, content[:80])
    if not content.strip():
        fail("prompt 1 came back empty")

    health = get_json(base, "/health")
    default_tone = health.get("defaultTone")
    if health.get("tone") != default_tone:
        fail(f"wire tone after prompt 1 was {health.get('tone')}, expected the default {default_tone}")
    first_conversation = health.get("conversationId")
    log.info("wire tone %s matches the default; conversation %s", health.get("tone"), first_conversation)

    # --- 5. streaming, explicit model: tone switches, conversation stays --------
    body = {
        "model": "Gpt_5_6_Chat",
        "stream": True,
        "messages": [{"role": "user", "content": "mpo-smoke 2: what single word did you just reply with?"}],
    }
    log.info("streaming prompt as Gpt_5_6_Chat in the same conversation, expecting the tone to switch and the thread to stay")
    started = time.time()
    text_parts = []
    saw_done = False
    with urllib.request.urlopen(post(base, "/v1/chat/completions", json.dumps(body).encode()), timeout=PROMPT_TIMEOUT_S) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                saw_done = True
                break
            chunk = json.loads(payload)
            delta = chunk["choices"][0].get("delta", {})
            if delta.get("content"):
                text_parts.append(delta["content"])
    text = "".join(text_parts)
    log.info("prompt 2 streamed in %.1fs: %r", time.time() - started, text[:80])

    # The server reports driver errors inside the stream, with HTTP 200.
    if "[error:" in text:
        fail(f"prompt 2 streamed an error: {text}")
    if not saw_done:
        fail("prompt 2 stream ended without [DONE]")
    if not text.strip():
        fail("prompt 2 streamed no content")

    health = get_json(base, "/health")
    if health.get("tone") != "Gpt_5_6_Chat":
        fail(f"wire tone after prompt 2 was {health.get('tone')}, expected Gpt_5_6_Chat")
    if health.get("conversationId") != first_conversation:
        fail(f"conversation changed from {first_conversation} to {health.get('conversationId')}; a model switch should keep it")
    log.info("wire tone Gpt_5_6_Chat, same conversation %s", first_conversation)

    log.info("PASS: all checks. Delete the two 'mpo-smoke' messages from Copilot when convenient.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
