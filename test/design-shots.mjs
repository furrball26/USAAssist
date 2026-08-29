#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { gotoApp, reloadApp } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml' };
const OUT = join(ROOT, 'test');

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const chromePath = execSync(`find "${ROOT}chrome-headless-shell" -type f -name 'chrome-headless-shell' 2>/dev/null | head -1`).toString().trim();
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });

const clickText = async (page, label) => {
  const clicked = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('button,a')];
    const el = els.find(e => e.textContent.trim().includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, label);
  await new Promise(r => setTimeout(r, 350));
  return clicked;
};
const shot = async (page, name) => { await new Promise(r => setTimeout(r, 150)); await page.screenshot({ path: join(OUT, name + '.png') }); console.log('shot:', name); };

async function run(width, tag) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844 });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));

  await page.evaluate(() => localStorage.clear()).catch(()=>{});
  await gotoApp(page, BASE + '/index.html');
  await new Promise(r => setTimeout(r, 500));
  await shot(page, `${tag}-01-onboarding-step1`);

  // fill onboarding to get a real case with a wage issue
  await page.select('#onb-state', 'California').catch(()=>{});
  await new Promise(r => setTimeout(r, 150));
  await clickText(page, 'Continue');
  const counties = await page.$$eval('#onb-county option', o => o.map(x => x.value).filter(Boolean)).catch(()=>[]);
  if (counties.length) await page.select('#onb-county', counties[0]);
  await new Promise(r => setTimeout(r, 150));
  await shot(page, `${tag}-02-onboarding-step2`);
  await clickText(page, 'Continue');
  await shot(page, `${tag}-03-onboarding-step3-issue`);
  await clickText(page, 'Unpaid overtime or wages');
  await clickText(page, 'Continue');
  await shot(page, `${tag}-04-onboarding-step4-details`);
  await clickText(page, 'Open my dashboard');
  await shot(page, `${tag}-05-home-standard`);

  await clickText(page, 'Action-first');
  await shot(page, `${tag}-06-home-actionfirst`);
  await clickText(page, 'Plain');
  await shot(page, `${tag}-07-home-plain`);
  await clickText(page, 'Standard');

  await clickText(page, 'Rights');
  await shot(page, `${tag}-08-rights`);

  await clickText(page, 'Agencies');
  await shot(page, `${tag}-09-agencies`);

  await clickText(page, 'Log');
  await shot(page, `${tag}-10-log-empty`);
  await clickText(page, 'Log an incident');
  await shot(page, `${tag}-11-log-entry-form`);
  await clickText(page, 'Home');

  await clickText(page, 'Draft a letter');
  await shot(page, `${tag}-12-letters`);

  await clickText(page, 'Home');
  await clickText(page, 'Ask AI');
  await shot(page, `${tag}-13-chat`);

  await clickText(page, 'Home');
  const ok1 = await clickText(page, 'Am I exempt from overtime');
  if (ok1) await shot(page, `${tag}-14-exemption-checker`);

  await clickText(page, 'Home');
  const ok2 = await clickText(page, 'What am I owed');
  if (!ok2) await clickText(page, 'estimate');
  await shot(page, `${tag}-15-estimator`);

  await clickText(page, 'Home');
  const ok3 = await clickText(page, 'Review a document');
  if (ok3) await shot(page, `${tag}-16-doc-review`);

  await clickText(page, 'Home');
  const ok4 = await clickText(page, 'Deadline');
  if (ok4) await shot(page, `${tag}-17-deadlines`);

  // Error state: kill content fetches then reload a fresh screen
  await page.setRequestInterception(true);
  page.on('request', req => { if (req.url().includes('/content/')) req.abort(); else req.continue(); });
  await clickText(page, 'Home');
  await clickText(page, 'Rights');
  await shot(page, `${tag}-18-rights-error-state`);
  await page.setRequestInterception(false);

  await page.close();
}

await run(390, 'm');
await run(1440, 'd');

await browser.close();
server.close();
