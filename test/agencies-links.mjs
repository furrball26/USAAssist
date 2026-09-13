#!/usr/bin/env node
/*
 * Agencies directory regression test.
 *
 * The Agencies tab is a directory of who enforces employment law, free to
 * contact. It used to gate its links on the case's declared issue; there is no
 * case now, so every reader sees the whole directory — which is the point: who
 * the right agency is depends on facts this site deliberately does not ask for.
 *
 * What must hold for each sampled state:
 *   - the four federal agencies (DOL WHD, EEOC, OSHA, NLRB) are all present;
 *   - THAT state's own agency links appear, read straight from
 *     content/states/<ABBR>.json so this stays correct if the content changes;
 *   - no OTHER state's agency links leak in;
 *   - the retaliation warning is shown before the links, since someone weighing
 *     whether to file needs to know complaining is itself protected.
 *
 * Run: node test/agencies-links.mjs
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

const stateContent = (abbr) => JSON.parse(readFileSync(ROOT + `content/states/${abbr}.json`, 'utf8'));

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function agencyScreen(state, county) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: { state, county } });
  await new Promise(r => setTimeout(r, 800));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Agencies')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 500));
  const hrefs = await pg.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: a.textContent })));
  const text = await pg.evaluate(() => document.body.innerText);
  await pg.close();
  return { hrefs, text, errs };
}

// Four states with genuinely different agency data behind them.
const CASES = [
  { state:'Ohio',       abbr:'OH', county:'Franklin County' },
  { state:'Texas',      abbr:'TX', county:'Travis County' },
  { state:'New York',   abbr:'NY', county:'Kings County' },
  { state:'California', abbr:'CA', county:'Alameda County' },
];

// Every reader gets the full federal set — the site no longer guesses which
// one is theirs.
const FEDERAL = [/dol\.gov/i, /eeoc\.gov/i, /osha\.gov/i, /nlrb\.gov/i];

for (const c of CASES) {
  const { hrefs, text, errs } = await agencyScreen(c.state, c.county);
  const all = hrefs.map(h => h.href).join(' ');
  const problems = [];

  FEDERAL.forEach(re => {
    if (!re.test(all)) problems.push('missing federal agency link matching ' + re + ' — got: ' + JSON.stringify(hrefs.map(h => h.href)));
  });

  if (!/protected from retaliation/i.test(text)) {
    problems.push('the retaliation warning is missing from the agencies screen');
  }

  // This state's own agencies, whatever the dataset happens to list.
  const ag = stateContent(c.abbr).agencies || {};
  Object.entries(ag).forEach(([key, entry]) => {
    if (!entry || !entry.url) return;
    if (!all.includes(entry.url)) {
      problems.push(`missing ${c.state}'s own ${key} agency link (${entry.url}) — got: ` + JSON.stringify(hrefs.map(h => h.href)));
    }
  });

  for (const other of CASES) {
    if (other.abbr === c.abbr) continue;
    const otherAg = stateContent(other.abbr).agencies || {};
    Object.values(otherAg).forEach((entry) => {
      // Some states genuinely share a URL with another (one agency, two roles),
      // so only a URL this state does NOT itself list counts as a leak.
      const ownUrls = Object.values(ag).map(e => e && e.url).filter(Boolean);
      if (entry && entry.url && !ownUrls.includes(entry.url) && all.includes(entry.url)) {
        problems.push(`${c.state}'s Agencies screen leaked ${other.state}'s agency link (${entry.url})`);
      }
    });
  }

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + c.state + ' agency directory' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL AGENCIES-LINKS CASES PASSED');
process.exit(fails ? 1 : 0);
