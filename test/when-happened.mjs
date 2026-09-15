#!/usr/bin/env node
/*
 * "When did this happen?" — the date step and the elapsed-time line it buys
 * (index.dev.html: monthsSince, shortestDeadlineDays, deadlineElapsed,
 * WhenPicker, ElapsedNote).
 *
 * The premise this suite protects is a limit, not a feature. content/ holds
 * ONE value per fact — today's — with no effectiveFrom anywhere, so this app
 * cannot say what the minimum wage was in March 2024 and must never appear to.
 * What a date can honestly do is put the reader's own elapsed time next to the
 * filing clock already on screen, which is the one fact here that cannot be
 * recovered once it runs out.
 *
 * Part 1 drives the pure functions out of source against the deadline values
 * that are really in content/ — prose with conditions, not numbers. The
 * property that matters most is an ASYMMETRY: the code may warn someone who
 * still has time, and must never reassure someone who does not.
 *
 * Part 2 drives the screens: the question is optional everywhere, the reading
 * lands per agency rather than once, and a reader who says nothing loses
 * nothing.
 *
 * Run: node test/when-happened.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChromePath } from './lib/chrome.mjs';
import { gotoApp } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

// ── Part 1 · the arithmetic, in isolation ───────────────────────────────────
const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
// Pulled out of the source rather than reimplemented here: a copy in the test
// would happily agree with itself while the app drifted.
const grab = (name) => {
  const m = dev.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}\\n'));
  if (!m) { console.log('❌ could not find ' + name + ' in index.dev.html'); process.exit(1); }
  return m[0];
};
const support = 'function factValStr(v){ return Array.isArray(v) ? v.join(", ") : (v == null ? "" : String(v)); }\n' +
  'const DURATION_DAYS = { day: 1, week: 7, month: 30, year: 365 };\n';
const { parseYM, monthsSince, elapsedLabel, shortestDeadlineDays, deadlineElapsed } = (0, eval)(
  '(function(){' + support + grab('parseYM') + grab('monthsSince') + grab('elapsedLabel') +
  grab('shortestDeadlineDays') + grab('deadlineElapsed') +
  ' return { parseYM, monthsSince, elapsedLabel, shortestDeadlineDays, deadlineElapsed }; })()'
);

const NOW = new Date(2026, 8, 15); // September 2026, the month this was written

{
  ok(monthsSince('2026-09', NOW) === 0, 'this month is nought months ago, not one');
  ok(monthsSince('2026-03', NOW) === 6, 'March to September is six months');
  ok(monthsSince('2024-09', NOW) === 24, 'two years back is twenty-four months');
  ok(monthsSince('2025-12', NOW) === 9, 'the count crosses a year boundary correctly');
  // A date in the future is not elapsed time. Left unhandled it would produce a
  // negative month count and a reassuring "nought months ago" beside a deadline.
  ok(monthsSince('2027-01', NOW) === null, 'a date in the future yields nothing, not negative time');
  for (const junk of ['', 'soon', '2026-13', '2026-00', '26-09', '2026/09', null, undefined, 42, {}]) {
    if (monthsSince(junk, NOW) !== null) { ok(false, 'junk input parsed: ' + JSON.stringify(junk)); break; }
  }
  ok(true, 'malformed, out-of-range and non-string dates all yield nothing');
  ok(elapsedLabel(1) === 'about a month ago' && elapsedLabel(12) === 'about a year ago' &&
     elapsedLabel(13) === 'about a year and a month ago' && elapsedLabel(31) === 'about 2 years and 7 months ago',
     'elapsed time is said in English, with singulars that read like English');
}

{
  // The real shapes in content/, not invented ones.
  ok(shortestDeadlineDays('180 days') === 180, 'a plain span parses');
  ok(shortestDeadlineDays('2 years (3 years for willful violations)') === 730,
     'where a value names two spans it takes the SHORTER — we do not know which is theirs');
  ok(shortestDeadlineDays('180 days (general); 300 days for sexual harassment') === 180,
     "Texas's two-clause value resolves to the clock that runs out first");
  // Arkansas's wage value reads "claims of $2,000 or less; ... within ~3 years".
  // A bare number is not a duration; if it were, this would resolve to 2,000 days.
  ok(shortestDeadlineDays('DOL investigates claims of $2,000 or less; private suits must be filed within ~3 years') === 1095,
     'a dollar figure is not mistaken for a span of time');
  ok(shortestDeadlineDays('no state administrative agency (court filing only)') === null,
     'a value naming no span at all yields nothing rather than a guess');
  ok(shortestDeadlineDays('') === null && shortestDeadlineDays(null) === null,
     'an empty or missing value yields nothing');
}

{
  // Every deadline value really in content/ must either parse to a positive
  // span or parse to nothing. A zero or negative one would divide the urgency
  // ratio into nonsense.
  let bad = [];
  for (const f of readdirSync(join(ROOT, 'content/states'))) {
    const j = JSON.parse(readFileSync(join(ROOT, 'content/states', f), 'utf8'));
    for (const fact of j.facts) {
      if (!String(fact.topic).startsWith('deadlines')) continue;
      const d = shortestDeadlineDays(fact.value);
      if (d !== null && !(d > 0)) bad.push(f + ' ' + fact.topic + ': ' + JSON.stringify(fact.value));
    }
  }
  ok(bad.length === 0, 'every deadline value in all 50 states parses to a positive span or to nothing' +
     (bad.length ? ' — got: ' + bad.slice(0, 3).join(' | ') : ''));
}

{
  /* The asymmetry, asserted directly. Across every deadline value in content/
     and a decade of possible dates, there must be no case where a reader past
     the shortest named span is shown no warning. The opposite direction — a
     warning shown to someone who still has time — is allowed on purpose. */
  let missed = 0, warnedEarly = 0, total = 0;
  const values = [];
  for (const f of readdirSync(join(ROOT, 'content/states'))) {
    const j = JSON.parse(readFileSync(join(ROOT, 'content/states', f), 'utf8'));
    j.facts.filter(x => String(x.topic).startsWith('deadlines')).forEach(x => values.push(x.value));
  }
  for (const v of values) {
    const shortest = shortestDeadlineDays(v);
    for (let back = 0; back <= 120; back++) {
      const d = new Date(2026, 8 - (back % 12), 15);
      d.setFullYear(2026 - Math.floor(back / 12));
      const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const e = deadlineElapsed(v, ym, NOW);
      if (!e) continue;
      total++;
      if (shortest === null) continue;
      if (e.months * 30 >= shortest && e.urgency !== 'past') missed++;
      if (e.months * 30 < shortest * 0.75 && e.urgency) warnedEarly++;
    }
  }
  ok(total > 1000, 'the sweep actually ran (' + total + ' state-deadline/date pairs)');
  ok(missed === 0, 'nobody past the shortest deadline on file is left without a warning');
  ok(warnedEarly === 0, 'and nobody well inside it is warned for no reason');
}

{
  const e = deadlineElapsed('180 days', '2025-09', NOW);
  ok(e.urgency === 'past' && /about a year ago/.test(e.label),
     'a Texas reader a year out is told how long it has been, and that it is past');
  ok(deadlineElapsed('3 years (up to 4 via UCL)', '2026-06', NOW).urgency === null,
     'a California reader three months into a three-year clock is not alarmed');
  ok(deadlineElapsed('2 years (3 years for willful violations)', '2024-12', NOW).urgency === 'soon',
     'and one approaching the shorter of two spans is told not to wait');
  ok(deadlineElapsed('no state administrative agency (court filing only)', '2020-01', NOW).urgency === null,
     'where no span is on file the elapsed time is stated with no verdict attached');
  ok(deadlineElapsed('180 days', '', NOW) === null && deadlineElapsed('180 days', 'nonsense', NOW) === null,
     'a reader who says nothing is told nothing');
}

/* The one thing this app must never say. A false "you still have time" is the
   error that ends a claim: it is acted on, it is acted on slowly, and by the
   time it is found out the clock has run. Checked against the source below and
   against every screen this suite renders in Part 2. */
const REASSURING = /still (in time|have time)|you are fine|plenty of time|not too late|no rush|in good time/i;

{
  // The copy is the safety property. If any of it ever starts reassuring, the
  // asymmetry above becomes decorative.
  const copy = dev.match(/const ELAPSED_COPY = \{[\s\S]*?\n\};/)[0] +
               dev.match(/const ELAPSED_CAVEAT = '[^']*';/)[0];
  ok(/check today/.test(copy) && /do not wait/i.test(copy), 'the warning copy tells the reader to act');
  ok(!/you are out of time|too late|you have missed|no longer/i.test(copy),
     'and never declares a claim dead — deadlines run from different dates and some can be paused');
  /* Comments stripped first: the source says "there is no 'you are still in
     time' branch anywhere in this app" to explain the rule, and a check that
     cannot tell the rule from a breach of it is not a check. Part 2 asserts
     the same property against what a reader actually sees. */
  const prose = dev.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!REASSURING.test(prose),
     'no copy anywhere in the source tells a reader they are still in time');
}

// ── Part 2 · the screens ────────────────────────────────────────────────────
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

const rendered = [];
const open = async (place, go) => {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await pg.setViewport({ width: 390, height: 900 });
  await gotoApp(pg, BASE, { place });
  await new Promise(r => setTimeout(r, 1200));
  if (go) { await pg.evaluate(go); await new Promise(r => setTimeout(r, 1000)); }
  const text = await pg.evaluate(() => document.body.innerText);
  rendered.push(text);
  await pg.close();
  return { text, errs };
};
const toAgencies = () => {
  const b = [...document.querySelectorAll('button,a')].find(el => /Who enforces|Agencies/i.test((el.textContent || '').trim()));
  if (b) b.click();
};
const toPay = () => {
  const b = [...document.querySelectorAll('button')].find(el => /^Pay & overtime/.test((el.textContent || '').trim()));
  if (b) b.click();
};

try {
  const TX = { state: 'Texas', county: 'Harris County' };
  {
    const { text, errs } = await open(TX, toAgencies);
    ok(errs.length === 0, 'the agencies screen renders clean with no date given' + (errs.length ? ': ' + errs[0] : ''));
    ok(/When did this happen\?/.test(text), 'the question is asked where the deadlines are');
    ok(/Optional/.test(text), 'and is marked optional, because every deadline shows without it');
    ok(!/You said this happened/.test(text), 'nothing is claimed about elapsed time until the reader says');
    ok(/Your deadline to file: 180 days/.test(text), 'the deadline itself is there either way');
  }
  {
    const { text, errs } = await open({ ...TX, when: '2025-09' }, toAgencies);
    ok(errs.length === 0, 'and clean with one' + (errs.length ? ': ' + errs[0] : ''));
    ok(/You said this happened about a year ago/.test(text),
       'a returning reader who already answered sees the reading, not the question again');
    ok(/That is past this deadline/.test(text),
       'and a Texas reader a year past a 180-day clock is told so');
    ok(/check today, not next week/.test(text), 'in the imperative, with a time frame');
  }
  {
    /* The reading is per card, not per screen: a Texas reader is past the
       180-day EEOC clock and well inside the multi-year wage-claim one, and
       the same screen has to say both. */
    const { text } = await open({ ...TX, when: '2026-03' }, toAgencies);
    const saidCount = (text.match(/You said this happened/g) || []).length;
    ok(saidCount > 1, 'the elapsed line is repeated per agency, since each runs its own clock (' + saidCount + ' cards)');
    ok(/That is past this deadline/.test(text),
       'six months reads as past on the 180-day card');
    const lines = text.split('\n').filter(l => /You said this happened/.test(l));
    ok(lines.some(l => !/this deadline/.test(l)),
       'and as bare elapsed time on a card whose clock is years long');
    /* The caveat is said once, by the picker, not by every card. Repeated on
       five cards it was forty words printed five times down one screen, which
       a reader scrolls past — the exact failure a deadline warning cannot
       afford. */
    const caveats = (text.match(/some can be paused/g) || []).length;
    ok(caveats === 1, 'and the caveat behind all of them is stated once, not per card (found ' + caveats + ')');
  }
  {
    const { text, errs } = await open({ state: 'California', county: 'Los Angeles County', city: 'West Hollywood', when: '2026-06' }, toPay);
    ok(errs.length === 0, 'the pay screen renders clean with a date' + (errs.length ? ': ' + errs[0] : ''));
    ok(/When did this happen\?/.test(text), 'the question is on the next-step card too, beside its own deadline');
    ok(/You said this happened about 3 months ago/.test(text), 'and answered there');
    ok(!/past this deadline|most of this deadline/.test(text),
       'three months into a three-year clock draws no warning — the app never manufactures urgency');
    ok(/\$20\.25/.test(text) && /Your employer owes you/.test(text),
       'and the answer the reader came for is untouched by any of it');
  }
  {
    /* The limit, stated. The rates on screen are today's, and the dataset has
       no history — so a reader dating their problem to the past must not be
       shown a figure implying we priced it then. */
    const { text } = await open({ state: 'California', county: 'Los Angeles County', city: 'West Hollywood', when: '2019-01' }, toPay);
    ok(!/rate (that|which) applied|at the time|back then|as of that/i.test(text),
       'no screen claims to know what the rate was on the reader’s date');
  }
  {
    // The source check above reads the file; this reads the screens, including
    // the four urgency states Part 2 has just walked through.
    const guilty = rendered.filter(t => REASSURING.test(t));
    ok(rendered.length >= 5 && guilty.length === 0,
       'across every screen this suite rendered, nothing reassured the reader about time (' + rendered.length + ' screens)');
  }
} finally {
  await browser.close();
  server.close();
}

console.log(fails ? `\n❌ ${fails} WHEN-HAPPENED CHECK(S) FAILED` : '\n✅ ALL WHEN-HAPPENED CASES PASSED');
process.exit(fails ? 1 : 0);
