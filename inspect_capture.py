"""Summarise a capture: where the prompt went, what came back, what carries model choice.

    python inspect_capture.py captures/think.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

# Words that would plausibly name a model or reasoning mode on the wire.
MODEL_HINT = re.compile(
    r"gpt|model|think|deep|reason|effort|mode|optionsSet|variant|sliceId|flux|mai|claude",
    re.IGNORECASE,
)


def load(path: Path) -> list[dict[str, Any]]:
    out = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def find_model_keys(obj: Any, path: str = "", hits: list[tuple[str, Any]] | None = None):
    """Report every leaf whose key or value smells like a model selector."""
    if hits is None:
        hits = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            here = f"{path}.{key}" if path else key
            if MODEL_HINT.search(str(key)):
                summary = value
                if isinstance(value, (dict, list)):
                    summary = json.dumps(value, ensure_ascii=False)[:300]
                hits.append((here, summary))
            find_model_keys(value, here, hits)
    elif isinstance(obj, list):
        for index, item in enumerate(obj):
            if isinstance(item, str) and MODEL_HINT.search(item):
                hits.append((f"{path}[{index}]", item))
            else:
                find_model_keys(item, f"{path}[{index}]", hits)
    elif isinstance(obj, str) and MODEL_HINT.search(obj) and len(obj) < 200:
        hits.append((path, obj))
    return hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", type=Path)
    ap.add_argument("--full", action="store_true", help="dump the prompt request bodies")
    args = ap.parse_args()

    records = load(args.path)
    print(f"{len(records)} records in {args.path}\n")

    # 1. Which endpoints received a POST with prompt-shaped content?
    prompts = []
    for rec in records:
        if rec.get("kind") not in ("tap", "http-request"):
            continue
        body = rec.get("body") or rec.get("body_raw")
        if body is None:
            continue
        blob = json.dumps(body, ensure_ascii=False) if not isinstance(body, str) else body
        if '"text"' in blob or '"prompt"' in blob or '"content"' in blob:
            prompts.append((rec, blob))

    print("=== requests carrying prompt-shaped bodies ===")
    for rec, blob in prompts:
        url = str(rec.get("url", "")).split("?")[0]
        action = ""
        if isinstance(rec.get("body"), dict):
            action = rec["body"].get("action") or ""
        print(f"  [{rec.get('phase') or rec.get('method')}] {url}"
              f"{'  action=' + action if action else ''}  ({len(blob)} bytes)")

    # 2. Streamed responses, grouped by endpoint.
    print("\n=== streamed responses ===")
    streams: dict[str, list[str]] = {}
    for rec in records:
        if rec.get("phase") in ("stream-chunk", "xhr-chunk", "sse"):
            url = str(rec.get("url", "")).split("?")[0]
            chunk = rec.get("chunk") or rec.get("data") or rec.get("data_raw") or ""
            if not isinstance(chunk, str):
                chunk = json.dumps(chunk, ensure_ascii=False)
            streams.setdefault(url, []).append(chunk)
    for url, chunks in streams.items():
        total = sum(len(c) for c in chunks)
        print(f"  {url}  -> {len(chunks)} chunks, {total} bytes")
        print(f"      first: {chunks[0][:180]!r}")

    # 3. Anything that looks like a model selector, anywhere.
    print("\n=== model-selector candidates ===")
    seen: set[str] = set()
    for rec in records:
        scope = {k: v for k, v in rec.items() if k in ("body", "body_raw", "chunk", "data", "json", "url")}
        for keypath, value in find_model_keys(scope):
            line = f"{keypath} = {value}"
            if line in seen:
                continue
            seen.add(line)
            print(f"  {line[:260]}")

    if args.full:
        print("\n=== full prompt bodies ===")
        for rec, blob in prompts:
            print(f"\n--- {str(rec.get('url','')).split('?')[0]} ---")
            try:
                print(json.dumps(json.loads(blob), indent=2, ensure_ascii=False)[:6000])
            except json.JSONDecodeError:
                print(blob[:6000])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
