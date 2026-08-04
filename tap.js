// Injected before any page script runs. Wraps the three ways this app could
// send a prompt and receive a streamed reply, and forwards what it sees to
// Python via the __wireTap binding.
//
// Why this exists: CDP's Network.eventSourceMessageReceived only fires for the
// real EventSource API. A modern app streaming `text/event-stream` through
// fetch() + ReadableStream is completely invisible to it, and that is the most
// likely shape here. Wrapping fetch is the only reliable way to see those chunks.
//
// Non-invasive by construction: we read response.clone(), never the original
// body, so the application consumes its own stream untouched.

(() => {
  const tap = (payload) => {
    try {
      if (window.__wireTap) window.__wireTap(JSON.stringify(payload));
    } catch (_) { /* never let instrumentation break the page */ }
  };

  const BORING = /\/events|client_health_ping|aria|telemetry|\.js$|\.css$|\.png$|\.svg$|\.woff2?$/i;

  // --- fetch ---------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    let url = "";
    let method = "GET";
    let body = null;
    try {
      const req = args[0];
      const init = args[1] || {};
      // args[0] may be a string, a URL, or a Request. Relative URLs must be
      // resolved or the record is useless for identifying an endpoint.
      if (typeof req === "string") {
        url = req;
      } else if (req instanceof URL) {
        url = req.href;
      } else if (req && typeof req.url === "string") {
        url = req.url;
      }
      try { url = new URL(url, location.href).href; } catch (_) {}

      method = (init.method || (req && req.method) || "GET").toUpperCase();

      if (typeof init.body === "string") {
        body = init.body;
      } else if (req && typeof req.clone === "function" && method !== "GET") {
        // A Request carries its body on the object, not in init.
        try { body = await req.clone().text(); } catch (_) {}
      }
    } catch (_) {}

    const boring = BORING.test(url);
    if (!boring && method !== "GET") {
      tap({ phase: "fetch-request", url, method, body });
    }

    const response = await origFetch.apply(this, args);

    try {
      const ctype = response.headers.get("content-type") || "";
      const streamy = /event-stream|ndjson|json-seq|octet-stream/i.test(ctype);
      if (!boring && (streamy || method !== "GET") && response.body) {
        // Read a clone so the app's own consumption is unaffected.
        const reader = response.clone().body.getReader();
        const decoder = new TextDecoder();
        let index = 0;
        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              if (chunk) tap({ phase: "stream-chunk", url, ctype, index: index++, chunk });
            }
            tap({ phase: "stream-end", url, chunks: index });
          } catch (err) {
            tap({ phase: "stream-error", url, error: String(err) });
          }
        })();
      }
    } catch (_) {}

    return response;
  };

  // --- EventSource ---------------------------------------------------------
  const OrigES = window.EventSource;
  if (OrigES) {
    window.EventSource = function (url, config) {
      const es = new OrigES(url, config);
      es.addEventListener("message", (e) =>
        tap({ phase: "sse", url: String(url), data: String(e.data).slice(0, 8000) })
      );
      return es;
    };
    window.EventSource.prototype = OrigES.prototype;
  }

  // --- XHR -----------------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__wireUrl = url;
    this.__wireMethod = method;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__wireUrl || "";
    if (!BORING.test(url)) {
      if (typeof body === "string") {
        tap({ phase: "xhr-request", url, method: this.__wireMethod, body });
      }
      let seen = 0;
      this.addEventListener("progress", () => {
        try {
          const text = this.responseText || "";
          if (text.length > seen) {
            tap({ phase: "xhr-chunk", url, chunk: text.slice(seen) });
            seen = text.length;
          }
        } catch (_) {}
      });
    }
    return origSend.call(this, body);
  };
})();
