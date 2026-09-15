"""Dump the chat page's input candidates so selectors can be based on fact.

Guessing composer selectors wasted a run, so this asks the page what it has.

    python probe_dom.py
"""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

from capture import PROFILE_DIR

CHAT_URL = "https://m365.cloud.microsoft/chat"
OUT = Path(__file__).parent / "captures" / "dom-probe.json"

DUMP = r"""
() => {
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    role: el.getAttribute('role'),
    type: el.getAttribute('type'),
    placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    ariaPlaceholder: el.getAttribute('aria-placeholder'),
    testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id'),
    contentEditable: el.getAttribute('contenteditable'),
    cls: (el.className && typeof el.className === 'string')
          ? el.className.slice(0, 120) : null,
    visible: !!(el.offsetParent || el.getClientRects().length),
    rect: (() => { const r = el.getBoundingClientRect();
                   return {w: Math.round(r.width), h: Math.round(r.height),
                           x: Math.round(r.x), y: Math.round(r.y)}; })(),
  });

  const inputs = Array.from(document.querySelectorAll(
    'textarea, input, [contenteditable], [role="textbox"], [role="combobox"]'
  )).map(describe);

  // Buttons are how the model picker is reached.
  const buttons = Array.from(document.querySelectorAll(
    'button, [role="button"], [role="menuitem"], [role="menuitemradio"]'
  )).map((el) => ({
    ...describe(el),
    text: (el.innerText || el.textContent || '').trim().slice(0, 60),
  })).filter((b) => b.visible && b.text);

  return {
    url: location.href,
    title: document.title,
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
      src: (f.getAttribute('src') || '').slice(0, 160),
      name: f.getAttribute('name'),
      visible: !!(f.offsetParent || f.getClientRects().length),
    })),
    inputs,
    buttons,
  };
}
"""


def main() -> int:
    OUT.parent.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1500, "height": 950},
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(CHAT_URL, wait_until="domcontentloaded")
        print("settling for 30s...")
        page.wait_for_timeout(30000)

        # The composer may live in an iframe; report every frame separately.
        report = {"frames": []}
        for frame in page.frames:
            try:
                data = frame.evaluate(DUMP)
            except Exception as exc:
                report["frames"].append({"frame_url": frame.url, "error": str(exc)})
                continue
            data["frame_url"] = frame.url
            report["frames"].append(data)

        OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

        for frame in report["frames"]:
            if frame.get("error"):
                print(f"\n[frame {frame['frame_url'][:70]}] error: {frame['error']}")
                continue
            print(f"\n=== frame {frame['frame_url'][:90]} ===")
            print(f"  iframes: {len(frame.get('iframes', []))}")
            print("  --- input candidates ---")
            for item in frame.get("inputs", []):
                if not item["visible"] or item["rect"]["w"] < 40:
                    continue
                print(f"    {item['tag']:9} role={item['role']} ce={item['contentEditable']} "
                      f"ph={item['placeholder']!r} aria={item['ariaLabel']!r} "
                      f"testid={item['testid']!r} {item['rect']['w']}x{item['rect']['h']}")
            print("  --- buttons with text (first 30) ---")
            for item in frame.get("buttons", [])[:30]:
                print(f"    [{item['text'][:40]:42}] role={item['role']} aria={item['ariaLabel']!r}")

        print(f"\nfull report -> {OUT}")
        page.screenshot(path=str(OUT.with_suffix(".png")))
        context.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
