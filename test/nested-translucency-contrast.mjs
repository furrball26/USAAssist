#!/usr/bin/env node
/*
 * Nested-translucent-card contrast regression test (P1 FIND-09,
 * docs/audit-2026-08-29.md).
 *
 * Action-first mode's Deadline Watch card is itself a translucent
 * `.surfacefx` button (`background:rgba(255,255,255,.14)` over the
 * `#2B3AA8` screen). `FlsaSolNote` and `DeadlineComputedBlock` render
 * INSIDE that button and used to set another `rgba(255,255,255,.14)` (or
 * similar) background of their own — two translucent layers stacking on
 * top of the screen color, compositing to a background no one had ever
 * measured. A stale "wl-ux contrast fix" comment asserted the wrong
 * (single-layer) background, so the failure went unnoticed.
 *
 * This test does NOT hardcode the expected composite. It walks the real
 * ancestor chain in a live page (via getComputedStyle) and alpha-composites
 * every background from the nearest opaque ancestor down to the text node,
 * the same way a browser actually paints it, then asserts every text/
 * background pair in these nested cards is >=4.5:1 (12px/14px bold text is
 * under the ~18.66px bold "large text" threshold, so the AA floor is 4.5:1,
 * not 3:1) — so a future re-introduction of stacked translucency, in this
 * component or a new one, can't silently regress contrast again.
 *
 * Run: node test/nested-translucency-contrast.mjs
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

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function openHome(eventDate) {
  const pg = await b.newPage();
  const seed = {
    onboarded: true, stateSel: 'Texas', county: 'Travis County', issue: 'Unpaid overtime or wages',
    profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20', eventDate },
    caseOpened: new Date().toISOString(), homeMode: 'action', entries: [], done: {}, messages: [],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return pg;
}

// Texas' wage deadline fact is "180 days" (deadlines.wageClaim). Pick
// eventDate offsets that land DeadlineComputedBlock in each of its three
// urgency tones (ok >=30 days left, urgent <30 days left, past already
// expired), so every color branch actually renders and gets measured.
const cases = [
  { tone: 'ok', eventDate: isoDaysAgo(100) },     // ~80 days left
  { tone: 'urgent', eventDate: isoDaysAgo(165) },  // ~15 days left
  { tone: 'past', eventDate: isoDaysAgo(200) },    // ~20 days past
];

for (const { tone, eventDate } of cases) {
  const pg = await openHome(eventDate);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const result = await pg.evaluate(() => {
    function srgbToLin(c) { const cs = c / 255; return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4); }
    function luminance([r, g, b]) { return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b); }
    function contrast(a, b) {
      const La = luminance(a), Lb = luminance(b);
      const lighter = Math.max(La, Lb), darker = Math.min(La, Lb);
      return (lighter + 0.05) / (darker + 0.05);
    }
    function parseColor(str) {
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return { r: 255, g: 255, b: 255, a: 1 };
      const parts = m[1].split(',').map(s => parseFloat(s));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    // Walks from the nearest opaque ancestor DOWN to `el`, alpha-compositing
    // every background along the way — the real rendered background,
    // regardless of how many translucent layers are stacked.
    function effectiveBg(el) {
      if (!el) return [255, 255, 255];
      const own = parseColor(getComputedStyle(el).backgroundColor);
      const under = effectiveBg(el.parentElement);
      if (own.a === 0) return under;
      if (own.a >= 1) return [own.r, own.g, own.b];
      return [own.a * own.r + (1 - own.a) * under[0], own.a * own.g + (1 - own.a) * under[1], own.a * own.b + (1 - own.a) * under[2]];
    }
    function findSpanByText(needle) {
      return Array.from(document.querySelectorAll('span')).find(s => s.textContent.includes(needle)) || null;
    }
    const targets = [];
    // FlsaSolNote (always renders for a wage issue with a deadline fact).
    const solLabel = findSpanByText('SEPARATE CLOCK');
    const solBody = findSpanByText('federal FLSA lawsuit deadline is 2');
    if (solLabel) targets.push(['FlsaSolNote label', solLabel]);
    if (solBody) targets.push(['FlsaSolNote body', solBody]);
    // DeadlineComputedBlock (only renders once profile.eventDate parses).
    const dcLabel = findSpanByText('YOUR ESTIMATED DEADLINE') || findSpanByText('DEADLINE MAY HAVE PASSED');
    const dcBody = findSpanByText('File by') || findSpanByText('This deadline may have passed');
    if (dcLabel) targets.push(['DeadlineComputedBlock label', dcLabel]);
    if (dcBody) targets.push(['DeadlineComputedBlock body', dcBody]);

    return targets.map(([name, el]) => {
      const color = parseColor(getComputedStyle(el).color);
      const bg = effectiveBg(el);
      return { name, ratio: contrast([color.r, color.g, color.b], bg), bg: bg.map(Math.round), color: [color.r, color.g, color.b] };
    });
  });

  const problems = [];
  if (result.length < 4) problems.push('expected 4 measured text nodes (FlsaSolNote label/body + DeadlineComputedBlock label/body), found ' + result.length + ': ' + JSON.stringify(result));
  result.forEach(r => {
    if (r.ratio < 4.5) problems.push(r.name + ' measured ' + r.ratio.toFixed(2) + ':1 against composited bg rgb(' + r.bg.join(',') + ') — below the 4.5:1 AA floor for bold text under ~18.66px');
  });
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  const detail = result.map(r => r.name + '=' + r.ratio.toFixed(2) + ':1').join(', ');
  console.log((ok ? '✅' : '❌') + ' Action-first Deadline Watch (' + tone + ' tone) — nested translucent text meets AA: ' + detail + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL NESTED-TRANSLUCENCY-CONTRAST CASES PASSED');
process.exit(fails ? 1 : 0);
