#!/usr/bin/env node
/*
 * Date/start-end time logging regression test.
 *
 * The "Hours worked" log entry now lets a wage user pick the DATE the hours
 * were worked (driving the entry's iso, so weekStartKey groups it into the
 * right workweek) and a start/end time, which COMPUTES the hours (rounded to
 * the nearest 0.25) instead of requiring a manual number. Covers:
 *   (a) picking a date sets the entry's workweek correctly, and that correctly
 *       feeds the owed-amount estimate via computeOwedBreakdown/weekStartKey;
 *   (b) start+end time compute the right hours (incl. an overnight shift) and
 *       that computed value — not a stale manual figure — feeds the letter's
 *       owed estimate;
 *   (c) the manual-hours fallback still works when start/end are left blank;
 *   (d) editing an entry repopulates its date/start/end.
 *
 * Run: node test/log-hours-time.mjs
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

const baseSeed = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
};

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

async function freshLogPage(seed) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Log an incident')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return { pg, errs };
}

async function typeIntoField(pg, selector, text) {
  await pg.evaluate((sel) => document.querySelector(sel).focus(), selector);
  await pg.keyboard.type(text, { delay: 5 });
}

async function readEntries(pg) {
  return pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').entries || []);
}

try {

// Case (a) + (c): picking a date sets the entry's workweek correctly, and
// the manual-hours fallback (no start/end set) still feeds the right numbers
// into computeOwedBreakdown's workweek grouping and owed-amount estimate.
{
  const { pg, errs } = await freshLogPage(baseSeed);

  // Entry 1: Jan 5, 2026 (Monday; Sunday-start week = 2026-01-04), 10 hrs, unpaid.
  await typeIntoField(pg, '#log-date', '01052026');
  await typeIntoField(pg, '#log-hours', '10');
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  // Entry 2: Jan 12, 2026 (a different workweek; Sunday-start = 2026-01-11),
  // 6 hrs, paid straight-time only.
  await typeIntoField(pg, '#log-date', '01122026');
  await typeIntoField(pg, '#log-hours', '6');
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Paid straight-time only'); if (btn) btn.click(); });
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const stored = await readEntries(pg);
  const problems = [];
  if (stored.length !== 2) problems.push('expected 2 stored entries, got ' + stored.length);
  const e1 = stored.find(e => e.hours === 10), e2 = stored.find(e => e.hours === 6);
  // Compare local calendar dates (not the UTC-rendered iso string, which can
  // print a different calendar day than the LOCAL one the date picker set,
  // depending on the machine's timezone — weekStartKey decodes iso back into
  // local components, so it's the local day that must match what was picked).
  const localDate = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  if (!e1 || localDate(e1.iso) !== '2026-01-05') problems.push('10hr entry did not get the picked date (2026-01-05) as its local iso date: ' + JSON.stringify(e1));
  if (!e2 || localDate(e2.iso) !== '2026-01-12') problems.push('6hr entry did not get the picked date (2026-01-12) as its local iso date: ' + JSON.stringify(e2));

  // Pill shows 2 distinct workweeks (weekStartKey groups by picked date, not "now").
  const pillText = await pg.evaluate(() => { const s = [...document.querySelectorAll('span')].find(s => /HRS LOGGED/.test(s.textContent)); return s ? s.textContent : null; });
  if (!pillText || !/16 HRS LOGGED/.test(pillText) || !/2 WORKWEEKS/.test(pillText)) problems.push('expected "16 HRS LOGGED · 2 WORKWEEKS", got: ' + JSON.stringify(pillText));

  // The owed estimate downstream (Letter screen) reflects the date-driven
  // workweek split. Neither week reaches the 40-hr/week overtime threshold, so
  // the 10 unpaid hours are owed at 1x ($200) and the 6 already-straight-paid
  // hours owe nothing further (correctly paid) — total $200, across "2 separate
  // workweeks". (Pre-fix, this used to be miscalculated as 10*20*1.5 + 6*20*0.5 =
  // $360, wrongly treating both under-40-hr weeks as if they were overtime.)
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Home'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Draft a letter')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Wage demand/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const letterText = await pg.evaluate(() => {
    const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
    return els.length ? els[els.length - 1].textContent : null;
  });
  if (!letterText) problems.push('wage-demand letter body not found');
  else {
    if (!letterText.includes('$200.00')) problems.push('expected owed estimate $200.00 from the date-driven workweek split, got: ' + JSON.stringify(letterText));
    if (!letterText.includes('2 separate workweeks')) problems.push('expected "2 separate workweeks" grouping text, got: ' + JSON.stringify(letterText));
    if (letterText.includes('$360.00')) problems.push('letter shows the OLD overstated figure ($360.00), ignoring that neither week crossed the 40-hr overtime threshold');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' (a)+(c) picked date drives the workweek grouping & owed estimate; manual-hours fallback works' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case (b): start+end time compute the right hours (incl. an overnight shift)
// and the computed value feeds the owed estimate — not a stale manual figure.
{
  const { pg, errs } = await freshLogPage(baseSeed);

  await typeIntoField(pg, '#log-start', '0900AM');
  await typeIntoField(pg, '#log-end', '0530PM');
  const liveText = await pg.evaluate(() => { const p = [...document.querySelectorAll('p')].find(p => p.textContent.includes('Time logged')); return p ? p.textContent : null; });

  // The manual "Hours" field must not be shown/used once start/end are set —
  // the computed value wins, so the two can never disagree.
  const manualFieldHidden = await pg.evaluate(() => !document.querySelector('#log-hours'));

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const stored = await readEntries(pg);
  const e = stored[0];

  const problems = [];
  if (!liveText || !/Time logged: 8\.5 hours/.test(liveText)) problems.push('expected live "Time logged: 8.5 hours", got: ' + JSON.stringify(liveText));
  if (!manualFieldHidden) problems.push('manual #log-hours field is still shown/editable once start+end are both set');
  if (!e || e.hours !== 8.5) problems.push('expected the stored entry to have the COMPUTED 8.5 hours, got: ' + JSON.stringify(e));
  if (!e || e.startTime !== '09:00' || e.endTime !== '17:30') problems.push('expected startTime/endTime stored on the entry, got: ' + JSON.stringify(e));

  // Overnight: an end time at/before the start time is treated as crossing
  // midnight (+24h), not rejected — 10:00 PM to 6:00 AM = 8 hours.
  await pg.evaluate(() => { document.querySelector('#log-start').focus(); });
  await pg.keyboard.type('1000PM', { delay: 5 });
  await pg.evaluate(() => { document.querySelector('#log-end').focus(); });
  await pg.keyboard.type('0600AM', { delay: 5 });
  const overnightText = await pg.evaluate(() => { const p = [...document.querySelectorAll('p')].find(p => p.textContent.includes('Time logged')); return p ? p.textContent : null; });
  if (!overnightText || !/Time logged: 8 hours/.test(overnightText) || !/overnight/i.test(overnightText)) problems.push('expected an overnight "Time logged: 8 hours" reading with an overnight note, got: ' + JSON.stringify(overnightText));

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' (b) start/end time compute the right hours, including an overnight shift, and win over manual entry' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case (d): editing an entry repopulates its date/start/end.
{
  const seed = Object.assign({}, baseSeed, {
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'a shift', color:'#EF7B22', tag:'Wage & hour', hours:8.5, payStatus:'unpaid', startTime:'09:00', endTime:'17:30' }],
  });
  const { pg, errs } = await freshLogPage(seed);
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Edit entry from JAN 5, 2026 · 9:00 AM'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const prefilled = await pg.evaluate(() => ({
    date: document.querySelector('#log-date')?.value,
    start: document.querySelector('#log-start')?.value,
    end: document.querySelector('#log-end')?.value,
  }));
  const timelineShowsRange = await pg.evaluate(() => [...document.querySelectorAll('p')].some(p => /9:00 AM.*5:30 PM/.test(p.textContent)));

  const problems = [];
  if (prefilled.date !== '2026-01-05') problems.push('edit form did not pre-fill the date, got: ' + JSON.stringify(prefilled));
  if (prefilled.start !== '09:00') problems.push('edit form did not pre-fill the start time, got: ' + JSON.stringify(prefilled));
  if (prefilled.end !== '17:30') problems.push('edit form did not pre-fill the end time, got: ' + JSON.stringify(prefilled));
  if (!timelineShowsRange) problems.push('the log timeline does not show the 9:00 AM–5:30 PM start-end range for the entry');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' (d) editing an Hours entry repopulates date/start/end, and the timeline shows the time range' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LOG-HOURS-TIME CASES PASSED');
process.exit(fails ? 1 : 0);
