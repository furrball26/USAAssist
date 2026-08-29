#!/usr/bin/env node
/*
 * Chat keyword-router false-positive regression test (F3, and the Aug 2026
 * automated-review Critical finding: the router's keyword matching was broad
 * enough to give confidently wrong, citation-backed answers to two real classes
 * of question).
 *
 * The chat's keyword router must match on word boundaries / real intent, not bare
 * substrings — "Where do I sign the timesheet?" must NOT route to the severance/
 * OWBPA reply just because it contains "sign", "Can I exterminate the pests in the
 * breakroom?" must NOT route to the termination/retaliation reply just because it
 * contains "terminat", and an unmatched question must NEVER carry a statutory
 * §-citation (the code's own rule — a citation on an unmatched reply reads as
 * authoritative for a question the app never actually understood). Two more
 * specific regressions: "sign + any document noun" (NDA, offer letter, a plain
 * contract) must NOT get the severance/OWBPA 21/7-day reply — that reply is
 * specific to a severance or release-of-claims document, not any document a
 * person might sign — and a 1099/independent-contractor coverage question must
 * NOT get the overtime reply, which presupposes employee status and never
 * addresses the actual question asked.
 * Run: node test/chat-router.mjs
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

const FALLBACK_SNIPPET = 'I can only give sample answers';

const CASES = [
  // Bare-substring false positives that must now fall through to the fallback reply.
  { q:'Where do I sign the timesheet?', expectFallback:true },
  { q:'Can I get my employer to update my signature on file?', expectFallback:true },
  { q:'Do I need to assign someone to cover my shift?', expectFallback:true },
  { q:'Who can help me design a new schedule?', expectFallback:true },
  { q:'Should I resign from the safety committee?', expectFallback:true },
  { q:'Can I exterminate the pests in the breakroom?', expectFallback:true },
  { q:"What's a good adapter for my laptop charger?", expectFallback:true },
  // "sign + document noun" that is NOT a severance/release document must NOT get
  // the OWBPA 21/7-day reply — that reply is specific to severance/release-of-
  // claims agreements, not any document a person might sign.
  { q:'Should I sign this NDA?', expectFallback:true },
  { q:'Can I sign the offer letter today?', expectFallback:true },
  { q:'My manager wants me to sign a new contract, should I?', expectFallback:true },
  // A 1099/independent-contractor coverage question must NOT get the overtime
  // reply — that reply presupposes employee status and doesn't address whether
  // wage-and-hour law covers the person at all.
  { q:'I drive for a delivery app and got a 1099, not a W-2. Am I covered by wage and hour law or am I an independent contractor?', expectFallback:true },
  // Real intent must still match.
  { q:'Should I sign this severance agreement?', expectSnippet:'21 days', expectCite:'29 U.S.C. §626(f)' },
  { q:'I was fired for reporting safety issues, is that retaliation?', expectSnippet:'Retaliation means' },
  { q:'How do I ask for an ADA accommodation?', expectSnippet:'interactive process', expectCite:'42 U.S.C. §12112' },
  { q:'Can my boss refuse to pay overtime?', expectSnippet:'Not approved' },
  // FIND-05 (docs/audit-2026-08-29.md) — the app's own seeded quick-reply chip for
  // termination cases, verbatim, must route to the wrongful-termination reply, not
  // the (different-theory) retaliation reply the bare "terminat" stem previously
  // matched.
  { q:'Is this a wrongful termination?', expectSnippet:'at-will', expectNotSnippet:'Retaliation means' },
  { q:'Was I wrongfully discharged?', expectSnippet:'at-will', expectNotSnippet:'Retaliation means' },
  // A genuine retaliation question — including one that also happens to say
  // "fired" — must still route to the retaliation reply, not the wrongful-
  // termination one, since the phrase "wrongful" never appears.
  { q:'I was fired right after I filed a complaint, is that retaliation?', expectSnippet:'Retaliation means' },
];

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

for (const c of CASES) {
  const pg = await b.newPage();
  await pg.setViewport({ width:430, height:840, deviceScaleFactor:1 });
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'', employer:'', payType:'', rate:'' },
    caseOpened:new Date().toISOString(), entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate(() => { const e = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Ask AI')); e && e.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const i = document.querySelector('input[placeholder="Type your question"]'); i && i.focus(); });
  await pg.keyboard.type(c.q, { delay:4 });
  await pg.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Send'); b && b.click(); });
  await new Promise(r => setTimeout(r, 1300)); // reply fires after a 900ms simulated-typing delay

  const last = await pg.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    if (!log) return null;
    // Each message bubble has real text; the log's final child is always the empty
    // scroll-anchor div (`<div ref={chatEnd}>`), so filter to non-empty bubbles.
    const bubbles = [...log.children].filter(el => el.textContent.trim().length > 0);
    const lastBubble = bubbles[bubbles.length - 1];
    return lastBubble ? lastBubble.textContent : null;
  });

  const problems = [];
  if (!last) {
    problems.push('no AI reply rendered');
  } else {
    if (c.expectFallback && !last.includes(FALLBACK_SNIPPET)) problems.push('expected fallback reply, got: ' + JSON.stringify(last));
    if (c.expectFallback && /§|U\.S\.C\.|C\.F\.R\./.test(last)) problems.push('unmatched/fallback reply carries a citation: ' + JSON.stringify(last));
    if (c.expectSnippet && !last.includes(c.expectSnippet)) problems.push('expected reply to include ' + JSON.stringify(c.expectSnippet) + ', got: ' + JSON.stringify(last));
    if (c.expectNotSnippet && last.includes(c.expectNotSnippet)) problems.push('reply wrongly includes ' + JSON.stringify(c.expectNotSnippet) + ': ' + JSON.stringify(last));
    if (c.expectCite && !last.includes(c.expectCite)) problems.push('expected citation ' + JSON.stringify(c.expectCite) + ' missing from: ' + JSON.stringify(last));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + JSON.stringify(c.q) + (ok ? '' : '\n   ' + problems.slice(0, 6).join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL CHAT ROUTER CASES PASSED');
process.exit(fails ? 1 : 0);
