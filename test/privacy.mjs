#!/usr/bin/env node
/*
 * Privacy regression test.
 *
 * This site used to hold a case: a name, an employer, pay figures, dated
 * incident notes, drafted letters and a chat transcript, all in plaintext in
 * localStorage. It holds none of that now — the only thing persisted is which
 * state and county the reader picked, so the law shown is theirs.
 *
 * That is a promise the app makes in its own words ("nothing about you is
 * stored"), so it needs a test that would fail the moment it stops being true:
 *
 *   1. After a full walk through the site, the ONLY app keys in localStorage
 *      are the remembered place, the seen-welcome flag, and the reading
 *      language.
 *   2. The stored place contains a state and a county and nothing else — no
 *      free text, no identifiers.
 *   3. A leftover case blob from the old app is deleted on first load rather
 *      than left sitting on the device.
 *   4. Nothing leaves the device: no network request goes anywhere but our own
 *      origin.
 *
 * Run: node test/privacy.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { resolveChromePath } from './lib/chrome.mjs';
import puppeteer from 'puppeteer-core';
import { gotoApp, reloadApp } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = normalize(join(ROOT, p));
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (cond, msg) => { if (!cond) fails++; console.log((cond ? '✅ ' : '❌ ') + msg); };

const LEGACY_CASE_KEY = 'worklaw.case.v2';
const PLACE_KEY = 'worklaw.place.v1';
const WELCOME_KEY = 'worklaw.seenWelcome.v1';
/* Which language the reader picked. Its own key rather than a field on the
   place blob, because the pick can happen on the welcome screen before there
   is any place — so it is a third key, and it is named here rather than
   quietly widening the assertion below. */
const LANG_KEY = 'worklaw.lang.v1';

const b = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });
try {
  const pg = await b.newPage();

  // Anything the page tries to fetch off our own origin is a leak.
  const offOrigin = [];
  pg.on('request', r => { if (!r.url().startsWith(ORIGIN) && !r.url().startsWith('data:')) offOrigin.push(r.url()); });

  // Seed a case blob exactly as the old app would have left it — this is the
  // upgrade path a real user is on.
  await pg.evaluateOnNewDocument((key, blob) => {
    try { localStorage.setItem(key, blob); } catch (e) {}
  }, LEGACY_CASE_KEY, JSON.stringify({
    onboarded: true, stateSel: 'California', county: 'Alameda County',
    issue: 'Unpaid overtime or wages',
    profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20' },
    entries: [{ title: 'Statement recorded', body: 'Manager said we do not pay overtime here.', iso: new Date().toISOString() }],
    messages: [{ role: 'user', text: 'I think my employer is stealing my wages' }],
  }));

  await gotoApp(pg, ORIGIN + '/index.html', { place: { state: 'California', county: 'Alameda County' } });
  await new Promise(r => setTimeout(r, 900));

  // ── 3 · the old blob is gone, not merely unread ──
  const legacy = await pg.evaluate(k => localStorage.getItem(k), LEGACY_CASE_KEY);
  ok(legacy === null, 'a leftover case blob from the old app is deleted from the device on load');

  // Walk the whole site, so anything that writes on navigation gets a chance to.
  const click = async (t) => {
    await pg.evaluate((t) => {
      const el = [...document.querySelectorAll('button,a')].find(b => (b.innerText || '').trim().includes(t));
      el && el.click();
    }, t);
    await new Promise(r => setTimeout(r, 450));
  };
  await click('Pay & overtime');
  await click('Am I exempt from overtime?');
  await click('Hourly');
  await click('No');
  await click('All rights');
  await click('Agencies');
  await click('Laws');
  // Pick the other language, so the key this suite is asserting about actually
  // exists. Last, because every click above finds its button by English text.
  await click('Español');
  await reloadApp(pg);
  await new Promise(r => setTimeout(r, 700));

  // ── 1 · only two keys, both ours, both innocuous ──
  const keys = await pg.evaluate(() => Object.keys(localStorage).sort());
  const unexpected = keys.filter(k => k !== PLACE_KEY && k !== WELCOME_KEY && k !== LANG_KEY);
  ok(unexpected.length === 0,
     'localStorage holds only the remembered place, the seen-welcome flag and the reading language' +
     (unexpected.length ? ' — also found: ' + unexpected.join(', ') : ''));

  /* A language key is only innocuous while it holds a language. Asserting the
     exact shape stops it becoming a convenient place to park anything else. */
  const langVal = await pg.evaluate(k => localStorage.getItem(k), LANG_KEY);
  ok(langVal === 'es',
     `the stored language is a bare locale code and nothing else (got: ${JSON.stringify(langVal)})`);

  // ── 2 · the place is a place, nothing more ──
  const place = await pg.evaluate(k => JSON.parse(localStorage.getItem(k) || '{}'), PLACE_KEY);
  const fields = Object.keys(place).sort();
  /* A closed allowlist, deliberately. The city was added because a municipal
     ordinance is what decides a wage, and it is MORE identifying than a county;
     `when` is a month the reader gives for when their problem happened, which
     is the first stored field that is about their situation rather than their
     geography. Both are named here and in the on-screen promise, not slipped
     in. Any field beyond these four is a regression this assertion exists to
     catch. */
  ok(fields.join(',') === 'city,county,stateSel,when',
     `the stored place carries exactly a state, county, city and month (got: ${fields.join(', ') || 'nothing'})`);
  ok(place.stateSel === 'California' && place.county === 'Alameda County',
     'the stored place is the one the reader actually picked');
  const blob = JSON.stringify(place);
  for (const leaked of ['Pat Vega', 'Northgate', 'overtime', 'Manager said']) {
    ok(!blob.includes(leaked), `the stored place carries no trace of case data ("${leaked}")`);
  }

  // ── 4 · nothing leaves the device ──
  ok(offOrigin.length === 0,
     'the site makes no request off its own origin' + (offOrigin.length ? ': ' + offOrigin.slice(0, 3).join(', ') : ''));

  await pg.close();
} finally {
  await b.close();
  server.close();
}

console.log(fails === 0 ? '\n✅ PRIVACY PASSED' : `\n❌ PRIVACY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
