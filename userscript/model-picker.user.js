// ==UserScript==
// @name         i want my model picker back (overlay)
// @namespace    https://github.com/aweussom/i-want-my-model-picker-back
// @version      20261125-225004
// @description  Forces the best GPT reasoning model on every M365 Copilot chat message, whatever Microsoft's picker says. No interaction needed.
// @match        https://m365.cloud.microsoft/*
// @match        https://copilot.cloud.microsoft/*
// @updateURL    https://raw.githubusercontent.com/aweussom/i-want-my-model-picker-back/main/userscript/model-picker.user.js
// @downloadURL  https://raw.githubusercontent.com/aweussom/i-want-my-model-picker-back/main/userscript/model-picker.user.js
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// ==/UserScript==

// How it works, for the 3AM reader:
//
// Copilot sends each prompt as a SignalR "type 4" invocation, target "chat", over
// a WebSocket to substrate.office.com/m365Copilot/Chathub. The model choice is a
// single top-level field, arguments[0].tone (see README "The finding"). This
// script wraps WebSocket.prototype.send, finds that record, swaps tone, and lets
// everything else through byte-for-byte.
//
// Default mode is "best": the bottom entry of the OpenAI group in Copilot's
// own model menu, read from the page. No dropdown; a small badge shows what is
// being forced, and turns red when the menu could not be read.
//
// Patching the prototype rather than the constructor is deliberate: it catches
// sockets created by code that grabbed a reference to WebSocket before we ran.
//
// It must run in the page's own JS world (@grant none, @sandbox raw,
// @inject-into page). In an isolated userscript world the patch would land on a
// different WebSocket and silently do nothing.
//
// The API driver (electron/src/driver.js) injects this same file and sets an
// explicit tone per request through window.__mpo.

(() => {
  "use strict";

  // Keep in step with @version above; both are stamped by the same edit.
  const VERSION = "20261125-225004";
  const TAG = "[model-picker-overlay]";
  // New key on purpose: the earlier dropdown version stored explicit picks
  // under "mpo.tone", and an old pick must not pin a browser below "best".
  const MODE_KEY = "mpo.mode";
  // Last menu read from the page, so the first send after a reload does not
  // depend on the fetch having finished.
  const MENU_KEY = "mpo.menu";
  // Versions before the menu read learned a "best" from tone names. Removed on
  // load so a stale value cannot look like it still matters.
  const OLD_LEARNED_KEY = "mpo.learnedBest";
  const RECORD_SEPARATOR = "\x1e"; // SignalR JSON protocol record terminator
  const OFF = ""; // do not touch the frame, Microsoft's picker decides
  const BEST = "best"; // resolve to bestTone() at send time

  // --- best-tone logic -------------------------------------------------------
  //
  // "best" is the bottom entry of the OpenAI group in Copilot's own model menu.
  // Microsoft has kept the most expensive model last through GPT-5.6, 6, 6.1
  // and 6.2 [OBSERVED up to 2026-11-25], while the value naming changed shape
  // three times: Gpt_5_6_Reasoning, Gpt_6_Sol_Chat, Gpt_62_Sol_Reasoning. So
  // position is trusted and names are not parsed at all.
  //
  // The menu is clientPreferences.modelSelectorMetadata, rendered by the server
  // into the HTML. The hydration scripts that carry it delete themselves after
  // running, so it is not in the live DOM; the script fetches its own page once
  // and reads it from the raw HTML. That HTML holds one copy per agent (Cowork,
  // Researcher, Planner, ...), with different entries; the chat's own copy is
  // the first one after "bizchat-as-gpt-scenario" [OBSERVED 2026-11-25].

  const CHAT_AGENT_MARKER = "bizchat-as-gpt-scenario";
  const METADATA_KEY = "modelSelectorMetadata";
  const MENU_GROUP = "OpenAI";

  // The JSON object after METADATA_KEY sits inside a JS string inside a
  // script, so it arrives escaped one or more levels. Unescape until it parses.
  function parseMetadataAt(html, keyAt) {
    const open = html.indexOf("{", keyAt);
    if (open < 0) {
      throw new Error(`no "{" after ${METADATA_KEY}`);
    }
    let depth = 0;
    let close = -1;
    for (let k = open; k < html.length; k++) {
      const c = html[k];
      if (c === "{") {
        depth += 1;
      }
      if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close < 0) {
      throw new Error(`unbalanced braces after ${METADATA_KEY}`);
    }
    let candidate = html.slice(open, close + 1);
    for (let level = 0; level < 4; level++) {
      try {
        return JSON.parse(candidate);
      } catch (_) {
        // Not JSON at this escaping level. Unescape one level and retry; that
        // JSON.parse throws, loud, if it is not an escaped string either.
      }
      candidate = JSON.parse(`"${candidate}"`);
    }
    throw new Error(`${METADATA_KEY} still not JSON after 4 unescapes`);
  }

  // Flat list of menu entries: {id, title, group, section, gated}. id is the
  // wire tone value. gated means the entry carries a tenant policy check, which
  // this script cannot evaluate (both Claude entries were gated, and disabled,
  // on the work tenant on 2026-11-25).
  function flattenMenu(meta) {
    const options = meta.availableModelSelectionOptions;
    if (!Array.isArray(options)) {
      throw new Error("availableModelSelectionOptions missing or not a list");
    }
    const items = [];
    for (const opt of options) {
      if (Array.isArray(opt.itemGroup)) {
        for (const child of opt.itemGroup) {
          items.push({
            id: child.id, title: child.menuItemTitle, group: opt.id,
            section: child.sectionNumber, gated: Boolean(child.policyExpression),
          });
        }
        continue;
      }
      items.push({
        id: opt.id, title: opt.menuItemTitle, group: null,
        section: opt.sectionNumber, gated: Boolean(opt.policyExpression),
      });
    }
    return items;
  }

  function menuFromHtml(html) {
    const agentAt = html.indexOf(CHAT_AGENT_MARKER);
    if (agentAt < 0) {
      throw new Error(`"${CHAT_AGENT_MARKER}" not in the page; Copilot renamed its chat agent?`);
    }
    const keyAt = html.indexOf(METADATA_KEY, agentAt);
    if (keyAt < 0) {
      throw new Error(`no ${METADATA_KEY} after "${CHAT_AGENT_MARKER}"`);
    }
    return flattenMenu(parseMetadataAt(html, keyAt));
  }

  let menu = null; // flat menu items, or null until read
  let menuFrom = "nowhere"; // "cache <iso>" or "page <iso>", for logs and __mpo
  try {
    const cached = JSON.parse(localStorage.getItem(MENU_KEY) || "null");
    if (cached && Array.isArray(cached.items)) {
      menu = cached.items;
      menuFrom = `cache ${cached.at}`;
    }
    localStorage.removeItem(OLD_LEARNED_KEY);
  } catch (err) {
    console.warn(TAG, "localStorage unreadable or cached menu corrupt; no cached menu:", err);
  }

  // Bottom entry of the OpenAI group, or null when there is no menu or no group.
  function bestTone() {
    if (!menu) {
      return null;
    }
    let bottom = null;
    for (const item of menu) {
      if (item.group === MENU_GROUP) {
        bottom = item;
      }
    }
    return bottom ? bottom.id : null;
  }

  // --- state ---------------------------------------------------------------

  let mode = BEST;
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored !== null) {
      mode = stored;
    }
  } catch (err) {
    console.warn(TAG, "localStorage unreadable, starting in best mode:", err);
  }
  console.info(TAG, `loaded v${VERSION}; mode = ${mode || "(off)"}; best = ${bestTone() || "UNKNOWN"} (menu from ${menuFrom})`);

  let badge = null; // DOM node, set once mounted
  let sendCount = 0; // chat invocations seen on the wire, rewritten or not
  let lastSend = null; // {before, sent, at} for the most recent one

  // What tone the next frame will carry, or "" for leave it alone.
  // In best mode without a menu this is OFF: forcing a guessed tone is worse
  // than forcing nothing. The send path and the red badge say so.
  function effectiveTone() {
    if (mode === BEST) {
      return bestTone() || OFF;
    }
    return mode;
  }

  function describeMode() {
    if (mode === OFF) {
      return "off: Microsoft's picker decides";
    }
    if (mode === BEST && !bestTone()) {
      return "best: NO MENU DATA, not rewriting";
    }
    if (mode === BEST) {
      return `forcing ${bestTone()} (best)`;
    }
    return `forcing ${mode}`;
  }

  function setMode(value) {
    mode = value;
    try {
      localStorage.setItem(MODE_KEY, value);
    } catch (err) {
      console.warn(TAG, "could not persist mode; applies to this tab only:", err);
    }
    console.info(TAG, `mode set to ${value || "(off)"}; ${describeMode()}`);
    renderBadge();
  }

  // Badge text is describeMode() plus an optional note; red while best mode has
  // no menu, because then nothing is being forced.
  function renderBadge(note) {
    if (!badge) {
      return;
    }
    badge.textContent = note ? `${describeMode()}; ${note}` : describeMode();
    const alarm = mode === BEST && !bestTone();
    badge.style.background = alarm ? "rgba(170,20,20,0.92)" : "rgba(20,20,24,0.75)";
  }

  // Fetch our own page and read the menu out of the raw HTML. Runs once per page
  // load. On failure the previous menu (cached or none) stays, and it says so.
  async function loadMenu() {
    const where = location.pathname;
    console.info(TAG, `reading the model menu: fetching ${where} for its server-rendered ${METADATA_KEY}, expecting a "${MENU_GROUP}" group`);
    let html;
    try {
      const res = await fetch(where, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      html = await res.text();
    } catch (err) {
      console.error(TAG, `menu fetch failed: ${err.message}; best stays ${bestTone() || "UNKNOWN"} (menu from ${menuFrom})`);
      renderBadge();
      return;
    }
    let items;
    try {
      items = menuFromHtml(html);
    } catch (err) {
      console.error(TAG, `menu not readable from ${html.length} chars of HTML: ${err.message}; best stays ${bestTone() || "UNKNOWN"} (menu from ${menuFrom})`);
      renderBadge();
      return;
    }
    const previous = bestTone();
    const at = new Date().toISOString();
    menu = items;
    menuFrom = `page ${at}`;
    try {
      localStorage.setItem(MENU_KEY, JSON.stringify({ at, items }));
    } catch (err) {
      console.warn(TAG, "could not cache the menu; the next reload starts without one:", err);
    }
    const best = bestTone();
    const change = previous && previous !== best ? ` (was ${previous})` : "";
    console.info(TAG, `menu: ${items.map((i) => i.id + (i.gated ? "[gated]" : "")).join(", ")}; best = ${best || `NONE, no "${MENU_GROUP}" group`}${change}`);
    renderBadge();
  }

  // Hook for the API driver and for the console. setTone("best"), setTone("")
  // for off, or an explicit wire value such as setTone("Gpt_5_6_Chat").
  // sendCount/lastSend let the driver confirm the rewrite really happened.
  window.__mpo = {
    version: VERSION,
    setTone(value) {
      const v = String(value == null ? "" : value).trim();
      if (!/^[A-Za-z0-9_]*$/.test(v)) {
        throw new Error(`${TAG} invalid tone ${JSON.stringify(value)}, expected "best", "" for off, or letters/digits/underscore`);
      }
      setMode(v);
    },
    getTone() {
      return mode;
    },
    get bestTone() {
      return bestTone();
    },
    // Flat copy of the chat's model menu, or null. The API driver reads this
    // for its default tone and for /v1/models.
    get menu() {
      return menu ? menu.map((item) => ({ ...item })) : null;
    },
    get menuFrom() {
      return menuFrom;
    },
    reloadMenu() {
      return loadMenu();
    },
    get sendCount() {
      return sendCount;
    },
    get lastSend() {
      return lastSend;
    },
  };

  // --- the actual override -------------------------------------------------

  const origSend = WebSocket.prototype.send;

  WebSocket.prototype.send = function (data) {
    const url = String(this.url || "").toLowerCase();
    if (!url.includes("chathub")) {
      return origSend.call(this, data);
    }
    if (typeof data !== "string") {
      // MessagePack framing would land here. Not seen so far; say so loudly
      // instead of pretending the override applied.
      console.warn(TAG, "chathub sent a binary frame; override NOT applied. Protocol changed?");
      return origSend.call(this, data);
    }

    const records = data.split(RECORD_SEPARATOR);
    let changed = false;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record.includes('"target":"chat"')) {
        continue; // handshake, pings, other targets
      }

      let msg;
      try {
        msg = JSON.parse(record);
      } catch (err) {
        console.warn(TAG, "chat record did not parse; sent unmodified:", err);
        continue;
      }

      if (msg.type !== 4 || msg.target !== "chat") {
        continue;
      }
      const arg0 = Array.isArray(msg.arguments) ? msg.arguments[0] : null;
      if (!arg0 || typeof arg0 !== "object") {
        console.warn(TAG, "chat invocation has no arguments[0]; sent unmodified. Protocol changed?");
        continue;
      }
      if (!("tone" in arg0)) {
        console.warn(TAG, "chat invocation has no tone field; sent unmodified. Protocol changed?");
        continue;
      }

      const before = arg0.tone;


      const target = effectiveTone();
      sendCount += 1;
      lastSend = { before, sent: target || before, at: Date.now() };

      if (!target && mode === BEST) {
        console.error(TAG, `best mode but no menu data (menu from ${menuFrom}); frame sent UNMODIFIED with tone = ${before}`);
        renderBadge(`picker sent ${before}`);
        continue;
      }
      if (!target) {
        console.info(TAG, `override off; Microsoft's picker sent tone = ${before}`);
        if (badge) {
          badge.textContent = `off; picker sent ${before}`;
        }
        continue;
      }
      console.info(TAG, `rewriting tone: ${before} -> ${target}`);
      arg0.tone = target;
      records[i] = JSON.stringify(msg);
      changed = true;
      renderBadge(`last: ${before} → ${target}`);
    }

    if (!changed) {
      // Includes the override-off case: still counted above, frame untouched.
      return origSend.call(this, data);
    }
    return origSend.call(this, records.join(RECORD_SEPARATOR));
  };

  // --- badge ---------------------------------------------------------------
  // Read-only, and click-through (pointer-events: none) so it can never sit on
  // top of something you need. createElement + textContent only: the page may
  // enforce Trusted Types, and innerHTML would throw there.

  function mountBadge() {
    if (!document.body) {
      return false;
    }
    badge = document.createElement("div");
    badge.id = "mpo-badge";
    badge.title = `model-picker-overlay v${VERSION}`;
    Object.assign(badge.style, {
      position: "fixed",
      right: "8px",
      bottom: "8px",
      zIndex: "2147483647",
      background: "rgba(20,20,24,0.75)",
      color: "#ddd",
      font: "11px/1.3 system-ui, sans-serif",
      padding: "3px 7px",
      borderRadius: "5px",
      pointerEvents: "none",
    });
    document.body.appendChild(badge);
    renderBadge();
    console.info(TAG, "badge mounted");
    return true;
  }

  if (location.pathname.startsWith("/chat")) {
    loadMenu();
  } else {
    console.info(TAG, `not a chat page (${location.pathname}); menu not read`);
  }

  // document-start means no body yet. Poll until there is one; the SPA may also
  // replace body contents, so re-mount if the badge disappears.
  setInterval(() => {
    if (document.getElementById("mpo-badge")) {
      return;
    }
    mountBadge();
  }, 1000);
})();
