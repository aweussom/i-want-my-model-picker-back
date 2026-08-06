'use strict';
/**
 * Electron shell.
 *
 * The main process owns the Playwright driver and the HTTP server; the renderer
 * is the same web UI, loaded over localhost. That is deliberate: the renderer
 * could talk to the driver over IPC instead, but then the OpenAI-compatible
 * surface would have to exist twice, and that surface is the entire point.
 * Serving it means one implementation, and `curl` works while the app is open.
 *
 * There are still two windows: this one, and the Playwright browser holding the
 * Copilot session. That is inherent -- the session is what makes any of this
 * work, and hiding it (headless) only works once a profile is already warm.
 */

const path = require('node:path');
const net = require('node:net');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { CopilotDriver } = require('./driver.js');
const { createServer } = require('./server.js');

const PROFILE_DIR = process.env.COPILOT_PROFILE
  ? path.resolve(process.env.COPILOT_PROFILE)
  : path.join(__dirname, '..', '.profile');

let driver = null;
let server = null;
let win = null;

/** Ask the OS for a free port instead of guessing one that might be taken. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const LOADING = `data:text/html,${encodeURIComponent(`
<html><head><meta charset="utf-8"><title>i want my model picker back</title></head>
<body style="margin:0;display:grid;place-items:center;height:100vh;
             background:#0f1020;color:#c7c9e0;font:14px system-ui">
  <div style="text-align:center">
    <div style="font-size:15px;color:#8ab4f8">starting the browser session…</div>
    <div id="s" style="margin-top:10px;opacity:.6">this takes a few seconds</div>
  </div>
  <script>
    let n = 0;
    setInterval(() => {
      n += 1;
      document.getElementById('s').textContent =
        n < 20 ? 'this takes a few seconds'
               : 'still going — if a sign-in page is showing, finish it there';
    }, 1000);
  </script>
</body></html>`)}`;

async function boot() {
  win = new BrowserWindow({
    width: 1280,
    height: 940,
    backgroundColor: '#0f1020',
    title: 'i want my model picker back',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  await win.loadURL(LOADING);

  // Links to anywhere else belong in the real browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    driver = new CopilotDriver({ profileDir: PROFILE_DIR });
    await driver.start({ signInTimeoutMs: 12 * 60 * 1000 });

    const port = await freePort();
    server = createServer(driver);
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

    console.log(`chat UI      http://127.0.0.1:${port}/`);
    console.log(`OpenAI API   http://127.0.0.1:${port}/v1/chat/completions`);
    if (!win.isDestroyed()) await win.loadURL(`http://127.0.0.1:${port}/`);
  } catch (err) {
    if (win && !win.isDestroyed()) {
      dialog.showMessageBoxSync(win, {
        type: 'error',
        title: 'Could not start',
        message: err.message,
        detail: 'If the profile has no session yet, run "npm run signin" first '
              + 'and complete the login there. That window waits 15 minutes.',
      });
    }
    app.quit();
  }
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});

app.on('window-all-closed', () => app.quit());

// Closing the app must take the Playwright browser with it, or a headed
// Chromium holding a live corporate session is left running with no owner.
app.on('before-quit', async (e) => {
  if (!driver && !server) return;
  e.preventDefault();
  const d = driver; const s = server;
  driver = null; server = null;
  try { await d?.close(); } catch { /* already gone */ }
  try { s?.close(); } catch { /* already gone */ }
  app.quit();
});
