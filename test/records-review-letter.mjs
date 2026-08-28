#!/usr/bin/env node
/*
 * records-request / review-time-request letter regression test.
 *
 * qa Finding #11 (Medium, automated review #1) — the records-request letter was
 * fully generic ("within the time required by [state] law") with no citation,
 * unlike every other letter kind, even though the state's own final-pay fact
 * (e.g. TX: 6 calendar days, Tex. Labor Code § 61.014) was already fetched and
 * unused. Also covers usertest Finding #9 (High) — the unreviewed-state-law
 * caveat that should appear whenever a letter actually cites unreviewed state
 * law. Before this test, neither of records-request/review-time-request had
 * any content assertion in the suite (persona.mjs only leak-checks them).
 * Run: node test/records-review-letter.mjs
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
const problems = [];

async function letterTextFor(seed, kindLabel) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Draft a letter')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  if (kindLabel) {
    await pg.evaluate((label) => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes(label)); if (btn) btn.click(); }, kindLabel);
    await new Promise(r => setTimeout(r, 300));
  }
  const bodyText = await pg.evaluate(() => document.body.innerText);
  const letterText = await pg.evaluate(() => {
    const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
    return els.length ? els[els.length - 1].textContent : null;
  });
  await pg.close();
  errs.forEach(e => problems.push(e));
  return { letterText, bodyText };
}

// (a) Texas / "Fired or pushed out" -> records-request cites the real 6-day
// final-pay timing rule (Tex. Labor Code § 61.014), NOT the unrelated
// "final-pay.wageRecoveryLimitations" 2-year civil-suit SOL that also lives
// under the same "final-pay" topic prefix in TX's data — and shows the
// unreviewed-state-law caveat since every state is reviewed:false today.
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Harris County', issue:'Fired or pushed out',
    profile:{ name:'Jordan Lee', employer:'Acme Freight LLC', payType:'Hourly', rate:'18' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  const { letterText, bodyText } = await letterTextFor(seed, 'Records request');
  if (!letterText) problems.push('records-request letter body not found (TX)');
  else {
    if (!letterText.includes('Tex. Labor Code § 61.014')) problems.push('TX records-request letter is missing the final-pay citation: ' + JSON.stringify(letterText));
    if (!/six calendar days/i.test(letterText)) problems.push('TX records-request letter does not state the 6-calendar-day final-pay rule');
    if (letterText.includes('Tex. Labor Code § 62.202')) problems.push('TX records-request letter cited the WRONG final-pay fact (the 2-year civil-suit SOL, § 62.202) instead of the final-paycheck timing rule (§ 61.014)');
  }
  if (!/\(DRAFT\)/.test(bodyText) || !/not yet verified by counsel/i.test(bodyText)) problems.push('TX records-request letter (cites unreviewed state law) is missing the unreviewed-caveat banner: ' + JSON.stringify(bodyText.slice(0, 400)));
  console.log((letterText && letterText.includes('Tex. Labor Code § 61.014') ? '✅' : '❌') + ' Texas records-request letter cites the correct final-pay rule, not the unrelated SOL fact');
}

// (b) A generic/unmatched issue with no state selected -> records-request
// falls back to the original honest generic phrasing, with no fabricated
// citation and no caveat banner (nothing state-specific was actually cited).
{
  const seed = {
    onboarded:true, stateSel:'', county:'', issue:'Something entirely unmatched',
    profile:{ name:'Sam', employer:'Acme' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  const { letterText, bodyText } = await letterTextFor(seed, 'Records request');
  if (!letterText) problems.push('records-request letter body not found (no-state fallback)');
  else if (!/within the time required by your state law/i.test(letterText)) problems.push('no-state fallback records-request letter lost its generic phrasing: ' + JSON.stringify(letterText));
  if (/\(DRAFT\)/.test(bodyText) && /This letter cites/.test(bodyText)) problems.push('no-state fallback letter should not show the state-law caveat (nothing state-specific was cited)');
  console.log((letterText && /within the time required by your state law/i.test(letterText) ? '✅' : '❌') + ' no-state fallback keeps the honest generic phrasing, no false caveat');
}

// (c) "A document to review" -> review-time-request asks for the consider/
// revoke deadlines in writing (OWBPA-adjacent language), unaffected by the
// final-pay work above since it's a different letter kind entirely.
{
  const seed = {
    onboarded:true, stateSel:'Ohio', county:'Franklin County', issue:'A document to review',
    profile:{ name:'Casey', employer:'Northgate Co' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  const { letterText } = await letterTextFor(seed, null);
  if (!letterText) problems.push('review-time-request letter body not found');
  else {
    if (!/deadline I have to consider and sign/i.test(letterText)) problems.push('review-time-request letter is missing the consider-deadline ask: ' + JSON.stringify(letterText));
    if (!/period I have to revoke/i.test(letterText)) problems.push('review-time-request letter is missing the revocation-period ask');
  }
  console.log((letterText && /deadline I have to consider and sign/i.test(letterText) ? '✅' : '❌') + ' document-review issue drafts a real review-time-request letter');
}

await b.close();
server.close();

const ok = problems.length === 0;
if (!ok) console.log('\n   ' + problems.join('\n   '));
console.log(ok ? '\n✅ ALL RECORDS/REVIEW-TIME LETTER CASES PASSED' : '\n❌ RECORDS/REVIEW-TIME LETTER TEST FAILED');
process.exit(ok ? 0 : 1);
