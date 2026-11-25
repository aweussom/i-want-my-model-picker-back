'use strict';
/**
 * Delete the throwaway conversations this project's testing created.
 *
 *     node src/cleanup-tests.js --dry-run     list what would go
 *     node src/cleanup-tests.js               actually delete
 *     node src/cleanup-tests.js --api-chats [--dry-run]
 *         delete the chats the API created in full-history mode (aider), by the
 *         ids server.js wrote to api/.api-chats.jsonl. Stop the server first:
 *         both use the same browser profile.
 *
 * Written because testing against a real account left sixteen "Reply with exactly
 * the word BANANA" threads in someone's actual Copilot history. That was a
 * foreseeable consequence of the testing and it should be cleanable.
 *
 * Deletion is irreversible, so this is deliberately narrow: it matches only the
 * codewords and prompt shapes the tests used, re-checks the name against that
 * pattern immediately before clicking, and prints every title as it goes. It will
 * not touch anything it does not recognise as its own litter. --dry-run first.
 *
 * --api-chats matches on id, not title: Copilot titles those chats itself
 * ("Implement Duration String Parsing"), so no title pattern is safe. An id is
 * removed from the ledger only once its chat is gone from the sidebar.
 */

const path = require('node:path');
const fs = require('node:fs');
const { CopilotDriver } = require('./driver.js');

// Only this project's own test traffic. Anchored or codeword-specific on purpose:
// a loose pattern here deletes someone's real work.
const TEST_PATTERNS = [
  /^Reply with (exactly )?the word\b/i,
  /^Remember (this codeword|the codeword)\b/i,
  /^Say hi$/i,
  /^In one short sentence, what was this conversation about/i,
  /^What was the codeword\?/i,
  /^Describe this image in one short sentence\.$/i,
  /^What colours and shape do you see in this image/i,
  /\b(BERGEN|TROMSO|NOFLAG|PACKAGED|ELECTRON|HIDDEN|MANDARIN|BANANA|CHERRY|GUARD|TIMING)\b/,
];

const isMine = (name) => TEST_PATTERNS.some((re) => re.test(String(name || '').trim()));

// Delete labels, localised. "Slett" is Norwegian.
const DELETE_LABELS = ['Slett', 'Delete', 'Fjern', 'Remove'];

const API_CHATS_LEDGER = path.join(__dirname, '..', '.api-chats.jsonl');

async function deleteOne(page, conv, { byId = false } = {}) {
  const link = page.locator(`a[href*="${conv.id}"]`).first();
  if (!(await link.count())) return { ok: false, why: 'not in sidebar' };

  // Re-read the name from the page and re-check it. The sidebar reorders as
  // items disappear, and matching on a stale list is how you delete the wrong
  // thing. With byId the href match above is the check.
  const liveName = (await link.getAttribute('aria-label'))
    || (await link.innerText().catch(() => '')) || '';
  if (!byId && !isMine(liveName)) return { ok: false, why: `name no longer matches: ${liveName.slice(0, 40)}` };

  await link.hover();
  await page.waitForTimeout(400);

  const more = link.locator('xpath=..').locator('button[aria-haspopup="menu"]').first();
  if (!(await more.count())) return { ok: false, why: 'no overflow button' };
  await more.click({ timeout: 5000 });
  await page.waitForTimeout(1000);

  let clicked = false;
  for (const label of DELETE_LABELS) {
    const item = page.getByRole('menuitem', { name: label, exact: false }).first();
    try {
      if ((await item.count()) && (await item.isVisible())) {
        await item.click({ timeout: 4000 });
        clicked = true;
        break;
      }
    } catch { /* try the next label */ }
  }
  if (!clicked) {
    try { await page.keyboard.press('Escape'); } catch { /* ignore */ }
    return { ok: false, why: 'no delete item in menu' };
  }

  // A confirmation dialog may follow.
  await page.waitForTimeout(900);
  for (const label of DELETE_LABELS) {
    const confirm = page.getByRole('button', { name: label, exact: false }).first();
    try {
      if ((await confirm.count()) && (await confirm.isVisible())) {
        await confirm.click({ timeout: 4000 });
        break;
      }
    } catch { /* no dialog, or already gone */ }
  }
  await page.waitForTimeout(1200);

  const stillThere = await page.locator(`a[href*="${conv.id}"]`).count();
  return stillThere ? { ok: false, why: 'still listed after delete' } : { ok: true };
}

async function cleanupApiChats(dryRun) {
  if (!fs.existsSync(API_CHATS_LEDGER)) {
    console.log(`no ledger at ${API_CHATS_LEDGER}: the API has recorded no chats. Nothing to do.`);
    return;
  }
  const lines = fs.readFileSync(API_CHATS_LEDGER, 'utf8').split('\n').filter((l) => l.trim());
  const entries = lines.map((l) => JSON.parse(l));
  const ids = [...new Set(entries.map((e) => e.id))];
  console.log(`ledger lists ${ids.length} chats created by the API; trying to delete them by id`);

  const driver = await new CopilotDriver({}).start();
  const listed = await driver.listConversations({ limit: 200 });
  // Sidebar ids can carry a query ("<id>?redirfrom=mcmToCcm"); the ledger has bare ids.
  const nameById = new Map(listed.map((c) => [String(c.id).split('?')[0], c.name]));
  for (const id of ids) {
    console.log(`  ${id}  ${nameById.has(id) ? nameById.get(id) : '(not in the sidebar list)'}`);
  }
  if (dryRun) {
    console.log('\n--dry-run: nothing deleted, ledger unchanged.');
    await driver.close();
    return;
  }

  const remaining = [];
  let done = 0;
  for (const id of ids) {
    const r = await deleteOne(driver.page, { id }, { byId: true });
    if (r.ok) {
      done += 1;
      console.log(`  deleted  ${id}  ${nameById.get(id) || ''}`);
      continue;
    }
    // Not in the sidebar can mean already deleted by hand, or just scrolled out
    // of the loaded list. Keep it in the ledger; a later run may reach it.
    console.log(`  kept     ${id}  (${r.why})`);
    remaining.push(id);
  }
  const keptLines = entries.filter((e) => remaining.includes(e.id)).map((e) => JSON.stringify(e));
  fs.writeFileSync(API_CHATS_LEDGER, keptLines.length ? keptLines.join('\n') + '\n' : '');
  console.log(`\ndeleted ${done} of ${ids.length}; ${remaining.length} left in the ledger`);
  await driver.close();
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  if (process.argv.includes('--api-chats')) {
    await cleanupApiChats(dryRun);
    return;
  }
  const driver = await new CopilotDriver({}).start();

  const all = await driver.listConversations({ limit: 100 });
  const mine = all.filter((c) => isMine(c.name));
  const others = all.length - mine.length;

  console.log(`listed ${all.length} conversations`);
  console.log(`recognised as test litter: ${mine.length}`);
  console.log(`leaving untouched:         ${others}\n`);
  mine.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${(c.name || '').slice(0, 62)}`));

  if (dryRun) {
    console.log('\n--dry-run: nothing deleted.');
    await driver.close();
    return;
  }
  if (!mine.length) {
    console.log('\nNothing to clean up.');
    await driver.close();
    return;
  }

  console.log('\ndeleting...\n');
  let done = 0;
  const failed = [];
  for (const conv of mine) {
    const r = await deleteOne(driver.page, conv);
    if (r.ok) {
      done += 1;
      console.log(`  deleted  ${(conv.name || '').slice(0, 56)}`);
    } else {
      failed.push({ name: conv.name, why: r.why });
      console.log(`  skipped  ${(conv.name || '').slice(0, 48)}  (${r.why})`);
    }
  }

  console.log(`\ndeleted ${done} of ${mine.length}`);
  if (failed.length) {
    console.log('not deleted:');
    failed.forEach((f) => console.log(`  ${(f.name || '').slice(0, 50)} -- ${f.why}`));
  }
  const after = await driver.listConversations({ limit: 100 });
  console.log(`\nremaining conversations: ${after.length}`);
  console.log(`still matching the test pattern: ${after.filter((c) => isMine(c.name)).length}`);
  await driver.close();
})().catch((e) => { console.error('FAILED:', e.message.split('\n')[0]); process.exit(1); });
