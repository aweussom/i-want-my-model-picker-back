'use strict';
/**
 * OpenAI-compatible endpoint and static UI, on Node's built-in http.
 *
 * No Express: three routes and a static directory do not justify a dependency.
 *
 * The test UI at / is the repo root's static/ and templates/, inherited from
 * the archived Python version. It talks fetch + SSE to /v1/chat/completions
 * like any other client.
 *
 * The `model` parameter maps onto `tone`. Microsoft's official Copilot Chat API
 * has no model parameter at all.
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TONES, DEFAULT_TONE } = require('./driver.js');

// Reported by /health so a bug report from another machine can name its build.
const VERSION = (() => {
  try { return require('../package.json').version; } catch { return 'unknown'; }
})();

// The repo root, two levels up from api/src.
const WEB_ROOT = path.join(__dirname, '..', '..');

const INDEX_HTML = path.join(WEB_ROOT, 'templates', 'index.html');
const STATIC_DIR = path.join(WEB_ROOT, 'static');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Map an OpenAI `model` value onto a tone.
 *
 * `fallback` is the driver's default (newest GPT in TONES). An unknown model
 * name falls back to it rather than failing; the tone that actually went out
 * is logged by the driver and reported as `tone` by /health.
 */
function resolveTone(requested, fallback = DEFAULT_TONE) {
  if (!requested) return fallback;
  if (TONES[requested]) return requested;
  // Accept the menu label too, and ignore any "@suffix" the UI appends.
  const bare = String(requested).split('@')[0].trim().toLowerCase();
  for (const [tone, meta] of Object.entries(TONES)) {
    if (bare === tone.toLowerCase()) return tone;
    if ((meta.labels || []).some((l) => bare === l.toLowerCase())) return tone;
  }
  return fallback;
}

function lastUserMessage(body) {
  const messages = body.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p && p.type === 'text').map((p) => p.text || '')
        .filter(Boolean).join('\n');
    }
  }
  return '';
}

function extractImages(body) {
  const messages = body.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (!Array.isArray(m.content)) return { uris: [], skippedRemote: 0 };
    const uris = [];
    let skippedRemote = 0;
    for (const part of m.content) {
      if (!part || part.type !== 'image_url') continue;
      const url = (part.image_url || {}).url || '';
      // Remote URLs are skipped, not fetched: the proxy makes no outbound
      // requests on a caller's behalf.
      if (url.startsWith('data:')) uris.push(url);
      else if (url) skippedRemote++;
    }
    return { uris, skippedRemote };
  }
  return { uris: [], skippedRemote: 0 };
}

function sseChunk(delta, model, { done = false, reasoning = false } = {}) {
  const d = done ? {} : reasoning ? { reasoning_content: delta } : { content: delta };
  const chunk = {
    id: `chatcmpl-${crypto.randomBytes(6).toString('hex')}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: d, finish_reason: done ? 'stop' : null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n` + (done ? 'data: [DONE]\n\n' : '');
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
    catch (e) { reject(e); }
  });
  req.on('error', reject);
});

async function serveStatic(res, filePath) {
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function createServer(driver) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    if (route === '/' || route === '/index.html') return serveStatic(res, INDEX_HTML);

    if (route.startsWith('/static/')) {
      // Contain path traversal to the static directory.
      const target = path.join(STATIC_DIR, route.slice('/static/'.length));
      if (!path.resolve(target).startsWith(path.resolve(STATIC_DIR))) {
        return void res.writeHead(403).end('nope');
      }
      return serveStatic(res, target);
    }

    if (route === '/health') {
      // Enough to diagnose a report from a machine you cannot inspect: which
      // build is running, which browser it drove, whether the sandbox is on, and
      // what licence the account actually has. Deliberately excludes the tenant
      // id and user object id, which the Chathub URL also carries.
      const socket = driver && driver.socketUrl;
      const licence = socket && /[?&]licenseType=([^&]*)/i.exec(socket);
      const agent = socket && /[?&]agent=([^&]*)/i.exec(socket);
      return json(res, 200, {
        status: driver && driver.ready ? 'ready' : 'loading',
        version: VERSION,
        tone: driver ? driver.currentTone : null,
        defaultTone: driver ? driver.defaultTone : null,
        availableTones: driver ? driver.availableTones : null,
        browser: driver ? driver.usingChannel : null,
        headless: driver ? driver.headless : null,
        conversationId: driver ? driver.currentConversationId() : null,
        sandbox: driver ? driver.sandboxEnabled : null,
        chathub: Boolean(socket),
        licenseType: licence ? decodeURIComponent(licence[1]) : null,
        agent: agent ? decodeURIComponent(agent[1]) : null,
      });
    }

    if (route === '/v1/models') {
      // Default first: the UI populates its dropdown in this order and the
      // browser selects option zero, so ordering *is* the default selection.
      // availableTones is always null since the picker is no longer clicked, so
      // this lists every known tone, default first.
      const preferred = (driver && driver.defaultTone) || DEFAULT_TONE;
      const offered = (driver && driver.availableTones) || Object.keys(TONES);
      const ids = offered
        .filter((id) => TONES[id])
        .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
      return json(res, 200, {
        object: 'list',
        data: ids.map((id) => ({
          id,
          object: 'model',
          owned_by: TONES[id].ownedBy,
          description: TONES[id].title,
        })),
      });
    }

    if (route === '/v1/conversations' && req.method === 'GET') {
      try {
        return json(res, 200, { data: await driver.listConversations() });
      } catch (e) {
        return json(res, 502, { error: { message: e.message } });
      }
    }

    if (route === '/v1/conversations/open' && req.method === 'POST') {
      // Reopening restores the thread server-side, and with it the tone it was
      // using -- tone is a property of the conversation, not of the session.
      let body = {};
      try { body = await readBody(req); } catch { /* validated below */ }
      if (!body.id) return json(res, 400, { error: { message: 'id required' } });
      try {
        return json(res, 200, await driver.openConversation(body.id, { tone: body.tone }));
      } catch (e) {
        return json(res, 502, { error: { message: e.message } });
      }
    }

    if (route === '/v1/browser' && req.method === 'POST') {
      // Show or hide the Playwright browser. Relaunching is the only way to
      // change headless, so this starts a new Copilot conversation -- said out
      // loud in the response rather than left as a surprise.
      let body = {};
      try { body = await readBody(req); } catch { /* default to hide */ }
      try {
        const result = await driver.setVisible(Boolean(body.visible));
        return json(res, 200, {
          ...result,
          note: result.changed
            ? 'browser relaunched; this started a new Copilot conversation'
            : 'already in that state',
        });
      } catch (e) {
        return json(res, 502, { error: { message: e.message } });
      }
    }

    if (route === '/v1/cancel' && req.method === 'POST') {
      return json(res, 200, { cancelled: false, note: 'not wired to the browser yet' });
    }

    if (route === '/v1/chat/completions' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch { return json(res, 400, { error: { message: 'bad json' } }); }

      const prompt = lastUserMessage(body);
      if (!prompt) return json(res, 400, { error: { message: 'no user message' } });

      const tone = resolveTone(body.model, (driver && driver.defaultTone) || DEFAULT_TONE);
      const { uris, skippedRemote } = extractImages(body);
      const notice = skippedRemote
        ? `[note: skipped ${skippedRemote} remote image URL(s); attach as a base64 data: URI instead]\n`
        : '';

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Device': tone,
        });
        if (notice) res.write(sseChunk(notice, tone, { reasoning: true }));
        try {
          for await (const ev of driver.prompt(prompt, { tone, images: uris })) {
            res.write(sseChunk(ev.value, tone, { reasoning: ev.kind === 'reasoning' }));
          }
        } catch (e) {
          res.write(sseChunk(`\n[error: ${e.message}]`, tone));
        }
        res.write(sseChunk('', tone, { done: true }));
        return void res.end();
      }

      try {
        let text = '';
        for await (const ev of driver.prompt(prompt, { tone, images: uris })) {
          if (ev.kind === 'text') text += ev.value;
        }
        return json(res, 200, {
          id: `chatcmpl-${crypto.randomBytes(6).toString('hex')}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: tone,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        });
      } catch (e) {
        return json(res, 502, { error: { message: e.message } });
      }
    }

    res.writeHead(404).end('not found');
  });
}

module.exports = { createServer, resolveTone, lastUserMessage, extractImages, sseChunk };

// Run standalone: node src/server.js
if (require.main === module) {
  const { CopilotDriver } = require('./driver.js');
  const port = Number(process.env.PORT || 8791);
  (async () => {
    if (!fs.existsSync(INDEX_HTML)) {
      console.error(`UI not found at ${INDEX_HTML}`);
      process.exit(1);
    }
    console.log('starting browser...');
    // Honour COPILOT_PROFILE the way main.js does. Without it the standalone
    // server could only ever drive electron/.profile, so testing against a
    // second account meant editing this file.
    const profileDir = process.env.COPILOT_PROFILE
      ? path.resolve(process.env.COPILOT_PROFILE)
      : undefined;
    if (profileDir) console.log(`profile: ${profileDir}`);
    const driver = await new CopilotDriver({
      profileDir,
      channel: process.env.COPILOT_CHANNEL || null,
    }).start();
    console.log(`composer ready; tone=${driver.currentTone}`);
    createServer(driver).listen(port, '127.0.0.1', () => {
      console.log(`chat UI      http://127.0.0.1:${port}/`);
      console.log(`OpenAI API   http://127.0.0.1:${port}/v1/chat/completions`);
    });
  })().catch((e) => { console.error(e); process.exit(1); });
}
