#!/usr/bin/env node
/*
 * Desktop responsive layout regression test (design-desktop-icons.md, Part 2).
 *
 * Below 768px the layout must be unchanged: a fixed-size (or, under 520px,
 * full-bleed) skeuomorphic phone device. At 768-1023px the fake phone bezel
 * and status bar go away in favor of a bordered "paper card" capped at
 * ~600px. At >=1024px the app becomes a full-height desktop shell: the
 * bottom tab bar becomes a fixed-width left icon rail and the content column
 * is capped at max-width 680px, centered with beige gutters. Onboarding (no
 * tab bar) must not reserve rail space at the desktop tier.
 *
 * Run: node test/desktop-layout.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

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

async function openHome(pg, homeMode = 'standard') {
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', rate:'50000' },
    caseOpened:new Date().toISOString(), homeMode, entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));
}

async function openOnboarding(pg) {
  await pg.evaluateOnNewDocument(() => localStorage.clear());
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 500));
}

const deviceBox = (pg) => pg.evaluate(() => {
  const d = document.querySelector('.device');
  const s = document.querySelector('.screen');
  const rect = d.getBoundingClientRect();
  const dcs = getComputedStyle(d);
  const scs = getComputedStyle(s);
  return {
    deviceWidth: Math.round(rect.width),
    deviceBg: dcs.backgroundColor,
    screenBorder: scs.borderWidth + ' ' + scs.borderStyle,
    screenDisplay: scs.display,
    screenGridCols: scs.gridTemplateColumns,
    statusbarVisibility: getComputedStyle(document.querySelector('.statusbar')).visibility,
    hasTabbar: !!document.querySelector('.tabbar'),
    tabbarDisplay: document.querySelector('.tabbar') ? getComputedStyle(document.querySelector('.tabbar')).display : null,
    scrollareaMaxWidth: (() => {
      const child = document.querySelector('.scrollarea > *');
      return child ? getComputedStyle(child).maxWidth : null;
    })(),
  };
});

// Case 1: <520px — mobile — full-bleed device, unchanged.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.setViewport({ width:390, height:844, deviceScaleFactor:1 });
  await openHome(pg, 'standard');

  const box = await deviceBox(pg);
  const problems = [];
  if (box.deviceWidth < 380) problems.push('device is not full-bleed at 390px: width=' + box.deviceWidth);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' 390px (mobile): full-bleed device, unchanged' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: 600-767px — below the new "wide" tier — still the classic
// fixed-410px phone mockup (untouched range, sanity check the floor).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.setViewport({ width:700, height:900, deviceScaleFactor:1 });
  await openHome(pg, 'standard');

  const box = await deviceBox(pg);
  const problems = [];
  if (box.deviceWidth !== 410) problems.push('expected the unchanged 410px phone box at 700px viewport, got ' + box.deviceWidth);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' 700px (below wide tier): still the fixed-410px phone box' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: 768-1023px — "wide" tier — bordered paper card, no dark bezel, no
// status bar, capped near 600px.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.setViewport({ width:900, height:900, deviceScaleFactor:1 });
  await openHome(pg, 'standard');

  const box = await deviceBox(pg);
  const problems = [];
  if (box.deviceWidth > 600) problems.push('device exceeds the 600px paper-card cap at 900px viewport: ' + box.deviceWidth);
  if (box.deviceWidth < 400) problems.push('device is too narrow for the paper-card tier: ' + box.deviceWidth);
  if (box.deviceBg !== 'rgba(0, 0, 0, 0)' && box.deviceBg !== 'transparent') problems.push('.device still has the dark phone-bezel background at 900px: ' + box.deviceBg);
  if (box.statusbarVisibility !== 'hidden') problems.push('fake status bar is not hidden at 900px: ' + box.statusbarVisibility);
  if (!/2px/.test(box.screenBorder)) problems.push('.screen is missing its 2px ink border at 900px: ' + box.screenBorder);
  if (box.tabbarDisplay !== 'grid') problems.push('tab bar should still be a bottom bar (grid) at 900px, got display=' + box.tabbarDisplay);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' 900px (wide tier): bordered paper card, no bezel, bottom tab bar' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: >=1024px — "desktop" tier — full-height shell, left rail nav,
// content column capped at 680px, for all three home modes.
for (const [width, mode] of [[1280, 'standard'], [1280, 'action'], [1280, 'plain'], [1920, 'standard']]) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.setViewport({ width, height:900, deviceScaleFactor:1 });
  await openHome(pg, mode);

  const box = await deviceBox(pg);
  const problems = [];
  if (box.screenDisplay !== 'grid') problems.push('.screen is not a grid shell at ' + width + 'px: ' + box.screenDisplay);
  if (box.tabbarDisplay !== 'flex') problems.push('rail nav should be a flex column at ' + width + 'px, got display=' + box.tabbarDisplay);
  if (box.scrollareaMaxWidth !== '680px') problems.push('content column is not capped at 680px at ' + width + 'px: ' + box.scrollareaMaxWidth);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + width + 'px desktop tier (home mode "' + mode + '"): left rail + 680px capped column' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 5: onboarding (no tab bar) at >=1024px must not reserve rail space —
// .screen.no-tabbar collapses the grid to a single column.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.setViewport({ width:1280, height:900, deviceScaleFactor:1 });
  await openOnboarding(pg);

  const hasNoTabbarClass = await pg.evaluate(() => document.querySelector('.screen').classList.contains('no-tabbar'));
  const gridCols = await pg.evaluate(() => getComputedStyle(document.querySelector('.screen')).gridTemplateColumns);
  const railPresent = await pg.evaluate(() => !!document.querySelector('.tabbar'));
  const problems = [];
  if (!hasNoTabbarClass) problems.push('onboarding .screen is missing the no-tabbar modifier class');
  if (railPresent) problems.push('onboarding should render no rail nav at all (no tab bar on this screen)');
  // A single-column grid should not reserve the 104px rail track.
  if (/^104px/.test(gridCols.trim())) problems.push('onboarding still reserves the 104px rail column at 1280px: ' + gridCols);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' onboarding at desktop tier: no rail, no reserved 104px column' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DESKTOP-LAYOUT CASES PASSED');
process.exit(fails ? 1 : 0);
