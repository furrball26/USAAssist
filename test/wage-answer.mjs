#!/usr/bin/env node
/*
 * The resolved minimum wage (index.dev.html: resolveMinimumWage + the Pay screen).
 *
 * Four minimum wages reach a West Hollywood worksite — city $20.25, California
 * $16.90, federal $7.25, plus county and neighbouring-city rates that do not
 * apply. The app used to print them all and leave the reader to pick. This
 * suite protects the resolution and, more importantly, its LIMITS.
 *
 * Part 1 exercises resolveMinimumWage directly, because the rule it encodes is
 * the part that could quietly become wrong. "The highest rule wins" is true of
 * wage FLOORS and is NOT a general principle of employment law: elsewhere
 * federal law can preempt and a state scheme can be narrower than the federal
 * one. If this ever starts resolving other topics, it is inventing law.
 *
 * Part 2 drives the built app for the two cases that matter: a reader whose
 * city is known (one confident figure) and one whose city is not (a figure we
 * can stand behind, plus an explicit warning that more may be owed).
 *
 * Run: node test/wage-answer.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChromePath } from './lib/chrome.mjs';
import { gotoApp } from './lib/nav.mjs';
import { catalogue, translator } from './lib/appsrc.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

// ── Part 1 · the rule, in isolation ─────────────────────────────────────────
const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
const fnSrc = dev.match(/function resolveMinimumWage\([\s\S]*?\n\}\n/);
if (!fnSrc) { console.log('❌ could not find resolveMinimumWage in index.dev.html'); process.exit(1); }
// Pull the real function out of the source rather than reimplementing it here:
// a copy in the test would happily agree with itself while the app drifted.
/* resolveMinimumWage names the federal layer through the catalogue now, so the
   real function needs a real t() to run. Both come out of the source, so this
   still measures what ships rather than a copy. */
const CAT = catalogue(dev);
const withT = 'const t = ' + translator.toString() + '(' + JSON.stringify(CAT) + ');\n';
const resolveMinimumWage = (0, eval)(withT + fnSrc[0] + '; resolveMinimumWage');

const F = (v) => [{ topic: 'minimumWage.hourly', value: v }];
const L = (n, v) => ({ loc: { name: n, covers: 'x' }, facts: F(v) });
const CA = { stateFacts: F(16.90), fedFacts: F(7.25), stName: 'California' };

/* The worked example exists because a third of US adults score at or below
   Level 1 numeracy and this app's subject is money and multipliers. Two
   properties make it trustworthy rather than decorative: the figures on screen
   must ADD UP when someone checks them with a calculator, and the total must
   equal the amount the unrounded law actually gives. Those can conflict —
   rounding 1.5 x $20.25 to $30.38 and multiplying by 5 prints $151.90 for an
   amount that is really $151.875 — so both are asserted on every case. */
const workedExample = (0, eval)(withT + dev.match(/function workedExample\([\s\S]*?\n\}\n/)[0] + '; workedExample');
{
  let bad = 0;
  for (const [rate, hours] of [[20.25, 45], [7.25, 45], [16.90, 50], [13.33, 43], [11.00, 41], [15.50, 60]]) {
    const e = workedExample(rate, hours);
    const sumsOnScreen = Math.round((e.base + e.otPay) * 100) / 100 === e.total;
    const matchesLaw = Math.round((e.normalHours * rate + e.otHours * rate * 1.5) * 100) / 100 === e.total;
    if (!sumsOnScreen || !matchesLaw) bad++;
  }
  ok(bad === 0, 'every worked example both adds up on screen and matches the unrounded legal amount');
  ok(workedExample(20.25, 45).total === 961.88, 'the canonical case totals $961.88');
  ok(workedExample(20.25, 40).otHours === 0, 'a 40-hour week produces no overtime line');
  ok(workedExample('x', 45) === null && workedExample(0, 45) === null,
     'a missing or zero rate produces no example rather than a $0.00 one');
  ok(workedExample(20.25, 45).otRate === undefined,
     'no per-hour overtime rate is exposed — a rounded one would not multiply out');
}

{
  const r = resolveMinimumWage({ ...CA, cityFacts: F(20.25), otherLocal: [], cityName: 'West Hollywood' });
  ok(r && r.winner.name === 'West Hollywood' && r.winner.fact.value === 20.25,
     'the city rate wins when it is the highest that reaches the worksite');
  ok(r.layers.length === 3, 'every layer that applies is kept as evidence, not dropped');
}
{
  // The whole point of "highest", not "most local".
  const r = resolveMinimumWage({ ...CA, cityFacts: F(15.00), otherLocal: [], cityName: 'Lowville' });
  ok(r.winner.name === 'California' && r.winner.fact.value === 16.90,
     'a city paying LESS than the state does not win just because it is more local');
}
{
  /* Nineteen states set a minimum exactly EQUAL to the federal floor. The first
     version struck the federal row through and explained that "a higher one
     applies to you" - false in every one of them, since nothing higher applies.
     A tie is not a loss. */
  const TX = { stateFacts: F(7.25), fedFacts: F(7.25), stName: 'Texas' };
  const r = resolveMinimumWage({ ...TX, cityFacts: null, otherLocal: [], cityName: '' });
  const fed = r.layers.find(l => l.key === 'federal');
  ok(fed.tied === true && fed.beaten === false,
     'a state matching the federal floor leaves federal tied, not beaten');
  ok(r.anyBeaten === false,
     'and nothing is reported as beaten, so the screen cannot claim a higher rate applies');
}
{
  const r = resolveMinimumWage({ ...CA, cityFacts: null, otherLocal: [], cityName: '' });
  ok(r.anyBeaten === true && r.layers.find(l => l.key === 'federal').beaten === true,
     'where a higher rate really does apply, the lower one is still marked beaten');
}
{
  const r = resolveMinimumWage({ ...CA, cityFacts: null, otherLocal: [L('West Hollywood', 20.25)], cityName: '' });
  ok(r.winner.name === 'California' && r.unresolvedLocal === true,
     'with no city chosen the local layer is reported unresolved, never assumed');
  ok(r.nearby.length === 1, 'and the higher local rate is surfaced as something to check');
}
{
  // A cheaper neighbour is not "you may be owed more".
  const r = resolveMinimumWage({ ...CA, cityFacts: null, otherLocal: [L('Lowville', 12.00)], cityName: '' });
  ok(r.nearby.length === 0 && r.unresolvedLocal === false,
     'a nearby town paying LESS is not advertised as a reason to check');
}
{
  const r = resolveMinimumWage({ ...CA, cityFacts: null, otherLocal: [L('Mid', 18.42), L('High', 20.25)], cityName: '' });
  ok(r.nearby[0].name === 'High', 'places that may owe more are listed highest first');
}
{
  ok(resolveMinimumWage({ cityFacts: null, otherLocal: [], stateFacts: null, fedFacts: F(7.25), stName: 'X', cityName: '' }) === null,
     'one lonely figure is not dressed up as a resolved answer');
  ok(resolveMinimumWage({ ...CA, cityFacts: [{ topic: 'overtime.daily', value: 99 }], otherLocal: [], cityName: 'Z' }).winner.name === 'California',
     'a non-wage fact is ignored — highest-wins is a rule about wage floors only');
}

// ── Part 2 · the screen ─────────────────────────────────────────────────────
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

const openPay = async (city, state) => {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await pg.setViewport({ width: 390, height: 900 });
  const st = state || 'California';
  const county = st === 'California' ? 'Los Angeles County' : 'Harris County';
  await gotoApp(pg, BASE, { place: { state: st, county, city } });
  await new Promise(r => setTimeout(r, 1200));
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(el => /^Pay & overtime/.test((el.textContent || '').trim()));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  const text = await pg.evaluate(() => document.body.innerText);
  await pg.close();
  return { text, errs };
};

try {
  {
    const { text, errs } = await openPay('West Hollywood');
    ok(/The least you can legally be paid in West Hollywood/i.test(text),
       'a reader with a known city is told the figure is theirs, by name');
    ok(/\$20\.25/.test(text), 'the resolved figure is the city rate ($20.25)');
    ok(/\$16\.90/.test(text) && /\$7\.25/.test(text),
       'the rates it beat are still shown as evidence, not hidden');
    ok(/highest minimum wage that reaches where you work/i.test(text),
       'the rule that decides it is stated, so the number is not magic');
    ok(/40 hours × \$20\.25/.test(text) && /\$810\.00/.test(text),
       'the worked example does the base-pay arithmetic rather than describing it');
    ok(/5 overtime hours at 1\.5/.test(text) && /\$151\.88/.test(text),
       'and the overtime, at the legally precise amount');
    ok(/Your employer owes you/.test(text) && /\$961\.88/.test(text),
       'and totals it');
    ok(/File a wage claim/.test(text) && /Division of Labor Standards Enforcement/.test(text),
       'the next step names the free remedy and the agency that takes it');
    ok(/Your deadline to file: 3 years/.test(text),
       'with the state deadline beside it, not on another screen');
    ok(!/You may be owed more/i.test(text),
       'no "you may be owed more" warning when the answer is actually resolved');
    ok(errs.length === 0, 'no console/page errors on the resolved wage screen' + (errs.length ? ': ' + errs[0] : ''));
  }
  {
    const { text } = await openPay('—');
    ok(/\$16\.90/.test(text), 'a reader who does not know their city still gets the figure we can stand behind');
    ok(/You may be owed more than the figure above/i.test(text),
       'and is told plainly that a higher local rate may be theirs');
    ok(/\$20\.25/.test(text), 'the higher local rates are named so the gap is visible');
    ok(/Tell us which one you work in/i.test(text), 'with a way to resolve it');
  }
  {
    // The 19-state case end to end: equal figures must not be struck through,
    // and the explanation must not claim something higher applies.
    const { text } = await openPay('\u2014', 'Texas');
    ok(/Every minimum wage that reaches your worksite is the same amount/.test(text),
       'Texas, whose state minimum equals the federal floor, says the figures are the same');
    ok(!/a higher one applies to you/.test(text),
       'and does not claim a higher rate applies when none does');
  }
} finally {
  await browser.close();
  server.close();
}

console.log(fails ? `\n❌ WAGE-ANSWER FAILED (${fails})` : '\n✅ WAGE-ANSWER PASSED');
process.exit(fails ? 1 : 0);
