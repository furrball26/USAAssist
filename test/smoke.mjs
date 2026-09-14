#!/usr/bin/env node
/*
 * Headless smoke test: serves the repo, loads the built index.html, clicks through
 * every screen, and fails on any page error / console error. Run: node test/smoke.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { resolveChromePath } from './lib/chrome.mjs';
import puppeteer from 'puppeteer-core';
import { gotoApp, reloadApp } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml' };

// tiny static server (same-origin so content/*.json fetches resolve)
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// locate the installed chrome-headless-shell
const chromePath = resolveChromePath();

const errors = [];
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE.ERROR: ' + m.text()); });

const clickText = async (label) => {
  const clicked = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('button,a')];
    const el = els.find(e => e.textContent.trim().includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, label);
  await new Promise(r => setTimeout(r, 350));
  return clicked;
};
const bodyText = () => page.evaluate(() => document.body.innerText);
const assert = (cond, msg) => { if (!cond) errors.push('ASSERT: ' + msg); };

try {
  // ── 1 · a first-ever visitor lands on the welcome, then the map ──
  await gotoApp(page, BASE + '/index.html', { freshVisitor: true });
  await new Promise(r => setTimeout(r, 500));
  const rootKids = await page.evaluate(() => document.getElementById('root')?.childElementCount || 0);
  assert(rootKids > 0, '#root did not render');
  assert(/Know your rights at work/i.test(await bodyText()), 'welcome screen did not render for a fresh visitor');
  await clickText("Find my state");
  let txt = await bodyText();
  assert(/Where do you work/i.test(txt), 'the map step did not render after the welcome');

  // Both ways in, always: the map for people who can point at where they live,
  // the labelled <select> for everyone the map fails.
  assert(await page.$('#onb-state') !== null, 'the labelled state <select> is missing beside the map');
  // Nine states are too small to tap and deliberately leave the map's a11y tree
  // for a button of their own (see test/small-state-targets.mjs), so a raw count
  // of shapes no longer means "every state is reachable". Assert the thing that
  // actually matters instead: each of the 50 has SOME control naming it.
  const reachable = await page.evaluate(() => {
    const names = new Set();
    document.querySelectorAll('.wlUsMap path[role="button"]').forEach(p => names.add(p.getAttribute('aria-label')));
    document.querySelectorAll('button').forEach(b => names.add((b.textContent || '').trim()));
    return [...document.querySelectorAll('#onb-state option')]
      .map(o => o.value).filter(Boolean)
      .filter(n => !names.has(n));
  });
  assert(reachable.length === 0,
    `every state must be pickable by a map shape or a button, not only the <select>; unreachable: ${reachable.join(', ')}`);

  // ── 2 · state → county → topics ──
  await page.select('#onb-state', 'California');
  await new Promise(r => setTimeout(r, 500));
  txt = await bodyText();
  assert(/Where in California/i.test(txt), 'picking a state did not advance to the county step');
  assert(await page.$('#onb-county') !== null, 'the labelled county <select> is missing beside the county map');
  // The county step states OUR coverage, never the law's. California has local
  // ordinances on file, so it names the counties it holds and says plainly that a
  // county missing from that list is a gap in our data, not an absence of local law.
  assert(/We hold local ordinances for/i.test(txt), 'the county step does not name the counties we hold local law for');
  assert(/does not mean your county has no ordinance/i.test(txt), 'the county step does not disclaim that missing data means no local law exists');

  await page.select('#onb-county', 'Alameda County');
  await new Promise(r => setTimeout(r, 600));
  txt = await bodyText();
  assert(/Your rights in California/i.test(txt), 'picking a county did not reach the topic grid');
  assert(/Pay & overtime/i.test(txt), 'the topic grid did not render its categories');

  // ── 3 · a topic opens the law, plain English above the citation ──
  assert(await clickText('Pay & overtime'), 'the Pay & overtime topic was not clickable');
  txt = await bodyText();
  assert(/THE LAW/i.test(txt), 'the category view did not render a THE LAW block');
  assert(/Cal\. Lab\. Code/i.test(txt), 'the category view did not render a California citation');

  // ── 4 · the three tabs, and only three ──
  const tabs = await page.$$eval('.tabbar button', els => els.map(e => e.innerText.trim()));
  assert(tabs.length === 3, `expected 3 tabs, found ${tabs.length}: ${tabs.join(', ')}`);
  for (const t of ['Laws', 'All rights', 'Agencies']) {
    assert(tabs.some(x => x.includes(t)), `tab "${t}" missing`);
  }
  // The removed features must be gone from the chrome, not merely unreachable.
  for (const gone of ['Ask AI', 'Log']) {
    assert(!tabs.some(x => x === gone), `retired tab "${gone}" still renders`);
  }

  assert(await clickText('All rights'), 'All rights tab not found');
  txt = await bodyText();
  assert(/Every rule, as written/i.test(txt), 'the raw rights listing did not render');
  assert(await clickText('Agencies'), 'Agencies tab not found');
  txt = await bodyText();
  assert(/Who enforces this/i.test(txt), 'the agencies directory did not render');
  assert(/Equal Employment Opportunity Commission/i.test(txt), 'the federal agency list is missing the EEOC');

  // ── 5 · a self-check runs off a topic, with no case behind it ──
  assert(await clickText('Laws'), 'Laws tab not found');
  await clickText('Pay & overtime');
  assert(await clickText('Am I exempt from overtime?'), 'the overtime self-check is not reachable from the pay topic');
  txt = await bodyText();
  assert(/How are you paid/i.test(txt), 'the self-check did not render its first question');
  assert(await clickText('Hourly'), 'the self-check did not accept an answer');
  // Hourly branches once more (the computer-employee carve-out) before a verdict.
  assert(await clickText('No'), 'the self-check did not accept the second answer');
  txt = await bodyText();
  assert(/non-exempt/i.test(txt), 'answering Hourly then No did not reach a non-exempt verdict');
  assert(/29 C\.F\.R/i.test(txt), 'the verdict did not cite the regulation behind it');

  // ── 6 · the place survives a reload; nothing else is kept ──
  await reloadApp(page);
  await new Promise(r => setTimeout(r, 700));
  txt = await bodyText();
  assert(!/Know your rights at work[\s\S]*Find my state/i.test(txt), 'reload replayed the welcome screen');
  const stored = await page.evaluate(() => Object.keys(localStorage).sort());
  assert(!stored.includes('worklaw.case.v2'), 'the retired case blob is still being written');
  const place = await page.evaluate(() => JSON.parse(localStorage.getItem('worklaw.place.v1') || '{}'));
  assert(place.stateSel === 'California', `reload lost the remembered state (got ${JSON.stringify(place)})`);

  if (errors.length) { errors.slice(0, 20).forEach(e => console.log('  ' + e)); }
} catch (e) {
  console.log('❌ SMOKE CRASHED:', e.message);
  errors.push(e.message);
} finally {
  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
}
