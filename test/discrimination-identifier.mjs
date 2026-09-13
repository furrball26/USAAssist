#!/usr/bin/env node
/*
 * Discrimination self-check identifier regression test.
 *
 * Guards the guided branching Q&A added for issueKey==='discrimination',
 * modeled on the existing FLSA overtime-exemption wizard (TREE_WAGE/
 * RESULTS_WAGE — see WIZARD_CONFIG/wizardConfigFor in index.dev.html):
 *
 *   1. The "Is this discrimination?" tool is shown ONLY on a discrimination
 *      case's dashboard (cfg.key === 'discrimination'), never on a wage
 *      case's — same gating as the wage wizard's "Am I exempt from
 *      overtime?" tile.
 *   2. Driving the tree to two different terminal answers ("employer under
 *      15 employees — federal coverage gap" and "protected class + adverse
 *      action + comparator — has the shape of a claim") renders a cited,
 *      non-conclusory result (hedged language — "may", "generally" —
 *      never a definitive legal conclusion).
 *   3. Every result carries the not-legal-advice framing and the EEOC
 *      deadline block (deadlines.eeocCharge), same as the wage wizard.
 *
 * Run: node test/discrimination-identifier.mjs
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

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;
const click = async (pg, t) => { await pg.evaluate((x) => { const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.includes(x)); e && e.click(); }, t); await new Promise(r => setTimeout(r, 300)); };
const bodyText = async (pg) => await pg.evaluate(() => document.body.innerText);
const PLACE = { state:'Texas', county:'Travis County' };
// The self-checks hang off the law topic they belong to now, not off a case's
// declared issue — so opening one means opening its topic first.
const openCheck = async (pg, topic, tool) => {
  await click(pg, topic);
  await new Promise(r => setTimeout(r, 300));
  await click(pg, tool);
  await new Promise(r => setTimeout(r, 400));
};
const NOT_LEGAL_ADVICE_RE = /not a legal opinion about your situation.{0,40}talk to an attorney/i;
const DEFINITIVE_CLAIM_RE = /\byou (have|are entitled to|will (win|recover)|definitely)\b/i;

try {

// 1. The tool is absent on a wage case's dashboard, present on a discrimination case's.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: PLACE });
  await new Promise(r => setTimeout(r, 800));
  const grid = await bodyText(pg);

  await click(pg, 'Pay & overtime');
  await new Promise(r => setTimeout(r, 400));
  const payTopic = await bodyText(pg);
  await click(pg, 'All topics');
  await new Promise(r => setTimeout(r, 400));
  await click(pg, 'Discrimination & harassment');
  await new Promise(r => setTimeout(r, 400));
  const discrimTopic = await bodyText(pg);
  await pg.close();

  const problems = [];
  if (/Is this discrimination\?/.test(grid)) problems.push('the topic grid itself offers the discrimination check, before any topic is opened');
  if (/Is this discrimination\?/.test(payTopic)) problems.push('the pay topic wrongly offers the discrimination check');
  if (!/Is this discrimination\?/.test(discrimTopic)) problems.push('the discrimination topic is missing the "Is this discrimination?" check');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "Is this discrimination?" lives under Discrimination & harassment only' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// 2. Terminal result A — employer under 15 employees, federal coverage gap.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: PLACE });
  await new Promise(r => setTimeout(r, 800));

  await openCheck(pg, 'Discrimination & harassment', 'Is this discrimination?');
  await click(pg, 'One of those is involved');
  await click(pg, 'Fewer than 15');
  await new Promise(r => setTimeout(r, 300));

  const text = await bodyText(pg);
  const problems = [];
  if (!/coverage/i.test(text)) problems.push('missing the employer-coverage explanation, got: ' + JSON.stringify(text.slice(0, 500)));
  if (!/\bmay\b/i.test(text)) problems.push('result reads as a flat statement, not hedged ("may")');
  if (DEFINITIVE_CLAIM_RE.test(text)) problems.push('result reads as a definitive legal conclusion');
  if (!/42 U\.S\.C\./.test(text)) problems.push('missing a citation');
  if (!NOT_LEGAL_ADVICE_RE.test(text)) problems.push('missing the not-legal-advice framing');
  if (!/DEADLINE WATCH/.test(text)) problems.push('missing the deadline block');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' terminal result: employer coverage gap' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. Terminal result B — protected class, 15+ employer, fired, comparator treated
//    better -> "has the shape of a discrimination claim".
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: PLACE });
  await new Promise(r => setTimeout(r, 800));

  await openCheck(pg, 'Discrimination & harassment', 'Is this discrimination?');
  await click(pg, 'One of those is involved');
  await click(pg, '15 or more');
  await click(pg, 'Fired');
  await click(pg, 'Yes, someone was treated better');
  await new Promise(r => setTimeout(r, 300));

  const text = await bodyText(pg);
  const problems = [];
  if (!/shape of a discrimination claim/i.test(text)) problems.push('expected the "has the shape of a discrimination claim" result, got: ' + JSON.stringify(text.slice(0, 500)));
  if (!/\bmay\b/i.test(text) && !/generally/i.test(text)) problems.push('result reads as a flat statement, not hedged');
  if (DEFINITIVE_CLAIM_RE.test(text)) problems.push('result reads as a definitive legal conclusion');
  if (!/2000e-2|Bostock/i.test(text)) problems.push('missing a citation');
  if (!NOT_LEGAL_ADVICE_RE.test(text)) problems.push('missing the not-legal-advice framing');
  if (!/DEADLINE WATCH/.test(text)) problems.push('missing the deadline block');
  // The onward CTAs used to open the log and the complaint-letter drafter.
  // Both are gone; a result now sends the reader to the law it was measured
  // against, and to whoever enforces it.
  if (!/Read the discrimination and harassment rules/i.test(text)) problems.push('missing the onward CTA back into the law');
  if (!/Who enforces this/i.test(text)) problems.push('missing the onward CTA to the enforcing agencies');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' terminal result: has the shape of a discrimination claim' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DISCRIMINATION IDENTIFIER CASES PASSED');
process.exit(fails ? 1 : 0);
