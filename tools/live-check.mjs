#!/usr/bin/env node
/**
 * Ski Stunt 3D — live check.
 *
 *   node tools/live-check.mjs <url> [<url> ...] [--expect index.html]
 *                             [--timeout 600] [--markdown out.md]
 *
 * More than one URL may be given; the first that serves the committed
 * build wins. GitHub Pages paths follow the repository name, and this
 * repo is mixed case, so "which casing actually resolves" is a question
 * worth answering by trying rather than by guessing.
 *
 * Runs AFTER a deploy, against the real Pages URL. Waits until the bytes
 * being served are the bytes that were committed, then opens the page in
 * headless Chromium and asserts the same things the pre-push boot check
 * does — except that here the import map resolves against the real CDN,
 * over the real network, in a real browser.
 *
 * That is the closest a machine gets to "it will load on the phone".
 * The pre-push check serves locally vendored modules, so it cannot catch
 * a CDN that is down, a pin that jsDelivr will not serve, or a Pages
 * deploy that silently published the wrong commit. This can.
 *
 * No dependencies. Node 22+.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

import { withPage, checkPlayablePage, findChromium } from './lib/boot.mjs';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URLS = argv.filter((a) => a.startsWith('http'));
const EXPECT = argValue('--expect', 'index.html');
const TIMEOUT = Number(argValue('--timeout', '600')) * 1000;
const MARKDOWN = argValue('--markdown', null);
const POLL_MS = 10000;

if (URLS.length === 0) {
  console.error('usage: node tools/live-check.mjs <url> [<url> ...] [--expect index.html] [--timeout 600]');
  process.exit(2);
}
let resolvedUrl = URLS[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

const notes = [];
const errors = [];

/* ---- 1. wait for the deploy to actually be the thing we built ---- */
const waitForDeploy = async () => {
  const wanted = fs.existsSync(EXPECT) ? fs.readFileSync(EXPECT, 'utf8') : null;
  if (!wanted) notes.push('no local ' + EXPECT + ' to compare against — checking reachability only');
  else notes.push('waiting for ' + EXPECT + ' (sha ' + digest(wanted) + ') to appear at the URL');

  const started = Date.now();
  const lastSeen = new Map();
  while (Date.now() - started < TIMEOUT) {
    for (const candidate of URLS) {
      try {
        const res = await fetch(candidate + (candidate.includes('?') ? '&' : '?') + 'cachebust=' + Date.now(), {
          cache: 'no-store',
          headers: { 'cache-control': 'no-cache' },
        });
        if (res.status === 200) {
          const body = await res.text();
          if (!wanted || body === wanted) {
            resolvedUrl = candidate;
            notes.push('serving the committed build after ' + Math.round((Date.now() - started) / 1000) + 's');
            if (URLS.length > 1) notes.push('resolved URL: ' + candidate);
            return true;
          }
          lastSeen.set(candidate, 'HTTP 200 but a different build (sha ' + digest(body) + ')');
        } else {
          lastSeen.set(candidate, 'HTTP ' + res.status);
        }
      } catch (err) {
        lastSeen.set(candidate, String(err && err.message ? err.message : err));
      }
    }
    await sleep(POLL_MS);
  }
  const seen = URLS.map((u) => u + ' -> ' + (lastSeen.get(u) || 'nothing')).join('; ');
  errors.push(
    'the deployed page never matched the committed build within ' +
      Math.round(TIMEOUT / 1000) + 's (last saw: ' + seen + ')'
  );
  return false;
};

/* ---- 2. drive the deployed page ---- */
const drive = async (debug) => {
  const label = debug ? '?debug=1: ' : '';
  const local = [];
  const outcome = await withPage({ url: resolvedUrl, debug: debug }, (page) => checkPlayablePage(page, { debug: debug }, local));
  if (outcome.skipped) {
    notes.push(label + 'skipped — ' + outcome.reason);
    return;
  }
  for (const note of local) notes.push(label + note);
  for (const err of outcome.errors) errors.push(label + err);
};

const main = async () => {
  console.log('Ski Stunt 3D — live check');
  console.log(URLS.join('\n'));
  console.log('-'.repeat(64));

  const deployed = await waitForDeploy();
  if (deployed) {
    if (!findChromium()) notes.push('no Chromium available — reachability verified, page not driven');
    else {
      await drive(false);
      await drive(true);
    }
  }

  for (const note of notes) console.log('  ' + note);
  for (const err of errors) console.log('  FAIL  ' + err);
  console.log('-'.repeat(64));
  console.log(errors.length ? errors.length + ' PROBLEM(S) WITH THE LIVE BUILD' : 'the deployed build loads and runs');

  if (MARKDOWN) {
    fs.writeFileSync(
      MARKDOWN,
      '### Live check — ' + (errors.length ? '**' + errors.length + ' problem(s)**' : 'the deployed build loads and runs') + '\n\n' +
        '`' + resolvedUrl + '`\n\n' +
        errors.map((e) => '- **fail:** ' + e).join('\n') + (errors.length ? '\n\n' : '') +
        notes.map((n) => '- ' + n).join('\n') + '\n'
    );
  }
  process.exit(errors.length ? 1 : 0);
};

main().catch((err) => {
  console.error('live check crashed:', err);
  process.exit(1);
});
