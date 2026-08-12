#!/usr/bin/env node
/*
 * Issue-aware Agencies links regression test (F19).
 *
 * The federal/state agency links on the Agencies screen (formerly "Referrals",
 * before the sample attorney-firm cards were removed) must adapt to the
 * current case's issue (cfg.key) instead of always showing the same fixed
 * EEOC + DOL pair:
 *   - wage             -> DOL Wage & Hour
 *   - discrimination / harassment -> EEOC
 *   - termination      -> EEOC AND an OSHA whistleblower-complaint link
 *                          (safety retaliation, 30-day deadline)
 *   - document         -> a lawyer/bar-referral link, not a government agency
 *
 * Coverage (review-2-report.md: "agencies-links.mjs only samples one state —
 * loop a few states with distinct agency data"): each case below now uses a
 * different state, and asserts the Agencies screen shows THAT state's real
 * wage-hour/discrimination agency link (read straight from
 * content/states/<ABBR>.json, so this stays correct if the content changes)
 * — and never another state's agency link.
 *
 * Run: node test/agencies-links.mjs
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

const stateContent = (abbr) => JSON.parse(readFileSync(ROOT + `content/states/${abbr}.json`, 'utf8'));

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function agencyHrefs(state, county, issue) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:state, county, issue,
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Agencies')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));
  const hrefs = await pg.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: a.textContent })));
  await pg.close();
  return { hrefs, errs };
}

const CASES = [
  { state:'Ohio', abbr:'OH', county:'Franklin County', issue:'Unpaid overtime or wages', mustHave:[/dol\.gov/i], mustNotHave:[/findlegalhelp/i, /osha\.gov|whistleblowers\.gov/i] },
  { state:'Texas', abbr:'TX', county:'Travis County', issue:'Discrimination', mustHave:[/eeoc\.gov/i], mustNotHave:[/findlegalhelp/i, /osha\.gov|whistleblowers\.gov/i] },
  { state:'New York', abbr:'NY', county:'Kings County', issue:'Harassment or a hostile workplace', mustHave:[/eeoc\.gov/i], mustNotHave:[/findlegalhelp/i] },
  { state:'California', abbr:'CA', county:'Alameda County', issue:'Fired or pushed out', mustHave:[/eeoc\.gov/i, /osha\.gov|whistleblowers\.gov/i], mustNotHave:[/findlegalhelp/i] },
  { state:'Florida', abbr:'FL', county:'Miami-Dade County', issue:'A document to review', mustHave:[/findlegalhelp/i], mustNotHave:[/eeoc\.gov/i, /osha\.gov|whistleblowers\.gov/i, /dol\.gov/i] },
];

for (const c of CASES) {
  const { hrefs, errs } = await agencyHrefs(c.state, c.county, c.issue);
  const all = hrefs.map(h => h.href).join(' ');
  const problems = [];

  // Federal-link issue-gating (F19).
  (c.mustHave || []).forEach(re => { if (!re.test(all)) problems.push('missing expected link matching ' + re + ' — got: ' + JSON.stringify(hrefs.map(h => h.href))); });
  (c.mustNotHave || []).forEach(re => { if (re.test(all)) problems.push('unexpectedly has a link matching ' + re + ' — got: ' + JSON.stringify(hrefs.map(h => h.href))); });

  // Coverage: this state's own wage-hour/discrimination agency links must
  // appear WHEN relevant to the issue (read from content/states/<ABBR>.json,
  // not hardcoded) — and must NOT appear when irrelevant (R8: the state
  // agency links are issue-gated the same way the federal ones already are,
  // so a doc-review/harassment-only case doesn't lead with an unrelated
  // wage-agency link, and vice versa). No OTHER sampled state's agency
  // links should ever leak in.
  const st = stateContent(c.abbr);
  const ag = st.agencies || {};
  const wantsWage = c.issue === 'Unpaid overtime or wages' || c.issue === 'Fired or pushed out';
  const wantsDiscrim = c.issue === 'Discrimination' || c.issue === 'Harassment or a hostile workplace' || c.issue === 'Fired or pushed out';
  // Match on the visible label (which the app always prefixes "Wage & hour —"
  // / "Discrimination —"), not just the URL — some states reuse the same
  // agency URL for both categories (e.g. Texas Workforce Commission), so a
  // plain href substring check can't tell the two links apart.
  const hasWageLabel = hrefs.some(h => /^Wage & hour —/.test(h.text) && h.href.replace(/\/$/, '') === ag.wageHour?.url.replace(/\/$/, ''));
  const hasDiscrimLabel = hrefs.some(h => /^Discrimination —/.test(h.text) && h.href.replace(/\/$/, '') === ag.discrimination?.url.replace(/\/$/, ''));
  if (ag.wageHour && ag.wageHour.url) {
    if (wantsWage && !hasWageLabel) problems.push(`missing ${c.state}'s own wage-hour agency link (${ag.wageHour.url}) — got: ` + JSON.stringify(hrefs.map(h => h.href)));
    if (!wantsWage && hasWageLabel) problems.push(`unexpectedly has ${c.state}'s own wage-hour agency link (${ag.wageHour.url}) for an unrelated issue — got: ` + JSON.stringify(hrefs.map(h => h.href)));
  }
  if (ag.discrimination && ag.discrimination.url) {
    if (wantsDiscrim && !hasDiscrimLabel) problems.push(`missing ${c.state}'s own discrimination agency link (${ag.discrimination.url}) — got: ` + JSON.stringify(hrefs.map(h => h.href)));
    if (!wantsDiscrim && hasDiscrimLabel) problems.push(`unexpectedly has ${c.state}'s own discrimination agency link (${ag.discrimination.url}) for an unrelated issue — got: ` + JSON.stringify(hrefs.map(h => h.href)));
  }
  for (const other of CASES) {
    if (other.abbr === c.abbr) continue;
    const otherAg = stateContent(other.abbr).agencies || {};
    [otherAg.wageHour, otherAg.discrimination].forEach((entry) => {
      if (entry && entry.url && all.includes(entry.url)) {
        problems.push(`${c.state}'s Agencies screen leaked ${other.state}'s agency link (${entry.url})`);
      }
    });
  }

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + c.state + ' / ' + c.issue + ' agency links' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL AGENCIES-LINKS CASES PASSED');
process.exit(fails ? 1 : 0);
