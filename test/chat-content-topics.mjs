#!/usr/bin/env node
/*
 * Chat CHAT_TOPICS content-router regression test.
 *
 * The chat's keyword router (send() in index.dev.html) previously reached only
 * six hardcoded reply buckets (overtime, retaliation, severance, ADA,
 * discrimination, wrongful-termination) plus an honest topic-neutral fallback —
 * everything else, including common questions the app's own content dataset
 * already answers (minimum wage, final pay, filing deadlines, non-compete,
 * meal breaks), hit that fallback. CHAT_TOPICS routes those questions onto the
 * SAME sourced content/_federal.json + content/states/*.json dataset Rights and
 * the wizards already read.
 *
 * This asserts, across several states (including sparse-content ones):
 *   - a topic match renders THAT STATE's own fact (summary + citation + a real
 *     https:// source link), never a different state's fact and never a
 *     federal fact presented as if it were state-specific;
 *   - a state with no fact on file for a matched topic gets an honest
 *     "I don't have a sourced answer" reply — no citation, no §/U.S.C./C.F.R.
 *     text, and a route to Rights — even though a DIFFERENT topic works fine
 *     for that same state (proving the gap is per-topic, not a state-wide
 *     failure being papered over);
 *   - with no state selected at all, a topic that has a genuine federal
 *     equivalent (minimum wage, EEOC charge deadline) falls back to the
 *     federal fact, clearly labeled FEDERAL, instead of the state fallback text
 *     or a guess; a topic with no federal equivalent (final pay) still gives
 *     the honest no-answer rather than inventing one;
 *   - the six existing reviewed reply buckets, and their existing precedence,
 *     are unaffected;
 *   - every new seeded quick-reply chip (minimum wage / final pay / filing
 *     deadline) actually routes to a real, on-topic answer, not the fallback
 *     (the FIND-05 regression class this task explicitly calls out).
 * Run: node test/chat-content-topics.mjs
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
const NO_ANSWER_SNIPPET = "I don't have a sourced answer for";
const CITE_RE = /§|U\.S\.C\.|C\.F\.R\.|Code|Stat\./;

function seedFor(stateSel, issue) {
  return {
    onboarded: true, stateSel, county: '', issue,
    profile: { name: '', employer: '', payType: '', rate: '' },
    caseOpened: new Date().toISOString(), entries: [], done: {}, messages: [],
  };
}

// CASES either type a free-form question (`q`) or click a seeded quick-reply
// chip (`chip`) — the chip cases prove FIND-05 never recurs for the three new
// chips this task adds.
const CASES = [
  // ── Real state answer: dense-coverage topics, two different states ──
  { label:'TX EEOC-charge deadline — state fact, state citation',
    state:'Texas', issue:'Discrimination', q:'How long do I have to file an EEOC charge?',
    expectSnippet:'TCHRA', expectCite:'Tex. Labor Code § 21.202(a), (a-1)', expectNotCite:'42 U.S.C. § 2000e-5(e)(1)' },
  { label:'AL minimum wage — state fact, state citation, NOT the overtime reply',
    state:'Alabama', issue:'Unpaid overtime or wages', q:"What's the minimum wage in Alabama?",
    expectSnippet:'Alabama has not enacted a state minimum wage', expectCite:'29 U.S.C. 206', expectNotSnippet:'Not approved' },

  // ── Per-topic gap, not a state-wide failure: Florida has no final-pay fact
  //    but DOES have a non-compete fact and a minimum-wage fact ──
  { label:'FL last paycheck — honest no-answer (no final-pay fact on file)',
    state:'Florida', issue:'Fired or pushed out', q:'When do I get my last paycheck?',
    expectNoAnswer:true },
  { label:'FL non-compete — real state answer (same state, different topic)',
    state:'Florida', issue:'A document to review', q:'Is my non-compete enforceable here?',
    expectSnippet:'Florida enforces reasonable non-compete', expectCite:'Fla. Stat. § 542.335' },
  { label:'FL minimum wage — real state answer (same state, different topic), NOT the overtime reply',
    state:'Florida', issue:'Unpaid overtime or wages', q:"What's the minimum wage in Florida?",
    expectSnippet:"Florida's minimum wage", expectCite:'Fla. Const. art. X', expectNotSnippet:'Not approved' },
  { label:'TX wage-claim deadline — natural phrasing, state fact, NOT the overtime reply',
    state:'Texas', issue:'Unpaid overtime or wages', q:'How long do I have to file a wage claim?',
    expectSnippet:'Texas Workforce Commission', expectCite:'Tex. Labor Code § 61.051(c)', expectNotSnippet:'Not approved' },

  // ── Sparse-content topic: non-compete is only sourced for 10 states ──
  { label:'AL non-compete — honest no-answer (sparse topic, this state has none)',
    state:'Alabama', issue:'A document to review', q:'Is my non-compete enforceable here?',
    expectNoAnswer:true },
  { label:'CA non-compete — real state answer (same sparse topic, a state that has it)',
    state:'California', issue:'A document to review', q:'Is my non-compete enforceable here?',
    expectSnippet:'California voids nearly all employee non-compete', expectCite:'Cal. Bus. & Prof. Code' },

  // ── Extremely sparse-content topic: meal breaks sourced for exactly 1 state ──
  { label:'TN meal break — real state answer (the one state with this fact)',
    state:'Tennessee', issue:'A document to review', q:'What is the meal break rule here?',
    expectSnippet:'Tennessee requires a 30-minute' },
  { label:'TX meal break — honest no-answer (no meal-break fact on file)',
    state:'Texas', issue:'A document to review', q:'What is the meal break rule here?',
    expectNoAnswer:true },

  // ── No state selected: a topic with a genuine federal equivalent falls back
  //    to the FEDERAL fact, clearly labeled — never presented as state-specific ──
  { label:'No state + EEOC charge deadline — federal fallback, clearly labeled',
    state:'', issue:'Discrimination', q:'How long do I have to file an EEOC charge?',
    expectSnippet:'FEDERAL', expectCite:'42 U.S.C. § 2000e-5(e)(1)' },
  { label:'No state + minimum wage — federal fallback, clearly labeled',
    state:'', issue:'Unpaid overtime or wages', q:"What's the minimum wage here?",
    expectSnippet:'FEDERAL', expectCite:'29 U.S.C. § 206(a)(1)' },
  // Final pay has NO federal equivalent (FLSA sets no final-paycheck deadline) —
  // even with nothing state-specific to fall back from, this must stay an
  // honest no-answer, never a guess and never federal-presented-as-state.
  { label:'No state + last paycheck — honest no-answer (no federal equivalent exists)',
    state:'', issue:'Fired or pushed out', q:'When do I get my last paycheck?',
    expectNoAnswer:true },

  // ── The six existing reviewed reply buckets are unaffected ──
  { label:'existing overtime bucket unaffected',
    state:'Texas', issue:'Unpaid overtime or wages', q:'Can my boss refuse to pay overtime?',
    expectSnippet:'Not approved' },
  { label:'existing ADA bucket unaffected',
    state:'Texas', issue:'Discrimination', q:'How do I ask for an ADA accommodation?',
    expectSnippet:'interactive process', expectCite:'42 U.S.C. §12112' },
  { label:'unmatched question still gets the honest topic-neutral fallback',
    state:'Texas', issue:'Unpaid overtime or wages', q:'Where do I sign the timesheet?',
    expectFallback:true },

  // ── Seeded quick-reply chips actually route to a real answer (FIND-05) ──
  // Worded the way a person actually asks it — "what's the minimum wage" —
  // now that minimumWage/wageClaimDeadline are checked BEFORE isOvertime's
  // bare "wage(s)" stem in the router precedence (see send() in index.dev.html).
  { label:'seeded chip: minimum wage (wage issue)',
    state:'Texas', issue:'Unpaid overtime or wages', chip:"What's the minimum wage here?",
    expectSnippet:'Texas sets its state minimum wage', expectCite:'Tex. Labor Code § 62.051' },
  { label:'seeded chip: last paycheck (termination issue)',
    state:'Texas', issue:'Fired or pushed out', chip:'When do I get my last paycheck?',
    expectSnippet:'Texas Payday Law', expectCite:'Tex. Labor Code § 61.014' },
  { label:'seeded chip: EEOC charge deadline (discrimination issue)',
    state:'Texas', issue:'Discrimination', chip:'How long do I have to file an EEOC charge?',
    expectSnippet:'TCHRA', expectCite:'Tex. Labor Code § 21.202(a), (a-1)' },
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
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seedFor(c.state, c.issue));
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate(() => { const e = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Ask AI')); e && e.click(); });
  await new Promise(r => setTimeout(r, 400)); // let content/_federal.json + content/states/<AB>.json load before asking

  if (c.chip) {
    const clicked = await pg.evaluate((chipText) => {
      const btn = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === chipText);
      if (!btn) return false;
      btn.click();
      return true;
    }, c.chip);
    if (!clicked) errs.push('seeded chip not found on screen: ' + JSON.stringify(c.chip));
  } else {
    await pg.evaluate(() => { const i = document.querySelector('input[placeholder="Type your question"]'); i && i.focus(); });
    await pg.keyboard.type(c.q, { delay:4 });
    await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Send'); btn && btn.click(); });
  }
  await new Promise(r => setTimeout(r, 1300)); // reply fires after a 900ms simulated-typing delay

  const last = await pg.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    if (!log) return null;
    const bubbles = [...log.children].filter(el => el.textContent.trim().length > 0);
    const lastBubble = bubbles[bubbles.length - 1];
    return lastBubble ? lastBubble.textContent : null;
  });
  // A real https:// source link, if any, must be the one rendered alongside
  // this exact reply — checked separately from the text so a citation chip
  // and a "Source ↗" link are both accounted for.
  const sourceHref = await pg.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    if (!log) return null;
    const bubbles = [...log.children].filter(el => el.textContent.trim().length > 0);
    const lastBubble = bubbles[bubbles.length - 1];
    const link = lastBubble && lastBubble.querySelector('a[href^="https://"]');
    return link ? link.href : null;
  });

  const problems = [];
  if (!last) {
    problems.push('no AI reply rendered');
  } else {
    if (c.expectFallback && !last.includes(FALLBACK_SNIPPET)) problems.push('expected the topic-neutral fallback, got: ' + JSON.stringify(last));
    if (c.expectFallback && CITE_RE.test(last)) problems.push('fallback reply wrongly carries a citation: ' + JSON.stringify(last));
    if (c.expectNoAnswer) {
      if (!last.includes(NO_ANSWER_SNIPPET)) problems.push('expected the honest no-sourced-answer reply, got: ' + JSON.stringify(last));
      if (CITE_RE.test(last)) problems.push('no-answer reply wrongly carries a citation: ' + JSON.stringify(last));
      if (sourceHref) problems.push('no-answer reply wrongly carries a source link: ' + sourceHref);
    }
    if (c.expectSnippet && !last.includes(c.expectSnippet)) problems.push('expected reply to include ' + JSON.stringify(c.expectSnippet) + ', got: ' + JSON.stringify(last));
    if (c.expectNotSnippet && last.includes(c.expectNotSnippet)) problems.push('reply wrongly includes ' + JSON.stringify(c.expectNotSnippet) + ': ' + JSON.stringify(last));
    if (c.expectCite && !last.includes(c.expectCite)) problems.push('expected citation ' + JSON.stringify(c.expectCite) + ' missing from: ' + JSON.stringify(last));
    if (c.expectNotCite && last.includes(c.expectNotCite)) problems.push('reply wrongly includes a DIFFERENT jurisdiction\'s citation ' + JSON.stringify(c.expectNotCite) + ': ' + JSON.stringify(last));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + c.label + (ok ? '' : '\n   ' + problems.slice(0, 6).join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL CHAT CONTENT-TOPIC CASES PASSED');
process.exit(fails ? 1 : 0);
