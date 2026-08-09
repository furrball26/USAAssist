#!/usr/bin/env node
/*
 * Issue-aware Referrals links regression test (F19).
 *
 * The four federal/lawyer links on the Referrals (Lawyers) screen must adapt
 * to the current case's issue (cfg.key) instead of always showing the same
 * fixed EEOC + DOL pair:
 *   - wage             -> DOL Wage & Hour
 *   - discrimination / harassment -> EEOC
 *   - termination      -> EEOC AND an OSHA whistleblower-complaint link
 *                          (safety retaliation, 30-day deadline)
 *   - document         -> a lawyer/bar-referral link, not a government agency
 *
 * Run: node test/referrals-links.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

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

async function referralHrefs(issue) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Ohio', county:'Franklin County', issue,
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Referrals')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));
  const hrefs = await pg.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: a.textContent })));
  await pg.close();
  return { hrefs, errs };
}

const CASES = [
  { issue:'Unpaid overtime or wages', mustHave:[/dol\.gov/i], mustNotHave:[/findlegalhelp/i, /osha\.gov|whistleblowers\.gov/i] },
  { issue:'Discrimination', mustHave:[/eeoc\.gov/i], mustNotHave:[/findlegalhelp/i, /osha\.gov|whistleblowers\.gov/i] },
  { issue:'Harassment or a hostile workplace', mustHave:[/eeoc\.gov/i], mustNotHave:[/findlegalhelp/i] },
  { issue:'Fired or pushed out', mustHave:[/eeoc\.gov/i, /osha\.gov|whistleblowers\.gov/i], mustNotHave:[/findlegalhelp/i] },
  { issue:'A document to review', mustHave:[/findlegalhelp/i], mustNotHave:[/eeoc\.gov/i, /osha\.gov|whistleblowers\.gov/i, /dol\.gov/i] },
];

for (const c of CASES) {
  const { hrefs, errs } = await referralHrefs(c.issue);
  const all = hrefs.map(h => h.href).join(' ');
  const problems = [];
  (c.mustHave || []).forEach(re => { if (!re.test(all)) problems.push('missing expected link matching ' + re + ' — got: ' + JSON.stringify(hrefs.map(h => h.href))); });
  (c.mustNotHave || []).forEach(re => { if (re.test(all)) problems.push('unexpectedly has a link matching ' + re + ' — got: ' + JSON.stringify(hrefs.map(h => h.href))); });
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + c.issue + ' referral links' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL REFERRALS-LINKS CASES PASSED');
process.exit(fails ? 1 : 0);
