#!/usr/bin/env node
/*
 * Custom icon set regression test (design-desktop-icons.md, Part 1).
 *
 * The app used to render 11 bare Unicode glyphs (⌂ ✦ ◷ § ⚖ ◉ ⏱ ▤ ✎ ‹ ✓) plus a
 * 12th "← Dashboard" arrow as plain text spans. All twelve were replaced with
 * the shared <Icon name=".." /> inline-SVG component. This guards against a
 * regression back to bare glyph text, and confirms every call site actually
 * renders a real <svg> (an unknown/typo'd icon name silently renders nothing,
 * per Icon()'s own contract, so "no bare glyph" alone isn't enough).
 *
 * Run: node test/icon-set.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { gotoApp, reloadApp } from './lib/nav.mjs';

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

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

// The 11 glyphs the icon set replaced, plus the "←" back-link arrow. These
// must never again appear as *visible page text* (they're fine inside JS
// comments/strings baked into inline <script>, so we scope the check to the
// rendered #root DOM's textContent, not the raw HTML source). "§" is
// deliberately excluded — it's the correct, legitimate legal-citation symbol
// used throughout real content (e.g. "29 C.F.R. §541.600") and was only ever
// a glyph-icon in the Rights-tab/exempt-tool call sites, which the SVG count
// assertions below already cover.
const BANNED_GLYPHS = ['⌂', '✦', '◷', '⚖', '◉', '⏱', '▤', '✎', '‹', '✓', '←', '⚠'];

async function seedAndOpen(pg, extra = {}) {
  const seed = Object.assign({
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', rate:'50000' },
    caseOpened:new Date().toISOString(), homeMode:'standard',
    entries:[{ date:'Jan 1, 2026', iso:new Date().toISOString(), title:'Hours', tag:'Wage & hour', color:'#EF7B22', body:'Worked unpaid overtime.' }],
    done:{}, messages:[],
  }, extra);
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
}

const rootText = (pg) => pg.evaluate(() => document.getElementById('root').textContent);
const svgCount = (pg) => pg.evaluate(() => document.querySelectorAll('#root svg').length);

// Case 1: Home (Standard) — tab bar (5 icons), Tools grid (4 icons), Deadline
// Watch badge, ◉ location pill, next-step checkbox all render real <svg>s and
// no bare glyph text leaks into the page.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, { homeMode:'standard' });

  const text = await rootText(pg);
  const svgs = await svgCount(pg);
  const problems = [];
  BANNED_GLYPHS.forEach(g => { if (text.includes(g)) problems.push('bare glyph "' + g + '" still present as visible text on Home (standard)'); });
  if (svgs < 10) problems.push('expected at least 10 <svg> icons on Home (standard) (tab bar x5 + tools grid x4 + deadline/pill), found ' + svgs);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Home (standard): icon set renders, no bare glyphs' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: Home (Action-first) and Home (Plain) — same check, different theme
// variant, to cover the dark/Action-first Deadline Watch badge specifically.
for (const mode of ['action', 'plain']) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, { homeMode: mode });

  const text = await rootText(pg);
  const svgs = await svgCount(pg);
  const problems = [];
  BANNED_GLYPHS.forEach(g => { if (text.includes(g)) problems.push('bare glyph "' + g + '" still present as visible text on Home (' + mode + ')'); });
  if (svgs < 5) problems.push('expected at least 5 <svg> icons on Home (' + mode + '), found ' + svgs);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Home (' + mode + '): icon set renders, no bare glyphs' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: Log screen (a primary tab, no "← Dashboard" link of its own) —
// attachment fallback icon (document glyph).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, {
    entries:[{ date:'Jan 1, 2026', iso:new Date().toISOString(), title:'Note', tag:'Statement', color:'#2B3AA8', body:'Filed a note.',
      attachment:{ name:'notes.pdf', type:'application/pdf', dataUrl:'data:application/pdf;base64,JVBERi0=' } }],
  });
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('nav button')].find(b => /Log/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const text = await rootText(pg);
  const svgs = await svgCount(pg);
  const problems = [];
  BANNED_GLYPHS.forEach(g => { if (text.includes(g)) problems.push('bare glyph "' + g + '" still present as visible text on Log'); });
  if (svgs < 6) problems.push('expected at least 6 <svg> icons on Log (tab bar x5 + attachment), found ' + svgs);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Log: attachment icon renders, no bare glyphs' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3b: any tool screen reached from Home (e.g. Draft a letter) shows the
// iconized "Dashboard" back link — the 12th glyph flagged for consistency in
// spec Part 1 ("← Dashboard" plain-arrow links, out of the original 11 but
// swapped to <Icon name="back"> anyway).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg);
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Draft a letter/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const text = await rootText(pg);
  const dashboardHasIcon = await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Dashboard/.test(b.textContent));
    return !!(btn && btn.querySelector('svg'));
  });
  const problems = [];
  BANNED_GLYPHS.forEach(g => { if (text.includes(g)) problems.push('bare glyph "' + g + '" still present as visible text on Letter'); });
  if (!dashboardHasIcon) problems.push('"← Dashboard" back link has no <Icon name="back"> — the 12th glyph flagged in spec Part 1 not applied');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Letter: iconized "Dashboard" back link, no bare glyphs' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: onboarding step 2+ — iconized "Back" control (no longer "‹ Back").
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument(() => localStorage.clear());
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate(() => { const sel = document.querySelector('#onb-state'); sel.value = 'Texas'; sel.dispatchEvent(new Event('change', { bubbles:true })); });
  await new Promise(r => setTimeout(r, 150));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 250));

  const text = await rootText(pg);
  const backHasIcon = await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Back to the previous step');
    return !!(btn && btn.querySelector('svg'));
  });
  const problems = [];
  BANNED_GLYPHS.forEach(g => { if (text.includes(g)) problems.push('bare glyph "' + g + '" still present as visible text on onboarding step 2'); });
  if (!backHasIcon) problems.push('onboarding Back control has no <Icon name="back">');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Onboarding: iconized Back control, no bare glyphs' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 5 (R7, docs/review-2-report.md) — the Agencies tab ("Where to file a
// complaint") used to reuse a scales/justice glyph, which reads as
// "lawyer/court" rather than "free government office you can file with
// directly". It must now render the distinct "building" icon.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg);

  const agenciesIconHtml = await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('nav button')].find(b => /Agencies/.test(b.textContent));
    const svg = btn && btn.querySelector('svg');
    return svg ? svg.innerHTML : null;
  });
  const problems = [];
  if (!agenciesIconHtml) problems.push('no <svg> found in the Agencies tab button');
  // "M3 21h18" is the building icon's ground line, not present in any other
  // icon; a scales/justice glyph would instead contain "M12 3v17".
  else if (!agenciesIconHtml.includes('M3 21h18')) problems.push('Agencies tab icon is not the "building" glyph: ' + agenciesIconHtml);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Agencies tab uses the "building" icon, not scales/justice' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL ICON-SET CASES PASSED');
process.exit(fails ? 1 : 0);
