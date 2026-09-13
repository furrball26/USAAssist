#!/usr/bin/env node
/*
 * Harassment (hostile work environment) self-check identifier regression test.
 *
 * Guards the guided branching Q&A added for issueKey==='harassment', modeled on
 * the existing FLSA overtime-exemption wizard (TREE_WAGE/RESULTS_WAGE — see
 * WIZARD_CONFIG/wizardConfigFor in index.dev.html):
 *
 *   1. The "Is this harassment?" tool is shown ONLY on a harassment case's
 *      dashboard (cfg.key === 'harassment'), never on a wage case's — same
 *      gating as the wage wizard's "Am I exempt from overtime?" tile.
 *   2. Driving the tree to two different terminal answers ("general rudeness,
 *      no protected-characteristic link" and "hostile work environment")
 *      renders a cited, non-conclusory result (hedged language — "may",
 *      "generally" — never a definitive legal conclusion).
 *   3. Every result carries the not-legal-advice framing and the EEOC
 *      deadline block (deadlines.eeocCharge), same as the wage wizard.
 *
 * Run: node test/harassment-identifier.mjs
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

// 1. The check lives under Discrimination & harassment, and nowhere else.
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
  if (/Is this harassment\?/.test(grid)) problems.push('the topic grid itself offers the harassment check, before any topic is opened');
  if (/Is this harassment\?/.test(payTopic)) problems.push('the pay topic wrongly offers the harassment check');
  if (!/Is this harassment\?/.test(discrimTopic)) problems.push('the discrimination topic is missing the "Is this harassment?" check');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "Is this harassment?" lives under Discrimination & harassment only' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// 2. Terminal result A — general rudeness, no protected-characteristic link.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: PLACE });
  await new Promise(r => setTimeout(r, 800));

  await openCheck(pg, 'Discrimination & harassment', 'Is this harassment?');
  await click(pg, 'No, it feels like general rudeness');
  await new Promise(r => setTimeout(r, 300));

  const text = await bodyText(pg);
  const problems = [];
  if (!/protected characteristic/i.test(text)) problems.push('missing the protected-characteristic explanation, got: ' + JSON.stringify(text.slice(0, 500)));
  if (!/\bmay\b/i.test(text)) problems.push('result reads as a flat statement, not hedged ("may")');
  if (DEFINITIVE_CLAIM_RE.test(text)) problems.push('result reads as a definitive legal conclusion');
  if (!/42 U\.S\.C\./.test(text)) problems.push('missing a citation');
  if (!NOT_LEGAL_ADVICE_RE.test(text)) problems.push('missing the not-legal-advice framing');
  if (!/DEADLINE WATCH/.test(text)) problems.push('missing the deadline block');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' terminal result: no protected-characteristic link' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. Terminal result B — protected + unwelcome + repeated by a coworker, reported
//    with no action taken -> "may rise to a hostile work environment".
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: PLACE });
  await new Promise(r => setTimeout(r, 800));

  await openCheck(pg, 'Discrimination & harassment', 'Is this harassment?');
  await click(pg, 'Yes, it is tied to one of those');
  await click(pg, 'Yes, it was unwelcome');
  await click(pg, 'Repeated over time');
  await click(pg, 'A coworker');
  await click(pg, 'I reported it and nothing changed');
  await new Promise(r => setTimeout(r, 300));

  const text = await bodyText(pg);
  const problems = [];
  if (!/hostile work environment/i.test(text)) problems.push('expected a hostile-work-environment result, got: ' + JSON.stringify(text.slice(0, 500)));
  if (!/\bmay\b/i.test(text) && !/generally/i.test(text)) problems.push('result reads as a flat statement, not hedged');
  if (DEFINITIVE_CLAIM_RE.test(text)) problems.push('result reads as a definitive legal conclusion');
  if (!/Meritor|Harris v\. Forklift/i.test(text)) problems.push('missing a citation');
  if (!NOT_LEGAL_ADVICE_RE.test(text)) problems.push('missing the not-legal-advice framing');
  if (!/DEADLINE WATCH/.test(text)) problems.push('missing the deadline block');
  if (!/REPORTING & RETALIATION/i.test(text)) problems.push('missing the report-and-anti-retaliation note');
  // The onward CTAs used to open the log and the complaint-letter drafter.
  // Both are gone; a result now sends the reader to the law it was measured
  // against, and to whoever enforces it.
  if (!/Read the discrimination and harassment rules/i.test(text)) problems.push('missing the onward CTA back into the law');
  if (!/Who enforces this/i.test(text)) problems.push('missing the onward CTA to the enforcing agencies');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' terminal result: hostile work environment' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL HARASSMENT IDENTIFIER CASES PASSED');
process.exit(fails ? 1 : 0);
