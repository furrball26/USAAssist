#!/usr/bin/env node
/*
 * FIND-11 (docs/audit-2026-08-29.md) — after a user logs "Requested
 * accommodation" then "Accommodation denied" in the ADA tracker (profile.adaLog
 * — see AdaProcessTracker), the accommodation-request letter was still written in
 * first-ask future tense ("I am requesting... I understand this begins an
 * interactive process") and the complaint letter never mentioned the ADA,
 * disability, or the logged denial at all — neither letter reflected the work
 * the user already did in the tracker.
 *
 * Guards:
 *   1. With a logged requested+denied ADA history, the accommodation-request
 *      letter acknowledges the PRIOR request/denial (not first-ask language)
 *      and references the actual logged dates.
 *   2. With that same history, the complaint letter mentions the ADA/disability
 *      denial specifically, not just generic Title VII boilerplate.
 *   3. With NO ADA log at all, both letters render exactly as before (first-ask
 *      accommodation-request wording; no ADA-specific line added to the
 *      complaint letter) — this only ever ADDS information when the log
 *      actually has it, never removes/breaks the baseline letters.
 *
 * Run: node test/ada-log-letter-content.mjs
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

const openLetter = async (pg, kindLabel) => {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Draft a letter')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate((label) => { const btn = [...document.querySelectorAll('button')].find(x => x.textContent.includes(label)); if (btn) btn.click(); }, kindLabel);
  await new Promise(r => setTimeout(r, 300));
  return await pg.evaluate(() => {
    const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
    return els.length ? els[els.length - 1].textContent : null;
  });
};

const seedBase = {
  onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Discrimination',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
};

try {

// 1/2. With a requested+denied ADA history, both letters reflect it.
{
  const seed = Object.assign({}, seedBase, {
    profile: Object.assign({}, seedBase.profile, {
      adaLog: [
        { date:'2026-07-01', what:'requested', notes:'need a flexible start time' },
        { date:'2026-07-20', what:'denied', notes:'manager said scheduling would not allow it' },
      ],
    }),
  });
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  const accText = await openLetter(pg, 'Accommodation request');
  const problems = [];
  if (!accText) problems.push('accommodation-request letter body not found');
  else {
    if (/^I am requesting a reasonable accommodation/.test(accText.split('To whom it may concern:')[1] || '')) problems.push('accommodation-request letter still uses bare first-ask wording despite a logged denial');
    if (!/denied/i.test(accText)) problems.push('accommodation-request letter does not mention the logged denial: ' + JSON.stringify(accText.slice(0, 400)));
    if (!/2026-07-20|July 20, 2026|Jul(y)? 20/i.test(accText)) problems.push('accommodation-request letter does not reference the actual logged denial date');
  }

  await pg.evaluate(() => { const b2 = [...document.querySelectorAll('button')].find(x => x.textContent === 'Home'); b2 && b2.click(); });
  await new Promise(r => setTimeout(r, 300));
  const complaintText = await openLetter(pg, 'Complaint letter');
  if (!complaintText) problems.push('complaint letter body not found');
  else {
    if (!/(ADA|Americans with Disabilities Act|disability)/i.test(complaintText)) problems.push('complaint letter still never mentions the ADA/disability despite a logged denial: ' + JSON.stringify(complaintText.slice(0, 400)));
    if (!/denied|denial/i.test(complaintText)) problems.push('complaint letter does not reference the logged accommodation denial');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' logged ADA request+denial is reflected in both the accommodation-request and complaint letters' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. With no ADA log at all, both letters keep their original baseline wording.
{
  const seed = seedBase;
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  const accText = await openLetter(pg, 'Accommodation request');
  const problems = [];
  if (!accText || !/I am requesting a reasonable accommodation/.test(accText)) problems.push('baseline accommodation-request letter (no ADA log) lost its first-ask wording: ' + JSON.stringify((accText || '').slice(0, 400)));
  if (!accText || !/interactive process/i.test(accText)) problems.push('baseline accommodation-request letter (no ADA log) lost its interactive-process line');

  await pg.evaluate(() => { const b2 = [...document.querySelectorAll('button')].find(x => x.textContent === 'Home'); b2 && b2.click(); });
  await new Promise(r => setTimeout(r, 300));
  const complaintText = await openLetter(pg, 'Complaint letter');
  if (complaintText && /denied|denial/i.test(complaintText)) problems.push('baseline complaint letter (no ADA log) wrongly references a denial that was never logged');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' baseline letters (no ADA log) are unchanged' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}

if (fails) { console.error(`\n${fails} check(s) failed.`); process.exit(1); }
console.log('\nAll ada-log-letter-content checks passed.');
