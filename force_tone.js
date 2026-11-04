// Injected before any page script runs, alongside tap.js. Rewrites the `tone`
// field on the chat invocation as it leaves the socket, so a model can be
// requested WITHOUT the picker ever being touched.
//
// Why this exists: the web client no longer renders the named-model section of
// the picker. driver.py and run_probe.py both select a model by clicking that
// menu, so on web they now have nothing to click. That makes them unable to
// answer the only question that still matters -- does the *server* still honour
// `tone: "Gpt_5_6_Reasoning"` when the *client* no longer offers it? The picker
// is the client's opinion. This bypasses the opinion and asks the server.
//
// Everything else in the frame is left exactly as the real client built it:
// auth, conversationId, the 34 optionsSets, the 31 allowedMessageTypes, the
// whole message object. One field changes. That is the same experiment as the
// original finding, run from the other end.
//
// Every rewrite is reported through __wireTap. That is not decoration: a silent
// override failure looks exactly like "the server accepted the tone", which is
// this repo's signature failure mode. probe_tone.py refuses to report a verdict
// unless it sees the confirmation record.

(() => {
  const FORCE = window.__forceTone;          // set by a prior init script
  if (!FORCE) return;

  const RS = "\x1e";                         // SignalR record separator

  const tap = (payload) => {
    try {
      if (window.__wireTap) window.__wireTap(JSON.stringify(payload));
    } catch (_) { /* never let instrumentation break the page */ }
  };

  // A chat invocation, as opposed to a handshake, a ping, or a completion.
  // SignalR numbers Invocation 1 and StreamInvocation 4; the README saw 4, but
  // accepting both costs nothing and survives a protocol tweak.
  const isChatInvocation = (obj) =>
    obj && (obj.type === 4 || obj.type === 1) &&
    obj.target === "chat" &&
    Array.isArray(obj.arguments) &&
    obj.arguments[0] && typeof obj.arguments[0] === "object";

  const rewrite = (text, url) => {
    if (typeof text !== "string" || text.indexOf('"chat"') === -1) return text;

    // A frame can carry several records. Split on the separator and rejoin, so
    // the trailing terminator survives untouched.
    const parts = text.split(RS);
    let touched = false;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      let obj;
      try {
        obj = JSON.parse(part);
      } catch (_) {
        // An unparseable record that nonetheless mentions tone is worth knowing
        // about: it could be the invocation in a framing we do not handle.
        if (part.indexOf('"tone"') !== -1) {
          tap({ phase: "tone-force-failed", url, reason: "record did not parse",
                sample: part.slice(0, 300) });
        }
        continue;
      }
      if (!isChatInvocation(obj)) continue;

      const from = obj.arguments[0].tone;
      if (from === FORCE) {
        tap({ phase: "tone-forced", url, from, to: FORCE, noop: true });
        touched = true;
        continue;
      }
      obj.arguments[0].tone = FORCE;
      parts[i] = JSON.stringify(obj);
      touched = true;
      tap({ phase: "tone-forced", url, from: from === undefined ? null : from,
            to: FORCE, noop: false });
    }

    return touched ? parts.join(RS) : text;
  };

  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    // `url` is a prototype getter that throws on anything that is not a real
    // WebSocket. Read it once, defensively, and reuse it -- an earlier version
    // read it inside the catch handler too, so a throw from the getter escaped
    // the catch and took the page's send() down with it. Instrumentation that
    // can break the page is worse than no instrumentation.
    let url = "";
    try { url = this.url || ""; } catch (_) {}

    try {
      if (typeof data === "string") {
        data = rewrite(data, url);
      } else if (data && (data instanceof ArrayBuffer || ArrayBuffer.isView(data) ||
                          (typeof Blob !== "undefined" && data instanceof Blob))) {
        // Binary framing would mean the JSON hub protocol was swapped for
        // MessagePack. We cannot rewrite it, and pretending otherwise would
        // produce a confident wrong answer. Say so loudly instead.
        tap({ phase: "tone-force-failed", url,
              reason: "binary frame; hub protocol is not JSON" });
      }
    } catch (err) {
      tap({ phase: "tone-force-failed", url, reason: String(err) });
    }
    return origSend.call(this, data);
  };
})();
