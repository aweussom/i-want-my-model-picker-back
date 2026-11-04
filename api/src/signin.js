'use strict';
/**
 * Open Copilot and wait, patiently, for you to sign in.
 *
 *     npm run signin
 *     npm run signin -- --profile ../.profile-personal
 *
 * This exists because signing in is the one step that cannot be automated and
 * the one step that takes unpredictably long -- Entra, MFA, an Authenticator
 * push you have to go and find your phone for. Everything else in this project
 * assumes the profile already holds a session; this is how it gets one.
 *
 * It does nothing but wait and then confirm. Nothing is sent, nothing recorded.
 */

const path = require('node:path');
const { CopilotDriver } = require('./driver.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const profileDir = path.resolve(arg('profile', path.join(__dirname, '..', '.profile')));
  const minutes = Number(arg('minutes', 15));

  console.log(`profile : ${profileDir}`);
  console.log(`\nA browser will open. Sign in if asked -- take as long as you need,`);
  console.log(`up to ${minutes} minutes. The window will not close under you.\n`);

  const driver = new CopilotDriver({ profileDir });
  try {
    await driver.start({
      signInTimeoutMs: minutes * 60 * 1000,
      onWait: (s) => process.stdout.write(`\r  waiting for the composer... ${s}s `),
    });
    console.log(`\r  signed in. The profile now holds a session.        `);
    console.log(`\nNext:  npm run serve      (API on port 8791)`);
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
})();
