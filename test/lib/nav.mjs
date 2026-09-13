/*
 * Shared navigation helper (R5b, review-2-report.md; FIND-20,
 * docs/audit-2026-08-29.md).
 *
 * All suites cold-launch a fresh Chrome + static server and then call
 * page.goto()/page.reload() with the app's `networkidle0` wait condition.
 * Under contention (many suites/agents running concurrently) that call was
 * timing out at a fixed 20s with no retry, which — combined with missing
 * try/finally cleanup — orphaned Chrome processes and compounded failures
 * across the run. This helper:
 *   - raises the navigation timeout from 20000ms to 40000ms, and
 *   - retries exactly once (after a short backoff) on a retryable
 *     navigation error, so a single slow/flaky load doesn't fail the
 *     whole suite.
 *
 * Use in place of `page.goto(url, { waitUntil:'networkidle0', timeout:20000 })`
 * and `page.reload({ waitUntil:'networkidle0', timeout:20000 })`.
 *
 * What counts as retryable (FIND-20): a full `npm run verify` run (~60
 * sequential Chrome launches) observed `test/desktop-layout.mjs` die at
 * `gotoApp` with:
 *   Error: Navigating frame was detached
 *     cause: LifecycleWatcher disposed
 * — a puppeteer-core `LifecycleWatcher` navigation race under launch
 * contention (see `LifecycleWatcher.js`: `#onFrameDetached` sets that exact
 * message, and `dispose()` unconditionally sets that exact cause), not a
 * product defect: the same suite passed standalone immediately after, and
 * every other suite in the run passed individually. The retry predicate
 * below matches:
 *   - Puppeteer `TimeoutError` / any "timeout" message (already retried), and
 *   - `LifecycleWatcher`-originated navigation races: "Navigating frame was
 *     detached" and "LifecycleWatcher disposed"/"terminated", checked on
 *     both the error's own message and its `.cause`, and
 *   - the same detached-frame race raised from a different guard —
 *     puppeteer-core's `CdpFrame` decorator throws "Attempted to use
 *     detached Frame '...'" (see `decorators.js`) instead of going through
 *     `LifecycleWatcher.dispose()` — observed under the same launch
 *     contention and retried for the same reason.
 * It deliberately does NOT match broader "closed"/"detached" phrasing such
 * as "Session closed", "Protocol error", or "Target closed" — those
 * indicate the browser/page itself died and are real failures that must
 * still fail loudly rather than be retried into a false pass.
 */

export const NAV_TIMEOUT_MS = 40000;
const RETRY_BACKOFF_MS = 500;

function isTimeout(e) {
  return !!e && (e.name === 'TimeoutError' || /timeout/i.test(e.message || ''));
}

function isLifecycleWatcherRace(e) {
  if (!e) return false;
  const msg = e.message || '';
  const causeMsg = (e.cause && e.cause.message) || '';
  return (
    /navigating frame was detached/i.test(msg) ||
    /lifecyclewatcher (disposed|terminated)/i.test(msg) ||
    /lifecyclewatcher (disposed|terminated)/i.test(causeMsg) ||
    /attempted to use detached frame/i.test(msg)
  );
}

function isRetryableNavError(e) {
  return isTimeout(e) || isLifecycleWatcherRace(e);
}

async function withRetry(op) {
  try {
    return await op(NAV_TIMEOUT_MS);
  } catch (e) {
    if (!isRetryableNavError(e)) throw e;
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    return op(NAV_TIMEOUT_MS);
  }
}

/*
 * First-run welcome screen (index.dev.html: `Welcome`, SEEN_WELCOME_KEY).
 *
 * A genuinely fresh visitor now lands on the welcome illustration, not on
 * onboarding. Every existing suite is written against "cold launch → onboarding
 * step 1", so gotoApp seeds the device-level seen flag BEFORE any app code
 * runs, and those suites keep seeing exactly what they always saw.
 *
 * Seeded rather than clicked through on purpose: clicking Skip would push a
 * history entry and change what test/onboarding-back.mjs and
 * test/history-nav.mjs are asserting about the back stack. Seeding leaves the
 * history stack identical to before the welcome screen existed.
 *
 * Pass { freshVisitor: true } to opt OUT and exercise the welcome screen
 * itself (see test/welcome-first-run.mjs).
 */
export const SEEN_WELCOME_KEY = 'worklaw.seenWelcome.v1';

async function seedWelcomeSeen(page) {
  await page.evaluateOnNewDocument((key) => {
    try { localStorage.setItem(key, '1'); } catch (e) { /* about:blank / blocked storage */ }
  }, SEEN_WELCOME_KEY);
}

/** page.goto with a raised timeout + one retry-on-timeout. */
export async function gotoApp(page, url, opts = {}) {
  const { freshVisitor, ...gotoOpts } = opts;
  if (!freshVisitor) await seedWelcomeSeen(page);
  return withRetry((timeout) => page.goto(url, { waitUntil: 'networkidle0', timeout, ...gotoOpts }));
}

/** page.reload with a raised timeout + one retry-on-timeout. */
export async function reloadApp(page, opts = {}) {
  return withRetry((timeout) => page.reload({ waitUntil: 'networkidle0', timeout, ...opts }));
}
