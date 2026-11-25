'use strict';
/**
 * How much text does the Copilot composer accept?
 *
 *     node src/probe-limits.js [size ...]
 *
 * Nothing is sent. For each size the composer is cleared, filled with
 * insertText (one input event, so 130k characters do not take 17 minutes to
 * type), and then read back: characters kept, whether newlines survived,
 * whether the end marker is there, whether Send is enabled, and any visible
 * text that looks like a counter or a length warning. The composer is cleared
 * again before the browser closes, so no draft is left behind.
 *
 * Why: a coding agent (aider) behind the OpenAI-compatible API needs its system
 * prompt, history and files in one prompt. Microsoft's features page says
 * 18,000 characters; community posts say 4k to 128k depending on tab and
 * rollout. This measures the tenant instead of guessing.
 */

const { CopilotDriver } = require('./driver.js');

const DEFAULT_SIZES = [4000, 8000, 16000, 18000, 20000, 50000, 130000];

function makeText(size) {
  // Code-like lines with newlines, ending in a marker that says whether the tail
  // survived. Lines are numbered so a truncation point can be read off directly.
  const marker = `\nEND-MARKER-${size}`;
  const lines = [];
  let total = 0;
  let n = 0;
  while (total < size - marker.length) {
    const line = `line ${String(n).padStart(6, '0')}: def f_${n}(x): return x * ${n}  # padding`;
    lines.push(line);
    total += line.length + 1;
    n += 1;
  }
  let text = lines.join('\n');
  text = text.slice(0, size - marker.length) + marker;
  return text;
}

async function readState(page) {
  return page.evaluate(() => {
    const composer = document.querySelector('[role="textbox"]');
    const composerText = composer ? composer.innerText : null;
    const buttons = [...document.querySelectorAll('button')]
      .filter((b) => /send|sende/i.test(b.getAttribute('aria-label') || '') ||
                     /send|sende/i.test(b.getAttribute('title') || ''))
      .map((b) => ({
        label: b.getAttribute('aria-label') || b.getAttribute('title'),
        disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
      }));
    // Anything on screen that reads like "12345/18000" or mentions a limit.
    const hints = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || '').trim();
      if (!t || t.length > 200) continue;
      if (/\d[\d\s.,]*\/\s*\d[\d\s.,]*/.test(t) ||
          /grense|limit|for lang|too long|tegn|characters/i.test(t)) {
        hints.push(t);
      }
    }
    return {
      found: !!composer,
      length: composerText === null ? null : composerText.length,
      newlines: composerText === null ? null : (composerText.match(/\n/g) || []).length,
      tail: composerText === null ? null : composerText.slice(-40),
      buttons,
      hints: [...new Set(hints)].slice(0, 10),
    };
  });
}

async function clearComposer(page, composer) {
  await composer.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
}

(async () => {
  const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const plan = sizes.length ? sizes : DEFAULT_SIZES;
  console.log(`[probe-limits] starting the driver; will fill the composer at ${plan.join(', ')} characters, never pressing Enter`);

  const driver = await new CopilotDriver({}).start();
  const page = driver.page;
  let failed = false;
  try {
    for (const size of plan) {
      const composer = await driver._findComposer();
      if (!composer) throw new Error('no composer on the page; signed out or a challenge box is showing');

      console.log(`[probe-limits] ${size}: clearing the composer, then inserting ${size} characters`);
      await clearComposer(page, composer);
      const text = makeText(size);
      const sentNewlines = (text.match(/\n/g) || []).length;
      const t0 = Date.now();
      await page.keyboard.insertText(text);
      await page.waitForTimeout(1500); // let any counter or warning render
      const state = await readState(page);
      const ms = Date.now() - t0;

      const kept = state.length === null ? 'no composer text' : `${state.length} chars kept`;
      const tailOk = state.tail && state.tail.includes(`END-MARKER-${size}`);
      console.log(`[probe-limits] ${size}: ${kept}, newlines ${state.newlines}/${sentNewlines}, ` +
        `end marker ${tailOk ? 'present' : 'MISSING'}, ${ms} ms`);
      console.log(`[probe-limits] ${size}: send buttons ${JSON.stringify(state.buttons)}`);
      if (state.hints.length) console.log(`[probe-limits] ${size}: on-screen hints ${JSON.stringify(state.hints)}`);
      if (!tailOk) console.log(`[probe-limits] ${size}: tail as kept: ${JSON.stringify(state.tail)}`);
    }
  } catch (err) {
    failed = true;
    console.error(`[probe-limits] FAILED: ${err.message}`);
  } finally {
    console.log('[probe-limits] clearing the composer so no draft is left, then closing');
    const composer = await driver._findComposer();
    if (composer) await clearComposer(page, composer);
    await driver.close();
  }
  process.exit(failed ? 1 : 0);
})();
