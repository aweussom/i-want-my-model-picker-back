"""Extract the full `tone` enum from the Copilot web app's own JavaScript.

Observing traffic tells you which tones *you* used. The client bundle knows
every value Microsoft ships, including ones your licence never surfaces in the
picker. That is a better artifact: a complete list, sourced from the app itself.

Method: load the chat page, ask the page which scripts it loaded, then fetch each
one from inside the page (so the session and CORS context come along for free)
and regex for tone-shaped identifiers.

Requires exclusive access to .profile, so stop any running capture.py first.

    python find_tones.py
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

from playwright.sync_api import sync_playwright

CHAT_URL = "https://m365.cloud.microsoft/chat"
PROFILE_DIR = Path(__file__).parent / ".profile"
OUT_PATH = Path(__file__).parent / "captures" / "tones.json"

# Harvest script URLs, then scan each body in-page. Returns {url: [matches]}.
SCAN_JS = r"""
async () => {
  const patterns = [
    /\b(?:Gpt|GPT)_[0-9]+_[0-9]+(?:_[A-Za-z]+)*\b/g,
    /\b(?:Magic|Creative|Balanced|Precise)\b/g,
    /\b[A-Za-z]*(?:Reasoning|ThinkDeeper|QuickResponse)[A-Za-z]*\b/g,
    /\bClaude_[A-Za-z0-9_]+\b/g,
  ];
  const urls = performance.getEntriesByType('resource')
    .map(e => e.name)
    .filter(u => /\.js(\?|$)/i.test(u));
  const unique = Array.from(new Set(urls));
  const out = {};
  for (const u of unique) {
    try {
      const r = await fetch(u, {credentials: 'include'});
      if (!r.ok) continue;
      const text = await r.text();
      const hits = new Set();
      for (const re of patterns) {
        for (const m of text.matchAll(re)) hits.add(m[0]);
      }
      if (hits.size) out[u] = Array.from(hits);
    } catch (e) { /* cross-origin or gone; skip */ }
  }
  return {scanned: unique.length, out};
}
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seconds", type=int, default=45,
                    help="settle time for the app to finish loading its bundles")
    args = ap.parse_args()

    OUT_PATH.parent.mkdir(exist_ok=True)

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1400, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(CHAT_URL, wait_until="domcontentloaded")

        print(f"letting the app load for {args.seconds}s...")
        page.wait_for_timeout(args.seconds * 1000)

        print("scanning loaded scripts...")
        result = page.evaluate(SCAN_JS)
        per_file = result.get("out", {})
        print(f"scanned {result.get('scanned')} script(s), "
              f"{len(per_file)} contained matches\n")

        tally: Counter[str] = Counter()
        for matches in per_file.values():
            tally.update(matches)

        gpt_like = sorted(t for t in tally if re.match(r"(?i)gpt_\d", t))
        claude_like = sorted(t for t in tally if t.startswith("Claude_"))
        other = sorted(t for t in tally if t not in gpt_like and t not in claude_like)

        print("=== GPT tone values ===")
        for value in gpt_like:
            print(f"  {value}")
        if claude_like:
            print("\n=== Claude tone values ===")
            for value in claude_like:
                print(f"  {value}")
        print("\n=== other mode-ish identifiers ===")
        for value in other[:40]:
            print(f"  {value}  (x{tally[value]})")

        OUT_PATH.write_text(
            json.dumps(
                {"gpt": gpt_like, "claude": claude_like,
                 "other": {k: tally[k] for k in other}},
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"\nwrote {OUT_PATH}")
        context.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
