'use strict';
/**
 * Resident browser that drives Microsoft 365 Copilot and reads its WebSocket.
 *
 * Port of the Python driver, and the port deletes an entire class of bug.
 *
 * Playwright's *synchronous* Python API dispatches event callbacks only while
 * the owning thread is inside a Playwright call, so the Python version needs a
 * dedicated worker thread, two queues, and a command loop that must never block
 * on queue.get() -- getting that wrong silently starved every framereceived
 * handler and the browser answered correctly while the API timed out.
 *
 * Node's Playwright is async by construction. There is no thread to confine, no
 * pump to starve, and the bug is not expressible. What is left is an event
 * emitter and an async generator.
 *
 * Everything else is the same hard-won detail: the composer is a <span> with
 * role="textbox", named models sit behind a submenu that opens on HOVER, `tone`
 * is per conversation, and uploads bind to the conversation server-side.
 */

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { chromium } = require('playwright');

const CHAT_URL = 'https://m365.cloud.microsoft/chat';

// Discovered by asking the DOM, not by guessing. Match on role and
// contenteditable, which do not change with UI language.
const COMPOSER_SELECTORS = [
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"][aria-label*="Copilot"]',
  'textarea',
  '[contenteditable="true"]',
];

// The picker button's accessible name is localized -- "Modellvelger" in
// Norwegian, "Model selector" in English -- and its inner text is the current
// selection.
//
// There used to be a bare `button[aria-haspopup]` as a last resort. That is far
// too broad: it matches every popup button on the page, and on an account where
// the real picker is absent it happily selected the overflow menu on a chat in
// the history sidebar (aria-label="Mer", class fui-SplitNavItem__menuButton).
// Clicking that then failed because the nav link's subtree intercepts pointer
// events, and the exception surfaced as a chat error. A selector that can match
// the wrong thing is worse than one that matches nothing.
const PICKER_SELECTORS = [
  '[aria-label*="odellvelger" i]',
  '[aria-label*="model selector" i]',
  '[aria-label*="modellvelg" i]',
];

// The trigger's text is the current tone's label, so it doubles as confirmation
// that we found the right button. Localised, hence the aliases below.
const PICKER_TEXT_HINTS = [
  'auto', 'automatisk',
  'quick response', 'raskt svar',
  'think deeper', 'tenk dypere',
  'gpt',
];

// `labels` are what the menu entry reads, and Copilot localises them. This laptop
// renders the entries in English while the surrounding chrome is Norwegian;
// another machine on the same product renders them fully translated. Matching on
// one language quietly finds nothing on the other, so every tone carries its
// aliases. Add more as they turn up -- a missing alias degrades to "this account
// does not offer that tone", which is wrong but harmless.
const TONES = {
  Magic: {
    labels: ['Auto', 'Automatisk'],
    title: 'Auto', ownedBy: 'microsoft',
  },
  Chat: {
    labels: ['Quick response', 'Raskt svar'],
    title: 'Quick response', ownedBy: 'microsoft',
  },
  Reasoning: {
    labels: ['Think deeper', 'Tenk dypere'],
    title: 'Think deeper', ownedBy: 'microsoft',
  },
  Gpt_5_6_Reasoning: {
    labels: ['GPT 5.6 Think deeper', 'GPT 5.6 Tenk dypere'],
    title: 'GPT 5.6 Think deeper', ownedBy: 'openai',
  },
  Gpt_5_5_Chat: {
    labels: ['GPT 5.5 Quick response', 'GPT 5.5 Raskt svar'],
    title: 'GPT 5.5 Quick response', ownedBy: 'openai',
  },
};

/** Does `text` contain any of this tone's localised labels? */
const toneMatches = (id, text) => {
  const low = String(text).toLowerCase();
  return (TONES[id]?.labels || []).some((l) => low.includes(l.toLowerCase()));
};
// What a *fresh Copilot conversation* is actually on. Not a preference: it is
// the browser's real state, and the driver compares against it to decide whether
// the picker needs touching. Conflating this with the requested default makes
// the driver skip the picker and quietly answer as Auto.
const BROWSER_DEFAULT_TONE = 'Magic';

/**
 * The newest named GPT, computed rather than hardcoded.
 *
 * The menu is a moving target -- `Gpt_5_4_Reasoning` was in this tenant's chat
 * history but had already been dropped from the picker. Deriving the default
 * means the day Microsoft ships 5.7, it becomes the default without an edit.
 * Reasoning wins over Chat at the same version: "Think deeper" is the point.
 */
function highestGptTone(tones = TONES) {
  const parse = (id) => {
    const m = /^Gpt_(\d+)_(\d+)_(\w+)$/i.exec(id);
    return m && { major: +m[1], minor: +m[2], reasoning: /reasoning/i.test(m[3]) };
  };
  let best = null;
  let bestId = null;
  for (const id of Object.keys(tones)) {
    const v = parse(id);
    if (!v) continue;
    let better;
    if (!best) better = true;
    else if (v.major !== best.major) better = v.major > best.major;
    else if (v.minor !== best.minor) better = v.minor > best.minor;
    else better = v.reasoning && !best.reasoning;
    if (better) { best = v; bestId = id; }
  }
  return bestId || BROWSER_DEFAULT_TONE;
}

// What we ask for when the caller does not specify.
const DEFAULT_TONE = highestGptTone();

// Bot messages that are progress chatter rather than the answer. The real reply
// arrives with no messageType at all and contentOrigin "DeepLeo".
const PROGRESS_TYPES = new Set([
  'Progress', 'InternalLoaderMessage', 'InternalSearchQuery', 'InternalSearchResult',
  'RenderCardRequest', 'SearchQuery', 'GeneratedCode', 'Disengaged',
]);

// Copilot marks citations two ways: [^1^] in hiddenText, and Unicode
// private-use sentinels in the streamed text -- U+E200 opens, U+E202 separates,
// U+E201 closes. Those code points have no glyph, so leaving them in renders a
// row of tofu boxes. Escapes are spelled out; the literal characters are
// invisible in an editor and get lost in edits.
const CITATION_RE = new RegExp(
  '\\uE200[\\s\\S]*?\\uE201'   // a complete sentinel-wrapped citation span
  + '|\\uE200[^\\uE201]*$'      // an unterminated span at the end of a delta
  + '|\\[\\^\\d+\\^\\]'          // the Bing-style marker used in hiddenText
  + '|[\\uE200-\\uE20F]',       // any stray sentinel that escaped the above
  'g',
);

const RECORD_SEPARATOR = '\u001E';
const SOCKETIO_PREFIX = /^\d+:\d*\+?::?/;

// ImageSanitizerBingAI rejects trivially small files with InvalidRequest.
const MIN_IMAGE_BYTES = 1024;
const EXT_FOR_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/webp': '.webp', 'image/gif': '.gif',
};

const isChathub = (u) => /chathub/i.test(u) || (/substrate/i.test(u) && /copilot/i.test(u));
const isUpload = (u) => /uploadfile/i.test(u);

function splitRecords(payload) {
  return payload
    .split(RECORD_SEPARATOR)
    .filter((p) => p.trim())
    .map((p) => {
      const stripped = p.replace(SOCKETIO_PREFIX, '');
      return stripped.trim() ? stripped : p;
    });
}

/** Minimal pushable async queue: the bridge from events to `for await`. */
class EventQueue {
  constructor() { this.items = []; this.waiters = []; }
  push(item) {
    const w = this.waiters.shift();
    if (w) w(item); else this.items.push(item);
  }
  clear() { this.items.length = 0; }
  next(timeoutMs) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(fn);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const fn = (item) => { clearTimeout(timer); resolve(item); };
      this.waiters.push(fn);
    });
  }
}

class CopilotDriver {
  constructor({ headless = false, profileDir, url = CHAT_URL, channel = null } = {}) {
    this.headless = headless;
    this.profileDir = profileDir || path.join(__dirname, '..', '.profile');
    this.url = url;
    this.channel = channel;          // null = try chrome, then msedge, then bundled
    this.usingChannel = null;
    this.sandboxEnabled = null;
    this.availableTones = null;   // filled by discoverTones() at startup
    this._conversationPinned = false;   // true while continuing a reopened thread
    this.currentTone = BROWSER_DEFAULT_TONE;   // what a fresh conversation is on
    this.socketUrl = null;
    this.ready = false;
    this._events = new EventQueue();
    this._uploads = new EventQueue();
    this._busy = Promise.resolve();          // serialises turns
    this._tmpdir = null;
  }

  /**
   * @param {object}  [opts]
   * @param {number}  [opts.signInTimeoutMs] How long to wait for a composer.
   *   Deliberately generous: if the profile holds no session the user signs in
   *   *here*, and an Entra login with an Authenticator push is not a 60-second
   *   operation. An earlier version waited one minute and then tore the browser
   *   down mid-login, which is a spectacularly unhelpful thing to do.
   * @param {function} [opts.onWait] Called with seconds waited, so a caller can
   *   say something rather than appear hung.
   */
  /**
   * Start headless when the profile already holds a session; headed when it does
   * not.
   *
   * Once you have signed in, the browser window is clutter -- it is doing work,
   * but you do not need to watch it. Hiding it unconditionally is the trap:
   * sessions expire and Conditional Access re-prompts, and an invisible browser
   * waiting on a login you cannot see is indistinguishable from a hang.
   *
   * So probe headless with a short fuse. A warm profile reaches the composer in
   * seconds; if it does not, a sign-in page is almost certainly showing, and we
   * relaunch visibly with the long timeout so you can deal with it. Self-healing
   * rather than configurable, though COPILOT_HEADLESS=0 or 1 forces the matter.
   */
  async start({ signInTimeoutMs = 12 * 60 * 1000, onWait = null,
    headlessProbeMs = 45 * 1000 } = {}) {
    const forced = process.env.COPILOT_HEADLESS;

    if (forced !== '0') {
      this.headless = true;
      this.context = await this._launch();
      try {
        return await this._afterLaunch(
          forced === '1' ? signInTimeoutMs : headlessProbeMs, onWait,
        );
      } catch (err) {
        if (forced === '1') throw err;
        console.log('[driver] no composer while hidden -- showing the browser to sign in');
        try { await this.context.close(); } catch { /* already gone */ }
        this.ready = false;
        this.socketUrl = null;
        this.availableTones = null;
      }
    }

    this.headless = false;
    this.context = await this._launch();
    return this._afterLaunch(signInTimeoutMs, onWait);
  }

  /**
   * Which tone the page is currently showing.
   *
   * The picker trigger's visible text *is* the current selection, so this reads
   * the live state rather than trusting what we last set. Locale-aware via the
   * tone aliases, which is why it survives a Norwegian UI.
   */
  async readCurrentTone() {
    const trigger = await this._findPickerTrigger();
    if (!trigger) return null;
    const text = await trigger.innerText().catch(() => '');
    if (!text) return null;
    // Longest label first, so "GPT 5.6 Think deeper" wins over "Think deeper".
    const ids = Object.keys(TONES).sort(
      (a, b) => Math.max(...TONES[b].labels.map((l) => l.length))
              - Math.max(...TONES[a].labels.map((l) => l.length)),
    );
    return ids.find((id) => toneMatches(id, text)) || null;
  }

  /**
   * List the account's existing Copilot conversations.
   *
   * Same action the web client uses for its own sidebar. Issued from inside the
   * page so the session and CORS context come along for free -- no token
   * handling, no endpoint of our own to keep in step.
   *
   * Falls back to reading the sidebar DOM, because the action's exact payload has
   * changed shape before and a rendered list is harder to break.
   */
  async listConversations({ limit = 40 } = {}) {
    const viaAction = await this.page.evaluate(async () => {
      try {
        const r = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'GetConversationPageHistoryList' }),
        });
        if (!r.ok) return null;
        const j = await r.json();
        const chats = j?.store?.conversationPageHistoryList?.chats;
        return Array.isArray(chats) ? chats : null;
      } catch { return null; }
    }).catch(() => null);

    if (viaAction) {
      return viaAction.slice(0, limit).map((c) => ({
        id: c.conversationId,
        name: c.chatName || '(untitled)',
        tone: c.tone || null,
        preview: (c.preview || '').slice(0, 200) || null,
        updated: c.updateTimeUtc || null,
        source: 'action',
      }));
    }

    // The sidebar links carry /chat/conversation/<id> and their own labels.
    const viaDom = await this.page.evaluate(() => Array.from(
      document.querySelectorAll('a[href*="/chat/conversation/"]'),
    ).map((a) => ({
      id: (a.getAttribute('href') || '').split('/chat/conversation/')[1] || null,
      name: (a.getAttribute('aria-label') || a.textContent || '').trim(),
    })).filter((x) => x.id)).catch(() => []);

    const seen = new Set();
    return viaDom.filter((c) => !seen.has(c.id) && seen.add(c.id))
      .slice(0, limit)
      .map((c) => ({ ...c, tone: null, preview: null, updated: null, source: 'dom' }));
  }

  /**
   * Open an existing conversation so the next prompt continues it.
   *
   * Navigating restores it server-side, which matters more than it sounds: `tone`
   * is a property of the conversation, so reopening an old thread also restores
   * the model it was using. currentTone is set from the listing when known, so
   * the driver does not then "helpfully" reset the picker.
   */
  async openConversation(id, { tone = null } = {}) {
    if (!/^[0-9a-f-]{16,}$/i.test(String(id))) throw new Error('implausible conversation id');
    let release;
    const mine = new Promise((r) => { release = r; });
    const previous = this._busy;
    this._busy = this._busy.then(() => mine);
    await previous;
    try {
      await this.page.goto(`https://m365.cloud.microsoft/chat/conversation/${id}`,
        { waitUntil: 'domcontentloaded' });
      const composer = await this._waitComposer(120);
      if (!composer) throw new Error('conversation did not load a composer');
      await this.page.waitForTimeout(1500);
      // Prefer what the page says over what the listing claimed: the picker
      // trigger's own text is the live truth, and the sidebar fallback has no
      // tone at all.
      this.currentTone = (await this.readCurrentTone())
        || (tone && TONES[tone] ? tone : BROWSER_DEFAULT_TONE);
      this._conversationPinned = true;
      return { id, tone: this.currentTone, pinned: true };
    } finally {
      release();
    }
  }

  /**
   * Show or hide the browser.
   *
   * Playwright cannot toggle headless on a running context, so this closes the
   * browser and launches a new one. That has a consequence worth surfacing rather
   * than hiding: a new browser is a new Copilot conversation, so the current
   * thread and its context are gone, and `tone` resets to what a fresh chat uses.
   *
   * Serialised against turns on the same lock as prompt(), so it cannot pull the
   * browser out from under a request in flight.
   */
  async setVisible(visible) {
    if (this.headless === !visible) {
      return { changed: false, headless: this.headless };
    }
    let release;
    const mine = new Promise((r) => { release = r; });
    const previous = this._busy;
    this._busy = this._busy.then(() => mine);
    await previous;
    try {
      try { await this.context.close(); } catch { /* already gone */ }
      this.ready = false;
      this.socketUrl = null;
      this.availableTones = null;
      this.currentTone = BROWSER_DEFAULT_TONE;   // new browser, new conversation
      this._conversationPinned = false;
      this.headless = !visible;
      this.context = await this._launch();
      await this._afterLaunch(visible ? 12 * 60 * 1000 : 60 * 1000, null);
      return { changed: true, headless: this.headless };
    } finally {
      release();
    }
  }

  async _afterLaunch(signInTimeoutMs, onWait) {
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this._attach(this.page);
    this.context.on('page', (p) => this._attach(p));

    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
    const composer = await this._waitComposer(Math.ceil(signInTimeoutMs / 500), onWait);
    if (!composer) {
      throw new Error(
        `No composer after ${Math.round(signInTimeoutMs / 1000)}s. If a sign-in page ` +
        'is showing, finish it and start again -- the profile keeps the session.',
      );
    }
    await this.page.waitForTimeout(2000);
    this.availableTones = await this.discoverTones();
    this._tmpdir = this._tmpdir || await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-wire-'));
    this.ready = true;
    return this;
  }

  /**
   * Launch a browser, preferring one the machine already has.
   *
   * A packaged build cannot assume Playwright's own Chromium: it lives in
   * %LOCALAPPDATA%\ms-playwright and is put there by `playwright install`, which
   * an installer user never runs. Driving installed Chrome or Edge instead means
   * the .exe works on a clean Windows box with no 150MB browser download, and
   * Edge is always present. Falls back to the bundled Chromium for dev checkouts.
   */
  async _launch() {
    const opts = {
      headless: this.headless,
      viewport: { width: 1500, height: 950 },
      // No extra args on purpose.
      //
      // This used to pass --disable-blink-features=AutomationControlled, the
      // usual trick for hiding navigator.webdriver. It was a defensive reflex,
      // not a requirement: nothing in Copilot appears to check, and everything
      // works without it. Meanwhile a branded Chrome puts "Du bruker et
      // kommandolinjeflagg som ikke handteres" across the top of the window on
      // every launch, which is a real cost for a speculative benefit. Removing
      // it also keeps this on the right side of "automating my own session"
      // rather than "evading detection".
      args: [],
      // Playwright disables the Chromium sandbox by default, which means it
      // passes --no-sandbox. Invisible with its own bundled Chromium, but a
      // branded Chrome shows "You are using an unsupported command-line flag"
      // across the top -- and the warning is right. This browser is signed into
      // a real Microsoft account and browsing the real web; its renderers should
      // be sandboxed like any other. Nothing here needs the sandbox off.
      chromiumSandbox: true,
    };
    const attempts = this.channel
      ? [this.channel]
      : ['chrome', 'msedge', null];   // null = Playwright's own Chromium
    let lastErr = null;
    for (const channel of attempts) {
      try {
        const ctx = await chromium.launchPersistentContext(
          this.profileDir, channel ? { ...opts, channel } : opts,
        );
        this.usingChannel = channel || 'bundled-chromium';
        this.sandboxEnabled = opts.chromiumSandbox === true;
        return ctx;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `No usable browser. Tried ${attempts.map((a) => a || 'bundled chromium').join(', ')}. `
      + `Last error: ${lastErr && lastErr.message}`,
    );
  }

  _attach(page) {
    page.on('websocket', (ws) => {
      if (!isChathub(ws.url())) return;
      this.socketUrl = ws.url().replace(/([?&]access_token=)[^&]*/i, '$1<REDACTED>');
      ws.on('framereceived', (data) => this._onFrame(data.payload));
    });

    page.on('response', async (res) => {
      if (!isUpload(res.url())) return;
      try {
        const body = await res.json();
        const result = body.result || {};
        if (result.value === 'Success') {
          this._uploads.push({ ok: true, detail: body.fileName || 'uploaded' });
        } else {
          this._uploads.push({
            ok: false,
            detail: `${result.value}: ${result.message} (sanitizer=${body.fileSanitizer})`,
          });
        }
      } catch {
        this._uploads.push({ ok: false, detail: `HTTP ${res.status()}, unreadable body` });
      }
    });
  }

  _onFrame(payload) {
    if (typeof payload !== 'string') return;
    for (const record of splitRecords(payload)) {
      let parsed;
      try { parsed = JSON.parse(record); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;

      if (parsed.type === 1) {
        for (const arg of parsed.arguments || []) this._harvest(arg && arg.messages);
      } else if (parsed.type === 2) {
        const item = parsed.item || {};
        this._harvest(item.messages);
        const result = item.result || {};
        if (result.value && result.value !== 'Success') {
          this._events.push({ kind: 'error', value: `${result.value}: ${result.message}` });
        }
        this._events.push({ kind: 'done' });
      } else if (parsed.type === 3) {
        this._events.push({ kind: 'done' });
      }
    }
  }

  _harvest(messages) {
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
      if (!m || m.author !== 'bot' || typeof m.text !== 'string' || !m.text) continue;
      if (PROGRESS_TYPES.has(m.messageType)) {
        this._events.push({ kind: 'progress', value: m.text });
      } else if (m.messageType == null || m.messageType === 'Chat') {
        this._events.push({ kind: 'text', id: m.messageId || 'answer', value: m.text });
      }
    }
  }

  async _findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      const el = this.page.locator(sel).first();
      try {
        if ((await el.count()) && (await el.isVisible())) return el;
      } catch { /* keep looking */ }
    }
    return null;
  }

  async _waitComposer(attempts = 120, onWait = null) {
    for (let i = 0; i < attempts; i++) {
      const c = await this._findComposer();
      if (c) return c;
      if (onWait && i > 0 && i % 20 === 0) onWait(Math.round(i / 2));
      await this.page.waitForTimeout(500);
    }
    return null;
  }

  async _findPickerTrigger() {
    for (const sel of PICKER_SELECTORS) {
      const el = this.page.locator(sel).first();
      try {
        if ((await el.count()) && (await el.isVisible())) return el;
      } catch { /* keep looking */ }
    }
    // Nothing matched by accessible name. Rather than reach for a generic
    // popup button -- which is how the sidebar's overflow menu got clicked --
    // look for a button whose visible text is a tone label, and require it to
    // be outside the navigation. If that finds nothing, we have no picker, and
    // saying so is the correct answer.
    try {
      const buttons = await this.page.locator('button:not(nav button)').all();
      for (const b of buttons) {
        const text = ((await b.innerText().catch(() => '')) || '')
          .split(/\s+/).join(' ').toLowerCase();
        if (!text || text.length > 30) continue;
        if (PICKER_TEXT_HINTS.some((h) => text.includes(h)) && await b.isVisible()) {
          return b;
        }
      }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * Ask the page which tones this account actually offers.
   *
   * The menu is not the same everywhere. A work tenant on licenseType=Starter
   * shows the generic modes *and* named models (GPT 5.6 Think deeper, GPT 5.5
   * Quick response). A personal Microsoft account shows only the generic three:
   * Auto, Quick response, Think deeper. Hardcoding the tone map meant the app
   * confidently offered GPT 5.6 on accounts that have never had it, failed to
   * find the menu entry, and silently answered as Auto instead.
   *
   * So: enumerate the real menu and match against known labels. Anything not on
   * screen is not offered.
   */
  async discoverTones() {
    const trigger = await this._findPickerTrigger();
    if (!trigger) return null;
    try {
      await trigger.click({ timeout: 5000 });
      await this.page.waitForTimeout(2500);

      const seen = new Set();
      const collect = async () => {
        for (const role of ['menuitemradio', 'menuitem', 'option']) {
          let all = [];
          try { all = await this.page.getByRole(role).all(); } catch { continue; }
          for (const it of all) {
            try {
              if (await it.isVisible()) {
                seen.add(((await it.innerText()) || '').split(/\s+/).join(' '));
              }
            } catch { /* skip */ }
          }
        }
      };
      await collect();
      // Named models hide behind a provider submenu that opens on hover.
      for (const role of ['menuitem']) {
        let all = [];
        try { all = await this.page.getByRole(role).all(); } catch { continue; }
        for (const it of all) {
          try {
            const t = ((await it.innerText()) || '').toLowerCase();
            if (!/gpt|openai|claude|anthropic/.test(t)) continue;
            await it.hover();
            await this.page.waitForTimeout(1800);
            await collect();
          } catch { /* skip */ }
        }
      }
      try { await this.page.keyboard.press('Escape'); } catch { /* ignore */ }

      const menu = [...seen].join(' || ').toLowerCase();
      const available = Object.keys(TONES).filter((id) => toneMatches(id, menu));
      return available.length ? available : null;
    } catch {
      try { await this.page.keyboard.press('Escape'); } catch { /* ignore */ }
      return null;
    }
  }

  /** Best tone this account actually has: newest GPT, else the deepest generic. */
  get defaultTone() {
    const pool = this.availableTones && this.availableTones.length
      ? Object.fromEntries(this.availableTones.map((id) => [id, TONES[id]]))
      : TONES;
    const gpt = highestGptTone(pool);
    if (gpt !== BROWSER_DEFAULT_TONE) return gpt;
    for (const fallback of ['Reasoning', 'Chat', 'Magic']) {
      if (pool[fallback]) return fallback;
    }
    return BROWSER_DEFAULT_TONE;
  }

  async _selectTone(tone) {
    if (!TONES[tone]) return false;
    if (this.availableTones && !this.availableTones.includes(tone)) return false;

    const trigger = await this._findPickerTrigger();
    if (!trigger) return false;

    // A failure here must not take the turn down with it: on an account with no
    // picker at all, this is expected, and the caller degrades to the current tone.
    try {
      await trigger.click({ timeout: 5000 });
    } catch {
      return false;
    }
    await this.page.waitForTimeout(2500);   // the menu takes well over a second

    const items = async () => {
      const out = [];
      for (const role of ['menuitemradio', 'menuitem', 'option']) {
        let all = [];
        try { all = await this.page.getByRole(role).all(); } catch { continue; }
        for (const it of all) {
          try {
            if (await it.isVisible()) {
              out.push({ it, role, text: ((await it.innerText()) || '').split(/\s+/).join(' ') });
            }
          } catch { /* skip */ }
        }
      }
      return out;
    };

    const clickMatch = async (list) => {
      for (const { it, text } of list) {
        if (toneMatches(tone, text)) {
          try {
            await it.click({ timeout: 5000 });
            await this.page.waitForTimeout(900);
            return true;
          } catch { /* try the next */ }
        }
      }
      return false;
    };

    const top = await items();
    if (await clickMatch(top)) return true;

    // Named models sit behind a provider submenu that opens on HOVER.
    // Clicking the parent collapses it and loses the nested entries.
    for (const { it, role, text } of top) {
      if (role !== 'menuitem') continue;
      if (!/gpt|openai|claude|anthropic/i.test(text)) continue;
      try {
        await it.hover();
        await this.page.waitForTimeout(2200);
      } catch { continue; }
      if (await clickMatch(await items())) return true;
    }

    try { await this.page.keyboard.press('Escape'); } catch { /* ignore */ }
    return false;
  }

  /**
   * Attach images through Copilot's own file input.
   *
   * Deliberately not a hand-rolled POST to /m365Copilot/UploadFile: handing the
   * file to the page means the app builds the multipart body, supplies the
   * conversationId and the gptv optionsSets, and carries its own auth.
   */
  async _attachImages(dataUris, emit) {
    const paths = [];
    for (const uri of dataUris) {
      const m = /^data:([\w.+/-]+);base64,(.+)$/s.exec(String(uri).trim());
      if (!m) { emit({ kind: 'progress', value: '[skipped an attachment: not a base64 data: URI]\n' }); continue; }
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < MIN_IMAGE_BYTES) {
        emit({ kind: 'progress', value:
          `[skipped an attachment: ${buf.length} bytes is below the sanitizer's floor]\n` });
        continue;
      }
      const file = path.join(this._tmpdir,
        `upload-${Date.now()}-${paths.length}${EXT_FOR_MIME[m[1].toLowerCase()] || '.png'}`);
      await fs.writeFile(file, buf);
      paths.push(file);
    }
    if (!paths.length) return;

    const input = this.page.locator('input[type="file"]').first();
    if (!(await input.count())) {
      emit({ kind: 'progress', value: '[no file input on the page; attachment dropped]\n' });
      return;
    }
    this._uploads.clear();
    await input.setInputFiles(paths);

    // Wait for one settle signal per file rather than sleeping and hoping.
    for (let i = 0; i < paths.length; i++) {
      const res = await this._uploads.next(90_000);
      if (!res) emit({ kind: 'progress', value: '[upload did not settle in 90s]\n' });
      else if (res.ok) emit({ kind: 'progress', value: `[attached ${res.detail}]\n` });
      else emit({ kind: 'progress', value: `[upload rejected: ${res.detail}]\n` });
    }
    await this.page.waitForTimeout(1200);
  }

  /**
   * Send one prompt; yield {kind: 'text'|'reasoning', value} as it arrives.
   *
   * Copilot re-sends the whole message body as it grows rather than emitting
   * pure deltas, so the longest prefix per message id is tracked and only the
   * new tail is yielded.
   */
  async *prompt(text, { tone = null, images = [], timeoutMs = 300_000 } = {}) {
    // An unspecified model means "whatever this conversation is on", not "my
    // preferred default". That distinction only shows up once you can reopen an
    // old thread: the default would differ from the thread's tone, the tone-change
    // path would navigate to the base chat URL to reach the picker, and the
    // conversation you just reopened would be silently abandoned. The default
    // applies to *new* conversations.
    if (!tone) tone = this._conversationPinned ? this.currentTone : this.defaultTone;
    else this._conversationPinned = false;   // an explicit switch starts a new thread
    // Serialise turns: one browser, one conversation.
    let release;
    const mine = new Promise((r) => { release = r; });
    const previous = this._busy;
    this._busy = this._busy.then(() => mine);
    await previous;

    const pending = [];
    const emit = (e) => pending.push(e);

    try {
      this._events.clear();

      // tone is per conversation, so a change needs a fresh chat.
      if (tone !== this.currentTone) {
        await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
        if (!(await this._waitComposer())) throw new Error('composer lost after reload');
        await this.page.waitForTimeout(2500);
        if (await this._selectTone(tone)) {
          this.currentTone = tone;
        } else {
          emit({ kind: 'progress', value: `[could not select ${tone}; using current]\n` });
          this.currentTone = BROWSER_DEFAULT_TONE;   // what a fresh conversation is on
        }
      }

      if (images.length) await this._attachImages(images, emit);

      for (const e of pending.splice(0)) {
        yield { kind: e.kind === 'progress' ? 'reasoning' : e.kind, value: e.value };
      }

      const composer = await this._findComposer();
      if (!composer) throw new Error('composer vanished');
      await composer.click();
      try { await composer.fill(''); } catch {
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.press('Delete');
      }
      await composer.type(text, { delay: 8 });
      await this.page.keyboard.press('Enter');

      const deadline = Date.now() + timeoutMs;
      const emitted = new Map();
      const seenProgress = new Set();
      let gotAnswer = false;

      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('no completion frame before timeout');
        const ev = await this._events.next(Math.min(left, 1000));
        if (!ev) continue;

        if (ev.kind === 'text') {
          const full = ev.value.replace(CITATION_RE, '');
          const prev = emitted.get(ev.id) || '';
          const tail = full.startsWith(prev) ? full.slice(prev.length) : full;
          if (tail) {
            emitted.set(ev.id, full);
            gotAnswer = true;
            yield { kind: 'text', value: tail };
          }
        } else if (ev.kind === 'progress') {
          if (!seenProgress.has(ev.value)) {
            seenProgress.add(ev.value);
            yield { kind: 'reasoning', value: `${ev.value}\n` };
          }
        } else if (ev.kind === 'error') {
          if (!gotAnswer) throw new Error(`driver error: ${ev.value}`);
        } else if (ev.kind === 'done') {
          return;
        }
      }
    } finally {
      release();
    }
  }

  async close() {
    try { await this.context?.close(); } catch { /* already gone */ }
  }
}

module.exports = { CopilotDriver, TONES, DEFAULT_TONE, BROWSER_DEFAULT_TONE, highestGptTone, toneMatches, CITATION_RE, splitRecords, isChathub, isUpload };
