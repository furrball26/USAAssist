#!/usr/bin/env node
/*
 * First-run welcome screen + state-map picker.
 *
 * A genuinely fresh visitor lands on the welcome illustration (index.dev.html:
 * `Welcome`), not on onboarding. This asserts the four things that make that
 * screen safe rather than merely decorative:
 *
 *   1. It appears once. A fresh device sees it; after entering, a reload goes
 *      straight to onboarding. The gate is a device-level key
 *      (SEEN_WELCOME_KEY), NOT the case blob — so it must survive a case
 *      being cleared, which is the whole reason it lives outside saveCase().
 *   2. It never traps anyone: one call to action, and it leaves.
 *   3. The illustration is announced as ONE image, not fifty state outlines
 *      and six figures — a screen-reader user should hear a sentence, not a
 *      list.
 *   4. The state map and the <select> stay in agreement. The map is real
 *      Census geography (content/geo/_states.json) and an ENHANCEMENT over the
 *      labelled select (index.dev.html: UsaStatePicker) — picking a state on
 *      the map must set the same value the select shows, and every rendered
 *      shape must correspond to a state the app has content for (no dead
 *      DC/PR shapes, since content/states/ has neither).
 *
 * Run: node test/welcome-first-run.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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
const URL_ = `http://127.0.0.1:${PORT}/index.html`;
const b = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };
const clickText = async (pg, t) => {
  await pg.evaluate((x) => {
    const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.trim() === x);
    if (e) e.click();
  }, t);
  await new Promise(r => setTimeout(r, 300));
};
/*
 * Each case gets its own browser context, which starts with empty storage.
 *
 * NOT evaluateOnNewDocument(localStorage.clear): that hook re-runs on every
 * navigation, so it wipes the seen flag during the very reload that is meant
 * to prove the flag persisted — the "does it replay?" assertions can then
 * never pass, whatever the app does. An isolated context gives a genuinely
 * fresh device once, and lets reloads behave like real reloads.
 */
const contexts = [];
const freshPage = async () => {
  const ctx = await b.createBrowserContext();
  contexts.push(ctx);
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  return { pg, errs };
};

try {

// ── 1 · a fresh visitor sees the welcome, and it is announced as one image ──
{
  const { pg, errs } = await freshPage();
  await gotoApp(pg, URL_, { freshVisitor: true });
  const t = await pg.evaluate(() => document.body.innerText);
  ok(/Know your rights at work/i.test(t), 'fresh visitor lands on the welcome screen');
  ok(!/Pick a topic|Where in /i.test(t), 'welcome is shown INSTEAD of the law itself, not alongside it');

  const art = await pg.evaluate(() => {
    const s = [...document.querySelectorAll('svg[role="img"]')]
      .find(el => /United States/i.test(el.getAttribute('aria-label') || ''));
    if (!s) return null;
    return {
      label: s.getAttribute('aria-label'),
      // Anything focusable or individually labelled inside would be announced
      // separately — the whole point of role="img" is that it is not.
      inner: s.querySelectorAll('[role],[aria-label],[tabindex]').length,
    };
  });
  ok(!!art, 'welcome illustration carries role="img" with a US-referencing label');
  ok(art && art.inner === 0, 'illustration announces as one image (no individually-labelled children)');
  ok(errs.length === 0, 'no console/page errors on the welcome screen' + (errs.length ? ': ' + errs[0] : ''));
  await pg.close();
}

// ── 2 · the primary CTA enters the app, and the welcome does not return ──
{
  const { pg } = await freshPage();
  await gotoApp(pg, URL_, { freshVisitor: true });
  await clickText(pg, 'Find my state’s rules');
  let t = await pg.evaluate(() => document.body.innerText);
  ok(await pg.$('#onb-state') !== null, 'primary button enters the state map');

  await reloadApp(pg);
  t = await pg.evaluate(() => document.body.innerText);
  ok(!/Know your rights at work/i.test(t), 'welcome does not replay on reload');
  await pg.close();
}

// ── 3 · the intro offers exactly one way ON, and it is not a trap ──
// There used to be a "Skip" link under the primary button wired to the SAME
// handler: two controls, one destination, and an opt-out that opted out of
// nothing. It is gone, so assert the shape rather than the old label — a
// second CTA reappearing here is the regression worth catching.
//
// The language picker sits on this screen too (LangBar), and deliberately: a
// reader who cannot read English cannot go looking for a settings menu
// labelled in English, so the one screen everyone starts on is where the
// choice has to be. It is not a second way on — it changes the language of
// the screen you are already reading — so it is excluded by its role, and
// then checked BELOW to be sure that is actually true of it.
{
  const { pg } = await freshPage();
  await gotoApp(pg, URL_, { freshVisitor: true });
  const ctas = await pg.evaluate(() => [...document.querySelectorAll('button')]
    .filter(b => !b.closest('[role="group"]'))
    .map(b => (b.textContent || '').trim()).filter(Boolean));
  ok(ctas.length === 1, `the welcome screen offers one call to action, not several — found: ${JSON.stringify(ctas)}`);

  // The exclusion above is only honest if the excluded controls really do stay
  // put. Pressing one must translate this screen, not leave it.
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('[role="group"] button')].find(x => (x.textContent || '').trim() === 'Español');
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 600));
  ok(await pg.$('#onb-state') === null, 'choosing a language stays on the welcome screen — it is a control, not a destination');
  ok(/Conozca sus derechos en el trabajo/.test(await pg.evaluate(() => document.body.innerText)),
     'and it does translate the screen it is on');
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('[role="group"] button')].find(x => (x.textContent || '').trim() === 'English');
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 600));

  await clickText(pg, 'Find my state’s rules');
  ok(await pg.$('#onb-state') !== null, 'that one button leaves the welcome screen for the state map');
  await pg.close();
}

// ── 4 · forgetting the remembered place must NOT replay the intro ──
// The flag deliberately lives outside the stored place; if it ever moves into
// savePrefs(), someone who changes state gets the first-run splash again.
// Simulate exactly that: place gone, welcome flag intact.
{
  const { pg } = await freshPage();
  await gotoApp(pg, URL_, { freshVisitor: true });
  await clickText(pg, 'Find my state’s rules');
  await pg.evaluate(() => { try { localStorage.removeItem('worklaw.place.v1'); } catch (e) {} });
  await reloadApp(pg);
  const t = await pg.evaluate(() => document.body.innerText);
  ok(!/Find my state.s rules/i.test(t), 'forgetting the remembered place does not replay the welcome');
  ok(await pg.$('#onb-state') !== null, 'forgetting the remembered place returns to the state map');
  await pg.close();
}

// ── 5 · state map is an enhancement over the select, and has no dead shapes ──
{
  const { pg, errs } = await freshPage();
  await gotoApp(pg, URL_);           // seeded: straight to the state map
  await new Promise(r => setTimeout(r, 1200));   // the map is fetched, not bundled
  // Coverage is about what is DRAWN, so read data-state: nine states are too
  // small to tap and are deliberately not controls (test/small-state-targets.mjs),
  // but they must still appear on the map. Reachability is asserted below.
  const shapes = await pg.evaluate(() =>
    [...document.querySelectorAll('.wlUsMap path[data-state]')].map(el => el.getAttribute('data-state')));
  ok(shapes.length === 50, `map renders one shape per supported state (got ${shapes.length}, expected 50)`);
  ok(!shapes.includes('District of Columbia') && !shapes.includes('Puerto Rico'),
    'no shape for DC/PR — the app has no content file for either, so it would select nothing');
  ok(shapes.every(l => l && l.length > 2), 'every shape names a full state, not an abbreviation');
  // Every shape that IS a control must also carry that name to a screen reader.
  const unlabelled = await pg.evaluate(() =>
    [...document.querySelectorAll('.wlUsMap path[role="button"]')]
      .filter(el => (el.getAttribute('aria-label') || '') !== el.getAttribute('data-state'))
      .map(el => el.getAttribute('data-state')));
  ok(unlabelled.length === 0,
    'every shape offered as a control announces its state name' + (unlabelled.length ? `: ${unlabelled.join(', ')}` : ''));

  // The labelled <select> must still be present — the map never replaces it.
  ok(await pg.$('#onb-state') !== null, 'the conventional labelled <select> is still present alongside the map');

  // The select must offer exactly the states the map does — one control can
  // never reach a state the other cannot.
  const opts = await pg.$$eval('#onb-state option', els => els.map(e => e.value).filter(Boolean));
  ok(opts.length === 50, `the state select offers 50 states (got ${opts.length})`);
  ok(shapes.every(l => opts.includes(l)), 'every state on the map is also in the select');
  ok(opts.every(v => shapes.includes(v)), 'every state in the select also has a shape on the map');

  // Drawn is not the same as pickable. Every state must be reachable without
  // the <select>, whether by its own shape or by a small-state button.
  const pickable = await pg.evaluate(() => {
    const names = new Set();
    document.querySelectorAll('.wlUsMap path[role="button"]').forEach(el => names.add(el.getAttribute('data-state')));
    document.querySelectorAll('button').forEach(b => names.add((b.textContent || '').trim()));
    return [...names];
  });
  const unreachable = opts.filter(v => !pickable.includes(v));
  ok(unreachable.length === 0,
    'every state is pickable by a shape or a button, not only by the select' +
    (unreachable.length ? `: ${unreachable.join(', ')}` : ''));

  // Picking on the map takes you to the same place picking in the select does:
  // that state's counties.
  await pg.evaluate(() => {
    const el = [...document.querySelectorAll('.wlUsMap path[role="button"]')]
      .find(e => e.getAttribute('aria-label') === 'California');
    el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 600));
  ok(/Where in California/i.test(await pg.evaluate(() => document.body.innerText)),
     'clicking a state on the map advances to that state’s counties');
  ok(errs.length === 0, 'no console/page errors using the map' + (errs.length ? ': ' + errs[0] : ''));
  await pg.close();
}

// ── 6 · the map data itself matches what ships in content/states ──
// Guards the inverse of test 5 at the source: a state file with no shape would
// silently drop a supported state off the map.
{
  const geo = JSON.parse(readFileSync(join(ROOT, 'content/geo/_states.json'), 'utf8'));
  const abbrs = geo.states.map(s => s.abbr);
  const shipped = readdirSync(join(ROOT, 'content/states'))
    .filter(f => f.endsWith('.json') && f !== '_TEMPLATE.json')
    .map(f => f.replace('.json', ''));
  const missing = shipped.filter(a => !abbrs.includes(a));
  const extra = abbrs.filter(a => !shipped.includes(a));
  ok(missing.length === 0, 'every shipped state file has a shape on the national map' + (missing.length ? ': missing ' + missing.join(', ') : ''));
  ok(extra.length === 0, 'the national map carries no shape without content behind it' + (extra.length ? ': ' + extra.join(', ') : ''));
}

} finally {
  await b.close();
  server.close();
}

console.log(fails === 0 ? '\n✅ WELCOME / STATE-MAP PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
