// Runs the real userscript in a vm context with a fake page around it, to check
// that "best" comes from the chat's own model menu in the server-rendered HTML.
//
// The fixture copies the shape seen on the work tenant on 2026-11-25: the menu
// JSON sits inside a JS string (escaped one level), the page carries one
// modelSelectorMetadata per agent, and the chat's own copy belongs to
// gptId "bizchat-as-gpt-scenario".
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', '..', 'userscript', 'model-picker.user.js'), 'utf8');
const RS = '\x1e';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const item = (id, title, extra = {}) => ({ policyFailureBehavior: 'disable', id, type: 'item', menuItemTitle: title, sectionNumber: 2, ...extra });
const gated = { policyExpression: { or: [{ and: [{ policyId: 'P_x' }] }] } };

const CHAT_MENU = {
  defaultModelSelectionId: 'Magic',
  availableModelSelectionOptions: [
    { id: 'Magic', type: 'item', menuItemTitle: 'Auto', sectionNumber: 1 },
    { id: 'Chat', type: 'item', menuItemTitle: 'Quick response', sectionNumber: 1 },
    { id: 'Reasoning', type: 'item', menuItemTitle: 'Think deeper', sectionNumber: 1 },
    { id: 'Claude', type: 'itemGroup', menuItemTitle: 'Claude', sectionNumber: 2,
      itemGroup: [item('Claude_Sonnet', 'Sonnet 5.5', gated), item('Claude_Opus', 'Opus 5.5', gated)] },
    { id: 'OpenAI', type: 'itemGroup', menuItemTitle: 'GPT', sectionNumber: 2,
      itemGroup: [item('Gpt_6_Sol_Chat', 'GPT-6'), item('Gpt_62_Sol_Reasoning', 'GPT-6.2 Sol')] },
  ],
  totalNumberOfSections: 2,
};

// An agent whose menu would win if the script took the first metadata on the page.
const DECOY_MENU = {
  defaultModelSelectionId: 'Magic',
  availableModelSelectionOptions: [
    { id: 'Magic', type: 'item', menuItemTitle: 'Auto', sectionNumber: 1 },
    { id: 'OpenAI', type: 'itemGroup', menuItemTitle: 'GPT', sectionNumber: 2,
      itemGroup: [item('Decoy_Agent_Tone', 'Not the chat')] },
  ],
};

function pageHtml(agents) {
  const state = { agents: agents.map((a) => ({ gptId: a.gptId, clientPreferences: { modelSelectorMetadata: a.meta } })) };
  return `<!doctype html><html><body><script>self.$S=${JSON.stringify(JSON.stringify(state))}</script></body></html>`;
}

const REAL_PAGE = pageHtml([
  { gptId: 'researcher', meta: DECOY_MENU },
  { gptId: 'bizchat-as-gpt-scenario', meta: CHAT_MENU },
  { gptId: 'cwc-as-gpt-scenario', meta: DECOY_MENU },
]);

// Load the userscript into a fresh context. fetchImpl answers its page fetch.
async function boot({ fetchImpl, stored = {}, pathname = '/chat' } = {}) {
  const storage = new Map(Object.entries(stored));
  const logs = [];
  const sent = [];
  function FakeWebSocket(url) { this.url = url; }
  FakeWebSocket.prototype.send = function (data) { sent.push(data); };
  const log = (level) => (...args) => logs.push(`${level} ${args.map(String).join(' ')}`);
  const ctx = {
    console: { info: log('info'), warn: log('warn'), error: log('error'), log: log('log') },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    location: { pathname },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, text: async () => REAL_PAGE })),
    WebSocket: FakeWebSocket,
    document: { body: null, getElementById: () => null },
    setInterval: () => 0,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx, { filename: 'model-picker.user.js' });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const sendChat = (tone) => {
    const ws = new ctx.WebSocket('wss://substrate.office.com/m365Copilot/Chathub/x');
    ws.send(JSON.stringify({ type: 4, target: 'chat', arguments: [{ tone, text: 'hi' }] }) + RS);
    return JSON.parse(sent[sent.length - 1].split(RS)[0]).arguments[0].tone;
  };
  return { mpo: ctx.__mpo, logs, storage, sendChat };
}

(async () => {
  console.log('menu from the page');
  await check('best is the bottom of the chat menu OpenAI group, not the first agent on the page', async () => {
    const { mpo } = await boot();
    assert.equal(mpo.bestTone, 'Gpt_62_Sol_Reasoning');
  });
  await check('menu lists every entry, Claude marked gated', async () => {
    const { mpo } = await boot();
    const ids = mpo.menu.map((i) => i.id + (i.gated ? '[gated]' : ''));
    assert.deepEqual(ids, ['Magic', 'Chat', 'Reasoning', 'Claude_Sonnet[gated]', 'Claude_Opus[gated]', 'Gpt_6_Sol_Chat', 'Gpt_62_Sol_Reasoning']);
  });
  await check('names are not parsed: whatever sits last wins', async () => {
    const menu = JSON.parse(JSON.stringify(CHAT_MENU));
    menu.availableModelSelectionOptions[4].itemGroup.push(item('Zz_Whatever_Name', 'GPT-7 Nova'));
    const html = pageHtml([{ gptId: 'bizchat-as-gpt-scenario', meta: menu }]);
    const { mpo } = await boot({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) });
    assert.equal(mpo.bestTone, 'Zz_Whatever_Name');
  });
  await check('a send on Auto goes out as the bottom entry', async () => {
    const { sendChat } = await boot();
    assert.equal(sendChat('Magic'), 'Gpt_62_Sol_Reasoning');
  });
  await check('the menu is cached for the next load', async () => {
    const { storage } = await boot();
    assert.equal(JSON.parse(storage.get('mpo.menu')).items.length, 7);
  });
  await check('the pre-menu learned key is removed', async () => {
    const { storage } = await boot({ stored: { 'mpo.learnedBest': 'Gpt_5_6_Reasoning' } });
    assert.ok(!storage.has('mpo.learnedBest'));
  });

  console.log('failing loud');
  await check('no chat marker: no best, send left alone, error logged', async () => {
    const html = pageHtml([{ gptId: 'researcher', meta: DECOY_MENU }]);
    const { mpo, logs, sendChat } = await boot({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) });
    assert.equal(mpo.bestTone, null);
    assert.equal(sendChat('Magic'), 'Magic');
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('bizchat-as-gpt-scenario')), logs.join('\n'));
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('UNMODIFIED')), logs.join('\n'));
  });
  await check('fetch fails: cached menu stays in use, and the log says so', async () => {
    const cache = JSON.stringify({ at: '2026-11-25T00:00:00Z', items: [{ id: 'Old_Best', group: 'OpenAI' }] });
    const { mpo, logs, sendChat } = await boot({
      stored: { 'mpo.menu': cache },
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
    });
    assert.equal(mpo.bestTone, 'Old_Best');
    assert.equal(sendChat('Magic'), 'Old_Best');
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('HTTP 503') && l.includes('cache 2026-11-25')), logs.join('\n'));
  });
  await check('not a chat page: no fetch', async () => {
    let fetched = false;
    await boot({ pathname: '/launch', fetchImpl: async () => { fetched = true; return { ok: true, status: 200, text: async () => REAL_PAGE }; } });
    assert.equal(fetched, false);
  });
  await check('explicit tone still wins over best', async () => {
    const { mpo, sendChat } = await boot();
    mpo.setTone('Gpt_6_Sol_Chat');
    assert.equal(sendChat('Magic'), 'Gpt_6_Sol_Chat');
  });

  console.log(`${passed} checks passed`);
})();
