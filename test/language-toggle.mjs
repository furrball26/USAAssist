#!/usr/bin/env node
/*
 * The reading language (index.dev.html: LOCALES, LANG_KEY, LangBar, t()).
 *
 * Roughly one working adult in eight in the United States speaks Spanish at
 * home, and the people this site is for — the ones least likely to have the
 * law explained to them anywhere else — are heavily over-represented in that
 * group. So Spanish is not a nice-to-have here; it is most of the point.
 *
 * Shipping a translation nobody has checked is a real risk, which is why
 * LOCALES carries `reviewed` and the app promises, in a comment written
 * before this suite existed, that an unreviewed locale says so in its own
 * language on every screen. This suite is what makes that a promise rather
 * than a sentence in a comment. It asserts:
 *
 *   1. The picker is reachable on the very first screen a visitor sees —
 *      before the app, not behind a settings menu labelled in English.
 *   2. Picking Spanish actually renders Spanish, from the shipped catalogue.
 *   3. The unreviewed notice is on screen, in Spanish, without scrolling, on
 *      every screen — and is a DIFFERENT claim from the not-lawyer-checked
 *      chip, which is about the law rather than the translation.
 *   4. <html lang> follows the pick, so a screen reader changes voice.
 *   5. The pick survives a reload, and switching back to English clears the
 *      notice.
 *   6. No catalogue key leaks onto a Spanish screen (t() renders the key
 *      itself on a miss — deliberately ugly, and this is where it is caught).
 *   7. No English UI copy survives on a Spanish screen. This is the one that
 *      earns its keep: check-i18n.mjs reads the compiled createElement calls,
 *      so prose parked in a data array and rendered as `{label}` is invisible
 *      to it — which is exactly how the three tab labels, on every screen of
 *      the app, stayed English through the whole extraction. Reading the
 *      strings back off the rendered page is the only measurement that
 *      cannot be fooled that way.
 *
 * Run: node test/language-toggle.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChromePath } from './lib/chrome.mjs';
import { gotoApp, reloadApp } from './lib/nav.mjs';
import { devSource, constSource, catalogue } from './lib/appsrc.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

// ── Part 1 · the catalogue, before a browser is involved ────────────────────
const src = devSource();
const LOCALES = (0, eval)('(' + constSource(src, 'LOCALES').replace(/^const LOCALES =/, '') .replace(/;\s*$/, '') + ')');
const EN = catalogue(src, 'en');

ok(LOCALES.length >= 2, `more than one language ships (${LOCALES.map(l => l.code).join(', ')})`);
ok(LOCALES[0].code === 'en' && LOCALES[0].reviewed === true,
   'English is first and is the reviewed source language');

const unreviewed = LOCALES.filter(l => !l.reviewed);
ok(unreviewed.length > 0, 'at least one locale is honestly marked unreviewed');

for (const loc of LOCALES.slice(1)) {
  const table = catalogue(src, loc.code);
  ok(Object.keys(table).length === Object.keys(EN).length,
     `${loc.code}: the catalogue is complete (${Object.keys(table).length} of ${Object.keys(EN).length})`);
  /* The notice has to be IN the language it is about. A locale that shipped
     the English sentence would satisfy key parity and tell a Spanish reader
     nothing — which is the exact failure this line exists to catch. */
  ok(!loc.reviewed ? table['lang.unreviewed'] !== EN['lang.unreviewed'] : true,
     `${loc.code}: the unreviewed notice is written in ${loc.name}, not left in English`);
  /* Two different claims, and they must not read as one sentence said twice:
     draft.chip is about whether a lawyer checked the LAW, lang.unreviewed
     about whether anyone checked the TRANSLATION. */
  ok(table['lang.unreviewed'] !== table['draft.chip'],
     `${loc.code}: the translation notice is not a restatement of the law-review chip`);
}

// ── Part 2 · the app ────────────────────────────────────────────────────────
const ES = catalogue(src, 'es');
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

const settle = (ms = 900) => new Promise(r => setTimeout(r, ms));

/* Where the notice is, relative to the window — a notice below the fold on
   arrival is a notice nobody reads. */
const noticeBox = (pg, text) => pg.evaluate((want) => {
  const el = [...document.querySelectorAll('p')].find(n => (n.textContent || '').trim() === want);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), vh: window.innerHeight, w: Math.round(r.width) };
}, text);

try {
  // ── A fresh visitor, on the welcome screen ──
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await pg.setViewport({ width: 390, height: 844 });
  await gotoApp(pg, BASE, { freshVisitor: true });
  await settle(1200);

  const chips = await pg.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label]');
    if (!g) return null;
    return {
      label: g.getAttribute('aria-label'),
      buttons: [...g.querySelectorAll('button')].map(b => ({
        text: (b.textContent || '').trim(),
        lang: b.getAttribute('lang'),
        pressed: b.getAttribute('aria-pressed'),
        h: Math.round(b.getBoundingClientRect().height),
      })),
    };
  });
  ok(!!chips, 'the language picker is on the first screen a visitor sees, before the app');
  ok(chips && chips.label === EN['lang.label'], 'the picker names itself for a screen reader');
  ok(chips && chips.buttons.length === LOCALES.length,
     `every shipped language is offered (${chips ? chips.buttons.map(b => b.text).join(', ') : '—'})`);
  ok(chips && chips.buttons.every(b => b.text === LOCALES.find(l => l.code === b.lang).name),
     'each option is labelled in its own language, and carries lang= so it is pronounced in it');
  ok(chips && chips.buttons.every(b => b.h >= 44), 'each option clears the 44px touch target');
  ok(chips && chips.buttons.filter(b => b.pressed === 'true').length === 1,
     'exactly one option reads as the current language');
  ok(!(await noticeBox(pg, ES['lang.unreviewed'])) && !(await noticeBox(pg, EN['lang.unreviewed'])),
     'English carries no translation notice — there is no translation to disown');

  // ── Switch to Spanish, still before entering the app ──
  const pick = async (name) => {
    await pg.evaluate((n) => {
      const b = [...document.querySelectorAll('[role="group"] button')].find(x => (x.textContent || '').trim() === n);
      if (b) b.click();
    }, name);
    await settle();
  };
  await pick('Español');

  const text1 = await pg.evaluate(() => document.body.innerText);
  ok(text1.includes(ES['home.h1']), 'the welcome heading is in Spanish: “' + ES['home.h1'] + '”');
  ok(text1.includes(ES['home.cta']), 'so is the one button on it');
  ok(!text1.includes(EN['home.h1']), 'and the English heading is gone, not stacked beside it');
  ok(await pg.evaluate(() => document.documentElement.lang) === 'es',
     '<html lang> follows the pick, so a screen reader changes voice');
  ok(await pg.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label]');
    return g && g.getAttribute('aria-label');
  }) === ES['lang.label'], 'the picker renames itself too');

  const box = await noticeBox(pg, ES['lang.unreviewed']);
  ok(!!box, 'the unreviewed-translation notice is on screen, in Spanish');
  ok(box && box.top >= 0 && box.top < box.vh,
     'and above the fold on arrival, not something to scroll for');

  // ── It survives a reload: a language pick is not a per-visit accident ──
  await reloadApp(pg);
  await settle(1200);
  ok((await pg.evaluate(() => document.body.innerText)).includes(ES['home.h1']),
     'the language survives a reload');

  // ── ...and holds on every screen inside the app ──
  const pg2 = await browser.newPage();
  pg2.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg2.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await pg2.setViewport({ width: 390, height: 844 });
  await pg2.evaluateOnNewDocument(() => { try { localStorage.setItem('worklaw.lang.v1', 'es'); } catch (e) {} });
  await gotoApp(pg2, BASE, { place: { state: 'California', county: 'Los Angeles County', city: 'West Hollywood' } });
  await settle(1400);

  const tabs = await pg2.evaluate(() => [...document.querySelectorAll('nav.tabbar button')].map(b => (b.innerText || '').trim()));
  ok(tabs.length >= 3, `the tab bar is there in Spanish (${tabs.join(' · ')})`);

  const keys = Object.keys(EN);

  /* English copy that, if it appears on a Spanish page, can only have got
     there un-translated.

     A probe is the longest literal run of an English string (the {holes} are
     filled with live data, so they are cut out). Two exclusions keep it
     honest rather than noisy: anything that also occurs somewhere in the
     Spanish catalogue is a word the two languages share — "email", an agency
     name, a statute number — and anything under five characters is too short
     to be distinctive. That second rule has a cost worth stating: it cannot
     see a leaked "Laws". It caught two of the three tab labels, which was
     enough, and widening it turns the check into noise. */
  const esValues = Object.keys(ES).map(k => String(ES[k]));
  const probes = [];
  for (const k of keys) {
    if (ES[k] === undefined || ES[k] === EN[k]) continue;
    const seg = String(EN[k]).split(/\{[A-Za-z0-9_]+\}/)
      .map(x => x.trim()).sort((a, b) => b.length - a.length)[0] || '';
    if (seg.length < 5) continue;
    if (esValues.some(v => v.includes(seg))) continue;
    probes.push({ key: k, seg });
  }
  ok(probes.length > 300, `${probes.length} English strings are distinctive enough to be checked for`);

  const englishLeaks = (body) => probes.filter(p => body.includes(p.seg));
  for (let i = 0; i < tabs.length; i++) {
    await pg2.evaluate((n) => {
      const b = [...document.querySelectorAll('nav.tabbar button')][n];
      if (b) b.click();
    }, i);
    await settle(1100);
    const b = await noticeBox(pg2, ES['lang.unreviewed']);
    ok(b && b.top >= 0 && b.top < b.vh,
       `“${tabs[i]}”: the unreviewed-translation notice is on screen without scrolling`);
    const body = await pg2.evaluate(() => document.body.innerText);
    const leaked = keys.filter(k => body.includes(k));
    ok(leaked.length === 0,
       `“${tabs[i]}”: no untranslated catalogue key reaches the page` +
       (leaked.length ? ' — ' + leaked.slice(0, 4).join(', ') : ''));
    const eng = englishLeaks(body);
    ok(eng.length === 0,
       `“${tabs[i]}”: no English UI copy survives on the Spanish page` +
       (eng.length ? ' — ' + eng.slice(0, 4).map(x => x.key + ' (' + x.seg.slice(0, 40) + ')').join(', ') : ''));
  }

  // ── Back to English ──
  await pg2.evaluate(() => {
    const b = [...document.querySelectorAll('[role="group"] button')].find(x => (x.textContent || '').trim() === 'English');
    if (b) b.click();
  });
  await settle();
  ok(!(await noticeBox(pg2, ES['lang.unreviewed'])), 'switching back to English retires the notice');
  ok(await pg2.evaluate(() => document.documentElement.lang) === 'en', 'and <html lang> with it');

  ok(errs.length === 0, 'none of it logs an error' + (errs.length ? ': ' + errs[0] : ''));
  await pg.close(); await pg2.close();
} finally {
  await browser.close();
  server.close();
}

console.log(fails === 0 ? '\n✅ LANGUAGE PASSED' : `\n❌ LANGUAGE FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
