'use strict';
/** Unit checks for the pure request-shaping helpers. node src/server.spec.js */

const assert = require('node:assert/strict');
const { resolveTone, lastUserMessage, extractImages, sseChunk } = require('./server.js');
const { DEFAULT_TONE } = require('./driver.js');

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('model -> tone');
check('exact id', () => assert.equal(resolveTone('Gpt_5_6_Reasoning'), 'Gpt_5_6_Reasoning'));
check('menu label', () => assert.equal(resolveTone('GPT 5.6 Think deeper'), 'Gpt_5_6_Reasoning'));
// The named models churn -- this case said Gpt_5_5_Chat until 2026-09-15, when
// the tenant's menu replaced 5.5 with 5.6 and the assertion started failing for
// a reason that had nothing to do with suffix parsing. Pin the behaviour to a
// generic tone, which does not get renamed, and keep one named case alongside
// it so a rename is still noticed rather than silently tolerated.
check('@suffix from the UI', () => assert.equal(resolveTone('Chat@microsoft'), 'Chat'));
check('@suffix on a named model', () => assert.equal(resolveTone('Gpt_5_6_Chat@openai'), 'Gpt_5_6_Chat'));
check('unknown model is refused, not swapped for the default', () => assert.equal(resolveTone('gpt-4o'), null));
check('missing model falls back to the default', () => assert.equal(resolveTone(undefined), DEFAULT_TONE));
// Ids and gated flags as the menu-data-tone userscript read the work tenant on
// 2026-11-25. Titles of the generic and GPT items as observed; the Claude titles
// are made up, only their ids and gated flags were reported.
const menu = [
  { id: 'Magic', title: 'Auto', gated: false },
  { id: 'Chat', title: 'Quick response', gated: false },
  { id: 'Reasoning', title: 'Think deeper', gated: false },
  { id: 'Claude_Sonnet', title: 'Claude Sonnet', gated: true },
  { id: 'Claude_Opus', title: 'Claude Opus', gated: true },
  { id: 'Gpt_6_Sol_Chat', title: 'GPT-6', gated: false },
  { id: 'Gpt_62_Sol_Reasoning', title: 'GPT-6.2 Sol', gated: false },
];
check('live menu: a TONES model that left the menu is refused', () =>
  assert.equal(resolveTone('Gpt_5_6_Chat', DEFAULT_TONE, menu), null));
check('live menu: a menu id TONES lacks is accepted', () =>
  assert.equal(resolveTone('gpt_6_sol_chat', DEFAULT_TONE, menu), 'Gpt_6_Sol_Chat'));
check('live menu: the menu title is an alias, matched exactly', () =>
  assert.equal(resolveTone('gpt-6', DEFAULT_TONE, menu), 'Gpt_6_Sol_Chat'));
check('live menu: a TONES label still resolves when its id is offered', () =>
  assert.equal(resolveTone('GPT 6.2', DEFAULT_TONE, menu), 'Gpt_62_Sol_Reasoning'));
check('live menu: a mode the menu dropped is refused', () =>
  assert.equal(resolveTone('Chat', DEFAULT_TONE, menu.filter((i) => i.id !== 'Chat')), null));
check('the default is the newest GPT, not Auto', () => assert.equal(DEFAULT_TONE, 'Gpt_62_Sol_Reasoning'));

console.log('message extraction');
check('plain string content', () =>
  assert.equal(lastUserMessage({ messages: [{ role: 'user', content: 'hi' }] }), 'hi'));
check('newest user turn wins', () =>
  assert.equal(lastUserMessage({ messages: [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'new' }] }), 'new'));
check('text parts joined, images ignored', () =>
  assert.equal(lastUserMessage({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'what is this' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }), 'what is this'));

console.log('image extraction');
check('data URIs kept, remote counted', () => {
  const r = extractImages({ messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }] });
  assert.equal(r.uris.length, 1);
  assert.equal(r.skippedRemote, 1);
});
check('no images is not an error', () => {
  const r = extractImages({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(r, { uris: [], skippedRemote: 0 });
});

console.log('sse encoding');
check('content chunk parses and carries the model', () => {
  const line = sseChunk('hello', 'Gpt_5_6_Reasoning');
  const obj = JSON.parse(line.slice('data: '.length).trim());
  assert.equal(obj.object, 'chat.completion.chunk');
  assert.equal(obj.model, 'Gpt_5_6_Reasoning');
  assert.equal(obj.choices[0].delta.content, 'hello');
  assert.equal(obj.choices[0].finish_reason, null);
});
check('reasoning rides in reasoning_content', () => {
  const obj = JSON.parse(sseChunk('thinking', 'Magic', { reasoning: true }).slice(6).trim());
  assert.equal(obj.choices[0].delta.reasoning_content, 'thinking');
  assert.equal(obj.choices[0].delta.content, undefined);
});
check('done chunk terminates the stream', () => {
  const out = sseChunk('', 'Magic', { done: true });
  assert.ok(out.includes('data: [DONE]'));
  assert.equal(JSON.parse(out.split('\n')[0].slice(6)).choices[0].finish_reason, 'stop');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
