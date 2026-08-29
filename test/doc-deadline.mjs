#!/usr/bin/env node
/*
 * Document/severance Home "Deadline Watch" regression test (R10).
 *
 * deadlineKeywordsFor('document') returns [] — there's no jurisdiction
 * "deadlines" fact for a document-review/severance case — so
 * pickDeadlineFactAcross was always null and these users got NO Deadline
 * Watch card on Home at all, unlike every other issue type. A generic,
 * clearly non-jurisdiction-sourced OWBPA note (21 days to consider / 7 days
 * to revoke, 29 U.S.C. §626(f)) must appear instead, in all three Home
 * modes, and must NOT appear for other issue types.
 *
 * Run: node test/doc-deadline.mjs
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

try {

async function seedAndOpen(issue, homeMode) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Ohio', county:'Franklin County', issue,
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode, entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return { pg, errs };
}

const docCardText = (pg) => pg.evaluate(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('GENERAL FEDERAL RULE'));
  return el ? el.textContent : null;
});

// Case 1: a document-review case shows the generic OWBPA card in all three
// Home modes.
for (const mode of ['standard', 'action', 'plain']) {
  const { pg, errs } = await seedAndOpen('A document to review', mode);
  const card = await docCardText(pg);
  const problems = [];
  if (!card) problems.push('no OWBPA Deadline Watch card for a document issue in home mode "' + mode + '"');
  else {
    if (!/21 days/.test(card)) problems.push('card does not show the 21-day figure: ' + JSON.stringify(card));
    if (!/7 days/.test(card)) problems.push('card does not show the 7-day figure: ' + JSON.stringify(card));
  }
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' document issue home mode "' + mode + '" shows the OWBPA Deadline Watch card' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: a non-document issue (e.g. wage) must NOT show this card.
{
  const { pg, errs } = await seedAndOpen('Unpaid overtime or wages', 'standard');
  const card = await docCardText(pg);
  const problems = [];
  if (card) problems.push('OWBPA card wrongly shown for a non-document (wage) issue: ' + JSON.stringify(card));
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' wage issue does not show the document OWBPA card' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DOC-DEADLINE CASES PASSED');
process.exit(fails ? 1 : 0);
