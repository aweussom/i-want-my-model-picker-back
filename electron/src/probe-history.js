'use strict';
/**
 * Find where a conversation's message history comes from.
 *
 *     node src/probe-history.js
 *
 * Two narrower versions of this probe found nothing. Watching action-dispatch
 * POSTs found nothing; watching every JSON response body and every WebSocket
 * frame found only the conversation *title* (which contains the prompt, so it
 * matched a naive needle search and was a red herring).
 *
 * The blind spot is the same one that hid the image upload: **streamed response
 * bodies**. Playwright's response.text() gives nothing useful for a fetch whose
 * body is consumed as a stream, so this reuses ../../tap.js -- the in-page fetch
 * wrapper written for exactly this -- reassembles the streamed chunks per URL,
 * and scores the result.
 *
 * Writes matches to captures/history-probe.json, which contains your own prompts
 * and replies. captures/ is gitignored.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { CopilotDriver } = require('./driver.js');

const REPO = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'captures');
const OUT = path.join(OUT_DIR, 'history-probe.json');
const PROFILE = process.env.COPILOT_PROFILE || path.join(__dirname, '..', '.profile');

function scoreForMessages(obj) {
  const authors = new Set();
  const paths = new Set();
  let texts = 0;
  const walk = (node, trail, depth) => {
    if (depth > 14 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v) => walk(v, `${trail}[]`, depth + 1));
      return;
    }
    if (typeof node.author === 'string' && typeof node.text === 'string') {
      authors.add(node.author);
      texts += 1;
      paths.add(trail || '(root)');
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${trail}.${k}`, depth + 1);
  };
  walk(obj, '', 0);
  return { texts, authors: [...authors], paths: [...paths].slice(0, 3) };
}

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Pick a target first, using an ordinary driver, then throw it away: the tap
  // has to be installed before the page that loads the conversation exists.
  const scout = await new CopilotDriver({}).start();
  const list = await scout.listConversations({ limit: 10 });
  await scout.close();
  if (!list.length) { console.log('No conversations. Send a message first.'); return; }
  const target = list[0];
  const needle = (/codeword (\w+)/i.exec(target.name || '') || [])[1] || null;
  console.log(`target : ${JSON.stringify((target.name || '').slice(0, 52))}`);
  console.log(`needle : ${needle || '(none)'}\n`);

  const streams = new Map();     // url -> reassembled body
  const requests = [];

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1500, height: 950 }, chromiumSandbox: true,
    channel: 'chrome',
  });
  await context.exposeFunction('__wireTap', (json) => {
    let e;
    try { e = JSON.parse(json); } catch { return; }
    const url = String(e.url || '').split('?')[0];
    if (/events\.data\.microsoft|OneCollector|client_health_ping/i.test(url)) return;
    if (e.phase === 'fetch-request' || e.phase === 'xhr-request') {
      let action = null;
      try { action = JSON.parse(e.body || '{}').action || null; } catch { /* not json */ }
      requests.push({ url, method: e.method, action });
    } else if (e.phase === 'stream-chunk' || e.phase === 'xhr-chunk') {
      streams.set(url, (streams.get(url) || '') + (e.chunk || ''));
    }
  });
  await context.addInitScript(await fs.readFile(path.join(REPO, 'tap.js'), 'utf8'));

  const page = context.pages()[0] || await context.newPage();
  console.log('loading the conversation with the in-page tap installed...\n');
  await page.goto(`https://m365.cloud.microsoft/chat/conversation/${target.id}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(15000);

  const rows = [];
  const keep = [];
  for (const [url, body] of streams) {
    let payload;
    try { payload = JSON.parse(body); } catch { payload = null; }
    const score = payload ? scoreForMessages(payload) : { texts: 0, authors: [], paths: [] };
    const carriesNeedle = needle ? body.toUpperCase().includes(needle.toUpperCase()) : false;
    if (!score.texts && !carriesNeedle) continue;
    const action = (requests.find((r) => r.url === url) || {}).action || null;
    rows.push({ url, action, bytes: body.length, ...score, carriesNeedle });
    keep.push({ url, action, score, carriesNeedle, body: body.slice(0, 60000) });
  }
  rows.sort((a, b) => b.texts - a.texts || Number(b.carriesNeedle) - Number(a.carriesNeedle));

  if (!rows.length) {
    console.log('No streamed body carried a transcript either.');
    console.log(`(saw ${streams.size} streamed responses, ${requests.length} requests)`);
  } else {
    console.log('action / url'.padEnd(52), 'bytes'.padEnd(8), 'msgs', 'authors');
    console.log('-'.repeat(92));
    for (const r of rows) {
      const label = r.action ? `[${r.action}]` : r.url.replace('https://', '');
      console.log(label.slice(0, 51).padEnd(52), String(r.bytes).padEnd(8),
        String(r.texts).padEnd(4), (r.authors || []).join(',') || '-');
    }
    const winner = rows.find((r) => r.authors.includes('bot')) || rows[0];
    console.log(`\nhistory arrives in: ${winner.action ? winner.action : winner.url}`);
    console.log(`  messages: ${winner.texts}`);
    console.log(`  path    : ${(winner.paths || [])[0] || '?'}`);
    console.log(`  authors : ${(winner.authors || []).join(', ')}`);
  }

  await fs.writeFile(OUT, JSON.stringify(keep, null, 2), 'utf8');
  console.log(`\nsaved -> ${OUT}`);
  await context.close();
})().catch((e) => { console.error('FAILED:', e.message.split('\n')[0]); process.exit(1); });
