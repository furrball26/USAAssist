/*
 * Centralized chrome-headless-shell discovery (FIND-07, docs/audit-2026-08-29.md).
 *
 * Every suite used to shell out to its own copy of:
 *   find "<ROOT>chrome-headless-shell" -type f -name 'chrome-headless-shell'
 * Two real bugs, duplicated 56 times:
 *   1. `-type f` does not follow symlinks, so a browser that is vendored
 *      elsewhere (e.g. a container image at /opt/pw-browsers) and symlinked
 *      into ./chrome-headless-shell/ is invisible to `find` even though the
 *      path resolves fine for everything else. CI is unaffected (it installs
 *      a real file via `npx @puppeteer/browsers install --path .`) — this
 *      bites local/container setups only.
 *   2. Nothing checked the result was non-empty before
 *      `puppeteer.launch({ executablePath })`, so a missing browser surfaced
 *      puppeteer's generic "An `executablePath` or `channel` must be
 *      specified" instead of pointing at the actual cause or the
 *      CONTRIBUTING.md remedy.
 *
 * This resolves the path once per process, follows symlinks, verifies the
 * result is an executable file, and fails loudly with an actionable message
 * otherwise.
 *
 * Why plain `find -L` and not `@puppeteer/browsers`' own
 * `getInstalledBrowsers`/`computeExecutablePath`: those APIs require the
 * standard cache layout `<rootDir>/<browser>/<platform>-<buildId>/...`. This
 * repo's committed/vendored `./chrome-headless-shell/` does not always match
 * that shape (e.g. a manually-copied `./chrome-headless-shell/local/...`
 * layout, seen in this same container), so the structured API silently finds
 * nothing where `find` still succeeds. `find -L` also transparently handles
 * the standard CI-installed layout, a manual copy, AND a symlink-in — one
 * code path for all three — which is why it's kept, just fixed.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const SEARCH_DIR = `${ROOT}chrome-headless-shell`;
const REMEDY = 'npx @puppeteer/browsers install chrome-headless-shell --path . (see CONTRIBUTING.md, "CI needs Chrome at ./chrome-headless-shell").';

let cached;

/**
 * Resolve the on-disk path to the `chrome-headless-shell` executable under
 * `./chrome-headless-shell`, following symlinks. Throws an actionable Error
 * (naming the expected directory and the install remedy) if nothing is
 * found or the match is not executable, instead of letting an empty string
 * reach `puppeteer.launch()`.
 */
export function resolveChromePath() {
  if (cached) return cached;

  let found = '';
  try {
    // -L: follow symlinks both while descending into SEARCH_DIR and when
    // testing `-type f`, so a symlinked-in browser directory (or a
    // symlinked binary itself) resolves the same as a physically-present
    // file. This is the one-line fix for FIND-07's symlink blind spot.
    const out = execFileSync(
      'find',
      ['-L', SEARCH_DIR, '-type', 'f', '-name', 'chrome-headless-shell'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
    found = out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  } catch {
    found = '';
  }

  if (!found) {
    throw new Error(
      `chrome-headless-shell not found under ${SEARCH_DIR}\n` +
      `Expected an executable named "chrome-headless-shell" somewhere under that directory ` +
      `(a real file, a copy, or a symlink that resolves to one).\n` +
      `Remedy: ${REMEDY}`,
    );
  }

  try {
    accessSync(found, fsConstants.X_OK);
  } catch {
    throw new Error(
      `Found ${found} under ${SEARCH_DIR}, but it is not executable.\n` +
      `Remedy: ${REMEDY}`,
    );
  }

  cached = found;
  return found;
}
