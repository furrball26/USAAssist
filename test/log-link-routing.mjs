#!/usr/bin/env node
/*
 * Log entry-point routing regression test.
 *
 * The Log screen's active "kind" (Wage & hour / Statement / Records / Witness)
 * is session state (logKind) shared across every CTA that opens the Log. A CTA
 * that navigates with a bare nav('log')/setScreen('log') WITHOUT also setting
 * logKind inherits whatever kind was last selected elsewhere in the session —
 * so a link that promises "Log my hours" could silently land the user on
 * whatever form they last touched (commonly the Statement form), and a
 * "Log a witness" link could land on the wrong form too.
 *
 * Covers:
 *   (a) the wage exemption wizard's non-exempt "Log my hours" CTA always opens
 *       the Hours-worked (Wage & hour) form — even when the session's last
 *       selected kind was Statement;
 *   (b) the harassment identifier's "Log a witness" CTA opens the Witness form.
 *
 * Run: node test/log-link-routing.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
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
const chrome = execSync(`find "${ROOT}chrome-headless-shell" -type f -name 'chrome-headless-shell' | head -1`).toString().trim();

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

async function freshPage(seed) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return { pg, errs };
}

async function clickButtonWithText(pg, text) {
  return pg.evaluate((text) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.textContent.includes(text));
    if (btn) { btn.click(); return true; }
    return false;
  }, text);
}

async function activeKindLabel(pg) {
  return pg.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Entry type"]');
    if (!group) return null;
    const btn = [...group.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') === 'true');
    return btn ? btn.textContent.trim() : null;
  });
}

try {

// Case A: the wage exemption wizard's non-exempt "Log my hours" CTA must open
// the Hours-worked form, even after the session last had the Statement kind
// selected (the bug: a bare nav('log') inherited that stale kind).
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  const { pg, errs } = await freshPage(seed);
  const problems = [];

  // 1. Open the Log directly and switch its kind to Statement — this is the
  //    stale session state a later "Log my hours" CTA must NOT inherit.
  const openedLog = await clickButtonWithText(pg, 'Log an incident or hours');
  await new Promise(r => setTimeout(r, 250));
  const switchedToStatement = await clickButtonWithText(pg, 'Something said');
  await new Promise(r => setTimeout(r, 200));
  const kindAfterSwitch = await activeKindLabel(pg);
  if (!openedLog) problems.push('could not open the Log from the Tools grid');
  if (!switchedToStatement) problems.push('could not select the Statement kind in the Log');
  if (kindAfterSwitch !== 'Something said') problems.push('Log kind was not Statement before navigating away (got ' + JSON.stringify(kindAfterSwitch) + ')');

  // 2. Back to the dashboard (bottom tab bar — the Log screen itself has no
  //    "Dashboard" back button), into the overtime-exemption wizard, answer to
  //    a non-exempt result ("Hourly" -> "No"), then click "Log my hours".
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('.tabbar-btn')].find(b => b.textContent.includes('Home')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 250));
  const openedWizard = await clickButtonWithText(pg, 'Am I exempt from overtime?');
  await new Promise(r => setTimeout(r, 250));
  const answered1 = await clickButtonWithText(pg, 'Hourly');
  await new Promise(r => setTimeout(r, 200));
  const answered2 = await clickButtonWithText(pg, 'No');
  await new Promise(r => setTimeout(r, 250));
  if (!openedWizard) problems.push('could not open the overtime-exemption wizard');
  if (!answered1) problems.push('could not answer "Hourly"');
  if (!answered2) problems.push('could not answer "No" to reach a non-exempt result');

  const clickedLogHours = await clickButtonWithText(pg, 'Log my hours');
  await new Promise(r => setTimeout(r, 250));
  if (!clickedLogHours) problems.push('no "Log my hours" CTA on the non-exempt result');

  const kindOnLog = await activeKindLabel(pg);
  const hasDateWorked = await pg.evaluate(() => !!document.querySelector('#log-date') && !!document.querySelector('label[for="log-date"]'));
  const hasSpeakerField = await pg.evaluate(() => !!document.querySelector('#log-speaker-name'));
  if (kindOnLog !== 'Hours worked') problems.push('"Log my hours" opened the Log with kind ' + JSON.stringify(kindOnLog) + ', not Hours worked');
  if (!hasDateWorked) problems.push('"Log my hours" did not open the Hours-worked form (#log-date/"Date worked" missing)');
  if (hasSpeakerField) problems.push('"Log my hours" opened the Statement form instead (#log-speaker-name present)');

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' wage wizard "Log my hours" opens Hours-worked, not a stale Statement kind' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case B: the harassment identifier's "Log a witness" CTA must open the
// Witness form.
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Harassment or a hostile workplace',
    profile:{ name:'Pat Vega', employer:'Northgate Co' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  const { pg, errs } = await freshPage(seed);
  const problems = [];

  const openedWizard = await clickButtonWithText(pg, 'Is this harassment?');
  await new Promise(r => setTimeout(r, 250));
  // "No, it feels like general rudeness..." reaches a result in one click; the
  // harassment result's Log CTAs (goLog('Witness')/goLog('Statement')) render
  // regardless of which result was reached.
  const answered = await clickButtonWithText(pg, 'No, it feels like general rudeness or a personality conflict');
  await new Promise(r => setTimeout(r, 250));
  if (!openedWizard) problems.push('could not open the harassment identifier wizard');
  if (!answered) problems.push('could not answer the identifier question to reach a result');

  const clickedLogWitness = await clickButtonWithText(pg, 'Log a witness');
  await new Promise(r => setTimeout(r, 250));
  if (!clickedLogWitness) problems.push('no "Log a witness" CTA on the harassment result');

  const kindOnLog = await activeKindLabel(pg);
  const hasWitnessField = await pg.evaluate(() => !!document.querySelector('#log-witness-name'));
  if (kindOnLog !== 'A witness') problems.push('"Log a witness" opened the Log with kind ' + JSON.stringify(kindOnLog) + ', not A witness');
  if (!hasWitnessField) problems.push('"Log a witness" did not open the Witness form (#log-witness-name missing)');

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' harassment identifier "Log a witness" opens the Witness form' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LOG-LINK-ROUTING CASES PASSED');
process.exit(fails ? 1 : 0);
