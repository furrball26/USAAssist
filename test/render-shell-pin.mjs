#!/usr/bin/env node
/*
 * render-shell SHA-pinning regression test.
 *
 * automation/render-shell.mjs pins the worklaw.app shell's jsDelivr URLs to a commit
 * SHA and injects a Subresource Integrity digest of assets/app.js. Those two must
 * describe the SAME commit. They did not: every input was read from the working tree
 * while only the URL honoured --sha, so the README's rollback procedure ("render the
 * shell pointed at the old SHA") produced a shell whose integrity hash was the CURRENT
 * bundle's and whose URL served the OLD one. The browser refuses to execute a script
 * whose hash does not match — a blank page, produced by the one procedure you reach
 * for when the site is already broken.
 *
 * Run: node test/render-shell-pin.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (cond, msg) => { if (!cond) fails++; console.log((cond ? '✅ ' : '❌ ') + msg); };

const sri = (buf) => 'sha384-' + createHash('sha384').update(buf).digest('base64');
const gitShow = (sha, path) =>
  execFileSync('git', ['show', `${sha}:${path}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
const render = (sha) => {
  const out = join(mkdtempSync(join(tmpdir(), 'shell-')), 'index.html');
  const args = ['automation/render-shell.mjs', `--out=${out}`];
  if (sha) args.push(`--sha=${sha}`);
  execFileSync('node', args, { cwd: ROOT, stdio: 'pipe' });
  const html = readFileSync(out, 'utf8');
  rmSync(out, { force: true });
  return html;
};
const pinIn = (html) => (html.match(/USAAssist@([0-9a-f]{40})/) || [])[1];
const sriIn = (html) => (html.match(/integrity="([^"]+)"\s+src="[^"]*app\.js"/) || [])[1];

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();

// A commit before HEAD whose assets/app.js actually differs — otherwise the test would
// pass trivially by comparing two identical bundles.
const older = execFileSync('git', ['log', '--format=%H', '-40', 'HEAD'], { cwd: ROOT })
  .toString().trim().split('\n')
  .find(s => { try { return !gitShow(s, 'assets/app.js').equals(gitShow(head, 'assets/app.js')); } catch { return false; } });

// ── 1 · a plain render describes HEAD, consistently ──
{
  const html = render(null);
  ok(pinIn(html) === head, `a default render pins HEAD (${head.slice(0, 7)})`);
  ok(sriIn(html) === sri(gitShow(head, 'assets/app.js')),
     'the integrity digest matches the bundle at the pinned commit');
  ok(!html.includes('{{SHA}}'), 'no {{SHA}} placeholder survives the render');
}

// ── 2 · the rollback case: every input must come from the pinned commit ──
if (!older) {
  console.log('⚠️  no recent commit with a different assets/app.js — rollback case not exercised');
} else {
  const html = render(older);
  ok(pinIn(html) === older, `a --sha render pins that commit (${older.slice(0, 7)})`);
  ok(sriIn(html) === sri(gitShow(older, 'assets/app.js')),
     'the integrity digest matches the bundle AT THAT COMMIT, not the working tree');
  ok(sriIn(html) !== sri(readFileSync(ROOT + 'assets/app.js')),
     'the integrity digest is NOT the working tree\'s — the bug this test exists for');
  // The CSS is injected from index.dev.html, so it must come from that commit too, or
  // a rollback ships current styling over a reverted bundle.
  const devStyle = (gitShow(older, 'index.dev.html').toString().match(/<style>[\s\S]*?<\/style>/) || [])[0];
  ok(devStyle && html.includes(devStyle), 'the injected <style> block is the one from the pinned commit');
}

// ── 3 · an uncommitted edit must never reach a deploy ──
{
  const p = ROOT + 'vercel/index.html';
  const original = readFileSync(p, 'utf8');
  try {
    writeFileSync(p, original.replace('<head>', '<head>\n<!-- uncommitted marker -->'));
    const html = render(null);
    ok(!html.includes('uncommitted marker'),
       'an uncommitted edit to the shell template does not reach the rendered output');
  } finally {
    writeFileSync(p, original);
  }
}

console.log(fails === 0 ? '\n✅ RENDER-SHELL-PIN PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
