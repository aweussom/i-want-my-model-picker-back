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
check('unknown model falls back to the default', () => assert.equal(resolveTone('gpt-4o'), DEFAULT_TONE));
check('missing model falls back to the default', () => assert.equal(resolveTone(undefined), DEFAULT_TONE));
check('the default is the newest GPT, not Auto', () => assert.equal(DEFAULT_TONE, 'Gpt_5_6_Reasoning'));

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
