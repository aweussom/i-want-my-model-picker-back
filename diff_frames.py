"""Diff the client->server chat invocation between two captures.

The proof that this project exists to produce: take one capture with the model
picker on Auto and one with it on a named model, and show exactly which field
on the wire changes. If nothing changes, the selection is server-side state and
that is worth knowing too.

Usage:
    python diff_frames.py captures/auto.jsonl captures/gpt56think.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Fields that differ on every single request and carry no information about
# model selection. Diffing without this filter buries the signal in GUIDs.
NOISE_KEYS = {
    "traceId",
    "requestId",
    "sessionId",
    "conversationId",
    "clientCorrelationId",
    "chatsessionid",
    "X-ClientRequestId",
    "X-SessionId",
    "invocationId",
    "text",
    "timestamp",
}


def load_invocations(path: Path) -> list[dict[str, Any]]:
    """Return client->server frames that look like a chat turn being started."""
    found = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("kind") != "frame" or entry.get("direction") != "sent":
                continue
            payload = entry.get("json")
            if not isinstance(payload, dict):
                continue
            args = payload.get("arguments")
            if isinstance(args, list) and args and isinstance(args[0], dict):
                if "message" in args[0] or payload.get("target") == "chat":
                    found.append(payload)
    return found


def strip_noise(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {
            key: strip_noise(value)
            for key, value in obj.items()
            if key not in NOISE_KEYS
        }
    if isinstance(obj, list):
        return [strip_noise(item) for item in obj]
    return obj


def walk_diff(left: Any, right: Any, path: str = "") -> list[str]:
    """Structural diff, reported as one line per differing leaf."""
    out: list[str] = []
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(set(left) | set(right)):
            here = f"{path}.{key}" if path else key
            if key not in left:
                out.append(f"  + {here} = {json.dumps(right[key], ensure_ascii=False)}")
            elif key not in right:
                out.append(f"  - {here} = {json.dumps(left[key], ensure_ascii=False)}")
            else:
                out.extend(walk_diff(left[key], right[key], here))
        return out
    if isinstance(left, list) and isinstance(right, list):
        # Positional lists (like SignalR's single-element `arguments`) recurse
        # element-wise so the diff names the leaf that actually changed. Only
        # fall back to set semantics when the shapes genuinely differ, which is
        # the case for flag lists such as optionsSets.
        if len(left) == len(right) and any(
            isinstance(x, (dict, list)) for x in left + right
        ):
            for index, (lhs, rhs) in enumerate(zip(left, right)):
                out.extend(walk_diff(lhs, rhs, f"{path}[{index}]"))
            return out
        if sorted(map(json.dumps, left)) != sorted(map(json.dumps, right)):
            only_left = [x for x in left if x not in right]
            only_right = [x for x in right if x not in left]
            if only_left:
                out.append(f"  - {path} lost {json.dumps(only_left, ensure_ascii=False)}")
            if only_right:
                out.append(f"  + {path} gained {json.dumps(only_right, ensure_ascii=False)}")
        return out
    if left != right:
        out.append(
            f"  ~ {path}: {json.dumps(left, ensure_ascii=False)}"
            f" -> {json.dumps(right, ensure_ascii=False)}"
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("left", type=Path)
    parser.add_argument("right", type=Path)
    parser.add_argument(
        "--index",
        type=int,
        default=0,
        help="which chat invocation to compare when a capture has several",
    )
    parser.add_argument(
        "--dump",
        action="store_true",
        help="also print both full payloads",
    )
    args = parser.parse_args()

    left_all = load_invocations(args.left)
    right_all = load_invocations(args.right)

    for name, found in ((args.left, left_all), (args.right, right_all)):
        print(f"{name}: {len(found)} chat invocation(s)")
    if not left_all or not right_all:
        print("\nNeed at least one chat invocation in each capture.", file=sys.stderr)
        print("Did you actually send a message in the browser?", file=sys.stderr)
        return 1

    left = strip_noise(left_all[min(args.index, len(left_all) - 1)])
    right = strip_noise(right_all[min(args.index, len(right_all) - 1)])

    if args.dump:
        print(f"\n--- {args.left} ---")
        print(json.dumps(left, indent=2, ensure_ascii=False))
        print(f"\n--- {args.right} ---")
        print(json.dumps(right, indent=2, ensure_ascii=False))

    diff = walk_diff(left, right)
    print(f"\n=== wire diff ({args.left.stem} -> {args.right.stem}) ===")
    if not diff:
        print("  (identical after noise filtering)")
        print("\n  Model selection is NOT carried in the chat invocation.")
        print("  Look for a separate settings call, or a connect-time parameter.")
    else:
        print("\n".join(diff))
    return 0


if __name__ == "__main__":
    sys.exit(main())
