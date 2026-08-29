#!/usr/bin/env node
/*
 * Wizard result-summary plain-language regression test (P2 FIND-18,
 * docs/audit-2026-08-29.md).
 *
 * The wage/harassment/discrimination self-check trees each render a trail of
 * pills above the RESULT card, one per answer given, so the user can see the
 * path that led to their result. Those pills used to carry raw internal
 * option tags — ALL-CAPS, code-like strings such as "SALARY", "≥ $684/WK",
 * "< $107,432/YR", "ROUTINE TASKS" — set in IBM Plex Mono, reading as
 * internal debug output rather than a plain-language answer review. The
 * tree options now carry short plain-language phrases instead.
 *
 * This drives the wage tree to a highly-compensated-employee terminal result
 * (the exact path the audit quoted) and asserts:
 *   - none of the OLD terse/code-like tags appear anywhere on the page
 *   - the pill trail instead reads in plain language
 *
 * Run: node test/wizard-plain-language-summary.mjs
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

// The exact terse/code-like tags the audit quoted (FIND-18) — none of these
// should ever appear on the rendered page again.
const OLD_CODE_TAGS = ['SALARY', '≥ $684/WK', '< $107,432/YR', 'ROUTINE TASKS', 'HCE DUTY: YES', 'HCE DUTY: NO'];

try {

const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

const seed = {
  onboarded: true, stateSel: 'Texas', county: 'Travis County', issue: 'Unpaid overtime or wages',
  profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Salary', rate: '' },
  caseOpened: new Date().toISOString(), homeMode: 'standard', done: {}, messages: [], entries: [],
};
await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
await new Promise(r => setTimeout(r, 700));

await click(pg, 'Am I exempt from overtime?');
await click(pg, 'A fixed salary every period');
await click(pg, 'Yes, $684/week or more');
await click(pg, 'Yes, $107,432/year or more');
await click(pg, 'Yes, at least one of those');

const text = await bodyText(pg);
const problems = [];
if (!/Meets the \$684\/week federal floor/.test(text)) problems.push('expected the plain-language salary-floor phrase, got: ' + text.slice(0, 400));
if (!/Meets the \$107,432\/year HCE threshold/.test(text)) problems.push('expected the plain-language HCE-threshold phrase');
if (!/Paid a salary/.test(text)) problems.push('expected the plain-language "Paid a salary" phrase');
OLD_CODE_TAGS.forEach(tag => { if (text.includes(tag)) problems.push('found old code-like tag still on page: "' + tag + '"'); });
errs.forEach(e => problems.push(e));

const ok = problems.length === 0;
if (!ok) fails++;
console.log((ok ? '✅' : '❌') + ' wage wizard result summary uses plain-language phrases, not internal tags' + (ok ? '' : '\n   ' + problems.join('\n   ')));
await pg.close();

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL WIZARD-PLAIN-LANGUAGE-SUMMARY CASES PASSED');
process.exit(fails ? 1 : 0);
