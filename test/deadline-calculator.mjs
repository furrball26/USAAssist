#!/usr/bin/env node
/*
 * Date-anchored Deadline Calculator regression test.
 *
 * Today the Deadline Watch card only ever shows a static DURATION string from a
 * jurisdiction fact ("180 days", "2 years (3 if willful)") — the case never captures a
 * trigger/event date, so a user has no way to tell whether they have 4 days or 4 months
 * left. This suite guards the fix:
 *
 *  - profile.eventDate (optional, ISO yyyy-mm-dd, LOCAL calendar day) can be set via
 *    onboarding step 4 / the ◉ edit flow, and once set, the Deadline Watch card computes
 *    and shows a real target date + countdown ("File by <date> — about N days left"),
 *    on top of (never instead of) the existing duration text.
 *  - a target date already in the past shows the honest passed-deadline warning instead
 *    of a negative countdown.
 *  - with NO eventDate set, the card still shows the plain duration text (unchanged
 *    behavior) plus a small prompt link to add the date.
 *  - parseDeadlineWindow(value) — the text parser behind the computation — always picks
 *    the SHORTEST/most conservative period it can find (e.g. "2 years (3 if willful)"
 *    resolves to 2 years, never 3), and returns null (no fabricated date) for text that
 *    doesn't cleanly parse.
 *
 * Run: node test/deadline-calculator.mjs
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

// Same LOCAL-calendar-day formatting as the app's dateInputValue — used to build
// eventDate seeds relative to "today" so the suite never hardcodes a date that goes
// stale.
function isoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return isoDate(d); }

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function seedAndOpen(pg, profileExtra) {
  const seed = {
    onboarded: true, stateSel: 'Georgia', county: 'Fulton County', issue: 'Fired or pushed out',
    profile: Object.assign({ name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20' }, profileExtra),
    caseOpened: new Date().toISOString(), homeMode: 'standard', entries: [], done: {}, messages: [],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
}

const deadlineCardText = (pg) => pg.evaluate(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('DEADLINE WATCH') && !b.textContent.includes('OSHA'));
  return el ? el.textContent : null;
});
const pageText = (pg) => pg.evaluate(() => document.body.textContent);

// Case 1: an eventDate set 100 days ago, against Georgia's clean "180 days"
// discrimination-charge fact (deadlines.discriminationComplaint), must show a computed
// target date ("File by …") and a "days left" countdown, in addition to the existing
// "180 days" duration text.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, { eventDate: daysAgo(100) });

  const card = await deadlineCardText(pg);
  const problems = [];
  if (!card) problems.push('Deadline Watch card missing entirely');
  else {
    if (!card.includes('180 days')) problems.push('existing duration text ("180 days") is missing once a computed deadline is shown: ' + JSON.stringify(card));
    if (!/File by/.test(card)) problems.push('no computed target date ("File by …") shown: ' + JSON.stringify(card));
    if (!/days left/.test(card)) problems.push('no "days left" countdown shown: ' + JSON.stringify(card));
    if (/may have passed/.test(card)) problems.push('a still-future deadline was wrongly shown as passed: ' + JSON.stringify(card));
    if (!/confirm the exact deadline with the agency or an attorney/i.test(card)) problems.push('the estimate caveat is missing: ' + JSON.stringify(card));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' eventDate set + a "180 days" fact shows a computed target date + countdown' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: an eventDate far enough in the past that eventDate + 180 days has already
// elapsed must show the honest "may have passed" warning, never a negative countdown.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, { eventDate: daysAgo(400) });

  const card = await deadlineCardText(pg);
  const problems = [];
  if (!card) problems.push('Deadline Watch card missing entirely');
  else {
    if (!/may have passed/i.test(card)) problems.push('past deadline does not show the passed-deadline warning: ' + JSON.stringify(card));
    if (!/talk to an attorney immediately/i.test(card)) problems.push('passed-deadline warning does not tell the user to talk to an attorney immediately: ' + JSON.stringify(card));
    if (/-\d+ days left/.test(card)) problems.push('a negative day count leaked into the UI instead of the passed-deadline warning: ' + JSON.stringify(card));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' a deadline in the past shows the passed-deadline warning, not a negative countdown' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: no eventDate at all — must fall back to the existing duration-text-only
// display, plus a small prompt/link inviting the user to add the date.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, {}); // no eventDate key at all

  const card = await deadlineCardText(pg);
  const full = await pageText(pg);
  const problems = [];
  if (!card) problems.push('Deadline Watch card missing entirely');
  else {
    if (!card.includes('180 days')) problems.push('duration-text fallback ("180 days") missing with no eventDate set: ' + JSON.stringify(card));
    if (/File by|YOUR ESTIMATED DEADLINE/.test(card)) problems.push('a computed deadline was shown despite no eventDate being set: ' + JSON.stringify(card));
  }
  if (!/Add the date this happened to see your actual deadline/.test(full)) problems.push('the "add the date" prompt is missing when no eventDate is set');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' no eventDate falls back to duration text + an "add the date" prompt' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: the onboarding step-4 date field is labeled per-issue and actually persists
// into profile.eventDate via the ◉ edit flow, and the field is optional (Save is never
// blocked by leaving it empty).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, {});

  // Open the ◉ edit-location/profile flow and jump to step 4 the same way the user
  // would by tapping the "add the date" prompt.
  await pg.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Add the date this happened'));
    if (el) el.click();
  });
  await new Promise(r => setTimeout(r, 400));

  const label = await pg.evaluate(() => {
    const l = document.querySelector('label[for="onb-event-date"]');
    return l ? l.textContent : null;
  });
  const target = daysAgo(10);
  const [ty, tm, td] = target.split('-');
  await pg.evaluate(() => document.getElementById('onb-event-date').focus());
  await pg.keyboard.type(tm + td + ty, { delay: 5 }); // native date-input MMDDYYYY typing, same as the Log screen's #log-date field
  await new Promise(r => setTimeout(r, 200));
  await pg.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find(b => /Save changes/.test(b.textContent));
    if (el) el.click();
  });
  await new Promise(r => setTimeout(r, 400));

  const saved = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').profile);
  const card = await deadlineCardText(pg);

  const problems = [];
  if (!label || !/date you were let go/i.test(label)) problems.push('onboarding date field is not labeled for the termination issue: ' + JSON.stringify(label));
  if (!saved || saved.eventDate !== target) problems.push('the entered date was not saved to profile.eventDate: ' + JSON.stringify(saved));
  if (!card || !/File by/.test(card)) problems.push('the dashboard does not reflect the newly-saved eventDate: ' + JSON.stringify(card));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' the onboarding/edit-flow date field is labeled per-issue and persists to profile.eventDate' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 5: parseDeadlineWindow — the shortest/most conservative reading always wins, and
// unparseable text returns null rather than a guessed window.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);

  const results = await pg.evaluate(() => ({
    willful: window.parseDeadlineWindow('2 years (3 if willful)'),
    plain180: window.parseDeadlineWindow('180 days'),
    orForm: window.parseDeadlineWindow('180 or 300 days'),
    owbpa: window.parseDeadlineWindow('21 days to consider, 7 days to revoke'),
    unparseable: window.parseDeadlineWindow('~3-year private-suit limitation'),
    empty: window.parseDeadlineWindow(''),
    nullish: window.parseDeadlineWindow(null),
  }));

  const problems = [];
  if (!results.willful || results.willful.days !== 730) problems.push('"2 years (3 if willful)" did not resolve to the conservative 2-year (730-day) window: ' + JSON.stringify(results.willful));
  if (!results.plain180 || results.plain180.days !== 180) problems.push('"180 days" did not parse to 180: ' + JSON.stringify(results.plain180));
  if (!results.orForm || results.orForm.days !== 180) problems.push('"180 or 300 days" did not resolve to the shorter 180-day window: ' + JSON.stringify(results.orForm));
  if (!results.owbpa || results.owbpa.days !== 21) problems.push('the OWBPA "to consider" window was not read as 21, not the shorter 7-day "to revoke" window: ' + JSON.stringify(results.owbpa));
  if (results.unparseable !== null) problems.push('unparseable text ("~3-year …") should return null, not a guess: ' + JSON.stringify(results.unparseable));
  if (results.empty !== null) problems.push('empty text should return null: ' + JSON.stringify(results.empty));
  if (results.nullish !== null) problems.push('null input should return null: ' + JSON.stringify(results.nullish));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' parseDeadlineWindow always picks the shortest/conservative period, and never guesses' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DEADLINE-CALCULATOR CASES PASSED');
process.exit(fails ? 1 : 0);
