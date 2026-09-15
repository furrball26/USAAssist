#!/usr/bin/env node
/*
 * The entry escape hatches (index.dev.html: ENTRY_SITUATIONS, EntrySituations).
 *
 * State → county → city assumes one fixed worksite. Four common working lives
 * do not have one, and before this a reader who could not honestly answer
 * "which county?" had nowhere to go on that screen except away.
 *
 * What this suite mostly protects is what the notes DO NOT say. Which
 * jurisdiction's law reaches a remote worker, or a driver crossing city lines,
 * is genuinely unsettled, and content/ holds no sourced answer to either — so
 * the notes must point at reading both and never at picking one. An earlier
 * draft of this copy asserted that "the rules usually follow where your route
 * starts", which is a legal claim this repo cannot source.
 *
 * Run: node test/entry-escapes.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChromePath } from './lib/chrome.mjs';
import { gotoApp, PLACE_KEY } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

// ── Part 1 · the copy ───────────────────────────────────────────────────────
const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
const block = dev.match(/const ENTRY_SITUATIONS = \[[\s\S]*?\n\];/);
if (!block) { console.log('❌ could not find ENTRY_SITUATIONS in index.dev.html'); process.exit(1); }
const SITUATIONS = (0, eval)(block[0] + '; ENTRY_SITUATIONS');

{
  ok(SITUATIONS.length === 4, 'four situations the map cannot express');
  ok(SITUATIONS.every(s => s.key && s.label && s.note), 'each has a key, a label and a note');
  ok(new Set(SITUATIONS.map(s => s.key)).size === 4, 'the keys are distinct');
  // Every note has to leave the reader with something to do. A note that only
  // explains why we cannot help is a dead end with extra words.
  ok(SITUATIONS.every(s => /^Pick |^Start /.test(s.note)),
     'every note opens with the action to take, not with the caveat');
}

{
  /* The claim none of them may make. "Which state's law reaches a remote
     worker" and "which city's rate reaches a driver" are contested questions
     this repo holds no source on, so the notes hedge or say nothing — they
     never assert an answer. */
  const asserts = /(rules|law|rate)s? (usually |generally |normally )?(follow|apply|govern)s?\b(?!.*(not always|can turn|may apply|worth reading))/i;
  const guilty = SITUATIONS.filter(s => asserts.test(s.note));
  ok(guilty.length === 0,
     'no note asserts which jurisdiction governs' + (guilty.length ? ' — ' + guilty.map(g => g.key).join(', ') : ''));
  const home = SITUATIONS.find(s => s.key === 'home');
  ok(/not always settled/.test(home.note) && /reading both/.test(home.note),
     'the remote-work note says the question is unsettled and sends the reader to both states');
  const drive = SITUATIONS.find(s => s.key === 'drive');
  ok(/cannot resolve that for you/.test(drive.note),
     'the driving note says outright that we cannot resolve it');
  ok(!/route starts\.\s*(The|Rules)/.test(drive.note) || /can turn on/.test(drive.note),
     'and hedges rather than stating a rule about where a route starts');
  const past = SITUATIONS.find(s => s.key === 'past');
  ok(/today’s/.test(past.note) && /do not hold what it was/.test(past.note),
     'the left-the-job note states the dataset limit: every figure here is current');
  ok(/filing clock|deadline/.test(past.note),
     'and hands off to the one thing that IS still computable — the filing clock');
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

// A page with the county left unanswered lands on the county step; one with a
// county we hold several localities for and no city lands on the city step.
const open = async (place) => {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await pg.setViewport({ width: 390, height: 900 });
  await gotoApp(pg, BASE, { place });
  await new Promise(r => setTimeout(r, 1200));
  return { pg, errs };
};
const chip = (label) => (l) => {
  const b = [...document.querySelectorAll('button')].find(e => (e.textContent || '').trim() === l);
  if (b) b.click();
  return !!b;
};

try {
  {
    const { pg, errs } = await open({ state: 'Texas', county: '' });
    let text = await pg.evaluate(() => document.body.innerText);
    ok(errs.length === 0, 'the county step renders clean' + (errs.length ? ': ' + errs[0] : ''));
    ok(/Where in Texas\?/.test(text), 'and is the county step');
    ok(/NONE OF THOSE FIT\?/.test(text), 'the escape hatches are offered there');
    for (const s of SITUATIONS) ok(text.includes(s.label), `"${s.label}" is on the screen`);
    ok(!SITUATIONS.some(s => text.includes(s.note)), 'no note is shown until one is chosen');

    const clicked = await pg.evaluate(chip(), 'I drive or deliver');
    ok(clicked, 'the driving chip is clickable');
    await new Promise(r => setTimeout(r, 300));
    text = await pg.evaluate(() => document.body.innerText);
    ok(text.includes(SITUATIONS.find(s => s.key === 'drive').note), 'and shows its note');
    ok(!text.includes(SITUATIONS.find(s => s.key === 'home').note), 'and only its own');
    const pressed = await pg.evaluate(() =>
      [...document.querySelectorAll('button[aria-pressed="true"]')].map(b => b.textContent.trim()));
    ok(pressed.length === 1 && pressed[0] === 'I drive or deliver',
       'the chosen chip is the one marked pressed, for anyone not seeing the colour');

    // Never a one-way door: a chip chosen by mistake can be taken back.
    await pg.evaluate(chip(), 'I drive or deliver');
    await new Promise(r => setTimeout(r, 300));
    text = await pg.evaluate(() => document.body.innerText);
    ok(!SITUATIONS.some(s => text.includes(s.note)), 'tapping the same chip again clears it');

    // The escape hatches must not have replaced the way through.
    ok(/Skip — show me Texas law/.test(text), 'the skip is still there');
    ok(await pg.evaluate(() => !!document.querySelector('#onb-county')), 'and so is the county list');
    await pg.close();
  }
  {
    // The city step insists "not where you live" — the exact instruction a
    // remote worker needs corrected, so the hatches are offered here too.
    const { pg, errs } = await open({ state: 'California', county: 'Los Angeles County', city: '' });
    let text = await pg.evaluate(() => document.body.innerText);
    ok(errs.length === 0, 'the city step renders clean' + (errs.length ? ': ' + errs[0] : ''));
    ok(/Where in Los Angeles County do you work\?/.test(text), 'and is the city step');
    ok(/Not where you live/.test(text), 'which still says "not where you live"');
    ok(/NONE OF THOSE FIT\?/.test(text), 'and offers the escape hatches that qualify it');
    await pg.evaluate(chip(), 'I work from home');
    await new Promise(r => setTimeout(r, 300));
    text = await pg.evaluate(() => document.body.innerText);
    ok(/Pick where you sit when you work/.test(text),
       'a remote worker is told to pick where they sit, correcting the line above');
    await pg.close();
  }
  {
    /* Not persisted, deliberately: "I drive or deliver" says more about someone
       than the county they picked, and a returning reader skips the entry flow
       the note belongs to. */
    const { pg } = await open({ state: 'Texas', county: '' });
    await pg.evaluate(chip(), 'I drive or deliver');
    await new Promise(r => setTimeout(r, 400));
    const stored = await pg.evaluate(k => localStorage.getItem(k) || '', PLACE_KEY);
    ok(!/drive|deliver|home|situation/i.test(stored),
       'nothing about the reader’s working life reaches the device' + (stored ? ' (stored: ' + stored + ')' : ''));
    await pg.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(fails ? `\n❌ ${fails} ENTRY-ESCAPE CHECK(S) FAILED` : '\n✅ ALL ENTRY-ESCAPE CASES PASSED');
process.exit(fails ? 1 : 0);
