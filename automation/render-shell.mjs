#!/usr/bin/env node
/*
 * Renders the deployable Vercel shell from the committed template.
 *
 * vercel/index.html is the source of truth for the worklaw.app shell, but it ships with a
 * literal `{{SHA}}` placeholder in its jsDelivr URLs (CONTENT_BASE + the app.js <script> src)
 * so the file itself is commit-independent and stays green-gated. This script substitutes
 * that placeholder with the current commit SHA to produce the actual file to upload to
 * Vercel — the substitution step every deploy must reproduce identically, which is why it's
 * a script and not a manual edit.
 *
 * Usage:
 *   node automation/render-shell.mjs                 # print rendered HTML to stdout
 *   node automation/render-shell.mjs --out=<path>     # write rendered HTML to <path>
 *   node automation/render-shell.mjs --sha=<full-sha> # override the SHA (default: HEAD)
 *
 * This script never writes to vercel/index.html itself and never touches the network or
 * any deploy target — it only renders a template to a string/file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const sha = args.sha || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
if (!/^[0-9a-f]{40}$/i.test(sha)) {
  throw new Error(`render-shell: "${sha}" does not look like a full 40-char commit SHA`);
}

const template = readFileSync(ROOT + 'vercel/index.html', 'utf8');
if (!template.includes('{{SHA}}')) {
  throw new Error('render-shell: vercel/index.html has no {{SHA}} placeholder — template drifted');
}
const rendered = template.split('{{SHA}}').join(sha);

if (args.out) {
  writeFileSync(args.out, rendered);
  console.log(`render-shell: wrote ${rendered.length} bytes to ${args.out} (sha ${sha})`);
} else {
  process.stdout.write(rendered);
}
