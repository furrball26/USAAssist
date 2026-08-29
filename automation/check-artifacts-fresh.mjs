#!/usr/bin/env node
/*
 * Artifact-freshness check: proves index.html and assets/app.js in the working tree are
 * exactly what `node build.mjs` produces from the current index.dev.html — i.e. nobody
 * hand-edited a generated artifact, and nobody edited index.dev.html without rebuilding.
 *
 * Method: copy the repo's index.dev.html + the *current* index.html (build.mjs edits
 * index.html in place, splicing into the existing app <script> block) into a scratch
 * directory, run the real build.mjs against that copy, and diff its output against the
 * working tree's index.html / assets/app.js. Any difference = drift = fail.
 *
 * ORDERING: this MUST run in `npm run verify` BEFORE `node build.mjs`. It compares the
 * on-disk index.html/assets/app.js against a *fresh rebuild of the on-disk index.dev.html*
 * — if `node build.mjs` has already run earlier in the same command, it will have just
 * overwritten both artifacts, so this check would always trivially pass (comparing a
 * freshly-built file to another freshly-built file) and could never catch real drift
 * (index.dev.html edited without a rebuild). Running before the build means it validates
 * whatever is actually on disk — which, on a fresh CI checkout, is exactly what's
 * committed, and for a developer with legitimate uncommitted index.dev.html edits it still
 * passes as long as they've also rebuilt (per AUTONOMY.md: "always rebuild in the same
 * commit"), since it only ever compares on-disk files to each other, never to git HEAD.
 *
 * Run: node automation/check-artifacts-fresh.mjs
 */
import { mkdtempSync, cpSync, mkdirSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;

const scratch = mkdtempSync(join(tmpdir(), 'worklaw-artifact-check-'));
try {
  // Only what build.mjs reads/writes: index.dev.html (source), index.html (spliced in
  // place), assets/ (app.js written fresh), and build.mjs itself.
  cpSync(ROOT + 'index.dev.html', join(scratch, 'index.dev.html'));
  cpSync(ROOT + 'index.html', join(scratch, 'index.html'));
  cpSync(ROOT + 'build.mjs', join(scratch, 'build.mjs'));
  mkdirSync(join(scratch, 'assets'));
  // build.mjs resolves paths off import.meta.url, so it must physically run from scratch/.
  // Symlink (not copy) node_modules — it's only a dependency resolution root, not an input.
  symlinkSync(ROOT + 'node_modules', join(scratch, 'node_modules'));

  execFileSync(process.execPath, ['build.mjs'], { cwd: scratch, stdio: 'pipe' });

  const diffs = [];
  for (const rel of ['index.html', 'assets/app.js']) {
    const built = readFileSync(join(scratch, rel), 'utf8');
    const committed = readFileSync(ROOT + rel, 'utf8');
    if (built !== committed) diffs.push(rel);
  }

  if (diffs.length) {
    console.log('❌ CHECK-ARTIFACTS-FRESH FAILED — generated artifact(s) do not match a fresh build:');
    diffs.forEach((f) => console.log('   ' + f));
    console.log('\nRun `npm run build` and commit the result.');
    process.exit(1);
  }
  console.log('✅ CHECK-ARTIFACTS-FRESH PASSED — index.html and assets/app.js match a fresh build from index.dev.html');
  process.exit(0);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
