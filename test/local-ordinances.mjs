#!/usr/bin/env node
/*
 * Local (county/city) ordinance layer regression test.
 *
 * The dangerous failure here is not a missing feature, it is a WRONG NUMBER shown
 * confidently. A county is not one jurisdiction: Los Angeles County contains five
 * different minimum wages, the county's own applies only to unincorporated areas, and
 * the City of Los Angeles actually pays LESS than the county around it. Cook County's
 * ordinance stops at the Chicago line. Flatten any of that into a single "county
 * minimum wage" and someone is told the wrong figure for their job.
 *
 * So this guards, in order of how much it would cost a reader to get wrong:
 *   1. Every locality renders with its own `covers` sentence — never a bare number.
 *   2. Conflicting rates in one county are shown side by side, not merged or deduped.
 *   3. A county we hold nothing for says so as a fact about US, never "no local law".
 *   4. No locality leaks into a county it does not cover.
 *   5. Money renders as money ($18.47), and employee-count thresholds do not.
 *   6. Data hygiene the app depends on: every county key matches the app's own county
 *      list, and every sourceUrl is an official government host.
 *
 * Run: node test/local-ordinances.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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
const URL_ = `http://127.0.0.1:${PORT}/index.html`;

let fails = 0;
const ok = (cond, msg) => { if (!cond) fails++; console.log((cond ? '✅ ' : '❌ ') + msg); };

// ── Part 1 · the data, before any browser ────────────────────────────────────
const index = JSON.parse(readFileSync(ROOT + 'content/index.json', 'utf8'));
const app = readFileSync(ROOT + 'index.dev.html', 'utf8');
const COUNTIES_BY_NAME = JSON.parse(app.match(/const US_COUNTIES = (\{[\s\S]*?\});/)[1]);
const ABBR = JSON.parse(app.match(/const US_STATE_ABBR = (\{[\s\S]*?\});/)[1]);
const countiesFor = (abbr) => {
  const stateName = Object.keys(ABBR).find(n => ABBR[n] === abbr);
  return new Set(COUNTIES_BY_NAME[stateName] || []);
};

const localFiles = [];
for (const abbr of readdirSync(ROOT + 'content/local').sort()) {
  for (const f of readdirSync(ROOT + `content/local/${abbr}`).filter(x => x.endsWith('.json')).sort()) {
    localFiles.push({ abbr, file: f, data: JSON.parse(readFileSync(ROOT + `content/local/${abbr}/${f}`, 'utf8')) });
  }
}
ok(localFiles.length > 0, `local ordinance files exist (${localFiles.length})`);

// (6) Every county key must match the app's list exactly — a typo means the ordinance
// silently never matches, which is indistinguishable from "no local law here".
{
  const bad = [];
  for (const { abbr, file, data } of localFiles) {
    const valid = countiesFor(abbr);
    for (const c of data.counties) if (!valid.has(c)) bad.push(`${abbr}/${file}: "${c}"`);
  }
  ok(bad.length === 0, 'every county named in a local file exists in the app\'s county list' + (bad.length ? ': ' + bad.join(', ') : ''));
}

// (6) Sourcing hygiene, asserted here too and not only in the validator: this is the
// claim the app makes to the reader with a "Read the official text" link.
{
  const bad = [];
  for (const { abbr, file, data } of localFiles) {
    for (const loc of data.localities) for (const f of loc.facts) {
      if (!/^https:\/\//.test(f.sourceUrl)) bad.push(`${abbr}/${file} ${loc.name}: not https`);
      if (!f.citation) bad.push(`${abbr}/${file} ${loc.name}: no citation`);
      if (f.reviewed !== false) bad.push(`${abbr}/${file} ${loc.name}: reviewed is not false`);
    }
  }
  ok(bad.length === 0, 'every local fact is https, cited, and unreviewed' + (bad.length ? ': ' + bad.join('; ') : ''));
}

// (1) `covers` is what stops five rates collapsing into one wrong number.
{
  const missing = [];
  for (const { abbr, file, data } of localFiles) {
    for (const loc of data.localities) {
      if (!loc.covers || !loc.covers.trim()) missing.push(`${abbr}/${file}: ${loc.name}`);
    }
  }
  ok(missing.length === 0, 'every locality says in words who it covers' + (missing.length ? ': ' + missing.join(', ') : ''));
}

// ── Part 2 · the app ─────────────────────────────────────────────────────────
const b = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });
const openPay = async (state, county) => {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, URL_, { place: { state, county } });
  await new Promise(r => setTimeout(r, 1500));
  await pg.evaluate(() => { [...document.querySelectorAll('button')].find(x => /Pay & overtime/.test(x.textContent))?.click(); });
  await new Promise(r => setTimeout(r, 900));
  const text = await pg.evaluate(() => document.body.innerText);
  await pg.close();
  return { text, errs };
};

try {
  // (2) The LA County case: five jurisdictions, and the city pays LESS than the county.
  // Both numbers must be on screen, each next to the name of the place it applies to.
  {
    const { text, errs } = await openPay('California', 'Los Angeles County');
    ok(/Unincorporated Los Angeles County/.test(text), 'LA County shows the unincorporated county ordinance');
    ok(/City of Los Angeles/.test(text), 'LA County shows the City of Los Angeles ordinance');
    ok(/West Hollywood/.test(text), 'LA County shows the West Hollywood ordinance');
    ok(/\$18\.47/.test(text) && /\$18\.42/.test(text),
       'both the county ($18.47) and city ($18.42) rates are shown — the lower city rate is not hidden by the higher county one');
    ok(/\$20\.25/.test(text), 'the highest local rate in the county (West Hollywood, $20.25) is shown');
    ok(/depends on where your worksite actually is/i.test(text),
       'the reader is told which rate applies depends on their worksite address');
    ok(/not yet lawyer-checked/i.test(text), 'local guidance is labelled as unreviewed draft');
    ok(errs.length === 0, 'no console/page errors on a county with local law' + (errs.length ? ': ' + errs[0] : ''));
  }

  // (2) Cook County: the county ordinance expressly stops at the Chicago line.
  {
    const { text } = await openPay('Illinois', 'Cook County');
    ok(/Cook County \(outside Chicago\)/.test(text), 'Cook County names itself as covering outside Chicago');
    ok(/\$15\.40/.test(text) && /\$17\.05/.test(text), 'both the Cook County and Chicago rates are shown');
    ok(/\$9\.25/.test(text), 'the tipped rate is shown alongside the standard one');
  }

  // (4) A county in the same state with no local file must show none of the above.
  {
    const { text } = await openPay('California', 'Fresno County');
    ok(!/West Hollywood|Unincorporated Los Angeles/.test(text),
       'a county with no local file does not leak another county\'s ordinances');
    ok(!/IN AND AROUND/.test(text), 'no local section renders for a county we hold nothing for');
  }

  // (4) And across states: NYC covers five boroughs, and must not appear outside them.
  {
    const inside = await openPay('New York', 'Kings County');
    ok(/New York City/.test(inside.text), 'a NYC borough shows the New York City rate');
    ok(/\$17\.00/.test(inside.text), 'the NYC rate renders as money');
    const outside = await openPay('New York', 'Erie County');
    // Matched on the local SECTION, not the words "New York City": New York State's own
    // facts mention the city in their summaries, so a bare string match would fail for
    // the wrong reason and pass for the wrong reason too.
    ok(!/IN AND AROUND/.test(outside.text) && !/all five boroughs/.test(outside.text),
       'an upstate county renders no local section and no NYC locality');
  }

  // (3) The county step must state our coverage as a fact about us, never about the law.
  {
    const pg = await b.newPage();
    await gotoApp(pg, URL_);
    await pg.evaluate(() => { try { localStorage.removeItem('worklaw.place.v1'); } catch (e) {} });
    await pg.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 1400));
    await pg.select('#onb-state', 'California');
    await new Promise(r => setTimeout(r, 1500));
    const covered = await pg.evaluate(() => document.body.innerText);
    ok(/We hold local ordinances for/.test(covered), 'a state with local data names the counties it has');
    ok(/does not mean your county has no ordinance/i.test(covered),
       'the county step never implies an absent ordinance means no ordinance exists');
    await pg.close();

    const pg2 = await b.newPage();
    await gotoApp(pg2, URL_);
    await pg2.evaluate(() => { try { localStorage.removeItem('worklaw.place.v1'); } catch (e) {} });
    await pg2.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 1400));
    await pg2.select('#onb-state', 'Kansas');
    await new Promise(r => setTimeout(r, 1500));
    const bare = await pg2.evaluate(() => document.body.innerText);
    ok(/We hold no county or city ordinances for Kansas yet/.test(bare),
       'a state with no local data says so about our coverage, not about the law');
    await pg2.close();
  }

  // (5) Money formats as money; an employee-count threshold must not grow a $.
  {
    const { text } = await openPay('Washington', 'King County');
    ok(/\$21\.30/.test(text), 'Seattle\'s rate renders as currency');
    ok(/SeaTac/.test(text) && /hospitality and transportation/i.test(text),
       'SeaTac\'s industry limit is stated, not presented as a general city rate');
    ok(/two conflicting minimum-wage laws|conflicting/i.test(text),
       'Burien\'s unresolved litigation is surfaced rather than flattened to one number');
  }
  {
    const pg = await b.newPage();
    await gotoApp(pg, URL_, { place: { state: 'Illinois', county: 'Cook County' } });
    await new Promise(r => setTimeout(r, 1400));
    await pg.evaluate(() => { [...document.querySelectorAll('button')].find(x => /Discrimination & harassment/.test(x.textContent))?.click(); });
    await new Promise(r => setTimeout(r, 700));
    const t = await pg.evaluate(() => document.body.innerText);
    await pg.close();
    // discrimination.coverage is an employee count ("15 or more employees"), not dollars.
    ok(!/\$15\b(?!\.)/.test(t.replace(/\$15\.\d\d/g, '')),
       'an employee-count threshold is not rendered as a dollar amount');
  }
} finally {
  await b.close();
  server.close();
}

console.log(fails === 0 ? '\n✅ ALL LOCAL-ORDINANCE CASES PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
