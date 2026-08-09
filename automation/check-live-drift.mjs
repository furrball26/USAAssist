#!/usr/bin/env node
/*
 * Read-only drift check: compares the commit SHA actually live on worklaw.app (extracted
 * from its pinned jsDelivr CONTENT_BASE / app.js URL) against origin/main, and reports the
 * delta. Guards against the C1 failure mode (a manually-redeployed shell silently drifting
 * from what's on GitHub) resurfacing after this fix.
 *
 * This script only performs GET requests against the live site — it never deploys, never
 * writes anything, and never touches Vercel. If worklaw.app is unreachable (offline sandbox,
 * DNS, etc.) it reports that plainly and exits non-zero; it is NOT wired into `npm run
 * verify` because it depends on network/live-site availability outside this repo's control.
 *
 * Run: node automation/check-live-drift.mjs [https://worklaw.app]
 */
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const LIVE_URL = process.argv[2] || 'https://worklaw.app';
// Matches ...USAAssist@<40-hex-char-sha>/... in either the CONTENT_BASE assignment or the
// assets/app.js <script src>, e.g. https://cdn.jsdelivr.net/gh/furrball26/USAAssist@<sha>/
const SHA_RE = /furrball26\/USAAssist@([0-9a-f]{40})/i;

function gitRemoteSha() {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    // offline or no `origin` remote configured — fall back to whatever's already known locally
  }
  try {
    return execFileSync('git', ['rev-parse', 'origin/main'], { cwd: ROOT }).toString().trim();
  } catch {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
  }
}

async function main() {
  let html;
  try {
    const res = await fetch(LIVE_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.log(`❌ check-live-drift: could not fetch ${LIVE_URL} (${e.message})`);
    console.log('   This is read-only diagnostic tooling — network/live-site access is required and is out of this repo\'s control.');
    process.exit(1);
  }

  const match = html.match(SHA_RE);
  if (!match) {
    console.log(`❌ check-live-drift: fetched ${LIVE_URL} but found no "furrball26/USAAssist@<sha>" jsDelivr reference in the response.`);
    console.log('   Either the shell changed shape (see vercel/index.html) or it is not the reproducible shell this repo generates.');
    process.exit(1);
  }
  const liveSha = match[1].toLowerCase();
  const mainSha = gitRemoteSha().toLowerCase();

  console.log(`live (${LIVE_URL}): ${liveSha}`);
  console.log(`origin/main       : ${mainSha}`);

  if (liveSha === mainSha) {
    console.log('✅ live shell is pinned to origin/main HEAD — no drift');
    process.exit(0);
  }

  let behindBy = null;
  try {
    behindBy = execFileSync('git', ['rev-list', '--count', `${liveSha}..${mainSha}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    // liveSha may not be an ancestor known locally (shallow clone, or live is AHEAD of
    // origin/main, or the SHA is unknown) — report the mismatch without a commit count.
  }

  console.log(`⚠️  DRIFT: live worklaw.app is pinned to ${liveSha}, origin/main is at ${mainSha}` +
    (behindBy !== null ? ` (live is ${behindBy} commit(s) behind main)` : ' (could not compute commit distance — see note below)'));
  console.log('   To redeploy: node automation/render-shell.mjs --sha=' + mainSha + ' --out=<upload-path>, then redeploy that file to Vercel.');
  console.log('   Rollback: see README.md "Deployment > Rollback".');
  process.exit(1);
}

main();
