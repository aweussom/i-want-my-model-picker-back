"""OpenAI-compatible endpoint in front of the resident Copilot browser.

    python serve.py --port 8790

Then point anything that speaks OpenAI at it:

    curl http://127.0.0.1:8790/v1/chat/completions -H "Content-Type: application/json" \
      -d '{"model":"m365-copilot","stream":true,"messages":[{"role":"user","content":"hi"}]}'

One browser means one conversation at a time; CopilotDriver serialises turns
behind a lock, so concurrent callers queue rather than interleave.
"""

from __future__ import annotations

import argparse
import json
import time
import uuid

from flask import Flask, Response, jsonify, request

from driver import CopilotDriver

app = Flask(__name__)
_driver: CopilotDriver | None = None
MODEL_LABEL = "m365-copilot"


def _sse(delta: str, model: str, done: bool = False) -> str:
    """Encode one OpenAI streaming chunk.

    Lifted from agentry (https://github.com/aweussom/agentry, agentry.py:125),
    trimmed to the text-only case.
    """
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {} if done else {"content": delta},
                "finish_reason": "stop" if done else None,
            }
        ],
    }
    out = f"data: {json.dumps(chunk)}\n\n"
    if done:
        out += "data: [DONE]\n\n"
    return out


def _last_user_message(body: dict) -> str:
    """Flatten the newest user turn. No history is replayed: the browser holds
    the conversation, so sending prior turns would duplicate them."""
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


@app.route("/health")
def health() -> Response:
    ready = _driver is not None and _driver._ready.is_set()
    return jsonify(
        {
            "status": "ready" if ready else "loading",
            "socket": _driver.socket_url if _driver else None,
        }
    )


@app.route("/v1/models")
def models() -> Response:
    return jsonify(
        {
            "object": "list",
            "data": [{"id": MODEL_LABEL, "object": "model", "owned_by": "microsoft"}],
        }
    )


@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    body = request.get_json(force=True) or {}
    prompt = _last_user_message(body)
    if not prompt:
        return jsonify({"error": {"message": "no user message"}}), 400

    assert _driver is not None
    stream = bool(body.get("stream"))

    if stream:
        def generate():
            try:
                for delta in _driver.prompt(prompt):
                    yield _sse(delta, MODEL_LABEL)
            except Exception as exc:
                yield _sse(f"\n[error: {exc}]", MODEL_LABEL)
            yield _sse("", MODEL_LABEL, done=True)

        return Response(generate(), mimetype="text/event-stream")

    try:
        text = "".join(_driver.prompt(prompt))
    except Exception as exc:
        return jsonify({"error": {"message": str(exc)}}), 502

    return jsonify(
        {
            "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": MODEL_LABEL,
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
        help="hide the browser (only works once the profile has a live session)",
    )
    args = parser.parse_args()

    print("starting browser...")
    _driver = CopilotDriver(headless=args.headless)
    _driver.wait_ready()
    print(f"composer ready; socket: {_driver.socket_url}")
    print(f"listening on http://{args.host}:{args.port}/v1/chat/completions")

    # threaded=False: every turn serialises on the driver lock anyway, and a
    # single request thread keeps the failure modes boring.
    app.run(host=args.host, port=args.port, threaded=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
