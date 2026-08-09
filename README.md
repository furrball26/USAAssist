# WorkLaw — know your rights at work

An employee-side, US state- and county-aware workplace-rights app. It explains the
layered federal → state → local law that applies to the user's location and helps
them organize facts — positioned throughout as **legal information, not legal advice**.

Implemented from the Claude Design handoff *Stand — Workplace Rights App*
(`Workplace Rights App.dc.html` + `support.js`), screen **1a** (the full interactive
prototype), plus the two alternate homes (**1b** action-first, **1c** plain-language)
wired in as switchable display modes.

## Screens

Onboarding (state → county → issue → case details) · Dashboard · AI consult chat ·
Overtime-exemption wizard (FLSA §541 decision tree) · Incident log · Document
review · Wage-demand letter · Case strength · Rights library · Attorney referrals.
Five-tab bottom navigation; home has Standard / Action-first / Plain modes.

## Your case (input-driven, persisted)

There is **no hardcoded persona** — the whole app is generated from what the user enters:

- **Onboarding** captures location, the chosen issue, and optional case details (name,
  employer, pay type/rate). The **issue** drives the dashboard title, next-steps checklist,
  action-mode flow, plain-mode framing, chat opener, and letter type.
- **Incident log** starts empty; entries (with optional unpaid-hours) are the source of
  truth. **Case strength** is computed from the evidence actually logged.
- **Wage-demand letter** is generated from the profile + logged hours + the state/federal
  overtime citations in `content/` (e.g. a Texas case cites Tex. Labor Code, not California).
  It is editable and exports via a print window (Save as PDF) with a `.txt` fallback.
- **Referrals** "Export case file" builds a portable case-file summary from the real inputs.
- The case is persisted to `localStorage` (`worklaw.case.v1`), so it survives reload.

## State-aware content

Onboarding covers the **50 states** (dropdowns; county list includes parishes/boroughs).
The app fetches the source-cited dataset in [`content/`](content/) at runtime and renders
jurisdiction-specific guidance on the **Rights library** (federal + state facts with official
Source links), the **overtime wizard** ("What applies in {state}"), the **Deadline watch**
(statute-of-limitations), and **Referrals** (official state wage/discrimination agencies + EEOC/DOL).

Every state datum is `reviewed: false` until counsel signs off, so state guidance renders behind a
**"pending attorney review"** draft banner that auto-clears when a state's file is marked
`reviewed: true`. See [`content/README.md`](content/README.md) and the counsel review view at
[`docs/legal-content-review.html`](docs/legal-content-review.html). Content loads same-origin on
GitHub Pages / locally; on worklaw.app the Vercel shell sets `window.CONTENT_BASE` to a
commit-pinned jsDelivr URL (served with open CORS).

## Stack

A single self-contained React app. `index.html` runs with **zero network requests**;
`index.dev.html` is the JSX source of truth.

- **`index.dev.html`** — **editable source**. The app authored as JSX, compiled in the
  browser via Babel standalone and loading React from a CDN. **Edit this file only.**
- **`index.html`** — generated production build. Fully self-contained: React + ReactDOM
  and the compiled app are inlined, and the Atkinson Hyperlegible / IBM Plex Mono fonts
  are embedded as base64. Open it directly in a browser or host the file anywhere.
- **`assets/app.js`** — generated minified bundle for jsDelivr / the Vercel shell.

## Build & test

The build regenerates the two artifacts from `index.dev.html` (JSX → `React.createElement`
via esbuild) and splices the app block into `index.html` — the React/font inlining is left
untouched. A headless smoke test and a multi-state persona test guard against regressions.

```sh
npm install        # esbuild + puppeteer-core (dev-only; see package.json)
npm run build      # index.dev.html → index.html + assets/app.js
npm test           # headless smoke test (all screens, home modes, persistence)
node test/persona.mjs   # multi-state / multi-issue consistency + no-leakage check
npm run verify     # build + smoke in one step
```

## Deployment

Live at **https://worklaw.app** and **https://furrball26.github.io/USAAssist/**.

- **GitHub Pages** serves the self-contained `index.html` from `main` (root) — fully
  offline-capable, auto-publishes on every push.
- **worklaw.app** is a Vercel project (`usaassist`, team Spectrum Dating; DNS already
  points there). It serves the shell in [`vercel/index.html`](vercel/index.html), which
  loads React from unpkg (with SRI) and the app bundle from jsDelivr, pinned to a
  **commit SHA** (immutable, cache-safe):
  `https://cdn.jsdelivr.net/gh/furrball26/USAAssist@<SHA>/assets/app.js`.
  `assets/app.js` is the minified compiled build, committed to the repo. Response headers
  (CSP, `X-Frame-Options`, etc.) are set by [`vercel.json`](vercel.json).

`vercel/index.html` is committed as a **template**: its jsDelivr URLs contain a literal
`{{SHA}}` placeholder instead of a real commit hash, so the file itself never goes stale
relative to a specific deploy. [`automation/render-shell.mjs`](automation/render-shell.mjs)
substitutes `{{SHA}}` with the current commit and prints (or writes, via `--out=`) the file
to actually upload to Vercel — this is what makes the shell reproducible from source instead
of a hand-maintained artifact living only in the Vercel dashboard.

### Updating a live change

1. Edit `index.dev.html` (the JSX source).
2. `npm run verify` — rebuilds `index.html` (for Pages) + `assets/app.js` (for jsDelivr /
   the Vercel shell), validates `content/`, checks the generated artifacts match a fresh
   build, and runs the full test suite.
3. `git push`. **GitHub Pages** (furrball26.github.io/USAAssist) updates automatically.
4. For **worklaw.app**: run `node automation/render-shell.mjs --out=<path>` (defaults to
   `git rev-parse HEAD`) and upload the rendered `<path>` as the Vercel project's
   `index.html`. Pinning to the SHA avoids all CDN/browser cache lag — a mutable `@main`
   URL can serve a stale bundle for up to ~12h even after a jsDelivr purge.
   (Data source for the state/county list: US Census `national_county.txt`, embedded at build.)
5. Optionally confirm the deploy landed: `npm run check-live-drift` fetches worklaw.app,
   extracts the SHA it's actually pinned to, and diffs it against `origin/main` (read-only;
   requires network access to the live site).

### Rollback

worklaw.app is just a static shell pointing at an immutable, SHA-pinned jsDelivr URL — there
is no server state to roll back. To revert a bad deploy:

1. Pick the last-known-good commit SHA (`git log` on `main`, or the previous value reported
   by `npm run check-live-drift`).
2. `node automation/render-shell.mjs --sha=<good-sha> --out=<path>` and upload `<path>` as
   the Vercel `index.html`, exactly as in step 4 above but pointed at the old SHA.
3. Because both `assets/app.js` and `content/*.json` are fetched from jsDelivr at that same
   pinned SHA, this rolls back the app code *and* the content dataset atomically — there is
   no separate "roll back the data" step.
4. GitHub Pages is unaffected by a Vercel rollback (it always serves whatever is on `main`);
   if the bad change is also live on Pages, revert it there separately (`git revert` + push).

> Alternative: point worklaw.app's DNS at GitHub Pages (apex A records to GitHub's IPs,
> `www` CNAME to `furrball26.github.io`) to serve the fully self-contained build directly,
> dropping the CDN dependencies. Requires a DNS change at the registrar.

### Fonts on the Vercel shell (accepted risk)

`vercel/index.html` (like `index.dev.html`) loads Atkinson Hyperlegible / IBM Plex Mono from
`fonts.googleapis.com` / `fonts.gstatic.com` rather than self-hosting them the way production
`index.html` does (base64-embedded, zero network requests — see "Stack" above). That means a
visitor's IP is observable by Google Fonts on worklaw.app specifically, on an app that may
carry sensitive workplace-dispute context. This is being kept as an **accepted risk** rather
than fixed here because self-hosting on the Vercel shell means either (a) inlining the same
base64 fonts `index.html` already carries (~duplicates ~250KB already in the repo into the
shell, defeating the point of a thin shell) or (b) serving font files from `/public` on
Vercel (a small, real change — new binary assets + a `vercel.json` route — that's a
reasonable follow-up but is out of scope for this pass). No code change made; flagging here
so it isn't lost.

## Accessibility (core to the brief)

Atkinson Hyperlegible for UI text, IBM Plex Mono for data/citations; 17px minimum
body text; WCAG-AA contrast; nothing hidden behind hover; 2px ink borders on
interactive cards for non-color affordance; 44px+ hit targets.

## Notes

- Case data is real and user-driven (persisted locally). The **chat AI responses** are
  still canned sample answers, and **attorney listings are labeled samples** — production
  would wire a real AI backend and a licensed-attorney directory. State legal content stays
  behind the `reviewed: false` draft banner until counsel signs off.
- Document review shows a clearly-labeled **example** clause analysis; automated parsing of
  an uploaded file is not available in this build.
- Icons are unicode glyphs from the prototype; swap for a matched icon set in production.
