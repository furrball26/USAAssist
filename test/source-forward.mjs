#!/usr/bin/env node
/*
 * Source-forward treatment of unreviewed facts (index.dev.html: formatChecked,
 * factCard, the RightsLib rows).
 *
 * Nought of the 496 facts in content/ carry reviewed:true. No attorney has
 * signed off on any of them, and under AUTONOMY.md none can be flipped here —
 * that is counsel's call. So the official text is the only authority on any of
 * these screens, and the design has to act like it: the source is the card's
 * primary action, not a 13px outlined pill beside a scope chip.
 *
 * The other half is the date. Every fact carries lastChecked and nothing ever
 * showed it, which left a reader no way to weigh staleness — the failure mode
 * that actually bites here, since an indexed minimum wage resets every January
 * and a figure that was right when written goes wrong on a schedule.
 *
 * Run: node test/source-forward.mjs
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

// ── Part 1 · the date, in isolation ─────────────────────────────────────────
const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
const formatChecked = (0, eval)(
  dev.match(/const CHECKED_MONTHS = \[[^\]]*\];/)[0] + '\n' +
  dev.match(/function formatChecked\([\s\S]*?\n\}\n/)[0] + '; formatChecked');

{
  ok(formatChecked('2026-08-08') === '8 Aug 2026', 'an ISO date reads as a date a person would say');
  ok(formatChecked('2026-01-01') === '1 Jan 2026', 'the first of January is not the 31st of December');
  ok(formatChecked('2025-12-31') === '31 Dec 2025', 'and the last of December is not the 1st of January');
  for (const junk of ['', 'yesterday', '2026-08', '2026-13-01', '2026-08-32', '08/08/2026', null, 42, {}]) {
    if (formatChecked(junk) !== '') { ok(false, 'junk date rendered: ' + JSON.stringify(junk)); break; }
  }
  ok(true, 'anything that is not an ISO date renders as nothing, never as "Invalid Date"');
}

{
  /* Every shipped fact must produce a real stamp. A silent '' here would read
     on screen as "we never checked this", which is the opposite of the truth. */
  const bad = [];
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name);
      if (e.isDirectory()) { walk(q); continue; }
      if (!e.name.endsWith('.json') || e.name.startsWith('_TEMPLATE')) continue;
      const j = JSON.parse(readFileSync(q, 'utf8'));
      for (const f of j.facts || []) {
        if (!formatChecked(f.lastChecked)) bad.push(e.name + ' ' + f.topic + ': ' + JSON.stringify(f.lastChecked));
      }
    }
  };
  walk(join(ROOT, 'content'));
  ok(bad.length === 0, 'every shipped fact carries a lastChecked that renders' +
     (bad.length ? ' — ' + bad.slice(0, 3).join(' | ') : ''));
}

{
  // The premise. If a fact is ever marked reviewed:true without this suite
  // being revisited, the copy below ("no attorney has checked") goes stale.
  let reviewed = 0, total = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name);
      if (e.isDirectory()) { walk(q); continue; }
      if (!e.name.endsWith('.json') || e.name.startsWith('_TEMPLATE')) continue;
      for (const f of JSON.parse(readFileSync(q, 'utf8')).facts || []) { total++; if (f.reviewed === true) reviewed++; }
    }
  };
  walk(join(ROOT, 'content'));
  ok(total > 400 && reviewed === 0,
     `nothing is attorney-reviewed yet (${reviewed} of ${total}) — the source-forward posture is the honest one`);
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

const open = async (go) => {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await pg.setViewport({ width: 390, height: 900 });
  await gotoApp(pg, BASE, { place: { state: 'California', county: 'Los Angeles County', city: 'West Hollywood' } });
  await new Promise(r => setTimeout(r, 1200));
  if (go) { await pg.evaluate(go); await new Promise(r => setTimeout(r, 1000)); }
  return { pg, errs };
};

try {
  {
    // Open a topic that is NOT the Pay screen: Pay has its own answer-first
    // layout, so the generic fact cards live under the other domains.
    const { pg, errs } = await open(() => {
      const b = [...document.querySelectorAll('button')].find(el => /^Discrimination & harassment/.test((el.textContent || '').trim()));
      if (b) b.click();
    });
    const text = await pg.evaluate(() => document.body.innerText);
    ok(errs.length === 0, 'the topic screen renders clean' + (errs.length ? ': ' + errs[0] : ''));

    ok(/we last checked this \d+ \w{3} \d{4}/.test(text),
       'each fact says when we last read the source ourselves');

    // The source has to be the card's primary action, which in this design
    // means a filled full-width link, not an outlined pill beside a chip.
    const links = await pg.evaluate(() => [...document.querySelectorAll('a')]
      .filter(a => /Check the official text/.test(a.textContent || ''))
      .map(a => { const s = getComputedStyle(a); const r = a.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), bg: s.backgroundColor, href: a.href, target: a.target, rel: a.rel }; }));
    ok(links.length > 0, 'every fact offers the official text (' + links.length + ' cards)');
    ok(links.every(l => l.h >= 44), 'each is at least a 44px target');
    ok(links.every(l => l.w > 200), 'and full-width rather than a pill beside the scope chip');
    ok(links.every(l => l.bg !== 'rgba(0, 0, 0, 0)' && !/255, 255, 255/.test(l.bg)),
       'and filled, so it reads as the action on the card');
    ok(links.every(l => /^https:\/\//.test(l.href)), 'every source link is https');
    ok(links.every(l => l.target === '_blank' && /noopener/.test(l.rel) && /noreferrer/.test(l.rel)),
       'and opens in a new tab without leaking the opener or the referrer');

    /* The reason is stated once, by the notice at the top of the list. Repeated
       on every card it would be wallpaper — the same failure the deadline
       cards had before the caveat moved to the picker. */
    const perCard = (text.match(/no attorney has checked/gi) || []).length;
    ok(perCard === 0, 'the "not lawyer-checked" reason is not repeated on every card');
    ok(/lawyer-checked/i.test(text), 'but it is said once on the screen');
    await pg.close();
  }
  {
    const { pg, errs } = await open(() => {
      const b = [...document.querySelectorAll('button,a')].find(el => /All rights/i.test((el.textContent || '').trim()));
      if (b) b.click();
    });
    const text = await pg.evaluate(() => document.body.innerText);
    ok(errs.length === 0, 'the All rights screen renders clean' + (errs.length ? ': ' + errs[0] : ''));
    ok(/Every rule, as written/.test(text), 'and is the raw-dataset view');
    ok(/checked \d+ \w{3} \d{4}/.test(text), 'whose rows carry the same check date');
    ok(!/Invalid Date|NaN|undefined/.test(text), 'with no date left half-rendered');
    await pg.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(fails ? `\n❌ ${fails} SOURCE-FORWARD CHECK(S) FAILED` : '\n✅ ALL SOURCE-FORWARD CASES PASSED');
process.exit(fails ? 1 : 0);
