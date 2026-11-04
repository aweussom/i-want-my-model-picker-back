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
 * Model selection does NOT touch Microsoft's picker any more. The driver injects
 * ../../userscript/model-picker.user.js, the same file people install in
 * Tampermonkey, and tells it which `tone` to write into the outgoing chat frame
 * via window.__mpo. The old way opened the menu, hovered a provider submenu and
 * matched localised labels; it broke every time Microsoft renamed an entry (the
 * "GPT-5.6 Sol" rename of Nov 2026 broke it silently). The wire field has not
 * changed since it was found.
 *
 * Still true: the composer is a <span> with role="textbox", and uploads bind to
 * the conversation server-side.
 */

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { chromium } = require('playwright');

const CHAT_URL = 'https://m365.cloud.microsoft/chat';

// The userscript lives at the repo root, two levels up from api/src. One copy,
// shared with Tampermonkey users; _afterLaunch() fails loudly if it is missing.
const USERSCRIPT_CANDIDATE = path.join(__dirname, '..', '..', 'userscript', 'model-picker.user.js');
const USERSCRIPT_PATH = fsSync.existsSync(USERSCRIPT_CANDIDATE) ? USERSCRIPT_CANDIDATE : null;

// Discovered by asking the DOM, not by guessing. Match on role and
// contenteditable, which do not change with UI language.
const COMPOSER_SELECTORS = [
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"][aria-label*="Copilot"]',
  'textarea',
  '[contenteditable="true"]',
];

// The tone values the API offers as `model`. Keys are wire values, which is all
// the driver needs now. `labels` are only aliases for server.js resolveTone(), so
// a caller may send the menu label instead of the wire value; they no longer
// drive any clicking, so a stale label costs an alias, not a broken request.
//
// Gpt_5_6_Reasoning and Gpt_5_6_Chat were read off the wire on 2026-11-04 with
// the userscript set to Off. Gpt_5_5_Chat had left the menu by then and is
// untested since; kept because values have outlived their buttons before.
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
    labels: ['GPT-5.6 Sol Think deeper', 'GPT 5.6 Sol Think', 'GPT 5.6 Think deeper',
      'GPT 5.6 Tenk dypere', 'GPT 5.6 Think'],
    title: 'GPT-5.6 Sol Think deeper', ownedBy: 'openai',
  },
  Gpt_5_6_Chat: {
    labels: ['GPT-5.6 Sol Quick response', 'GPT 5.6 Sol Quick', 'GPT 5.6 Quick response',
      'GPT 5.6 Raskt svar'],
    title: 'GPT-5.6 Sol Quick response', ownedBy: 'openai',
  },
  Gpt_5_5_Chat: {
    labels: ['GPT 5.5 Quick response', 'GPT 5.5 Raskt svar', 'GPT 5.5 Quick'],
    title: 'GPT 5.5 Quick response (no longer in the menu)', ownedBy: 'openai',
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

// Cloudflare Turnstile's own iframe host. Seen on the free consumer surface,
// where every send raises a verification box; not seen on a work tenant.
const CHALLENGE_FRAME_MARKER = 'challenges.cloudflare.com';

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
  // MemoryUpdate turned up while reading a stored transcript: Copilot records
  // things it has decided to remember as a bot message ("Codeword BERGEN"). It
  // is bookkeeping, not an answer, and without this it would have been rendered
  // as one.
  'MemoryUpdate', 'TriggerPlugin', 'HintInvocation', 'DeveloperLogs',
  'ReferencesListComplete', 'EndOfRequest',
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
    // Always null now. It used to be filled by clicking through the menu; the
    // menu is no longer touched, and the model list is not in the page's
    // hydration data [OBSERVED 2026-11-04]. null means "not discovered", and
    // server.js then offers every entry in TONES.
    this.availableTones = null;
    this._conversationPinned = false;   // true while continuing a reopened thread
    // The tone of the last chat frame that went out, as reported by the
    // userscript. Before any send it is what a fresh conversation is on; after
    // reopening a thread it is null until the next send reports it.
    this.currentTone = BROWSER_DEFAULT_TONE;
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
      }
    }

    this.headless = false;
    this.context = await this._launch();
    return this._afterLaunch(signInTimeoutMs, onWait);
  }

  /**
   * Read the transcript of the conversation currently loaded.
   *
   * There is no action that fetches this, which is why three separate traffic
   * probes came back empty. Copilot server-side renders the history into the page
   * when you navigate to /chat/conversation/<id>, and it lands in the React Router
   * hydration blob under the `chat-history` loader:
   *
   *   window.__staticRouterHydrationData
   *     .loaderData['chat-history'].store.rawConversationResponse.messages
   *
   * Each entry has the same shape as a Chathub frame message -- author, text,
   * messageType -- so the same PROGRESS_TYPES filter applies. Note that filter
   * has to include MemoryUpdate: Copilot logs what it chose to remember as a bot
   * message, and it is not an answer.
   */
  async readTranscript() {
    const messages = await this.page.evaluate(() => {
      const data = window.__staticRouterHydrationData;
      const loader = data && data.loaderData && data.loaderData['chat-history'];
      const raw = loader && loader.store && loader.store.rawConversationResponse;
      if (!raw || !Array.isArray(raw.messages)) return null;
      return raw.messages.map((m) => ({
        author: m.author || null,
        messageType: m.messageType || null,
        text: typeof m.text === 'string' ? m.text : '',
        createdAt: m.createdAt || m.timestamp || null,
      }));
    }).catch(() => null);
    if (!messages) return null;

    return messages
      .filter((m) => m.text && !PROGRESS_TYPES.has(m.messageType))
      .filter((m) => m.author === 'user' || m.author === 'bot')
      .map((m) => ({
        role: m.author === 'user' ? 'user' : 'assistant',
        content: m.text.replace(CITATION_RE, ''),
        at: m.createdAt,
      }));
  }

  /**
   * The conversation the browser is currently in, or null for an unsent new chat.
   *
   * Copilot navigates to /chat/conversation/<id> once a thread exists, so the URL
   * is the cheapest source. The Chathub socket URL carries ConversationId too and
   * is used as a fallback, since navigation can lag a turn.
   */
  currentConversationId() {
    try {
      const fromUrl = /\/chat\/conversation\/([0-9a-f-]{16,})/i.exec(this.page.url());
      if (fromUrl) return fromUrl[1];
    } catch { /* page may be gone */ }
    const fromSocket = this.socketUrl
      && /[?&]ConversationId=([0-9a-f-]{16,})/i.exec(this.socketUrl);
    return fromSocket ? fromSocket[1] : null;
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
    // A captured request from the real client shows five fields, not one:
    //   {action, syncState, enableLastMessage, conversationHistoryFilter, state}
    //
    // Sending only `action` returns nothing. Mirroring the other fields does not
    // help either -- all three shapes below were tried against a live session and
    // every one came back empty, so `syncState` (a sync cursor we have no
    // legitimate copy of) appears to be required. Recorded as a negative result
    // rather than deleted: the next person should not have to re-run it.
    //
    // Consequence: this falls through to the DOM, which yields only name and id.
    // No tone, no preview, no timestamp, and only the conversations the sidebar
    // has actually rendered -- so the count varies between 18 and 36 depending on
    // how much has lazy-loaded. Worth fixing properly by capturing a real
    // syncState, but not by pretending this works.
    const viaAction = await this.page.evaluate(async () => {
      const attempts = [
        {
          action: 'GetConversationPageHistoryList',
          enableLastMessage: true,
          conversationHistoryFilter: null,
          state: { conversationPageHistoryList: {} },
        },
        {
          action: 'GetConversationPageHistoryList',
          enableLastMessage: true,
          conversationHistoryFilter: null,
        },
        { action: 'GetConversationPageHistoryList' },
      ];
      for (const body of attempts) {
        try {
          const r = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!r.ok) continue;
          const j = await r.json();
          const chats = j && j.store && j.store.conversationPageHistoryList
            && j.store.conversationPageHistoryList.chats;
          if (Array.isArray(chats) && chats.length) return chats;
        } catch { /* try the next shape */ }
      }
      return null;
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
   * Navigating restores it server-side, and the page's own picker comes back on
   * the thread's stored tone. A prompt with no model then leaves the override
   * off, so the thread keeps that tone; see prompt().
   */
  async openConversation(id, { tone = null } = {}) {
    let release;
    const mine = new Promise((r) => { release = r; });
    const previous = this._busy;
    this._busy = this._busy.then(() => mine);
    await previous;
    try {
      return await this._openConversation(id, { tone });
    } finally {
      release();
    }
  }

  /** As openConversation, but assumes the caller already holds the turn lock. */
  async _openConversation(id, { tone = null } = {}) {
    if (!/^[0-9a-f-]{16,}$/i.test(String(id))) throw new Error('implausible conversation id');
    await this.page.goto(`https://m365.cloud.microsoft/chat/conversation/${id}`,
      { waitUntil: 'domcontentloaded' });
    const composer = await this._waitComposer(120);
    if (!composer) throw new Error(await this._composerLostReason());
    await this.page.waitForTimeout(1500);
    // The listing's tone if it had one (the DOM fallback never does). Otherwise
    // unknown until the next send, when the userscript reports what went out.
    // Reading the picker button's label used to fill this in; labels change,
    // and that is the fragility this refactor removed.
    this.currentTone = tone && TONES[tone] ? tone : null;
    this._conversationPinned = true;
    // The transcript is in the page already; handing it back means the caller can
    // show the thread instead of an empty pane that looks like a loss.
    const messages = await this.readTranscript();
    return { id, tone: this.currentTone, pinned: true, messages: messages || [] };
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
      // Note where we were before throwing the browser away, so the toggle stops
      // costing you the thread. A new browser genuinely is a new conversation --
      // but an existing conversation can be reopened, so it need not stay lost.
      const wasIn = this.currentConversationId();

      try { await this.context.close(); } catch { /* already gone */ }
      this.ready = false;
      this.socketUrl = null;
      this.currentTone = BROWSER_DEFAULT_TONE;
      this._conversationPinned = false;
      this.headless = !visible;
      this.context = await this._launch();
      await this._afterLaunch(visible ? 12 * 60 * 1000 : 60 * 1000, null);

      let restored = null;
      if (wasIn) {
        try {
          // _openConversation, not openConversation: we already hold the lock.
          restored = (await this._openConversation(wasIn)).id;
        } catch {
          restored = null;   // gone or inaccessible; a fresh chat is the fallback
        }
      }
      return { changed: true, headless: this.headless, restored };
    } finally {
      release();
    }
  }

  async _afterLaunch(signInTimeoutMs, onWait) {
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this._attach(this.page);
    this.context.on('page', (p) => this._attach(p));

    // The userscript must be in place before Copilot's own code runs, because
    // it patches WebSocket.prototype.send. addInitScript runs on every
    // navigation in this context, ahead of page scripts.
    if (!USERSCRIPT_PATH) {
      throw new Error(
        'userscript/model-picker.user.js not found next to the app or in resources/. '
        + 'Model selection depends on it; a build without it cannot pick a model.',
      );
    }
    console.log(`[driver] injecting ${USERSCRIPT_PATH} so tone can be set on the wire`);
    await this.context.addInitScript({ path: USERSCRIPT_PATH });

    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
    const composer = await this._waitComposer(Math.ceil(signInTimeoutMs / 500), onWait);
    if (!composer) {
      throw new Error(
        `No composer after ${Math.round(signInTimeoutMs / 1000)}s. If a sign-in page ` +
        'is showing, finish it and start again -- the profile keeps the session.',
      );
    }
    await this.page.waitForTimeout(2000);

    // Fail here, at startup, rather than on the first prompt.
    const hookVersion = await this.page.evaluate(
      () => (window.__mpo ? window.__mpo.version : null),
    );
    if (!hookVersion) {
      throw new Error(
        'userscript loaded but window.__mpo is missing in the page. '
        + 'Either the init script did not run, or the file predates the hook.',
      );
    }
    console.log(`[driver] userscript hook present, v${hookVersion}`);

    this._tmpdir = this._tmpdir || await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-wire-'));
    this.ready = true;
    return this;
  }

  /**
   * Launch a browser, preferring one the machine already has.
   *
   * Playwright's own Chromium lives in %LOCALAPPDATA%\ms-playwright and only
   * exists after `npx playwright install`. Driving installed Chrome or Edge
   * instead skips a 150MB download, and Edge is always present on Windows.
   * Falls back to the bundled Chromium if neither launches.
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

  /**
   * Newest GPT in TONES. No longer per-account: nothing discovers what an
   * account offers now, so a personal account (which showed only the three
   * generic modes) will be asked for a GPT tone too. What the server does with
   * a tone the account does not have is untested; a rejection surfaces as a
   * driver error, a silent downgrade would not be visible.
   */
  get defaultTone() {
    return highestGptTone(TONES);
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
  /**
   * Is Copilot asking whether you are a human?
   *
   * Detected via the FRAME TREE, not the DOM. Turnstile renders its iframe into
   * a shadow root, so `document.querySelectorAll('iframe')` finds nothing while
   * the challenge fills the screen; `page.frames()` shows it plainly. The
   * wrapper dialog is Microsoft's own Fluent component and its aria-label is
   * localised ("Sikkerhetskontroll kreves" on a Norwegian tenant), so it is a
   * fallback signal at best and never the test.
   *
   * This matters because the challenge swallows the send completely: the
   * Chathub socket opens, handshakes, pings, and carries no invocation at all.
   * Without this check that surfaces as `no completion frame before timeout`
   * five minutes later, which reads like a broken driver and is not one.
   */
  /**
   * Why is there no composer? "composer lost after reload" names the symptom
   * and nothing else, which leaves you guessing between an expired session, a
   * verification box, a dialog, and a genuinely slow page -- four problems with
   * four different fixes. Ask the page before reporting.
   */
  async _composerLostReason() {
    let url = '';
    let title = '';
    try { url = this.page.url() || ''; } catch { /* page may be gone */ }
    try { title = await this.page.title(); } catch { /* ditto */ }

    if (/login\.(microsoftonline|live)\.com|\/oauth2\/|[?&]sso_reload=/i.test(url)) {
      let host = url;
      try { host = new URL(url).host; } catch { /* keep the raw string */ }
      return `the Copilot session has expired — the page is now ${host}. `
           + 'Sign in again with: npm run signin';
    }
    if (this._challengeVisible()) {
      return 'a human-verification box is covering the page, so the composer '
           + 'never appeared and the prompt was never sent';
    }
    try {
      const d = this.page.locator('[role="dialog"],[aria-modal="true"]').first();
      if ((await d.count()) && (await d.isVisible())) {
        const label = (await d.getAttribute('aria-label'))
          || (await d.innerText().catch(() => '')) || '';
        if (label) return `a dialog is covering the page: ${String(label).slice(0, 80)}`;
      }
    } catch { /* no dialog is the common case */ }

    return `composer lost after reload (url=${url || 'unknown'}, `
         + `title=${title || 'unknown'})`;
  }

  _challengeVisible() {
    try {
      return this.page.frames().some(
        (f) => ((f.url && f.url()) || '').includes(CHALLENGE_FRAME_MARKER));
    } catch {
      return false;
    }
  }

  async *prompt(text, { tone = null, images = [], timeoutMs = 300_000 } = {}) {
    // Which tone goes into the frame.
    //
    // An explicit model is sent as asked, in the current thread. Changing tone no
    // longer starts a new chat: the server stores the latest tone per message
    // [OBSERVED 2026-11-04, a Magic thread reopened as GPT 5.6 Sol Think after
    // one rewritten message], so there is nothing to reload for.
    //
    // No model on a reopened thread means "keep what this thread is on": the
    // tone of our last send if we know it, otherwise "" which switches the
    // override off and lets the page's own picker, restored to the thread's
    // tone on load, decide. No model on a fresh chat means our default.
    let toneToSend;
    if (tone) {
      toneToSend = tone;
    } else if (this._conversationPinned) {
      toneToSend = this.currentTone || '';
    } else {
      toneToSend = this.defaultTone;
    }
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

      // Set the override every turn, not only on change: a full navigation
      // re-runs the userscript, which then starts from whatever localStorage
      // holds, and that may be what a human last picked in the box.
      console.log(`[driver] setting userscript tone to ${toneToSend || '(off)'} for this send`);
      const sendsBefore = await this.page.evaluate((t) => {
        if (!window.__mpo) {
          throw new Error('userscript hook window.__mpo missing; was it injected?');
        }
        window.__mpo.setTone(t);
        return window.__mpo.sendCount;
      }, toneToSend);

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

      // Confirm the frame went out through the userscript with our tone. Without
      // this, a page that changed its transport would answer as Auto and look
      // like success. The Chathub socket opens lazily on the first send, so the
      // first turn needs a few seconds.
      console.log('[driver] waiting for the userscript to report the chat frame, expecting it within 15s');
      let sent = null;
      for (let i = 0; i < 60; i++) {
        sent = await this.page.evaluate(
          (n) => (window.__mpo && window.__mpo.sendCount > n ? window.__mpo.lastSend : null),
          sendsBefore,
        );
        if (sent) break;
        await this.page.waitForTimeout(250);
      }
      if (!sent) {
        // A Turnstile box swallows the send before any frame exists, so it
        // lands here, not in the challenge handling further down. Name it.
        if (this._challengeVisible()) {
          throw new Error(this.headless
            ? 'Copilot wants human verification, and the browser is hidden, so the '
              + 'prompt was never sent. Show the browser and answer the box.'
            : 'Copilot wants human verification; answer the box in the browser. '
              + 'The prompt was never sent.');
        }
        throw new Error(
          'userscript saw no chat frame within 15s of Enter. Either the prompt was '
          + 'not sent, or Copilot no longer sends chat over the Chathub WebSocket.',
        );
      }
      if (toneToSend && sent.sent !== toneToSend) {
        throw new Error(`userscript sent tone ${sent.sent}, expected ${toneToSend}`);
      }
      console.log(`[driver] tone on the wire: ${sent.before} -> ${sent.sent}`);
      this.currentTone = sent.sent;

      const deadline = Date.now() + timeoutMs;
      const emitted = new Map();
      const seenProgress = new Set();
      let gotAnswer = false;
      let challenged = false;
      let nextChallengeCheck = 0;

      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) {
          // Name the real cause. Waiting five minutes and then blaming the
          // completion frame sent a previous investigation looking for a broken
          // observer when a verification box had simply eaten the send.
          throw new Error(challenged || this._challengeVisible()
            ? 'human verification was never completed, so the prompt was never sent'
            : 'no completion frame before timeout');
        }

        // Cheap poll rather than per-iteration: the check walks the frame tree.
        if (!gotAnswer && Date.now() >= nextChallengeCheck) {
          nextChallengeCheck = Date.now() + 3000;
          if (this._challengeVisible()) {
            if (!challenged) {
              challenged = true;
              // A hidden browser makes this unanswerable rather than merely
              // slow: the box needs a click, and there is no window to click
              // in. Say that, instead of asking for an impossible action.
              yield { kind: 'reasoning', value: this.headless
                ? '[Copilot wants you to confirm you are a human, but the Copilot '
                  + 'browser is hidden, so there is nothing to click. Show it with '
                  + 'the eye icon and ask again — showing it starts a new '
                  + 'conversation.]\n'
                : '[Copilot is asking you to confirm you are a human — tick the box '
                  + 'in the Copilot browser window]\n' };
            }
          } else if (challenged) {
            challenged = false;
            yield { kind: 'reasoning', value: '[verification cleared]\n' };
          }
        }

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
