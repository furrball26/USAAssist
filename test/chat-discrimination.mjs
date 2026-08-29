#!/usr/bin/env node
/*
 * Chat router discrimination/harassment coverage regression test.
 *
 * "Ask AI" claims to cover "discrimination and harassment" in its own fallback
 * copy, but until this fix the keyword router (send() in index.dev.html) had no
 * isDiscrimination route at all — isAda/isRetaliation/isSeverance/isOvertime were
 * the only topics matched, so every discrimination/harassment question silently
 * fell through to the generic "I can only give sample answers on..." fallback.
 * This asserts realistic on-topic questions — a direct-keyword discrimination
 * question, a direct-keyword harassment/hostile-work-environment question, and a
 * religious-accommodation-scheduling-conflict question that only matches via the
 * protected-characteristic + adverse-treatment word pairing (no bare "discriminat"/
 * "harass" keyword) — all get a real, topic-appropriate reply, not the fallback.
 * Run: node test/chat-discrimination.mjs
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

const FALLBACK_SNIPPET = 'I can only give sample answers';

const CASES = [
  // Direct-keyword discrimination question.
  {
    q: 'I was passed over for promotion three times and everyone promoted was a different race than me — is that race discrimination?',
    expectSnippet: 'Discrimination is adverse treatment',
    expectCite: '42 U.S.C. §2000e-2',
  },
  // Direct-keyword harassment / hostile-work-environment question.
  {
    q: 'My manager keeps making unwelcome comments about my religion and I think it is creating a hostile work environment.',
    expectSnippet: 'Harassment is unwelcome conduct',
    expectCite: '42 U.S.C. §2000e-2',
  },
  // Religious-accommodation scheduling conflict — no "discriminat"/"harass" keyword,
  // must still route via the protected-characteristic + adverse-treatment pairing,
  // not fall through to the fallback (this exact shape of question was verified
  // fallback-only before the fix).
  {
    q: 'My employer denied my schedule change for my religious observance but approved the same swap for a coworker of a different religion.',
    expectSnippet: 'Discrimination is adverse treatment',
    expectCite: '42 U.S.C. §2000e-2',
  },
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
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Discrimination',
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
    const bubbles = [...log.children].filter(el => el.textContent.trim().length > 0);
    const lastBubble = bubbles[bubbles.length - 1];
    return lastBubble ? lastBubble.textContent : null;
  });

  const problems = [];
  if (!last) {
    problems.push('no AI reply rendered');
  } else {
    if (last.includes(FALLBACK_SNIPPET)) problems.push('got the generic fallback reply instead of a discrimination/harassment answer: ' + JSON.stringify(last));
    if (c.expectSnippet && !last.includes(c.expectSnippet)) problems.push('expected reply to include ' + JSON.stringify(c.expectSnippet) + ', got: ' + JSON.stringify(last));
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
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL CHAT DISCRIMINATION/HARASSMENT CASES PASSED');
process.exit(fails ? 1 : 0);
