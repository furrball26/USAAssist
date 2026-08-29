#!/usr/bin/env node
/*
 * FIND-06 (docs/audit-2026-08-29.md) — onboarding's "Skip to dashboard" leaves
 * stateSel/issue unset. Since pickDeadlineFactAcross has nothing to key off, every
 * Home mode previously rendered NO Deadline Watch card and gave no indication
 * anything was missing — silently dropping the app's most time-critical widget for
 * exactly the hurried user that shortcut targets.
 *
 * Guards:
 *   1. After "Skip to dashboard" (no state/issue on file), each of the three home
 *      modes (Standard/Action-first/Plain) shows a visible "Add your state to see
 *      your filing deadline" CTA in the Deadline Watch slot.
 *   2. That CTA routes back to the state-selection onboarding step.
 *   3. A fully set-up wage case (state + issue on file, a real deadline fact
 *      exists) shows the REAL Deadline Watch card, not the missing-state CTA.
 *   4. A fully set-up case whose issue legitimately has no deadline concept
 *      (document review — deadlineKeywordsFor returns []) does NOT show the
 *      missing-state CTA, since state/issue ARE on file — only the fact lookup
 *      came back empty, which is a true "no applicable deadline here."
 *
 * Run: node test/home-missing-deadline-cta.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
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
const chrome = execSync(`find "${ROOT}chrome-headless-shell" -type f -name 'chrome-headless-shell' | head -1`).toString().trim();

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;
const click = async (pg, t) => { const ok = await pg.evaluate((x) => { const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.includes(x)); if (e) { e.click(); return true; } return false; }, t); await new Promise(r => setTimeout(r, 300)); return ok; };
const bodyText = async (pg) => await pg.evaluate(() => document.body.innerText);
const CTA_TEXT = 'Add your state to see your filing deadline';

try {

// 1/2. "Skip to dashboard" — CTA appears in all three home modes and routes back
//      to state selection.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await click(pg, 'Skip to dashboard');

  const problems = [];
  for (const mode of ['Standard', 'Action-first', 'Plain']) {
    await click(pg, mode);
    const txt = await bodyText(pg);
    if (!txt.includes(CTA_TEXT)) problems.push(mode + ' home mode is missing the "' + CTA_TEXT + '" CTA after Skip to dashboard');
  }
  // Back on Standard (default), click the CTA and confirm it routes to state selection.
  await click(pg, 'Standard');
  const clicked = await click(pg, CTA_TEXT);
  if (!clicked) problems.push('CTA button not clickable');
  const afterTxt = await bodyText(pg);
  if (!/Where do you work/i.test(afterTxt)) problems.push('CTA did not route back to the state-selection onboarding step, got: ' + JSON.stringify(afterTxt.slice(0, 200)));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "Skip to dashboard" shows the missing-state Deadline Watch CTA in every home mode, and it routes back to state selection' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. A fully set-up wage case (real deadline fact) shows the REAL card, not the CTA.
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const txt = await bodyText(pg);
  const problems = [];
  if (txt.includes(CTA_TEXT)) problems.push('a fully set-up wage case wrongly shows the missing-state CTA');
  if (!txt.includes('DEADLINE WATCH')) problems.push('a fully set-up wage case is missing the real Deadline Watch card entirely');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' a fully set-up wage case shows the real Deadline Watch card, not the missing-state CTA' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 4. A fully set-up document-review case (no deadline concept for this issue) does
//    NOT show the missing-state CTA — state/issue ARE on file.
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'A document to review',
    profile:{ name:'Pat Vega', employer:'Northgate Co' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const txt = await bodyText(pg);
  const problems = [];
  if (txt.includes(CTA_TEXT)) problems.push('a fully set-up document-review case wrongly shows the missing-state CTA (state/issue are already on file)');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' a fully set-up document-review case (no deadline concept) does not show the missing-state CTA' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}

if (fails) { console.error(`\n${fails} check(s) failed.`); process.exit(1); }
console.log('\nAll home-missing-deadline-cta checks passed.');
