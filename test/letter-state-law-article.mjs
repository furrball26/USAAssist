#!/usr/bin/env node
/*
 * Draft-letter "a/an {state} law" article regression test (P2 FIND-19,
 * docs/audit-2026-08-29.md).
 *
 * The draft-letter "not yet verified by counsel" disclaimer hardcoded the
 * article "a" in front of the state name — "This letter cites a {stateLabel}
 * law" — which reads as "a Arizona law", "a Alabama law", "a Illinois law",
 * "a Arkansas law" for every state whose name starts with a vowel sound.
 * This is the trust-critical sentence telling the user the citation is
 * unverified, so the typo undercuts it.
 *
 * Fixed with articleFor(word), a leading-SOUND-based a/an picker (not just
 * leading-letter), which happens to matter for zero current US state names
 * (every vowel-led one really does start with a vowel sound) but is exactly
 * as cheap to write correctly and future-proofs any label this is reused
 * for.
 *
 * This drives the wage-demand letter (the one surface with `usesStateLaw`
 * gating already exercised by test/wage-state-remedy.mjs) for one
 * vowel-sound state (Arizona, via its state wage-remedy facts) and one
 * consonant-sound state (California, via its own daily-overtime statute)
 * and asserts the disclaimer reads "an Arizona law" / "a California law".
 *
 * Run: node test/letter-state-law-article.mjs
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

async function wageDemandDisclaimerText(seed) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Ask HR, in writing, for your overtime'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Wage demand/.test(b.textContent));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  const text = await pg.evaluate(() => document.body.innerText);
  await pg.close();
  return { text, errs };
}

try {

// Arizona (vowel-SOUND state name) — via its own state wage-remedy facts
// (unpaid-wages claim, rate above minimum wage — same shape as
// test/wage-state-remedy.mjs Case B, which already confirms usesStateLaw is
// true here).
{
  const seed = {
    onboarded: true, stateSel: 'Arizona', county: 'Maricopa County', issue: 'Unpaid overtime or wages',
    homeMode: 'standard', done: {}, messages: [],
    profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20' },
    caseOpened: new Date().toISOString(),
    entries: [{ date: 'JAN 5, 2026 · 9:00 AM', iso: '2026-01-05T09:00:00.000Z', title: 'Unpaid or extra hours', body: 'x', color: '#EF7B22', tag: 'Wage & hour', hours: 30, payStatus: 'unpaid' }],
  };
  const { text, errs } = await wageDemandDisclaimerText(seed);
  const problems = [];
  if (!/\bcites an Arizona law\b/.test(text)) problems.push('expected "cites an Arizona law", got: ' + (text.match(/cites\s+\w+\s+Arizona\s+law/) || ['(not found)'])[0]);
  if (/\bcites a Arizona law\b/.test(text)) problems.push('found the old broken "cites a Arizona law" wording');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Arizona (vowel-sound state) draft-letter disclaimer reads "an Arizona law"' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// California (consonant-sound state name) — via its own daily-overtime
// statute (stateAddsRealOvertimeProtection), a single week under 40 hours so
// only the daily-overtime branch of usesStateLaw fires.
{
  const seed = {
    onboarded: true, stateSel: 'California', county: 'Los Angeles County', issue: 'Unpaid overtime or wages',
    homeMode: 'standard', done: {}, messages: [],
    profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20' },
    caseOpened: new Date().toISOString(),
    entries: [{ date: 'JAN 5, 2026 · 9:00 AM', iso: '2026-01-05T09:00:00.000Z', title: 'Unpaid or extra hours', body: 'x', color: '#EF7B22', tag: 'Wage & hour', hours: 30, payStatus: 'unpaid' }],
  };
  const { text, errs } = await wageDemandDisclaimerText(seed);
  const problems = [];
  if (!/\bcites a California law\b/.test(text)) problems.push('expected "cites a California law", got: ' + (text.match(/cites\s+\w+\s+California\s+law/) || ['(not found)'])[0]);
  if (/\bcites an California law\b/.test(text)) problems.push('found an incorrect "cites an California law" wording');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' California (consonant-sound state) draft-letter disclaimer reads "a California law"' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LETTER-STATE-LAW-ARTICLE CASES PASSED');
process.exit(fails ? 1 : 0);
