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
import { resolveChromePath } from './lib/chrome.mjs';
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
const chrome = resolveChromePath();

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function openHome(pg) {
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`,
    { place: { state: 'Texas', county: 'Travis County' } });
  await new Promise(r => setTimeout(r, 800));
}

// The welcome illustration is the one screen with no tab bar — everything
// else in the app is a destination inside it.
async function openWelcome(pg) {
  // localStorage is per-ORIGIN, not per-page: an earlier case in this same
  // browser has already set the seen-welcome flag, so `freshVisitor` alone
  // (which only declines to seed it) would not produce a fresh visitor. Drop
  // both keys on this document before the app's own script runs.
  await pg.evaluateOnNewDocument(() => {
    try { localStorage.removeItem('worklaw.seenWelcome.v1'); localStorage.removeItem('worklaw.place.v1'); } catch (e) {}
  });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { freshVisitor: true });
  await new Promise(r => setTimeout(r, 600));
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
    screenBg: scs.backgroundColor,
    columnBg: (() => {
      const child = document.querySelector('.scrollarea > *');
      return child ? getComputedStyle(child).backgroundColor : null;
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
  await openHome(pg);

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
  await openHome(pg);

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
  await openHome(pg);

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
// content column capped at 680px.
// R2 (review-2-report.md): .screen itself must be the beige "desk" gutter
// (#F3EFE7 = rgb(243, 239, 231)); the reading column color must be confined
// to the 680px reading column, not flood the full-width .screen.
// Home is a single Standard layout now — the mode-dependent column color
// (navy for Action-first, white for Plain) is gone; the column is always
// Standard's cream, including for a case saved under one of those retired
// `homeMode` values (backward compat — see home-mode-edit-pill.mjs).
const DESK_BG = 'rgb(243, 239, 231)';
const STANDARD_COLUMN_BG = 'rgb(255, 253, 248)';
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
  // R1 (review-2-report.md): the dark phone-bezel .device background/padding/
  // radius/shadow must be reset at the desktop tier too (it used to only be
  // reset in the 768-1023 "wide" tier, leaking a navy rounded frame at >=1024).
  if (box.deviceBg !== 'rgba(0, 0, 0, 0)' && box.deviceBg !== 'transparent') problems.push('.device still has the dark phone-bezel background at ' + width + 'px: ' + box.deviceBg);
  if (box.screenBg !== DESK_BG) problems.push('.screen is not the beige desk gutter (' + DESK_BG + ') at ' + width + 'px: ' + box.screenBg);
  if (box.columnBg !== STANDARD_COLUMN_BG) problems.push('680px column background (saved homeMode "' + mode + '") should always be Standard\'s cream ' + STANDARD_COLUMN_BG + ' at ' + width + 'px, got ' + box.columnBg);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + width + 'px desktop tier (saved homeMode "' + mode + '"): left rail + 680px capped Standard column' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 5: the welcome screen (no tab bar) at >=1024px must not reserve rail
// space — .screen.no-tabbar collapses the grid to a single column.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.setViewport({ width:1280, height:900, deviceScaleFactor:1 });
  await openWelcome(pg);

  const hasNoTabbarClass = await pg.evaluate(() => document.querySelector('.screen').classList.contains('no-tabbar'));
  const gridCols = await pg.evaluate(() => getComputedStyle(document.querySelector('.screen')).gridTemplateColumns);
  const railPresent = await pg.evaluate(() => !!document.querySelector('.tabbar'));
  const problems = [];
  if (!hasNoTabbarClass) problems.push('the welcome .screen is missing the no-tabbar modifier class');
  if (railPresent) problems.push('the welcome screen should render no rail nav at all');
  // A single-column grid should not reserve the 104px rail track.
  if (/^104px/.test(gridCols.trim())) problems.push('the welcome screen still reserves the 104px rail column at 1280px: ' + gridCols);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' welcome at desktop tier: no rail, no reserved 104px column' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 6 (coverage gap from review-2-report.md: "desktop-layout.mjs only
// checks home/onboarding — sweep the other 9 screens for the rail + 680px
// cap"). Every non-home tool/tab screen must show the same desktop shell as
// Home — left icon rail (flex), 680px-capped content column — AND must never
// force horizontal scroll at the desktop tier.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.setViewport({ width:1280, height:900, deviceScaleFactor:1 });
  await openHome(pg);

  const click = async (t) => {
    await pg.evaluate((text) => {
      const el = [...document.querySelectorAll('button,a')].find((e) => e.textContent.includes(text));
      if (el) el.click();
    }, t);
    await new Promise(r => setTimeout(r, 350));
  };
  const noHorizontalScroll = () => pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  const screens = [
    { label:'Laws — topic grid', open: async () => { await click('Laws'); } },
    { label:'Laws — one topic', open: async () => { await click('Laws'); await click('Pay & overtime'); } },
    { label:'Self-check (wizard)', open: async () => { await click('Laws'); await click('Pay & overtime'); await click('Am I exempt'); } },
    { label:'Non-compete checker', open: async () => { await click('Laws'); await click('All topics'); await click('Leaving a job'); await click('Is my non-compete'); } },
    { label:'All rights', open: () => click('All rights') },
    { label:'Agencies', open: () => click('Agencies') },
  ];


  for (const s of screens) {
    const errsBefore = errs.length;
    await s.open();
    const box = await deviceBox(pg);
    const scrollOk = await noHorizontalScroll();
    const problems = [];
    if (box.screenDisplay !== 'grid') problems.push('.screen is not a grid shell: ' + box.screenDisplay);
    if (box.tabbarDisplay !== 'flex') problems.push('rail nav should be a flex column, got display=' + box.tabbarDisplay);
    if (box.scrollareaMaxWidth !== '680px') problems.push('content column is not capped at 680px: ' + box.scrollareaMaxWidth);
    if (!scrollOk) problems.push('page forces horizontal scroll at 1280px');
    errs.slice(errsBefore).forEach(e => problems.push(e));

    const ok = problems.length === 0;
    if (!ok) fails++;
    console.log((ok ? '✅' : '❌') + ' 1280px desktop tier — ' + s.label + ': rail + 680px cap + no h-scroll' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  }
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DESKTOP-LAYOUT CASES PASSED');
process.exit(fails ? 1 : 0);
