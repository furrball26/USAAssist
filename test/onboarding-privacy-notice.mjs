#!/usr/bin/env node
/*
 * Onboarding shared-device privacy notice regression test (P2 FIND-21,
 * docs/audit-2026-08-29.md).
 *
 * Case data (name, employer, wages, incident narrative) sits in
 * localStorage['worklaw.case.v2'] in plaintext with no TTL. There is no
 * remote exposure path (wl-security's threat model) — this is purely a
 * shared/public-computer and forensic-recovery risk. The app already
 * discloses "stays on this device" REACTIVELY: a one-time note on Home
 * after name+employer are both already filled in (privacyNoteSeen), the
 * always-present Home footer note, and the "Manage your case data" panel
 * next to "Delete my case" on Agencies. Nothing said so PROACTIVELY, at the
 * actual point of creation — onboarding step 4, right before the user types
 * their name/employer for the very first time.
 *
 * This asserts a first-run (not editing) user reaches onboarding step 4 and
 * sees a "stays on this device... until you delete it" notice BEFORE the
 * name/employer inputs, and that re-entering onboarding to EDIT an existing
 * case (data already exists, already covered by the other two surfaces)
 * does not duplicate it.
 *
 * Run: node test/onboarding-privacy-notice.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { resolveChromePath } from './lib/chrome.mjs';
import puppeteer from 'puppeteer-core';
import { gotoApp } from './lib/nav.mjs';

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
const chrome = resolveChromePath();

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;
const click = async (pg, t) => { await pg.evaluate((x) => { const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.trim() === x); e && e.click(); }, t); await new Promise(r => setTimeout(r, 250)); };
const bodyText = async (pg) => await pg.evaluate(() => document.body.innerText);

const PRIVACY_RE = /saved only in this browser, on this device.*never uploaded anywhere.*until you delete it/is;

try {

// 1. First-run onboarding: navigate to step 4 and confirm the notice
// appears BEFORE the name field, ahead of typing anything identifying.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument(() => localStorage.clear());
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await pg.evaluate(() => { const sel = document.querySelector('#onb-state'); sel.value = 'Texas'; sel.dispatchEvent(new Event('change', { bubbles:true })); });
  await new Promise(r => setTimeout(r, 150));
  await click(pg, 'Continue');
  await pg.evaluate(() => { const sel = document.querySelector('#onb-county'); sel.value = 'Travis County'; sel.dispatchEvent(new Event('change', { bubbles:true })); });
  await new Promise(r => setTimeout(r, 150));
  await click(pg, 'Continue');
  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button[role="radio"]')].find(b => b.textContent.includes('Unpaid overtime or wages'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 200));
  await click(pg, 'Continue');
  await new Promise(r => setTimeout(r, 200));

  const result = await pg.evaluate(() => {
    const nameInput = document.querySelector('#onb-name');
    const all = Array.from(document.querySelectorAll('body *'));
    const notice = all.find(el => /saved only in this browser, on this device/.test(el.textContent) && el.children.length <= 1);
    if (!nameInput || !notice) return { found: !!notice, order: null };
    // DOCUMENT_POSITION_FOLLOWING means notice comes BEFORE nameInput in the DOM.
    const pos = notice.compareDocumentPosition(nameInput);
    return { found: true, noticeBeforeName: !!(pos & Node.DOCUMENT_POSITION_FOLLOWING) };
  });

  const problems = [];
  if (!result.found) problems.push('no shared-device privacy notice found on onboarding step 4');
  else if (!result.noticeBeforeName) problems.push('privacy notice does not appear before the name input');
  const text = await bodyText(pg);
  if (!PRIVACY_RE.test(text)) problems.push('notice text missing expected "stays on this device / until you delete it" phrasing, got: ' + text.slice(0, 500));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' first-run onboarding step 4 shows the shared-device privacy notice before the name field' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 2. Editing an existing case (data already exists, already covered by the
// Home footer + Agencies panel) does not duplicate the proactive notice.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded: true, stateSel: 'Texas', county: 'Travis County', issue: 'Unpaid overtime or wages',
    profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20' },
    caseOpened: new Date().toISOString(), homeMode: 'standard', entries: [], done: {}, messages: [],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  // Open the ◉ edit-location pill, jump straight to step 4.
  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Edit your state, county or issue'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));
  await click(pg, 'Continue');
  await click(pg, 'Continue');
  await click(pg, 'Continue');

  const text = await bodyText(pg);
  const problems = [];
  if (!text.includes('YOUR NAME') && !(await pg.$('#onb-name'))) problems.push('did not reach onboarding step 4 via edit flow');
  if (PRIVACY_RE.test(text)) problems.push('editing flow unexpectedly shows the first-run proactive privacy notice again');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' editing an existing case does not duplicate the proactive notice' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL ONBOARDING-PRIVACY-NOTICE CASES PASSED');
process.exit(fails ? 1 : 0);
