'use strict';
/**
 * OpenAI-compatible endpoint and static UI, on Node's built-in http.
 *
 * No Express: three routes and a static directory do not justify a dependency.
 *
 * The UI is served unchanged from the Python version's static/ and templates/,
 * so it keeps talking fetch + SSE to /v1/chat/completions and needs no rewrite
 * for Electron. The renderer could use IPC instead, but then the OpenAI surface
 * would have to exist twice, and that surface is the entire point of the project.
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

// The Python project's UI, reused verbatim rather than forked again.
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

function resolveTone(requested) {
  if (!requested) return DEFAULT_TONE;
  if (TONES[requested]) return requested;
  // Accept the menu label too, and ignore any "@suffix" the UI appends.
  const bare = String(requested).split('@')[0].trim().toLowerCase();
  for (const [tone, meta] of Object.entries(TONES)) {
    if (bare === tone.toLowerCase() || bare === meta.label.toLowerCase()) return tone;
  }
  return DEFAULT_TONE;
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
      return json(res, 200, {
        status: driver && driver.ready ? 'ready' : 'loading',
        tone: driver ? driver.currentTone : null,
        // Report only whether the socket is attached: the URL embeds the user
        // object id and tenant id.
        chathub: Boolean(driver && driver.socketUrl),
      });
    }

    if (route === '/v1/models') {
      // Default first: the UI populates its dropdown in this order and the
      // browser selects option zero, so ordering *is* the default selection.
      const ids = Object.keys(TONES)
        .sort((a, b) => (a === DEFAULT_TONE ? -1 : b === DEFAULT_TONE ? 1 : 0));
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

    if (route === '/v1/cancel' && req.method === 'POST') {
      return json(res, 200, { cancelled: false, note: 'not wired to the browser yet' });
    }

    if (route === '/v1/chat/completions' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch { return json(res, 400, { error: { message: 'bad json' } }); }

      const prompt = lastUserMessage(body);
      if (!prompt) return json(res, 400, { error: { message: 'no user message' } });

      const tone = resolveTone(body.model);
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
    const driver = await new CopilotDriver({}).start();
    console.log(`composer ready; tone=${driver.currentTone}`);
    createServer(driver).listen(port, '127.0.0.1', () => {
      console.log(`chat UI      http://127.0.0.1:${port}/`);
      console.log(`OpenAI API   http://127.0.0.1:${port}/v1/chat/completions`);
    });
  })().catch((e) => { console.error(e); process.exit(1); });
}
