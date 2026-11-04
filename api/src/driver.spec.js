'use strict';
/**
 * Unit checks for the pure parts of driver.js -- no browser required.
 *
 *     node src/driver.spec.js
 *
 * These exist because the two nastiest bugs in the Python original were in the
 * observer, not the target, and both were invisible until something was
 * asserted about them. The citation regex in particular has been silently
 * broken twice by edits that dropped invisible characters.
 */

const assert = require('node:assert/strict');
const { CITATION_RE, splitRecords, isChathub, isUpload, TONES, DEFAULT_TONE,
        toneMatches, CopilotDriver } = require('./driver.js');

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const strip = (s) => s.replace(CITATION_RE, '');
const OPEN = '\uE200', SEP = '\uE202', CLOSE = '\uE201';

console.log('citation stripping');
check('removes a complete span', () =>
  assert.equal(strip(`Census.${OPEN}cite${SEP}turn1search1${CLOSE} Next.`), 'Census. Next.'));
check('removes an unterminated span at end of a partial delta', () =>
  assert.equal(strip(`included.${OPEN}cite${SEP}turn2search1`), 'included.'));
check('removes Bing-style markers', () =>
  assert.equal(strip('Figures[^1^] and[^12^].'), 'Figures and.'));
check('removes a stray separator', () =>
  assert.equal(strip(`lone ${SEP} sep`), 'lone  sep'));
check('leaves clean text alone', () =>
  assert.equal(strip('Nothing to strip.'), 'Nothing to strip.'));
check('does not eat everything (the regression that broke it twice)', () =>
  assert.equal(strip('The image is a soft gradient.'), 'The image is a soft gradient.'));
check('no private-use survivors', () => {
  const out = strip(`a${OPEN}cite${SEP}x${CLOSE}b${SEP}c`);
  assert.ok(![...out].some((c) => c >= '\uE200' && c <= '\uE20F'), `residual in ${JSON.stringify(out)}`);
});

console.log('frame splitting');
check('splits SignalR records on U+001E', () =>
  assert.deepEqual(splitRecords('{"a":1}\u001E{"b":2}\u001E'), ['{"a":1}', '{"b":2}']));
check('strips socket.io framing', () =>
  assert.deepEqual(splitRecords('5:1+::{"name":"ping"}'), ['{"name":"ping"}']));
check('keeps a bare record intact', () =>
  assert.deepEqual(splitRecords('{"type":3}'), ['{"type":3}']));

console.log('url matching');
check('chathub recognised', () =>
  assert.ok(isChathub('wss://substrate.office.com/m365Copilot/Chathub/a@b?x=1')));
check('trouter is not chathub', () =>
  assert.ok(!isChathub('wss://go-eu.trouter.teams.microsoft.com/v4/c?ua=BizChat')));
check('upload recognised', () =>
  assert.ok(isUpload('https://substrate.office.com/m365Copilot/UploadFile')));

console.log('tones');
check('six tones, and the newest GPT is what we request by default', () => {
  assert.equal(Object.keys(TONES).length, 6);
  assert.equal(DEFAULT_TONE, 'Gpt_5_6_Reasoning');
  // Labels are aliases for resolveTone() now. Both the Sol menu text of Nov
  // 2026 and the older names must resolve.
  assert.ok(TONES.Gpt_5_6_Reasoning.labels.includes('GPT-5.6 Sol Think deeper'));
  assert.ok(TONES.Gpt_5_6_Reasoning.labels.includes('GPT 5.6 Think deeper'));
  assert.ok(TONES.Gpt_5_6_Chat.labels.includes('GPT-5.6 Sol Quick response'));
});
check('every tone value is something the userscript hook accepts', () => {
  for (const id of Object.keys(TONES)) assert.match(id, /^[A-Za-z0-9_]+$/);
});

console.log('short titles');
check('the picker button shortTitle still identifies the tone', () =>
  assert.ok(toneMatches('Gpt_5_6_Reasoning', 'GPT 5.6 Think')));
check('a generic tone is not matched by a GPT shortTitle', () =>
  assert.ok(!toneMatches('Reasoning', 'GPT 5.6 Think')));

console.log('localised label matching');
check('matches the English menu entry', () =>
  assert.ok(toneMatches('Reasoning', 'Think deeper Think longer for better answers')));
check('matches the Norwegian menu entry', () =>
  assert.ok(toneMatches('Reasoning', 'Tenk dypere Tenk lenger for bedre svar')));
check('Automatisk is Magic', () => assert.ok(toneMatches('Magic', 'Automatisk')));
check('Raskt svar is Chat', () => assert.ok(toneMatches('Chat', 'Raskt svar')));
check('a menu without named models does not match a GPT tone', () =>
  assert.ok(!toneMatches('Gpt_5_6_Reasoning',
    'Automatisk || Raskt svar || Tenk dypere')));
check('a menu with named models does match', () =>
  assert.ok(toneMatches('Gpt_5_6_Reasoning',
    'Automatisk || Raskt svar || Tenk dypere || GPT 5.6 Think deeper')));



console.log('default tone selection');
const { highestGptTone, BROWSER_DEFAULT_TONE } = require('./driver.js');
check('picks the highest GPT from the shipped menu', () =>
  assert.equal(highestGptTone(), 'Gpt_5_6_Reasoning'));
check('a future 5.7 would win without an edit', () =>
  assert.equal(highestGptTone({ Gpt_5_6_Reasoning: {}, Gpt_5_7_Chat: {} }), 'Gpt_5_7_Chat'));
check('major version beats minor', () =>
  assert.equal(highestGptTone({ Gpt_5_9_Reasoning: {}, Gpt_6_0_Chat: {} }), 'Gpt_6_0_Chat'));
check('Reasoning wins over Chat at the same version', () =>
  assert.equal(highestGptTone({ Gpt_5_6_Chat: {}, Gpt_5_6_Reasoning: {} }), 'Gpt_5_6_Reasoning'));
check('falls back to the browser default when no GPT is listed', () =>
  assert.equal(highestGptTone({ Magic: {}, Reasoning: {} }), BROWSER_DEFAULT_TONE));
check('browser default stays Magic, which is the real fresh-chat state', () =>
  assert.equal(BROWSER_DEFAULT_TONE, 'Magic'));

// --- why the composer is missing ----------------------------------------
//
// "composer lost after reload" named the symptom and left four different
// problems looking identical: an expired session, a verification box, a modal,
// and a page that is merely slow. Each wants a different response from whoever
// reads it, so each has to be distinguishable. A stand-in page is enough --
// the branch that matters is the URL test.

const reasonFor = ({ url = '', title = '', challenge = false, dialog = null }) => {
  const absent = { count: async () => 0 };
  const present = {
    count: async () => 1,
    isVisible: async () => true,
    getAttribute: async () => dialog,
    innerText: async () => dialog,
  };
  const self = {
    page: {
      url: () => url,
      title: async () => title,
      locator: () => ({ first: () => (dialog ? present : absent) }),
    },
    _challengeVisible: () => challenge,
  };
  return CopilotDriver.prototype._composerLostReason.call(self);
};

const asyncCheck = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

(async () => {
  console.log('why the composer is missing');
  await asyncCheck('an expired session is named as such, with the fix', async () => {
    const r = await reasonFor({ url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1' });
    assert.match(r, /session has expired/);
    assert.match(r, /login\.microsoftonline\.com/);
    assert.match(r, /npm run signin/);
  });
  await asyncCheck('a consumer login redirect counts too', async () => {
    assert.match(await reasonFor({ url: 'https://login.live.com/oauth20_authorize.srf' }),
                 /session has expired/);
  });
  await asyncCheck('a verification box is not mistaken for an expired session', async () => {
    const r = await reasonFor({ url: 'https://m365.cloud.microsoft/chat', challenge: true });
    assert.match(r, /human-verification/);
    assert.doesNotMatch(r, /expired/);
  });
  await asyncCheck('a modal is reported with its label', async () => {
    assert.match(
      await reasonFor({ url: 'https://m365.cloud.microsoft/chat', dialog: 'Sikkerhetskontroll kreves' }),
      /dialog is covering the page: Sikkerhetskontroll kreves/);
  });
  await asyncCheck('an ordinary slow page still reports where it was', async () => {
    const r = await reasonFor({ url: 'https://m365.cloud.microsoft/chat', title: 'Chat | Microsoft Copilot' });
    assert.match(r, /composer lost after reload/);
    assert.match(r, /m365\.cloud\.microsoft/);
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
})();
