// ==UserScript==
// @name         i want my model picker back (overlay)
// @namespace    https://github.com/aweussom/i-want-my-model-picker-back
// @version      20261104-151151
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
// Default mode is "best": the highest Gpt_<major>_<minor>_Reasoning known. No
// dropdown; a small badge shows what is being forced. If Microsoft's own picker
// ever sends a higher Gpt_*_Reasoning (you picked a new model in their menu),
// that value is adopted as the new best and remembered.
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
  const VERSION = "20261104-151151";
  const TAG = "[model-picker-overlay]";
  // New key on purpose: the earlier dropdown version stored explicit picks
  // under "mpo.tone", and an old pick must not pin a browser below "best".
  const MODE_KEY = "mpo.mode";
  const LEARNED_KEY = "mpo.learnedBest";
  const RECORD_SEPARATOR = "\x1e"; // SignalR JSON protocol record terminator
  const OFF = ""; // do not touch the frame, Microsoft's picker decides
  const BEST = "best"; // resolve to bestTone() at send time

  // Reasoning tones seen on the wire. Gpt_5_6_Reasoning is shown as
  // "GPT-5.6 Sol Think deeper" [OBSERVED 2026-11-04].
  const KNOWN_REASONING_TONES = ["Gpt_5_6_Reasoning"];
  // Used only if no Gpt_*_Reasoning is known at all.
  const FALLBACK_TONE = "Reasoning";

  // --- best-tone logic -------------------------------------------------------

  // "Gpt_5_6_Reasoning" -> 5006; anything else -> null. Major dominates minor.
  function reasoningRank(tone) {
    const m = /^Gpt_(\d+)_(\d+)_Reasoning$/.exec(String(tone));
    if (!m) {
      return null;
    }
    return Number(m[1]) * 1000 + Number(m[2]);
  }

  let learnedBest = null;
  try {
    learnedBest = localStorage.getItem(LEARNED_KEY);
  } catch (err) {
    console.warn(TAG, "localStorage unreadable, no learned best tone:", err);
  }

  function bestTone() {
    const candidates = KNOWN_REASONING_TONES.slice();
    if (learnedBest && reasoningRank(learnedBest) !== null) {
      candidates.push(learnedBest);
    }
    let best = null;
    let bestRank = -1;
    for (const tone of candidates) {
      const rank = reasoningRank(tone);
      if (rank !== null && rank > bestRank) {
        best = tone;
        bestRank = rank;
      }
    }
    return best || FALLBACK_TONE;
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
  console.info(TAG, `loaded v${VERSION}; mode = ${mode || "(off)"}; best = ${bestTone()}`);

  let badge = null; // DOM node, set once mounted
  let sendCount = 0; // chat invocations seen on the wire, rewritten or not
  let lastSend = null; // {before, sent, at} for the most recent one

  // What tone the next frame will carry, or "" for leave it alone.
  function effectiveTone() {
    if (mode === BEST) {
      return bestTone();
    }
    return mode;
  }

  function describeMode() {
    if (mode === OFF) {
      return "off: Microsoft's picker decides";
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
    if (badge) {
      badge.textContent = describeMode();
    }
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

      // Learn: Microsoft's picker offering something newer than our best means
      // a new model shipped. Adopt it so "best" moves up without an edit.
      const beforeRank = reasoningRank(before);
      const bestRank = reasoningRank(bestTone());
      if (beforeRank !== null && (bestRank === null || beforeRank > bestRank)) {
        console.info(TAG, `picker sent ${before}, newer than best ${bestTone()}; adopting it`);
        learnedBest = before;
        try {
          localStorage.setItem(LEARNED_KEY, before);
        } catch (err) {
          console.warn(TAG, "could not persist learned best; applies to this tab only:", err);
        }
      }

      const target = effectiveTone();
      sendCount += 1;
      lastSend = { before, sent: target || before, at: Date.now() };

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
      if (badge) {
        badge.textContent = `${describeMode()}; last: ${before} → ${target}`;
      }
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
    badge.textContent = describeMode();
    document.body.appendChild(badge);
    console.info(TAG, "badge mounted");
    return true;
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
