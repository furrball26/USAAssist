#!/usr/bin/env node
/*
 * Filing deadlines appear where the reader acts (index.dev.html: Agencies).
 *
 * This is the highest-stakes fact the app holds. Deadlines vary enormously by
 * state — Texas gives 180 days to claim unpaid wages, New York gives six years,
 * a 12x spread — and a Texan who assumes "a couple of years" has already lost.
 * The app held every one of those facts and buried them in their own topic, so
 * the Agencies tab told you where to file and never how long you had. Its
 * footer even said "check the Deadlines topic before you wait", which sends
 * someone to another screen for the one fact that expires.
 *
 * What this protects:
 *   1. the deadline is ON the agency card, not one tap away,
 *   2. it is the state's own deadline where the state has one, since that is
 *      what binds a state filing,
 *   3. it carries its citation, so it is checkable rather than asserted,
 *   4. an agency with NO sourced deadline shows none — never a plausible
 *      guess, which here would be the most harmful thing the app could do.
 *
 * Run: node test/deadlines-visible.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChromePath } from './lib/chrome.mjs';
import { gotoApp } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });

const openAgencies = async (state) => {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await pg.setViewport({ width: 390, height: 900 });
  await gotoApp(pg, BASE, { place: { state, county: '—', city: '—' } });
  await new Promise(r => setTimeout(r, 1100));
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(el => /^Agencies/.test((el.textContent || '').trim()));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 900));
  const text = await pg.evaluate(() => document.body.innerText);
  await pg.close();
  return { text, errs };
};

try {
  // Two states whose wage-claim clocks differ by more than an order of magnitude.
  {
    const { text, errs } = await openAgencies('Texas');
    ok(/Your deadline to file: 180 days/.test(text),
       'Texas shows its own 180-day wage-claim deadline on the agency card');
    ok(/Tex\. Labor Code/.test(text), 'and the citation behind it, so it can be checked');
    ok(errs.length === 0, 'no console/page errors on the agencies tab' + (errs.length ? ': ' + errs[0] : ''));
  }
  {
    const { text } = await openAgencies('New York');
    ok(/Your deadline to file: 6 years/.test(text),
       'New York shows six years — the state deadline, not a federal stand-in');
  }
  {
    const { text } = await openAgencies('California');
    ok(/Your deadline to file: 3 years/.test(text), 'California shows its three-year wage-claim deadline');
    // Federal cards carry the federal clocks regardless of state.
    ok(/180 or 300 days/.test(text), 'the EEOC card carries the federal charge deadline');
    ok(/2 years \(3 if willful\)/.test(text), 'the federal wage card carries the FLSA limitations period');
    ok(/30 days/.test(text), 'the OSHA card carries its 30-day retaliation deadline');
  }
  {
    // The app ships no NLRB deadline. A guessed one here would be the most
    // harmful thing on the screen, so the card must simply carry none.
    const { text } = await openAgencies('California');
    const nlrb = text.slice(text.indexOf('National Labor Relations Board'));
    const next = nlrb.indexOf('Find an employment lawyer');
    const block = next > 0 ? nlrb.slice(0, next) : nlrb;
    ok(!/Your deadline to file/.test(block),
       'the NLRB card shows no deadline, because none is on file — never a guess');
  }
  {
    // The footer must not punt to another screen for the urgent fact.
    const { text } = await openAgencies('California');
    ok(!/check the Deadlines topic/i.test(text),
       'the page no longer sends the reader elsewhere for the deadline');
  }
} finally {
  await browser.close();
  server.close();
}

console.log(fails ? `\n❌ DEADLINES-VISIBLE FAILED (${fails})` : '\n✅ DEADLINES-VISIBLE PASSED');
process.exit(fails ? 1 : 0);
