"""OpenAI-compatible endpoint (and a chat UI) in front of a resident Copilot browser.

    python serve.py --port 8790

Then open http://127.0.0.1:8790/ for the chat interface, or point anything that
speaks OpenAI at the same port:

    curl http://127.0.0.1:8790/v1/chat/completions -H "Content-Type: application/json" \
      -d '{"model":"Gpt_5_6_Reasoning","stream":true,
           "messages":[{"role":"user","content":"hi"}]}'

The joke, such as it is: the `model` parameter works. Microsoft's official Copilot
Chat API has no such parameter, and this one maps straight onto the `tone` field
the web client already sends. `GET /v1/models` lists the five values.

One browser means one conversation at a time; CopilotDriver serialises turns
behind a lock, so concurrent callers queue rather than interleave. Because `tone`
is per-conversation, changing `model` between requests starts a new Copilot
conversation and the prior context is gone.
"""

from __future__ import annotations

import argparse
import json
import time
import uuid

from flask import Flask, Response, jsonify, render_template, request

from driver import DEFAULT_TONE, TONES, CopilotDriver

app = Flask(__name__)
_driver: CopilotDriver | None = None


def _sse(delta: str, model: str, done: bool = False, reasoning: bool = False) -> str:
    """Encode one OpenAI streaming chunk.

    Lifted from agentry (https://github.com/aweussom/agentry, agentry.py:125).
    Reasoning deltas ride in "reasoning_content", the de-facto extension DeepSeek
    popularised; standard OpenAI clients ignore the unknown key, and the bundled
    UI folds them into its think-block.
    """
    if done:
        payload: dict = {}
    elif reasoning:
        payload = {"reasoning_content": delta}
    else:
        payload = {"content": delta}
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": payload,
                "finish_reason": "stop" if done else None,
            }
        ],
    }
    out = f"data: {json.dumps(chunk)}\n\n"
    if done:
        out += "data: [DONE]\n\n"
    return out


def _resolve_tone(requested: str | None) -> str:
    """Map an OpenAI `model` value onto a tone, tolerantly."""
    if not requested:
        return DEFAULT_TONE
    if requested in TONES:
        return requested
    # Accept the menu label too ("GPT 5.6 Think deeper"), and ignore any
    # "@suffix" the UI appends for display purposes.
    bare = requested.split("@")[0].strip().lower()
    for tone, meta in TONES.items():
        if bare == tone.lower() or bare == meta["label"].lower():
            return tone
    return DEFAULT_TONE


def _extract_images(body: dict) -> tuple[list[str], int]:
    """Pull base64 data: URIs off the newest user turn.

    Returns (data_uris, skipped_remote). Remote http(s) image URLs are skipped
    rather than fetched, so the proxy makes no outbound requests on a caller's
    behalf -- the same rule agentry applies.
    """
    for message in reversed(body.get("messages") or []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            return [], 0
        uris: list[str] = []
        skipped = 0
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "image_url":
                continue
            url = (part.get("image_url") or {}).get("url") or ""
            if url.startswith("data:"):
                uris.append(url)
            elif url:
                skipped += 1
        return uris, skipped
    return [], 0


def _last_user_message(body: dict) -> str:
    """Flatten the newest user turn.

    History is deliberately not replayed: the browser holds the conversation, so
    sending prior turns would duplicate them.
    """
    for message in reversed(body.get("messages") or []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = [
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            ]
            return "\n".join(p for p in parts if p)
    return ""


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health() -> Response:
    ready = _driver is not None and _driver._ready.is_set() and _driver.is_alive()
    # Report only whether the Chathub is attached. The full URL embeds the user
    # object id, the tenant id and a wall of feature flags -- fine in a capture
    # you control, needless exposure in a status endpoint somebody may screenshot.
    socket = _driver.socket_url if _driver else None
    return jsonify(
        {
            "status": "ready" if ready else "loading",
            "tone": _driver.current_tone if _driver else None,
            "chathub": bool(socket),
        }
    )


@app.route("/v1/models")
def models() -> Response:
    return jsonify(
        {
            "object": "list",
            # Default first: the UI populates its dropdown in this order and
            # the browser selects option zero, so ordering *is* the default.
            "data": [
                {
                    "id": tone,
                    "object": "model",
                    "owned_by": TONES[tone]["owned_by"],
                    "description": TONES[tone]["title"],
                }
                for tone in sorted(TONES, key=lambda t: t != DEFAULT_TONE)
            ],
        }
    )


@app.route("/v1/cancel", methods=["POST"])
def cancel() -> Response:
    if _driver and _driver.cancel():
        return jsonify({"cancelled": True})
    return jsonify({"cancelled": False})


@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    body = request.get_json(force=True) or {}
    prompt = _last_user_message(body)
    if not prompt:
        return jsonify({"error": {"message": "no user message"}}), 400

    assert _driver is not None
    tone = _resolve_tone(body.get("model"))
    stream = bool(body.get("stream"))

    images, skipped_remote = _extract_images(body)
    dropped = (
        f"[note: skipped {skipped_remote} remote image URL(s); "
        f"attach as a base64 data: URI instead]\n"
        if skipped_remote
        else ""
    )

    if stream:
        def generate():
            if dropped:
                yield _sse(dropped, tone, reasoning=True)
            try:
                for kind, delta in _driver.prompt(prompt, tone=tone, images=images):
                    yield _sse(delta, tone, reasoning=(kind == "reasoning"))
            except Exception as exc:
                yield _sse(f"\n[error: {exc}]", tone)
            yield _sse("", tone, done=True)

        response = Response(generate(), mimetype="text/event-stream")
        response.headers["X-Device"] = tone
        response.headers["Cache-Control"] = "no-cache"
        return response

    try:
        text = "".join(
            delta
            for kind, delta in _driver.prompt(prompt, tone=tone, images=images)
            if kind == "text"
        )
    except Exception as exc:
        return jsonify({"error": {"message": str(exc)}}), 502

    return jsonify(
        {
            "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": tone,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
        }
    )


def main() -> int:
    global _driver
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--headless",
        action="store_true",
        help="hide the browser; only works once the profile holds a live session",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help="browser profile dir. Keep work and personal accounts in separate "
        "profiles, e.g. --profile .profile-personal",
    )
    args = parser.parse_args()

    print("starting browser...")
    _driver = CopilotDriver(headless=args.headless, profile=args.profile)
    _driver.wait_ready()
    print(f"composer ready; tone={_driver.current_tone}")
    print(f"chat UI      http://{args.host}:{args.port}/")
    print(f"OpenAI API   http://{args.host}:{args.port}/v1/chat/completions")

    # threaded=False: every turn serialises on the driver lock anyway, and a
    # single request thread keeps the failure modes boring.
    app.run(host=args.host, port=args.port, threaded=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
