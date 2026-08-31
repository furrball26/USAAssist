#!/usr/bin/env node
/*
 * Stale-fallback guard (non-blocking). `index.dev.html` hardcodes CONTENT_FALLBACK_BASE as
 * a raw.githubusercontent.com URL pinned to a commit SHA — it's the degraded-network path
 * `fetchContentJson()` falls back to when the primary CONTENT_BASE fetch fails. Because it's
 * pinned, it never silently changes, but that also means it can quietly go stale: every commit
 * to state/federal law data since that SHA is invisible to a user who lands on the fallback
 * path (offline-first / CONTENT_BASE outage). There is no way for this repo to fix that itself
 * (bumping the SHA is an app-code edit in index.dev.html, owned by wl-builder) — this script's
 * only job is to make the drift visible instead of silent.
 *
 * Reuses the SHA-extraction + git-distance pattern from check-live-drift.mjs, but is entirely
 * local/offline: it reads the SHA out of the committed index.dev.html (no live-site fetch) and
 * diffs it against origin/main (or local HEAD if there's no reachable `origin`), so it's safe
 * to run in `npm run verify` on every commit.
 *
 * Always exits 0 — this is a WARNING, not a build-breaker. Bumping the pinned SHA is app code
 * (index.dev.html) and out of this script's/agent's file domain (wl-backend); only wl-builder
 * edits index.dev.html.
 *
 * Run: node automation/check-fallback-freshness.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const MAX_DAYS = 30;
const MAX_COMMITS = 20;

// Matches the literal CONTENT_FALLBACK_BASE assignment in index.dev.html, e.g.
// const CONTENT_FALLBACK_BASE = 'https://raw.githubusercontent.com/furrball26/USAAssist/<sha>/';
const SHA_RE = /CONTENT_FALLBACK_BASE\s*=\s*'https:\/\/raw\.githubusercontent\.com\/furrball26\/USAAssist\/([0-9a-f]{40})\//i;

function warn(msg) {
  console.log('⚠️  ' + msg);
}

function gitTargetSha() {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    // offline / no origin remote — fall back to whatever's known locally
  }
  try {
    return { sha: execFileSync('git', ['rev-parse', 'origin/main'], { cwd: ROOT }).toString().trim(), ref: 'origin/main' };
  } catch {
    return { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(), ref: 'HEAD' };
  }
}

function main() {
  let html;
  try {
    html = readFileSync(ROOT + 'index.dev.html', 'utf8');
  } catch (e) {
    warn(`check-fallback-freshness: could not read index.dev.html (${e.message}) — skipping`);
    process.exit(0);
  }

  const match = html.match(SHA_RE);
  if (!match) {
    warn('check-fallback-freshness: no CONTENT_FALLBACK_BASE pin found in index.dev.html (shape changed?) — skipping freshness check');
    process.exit(0);
  }
  const pinnedSha = match[1].toLowerCase();

  const { sha: targetSha, ref } = gitTargetSha();

  if (pinnedSha === targetSha) {
    console.log(`✅ check-fallback-freshness: CONTENT_FALLBACK_BASE (${pinnedSha}) is exactly ${ref} — no drift`);
    process.exit(0);
  }

  let commitsBehind = null;
  try {
    commitsBehind = parseInt(
      execFileSync('git', ['rev-list', '--count', `${pinnedSha}..${targetSha}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim(),
      10
    );
  } catch {
    // pinnedSha not known locally (shallow clone) or not an ancestor of targetSha — can't
    // compute a commit distance, only a date if git has the commit at all.
  }

  let daysOld = null;
  try {
    const commitEpoch = parseInt(
      execFileSync('git', ['log', '-1', '--format=%ct', pinnedSha], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim(),
      10
    );
    daysOld = Math.floor((Date.now() / 1000 - commitEpoch) / 86400);
  } catch {
    // pinned SHA unknown to local git (e.g. shallow clone) — can't date it
  }

  console.log(`CONTENT_FALLBACK_BASE pin : ${pinnedSha}${daysOld !== null ? ` (${daysOld} day(s) old)` : ' (age unknown — shallow clone?)'}`);
  console.log(`${ref.padEnd(26)}: ${targetSha}${commitsBehind !== null ? ` (fallback is ${commitsBehind} commit(s) behind)` : ''}`);

  const staleByDays = daysOld !== null && daysOld > MAX_DAYS;
  const staleByCommits = commitsBehind !== null && commitsBehind > MAX_COMMITS;
  const freshnessUnknown = daysOld === null && commitsBehind === null;

  if (staleByDays || staleByCommits) {
    warn(`STALE FALLBACK: index.dev.html's CONTENT_FALLBACK_BASE is pinned to a commit that is ` +
      [staleByDays ? `${daysOld} day(s) old (> ${MAX_DAYS})` : null, staleByCommits ? `${commitsBehind} commit(s) behind ${ref} (> ${MAX_COMMITS})` : null]
        .filter(Boolean).join(' and ') + '.');
    warn('   A user on the degraded-network fallback path could be served stale law data.');
    warn(`   Fix: wl-builder bumps CONTENT_FALLBACK_BASE in index.dev.html to a recent commit SHA (e.g. ${targetSha}), rebuilds, and commits.`);
    warn('   (Non-blocking: this check always exits 0 — see README.md "Maintenance".)');
  } else if (freshnessUnknown) {
    // Neither signal resolved (typical in a shallow clone, incl. this repo's own checkout
    // and CI's actions/checkout@v4 depth-1 default): freshness was NOT verified, it's
    // unknown. Reporting the same "no action needed" line as an actual clean check would
    // be a false positive — say plainly that nothing was confirmed.
    warn('cannot determine fallback pin freshness (shallow clone / pin not in local history) — ' +
      'neither commit age nor commit-distance could be computed, so this is NOT a confirmed-fresh ' +
      'result, just an unknown one. Deepen the clone (e.g. `git fetch --unshallow` or fetch enough ' +
      'history to include the pinned commit) to actually check.');
  } else {
    console.log('✅ check-fallback-freshness: pin is within freshness thresholds — no action needed');
  }

  // Always non-blocking.
  process.exit(0);
}

main();
