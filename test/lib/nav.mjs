/*
 * Shared navigation helper (R5b, review-2-report.md).
 *
 * All suites cold-launch a fresh Chrome + static server and then call
 * page.goto()/page.reload() with the app's `networkidle0` wait condition.
 * Under contention (many suites/agents running concurrently) that call was
 * timing out at a fixed 20s with no retry, which — combined with missing
 * try/finally cleanup — orphaned Chrome processes and compounded failures
 * across the run. This helper:
 *   - raises the navigation timeout from 20000ms to 40000ms, and
 *   - retries exactly once (after a short backoff) on a Puppeteer
 *     TimeoutError, so a single slow load doesn't fail the whole suite.
 *
 * Use in place of `page.goto(url, { waitUntil:'networkidle0', timeout:20000 })`
 * and `page.reload({ waitUntil:'networkidle0', timeout:20000 })`.
 */

export const NAV_TIMEOUT_MS = 40000;
const RETRY_BACKOFF_MS = 500;

function isTimeout(e) {
  return !!e && (e.name === 'TimeoutError' || /timeout/i.test(e.message || ''));
}

async function withRetry(op) {
  try {
    return await op(NAV_TIMEOUT_MS);
  } catch (e) {
    if (!isTimeout(e)) throw e;
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    return op(NAV_TIMEOUT_MS);
  }
}

/** page.goto with a raised timeout + one retry-on-timeout. */
export async function gotoApp(page, url, opts = {}) {
  return withRetry((timeout) => page.goto(url, { waitUntil: 'networkidle0', timeout, ...opts }));
}

/** page.reload with a raised timeout + one retry-on-timeout. */
export async function reloadApp(page, opts = {}) {
  return withRetry((timeout) => page.reload({ waitUntil: 'networkidle0', timeout, ...opts }));
}
