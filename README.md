# WorkLaw — know your rights at work

An employee-side, US state- and county-aware workplace-rights app. It explains the
layered federal → state → local law that applies to the user's location and helps
them organize facts — positioned throughout as **legal information, not legal advice**.

Implemented from the Claude Design handoff *Stand — Workplace Rights App*
(`Workplace Rights App.dc.html` + `support.js`), screen **1a** (the full interactive
prototype), plus the two alternate homes (**1b** action-first, **1c** plain-language)
wired in as switchable display modes.

## Screens

Onboarding (state → county dropdowns + issue picker) · Dashboard · AI consult chat ·
Overtime-exemption wizard (FLSA §541 decision tree) · Incident log · Document
review · Wage-demand letter · Case strength · Rights library · Attorney referrals.
Five-tab bottom navigation; home has Standard / Action-first / Plain modes.

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

A single self-contained React app — no build step or server required to run.

- **`index.html`** — production build. Fully self-contained: React + ReactDOM and the
  compiled app are inlined, and the Atkinson Hyperlegible / IBM Plex Mono fonts are
  embedded as base64. **Zero network requests** — open it directly in a browser or
  host the file anywhere.
- **`index.dev.html`** — editable source. Same app authored as JSX, compiled in the
  browser via Babel standalone and loading React from a CDN. Edit this, then rebuild.

## Rebuilding `index.html` from `index.dev.html`

The production file is generated from the dev file (JSX precompiled, runtime + fonts
inlined). The build script lives in the working scratchpad used during development;
to regenerate, precompile the `<script type="text/babel">` block with the Babel
`react` preset, inline `react`/`react-dom` UMD bundles, and embed the Google Fonts
woff2 files as `data:` URIs.

## Deployment

Live at **https://worklaw.app** and **https://furrball26.github.io/USAAssist/**.

- **GitHub Pages** serves the self-contained `index.html` from `main` (root) — fully
  offline-capable, auto-publishes on every push.
- **worklaw.app** is a Vercel project (`usaassist`, team Spectrum Dating; DNS already
  points there). It serves a small shell `index.html` that loads React from a CDN and the
  app bundle from jsDelivr, pinned to a **commit SHA** (immutable, cache-safe):
  `https://cdn.jsdelivr.net/gh/furrball26/USAAssist@<SHA>/assets/app.js`.
  `assets/app.js` is the minified compiled build, committed to the repo.

### Updating a live change

1. Edit `index.dev.html` (the JSX source).
2. Rebuild the artifacts: self-contained `index.html` (for Pages) and minified
   `assets/app.js` (for jsDelivr / the Vercel shell).
3. `git push`. **GitHub Pages** (furrball26.github.io/USAAssist) updates automatically.
4. For **worklaw.app**, redeploy the Vercel shell with the script `src` pinned to the new
   commit SHA (`git rev-parse HEAD`). Pinning to the SHA avoids all CDN/browser cache lag —
   a mutable `@main` URL can serve a stale bundle for up to ~12h even after a jsDelivr purge.
   (Data source for the state/county list: US Census `national_county.txt`, embedded at build.)

> Alternative: point worklaw.app's DNS at GitHub Pages (apex A records to GitHub's IPs,
> `www` CNAME to `furrball26.github.io`) to serve the fully self-contained build directly,
> dropping the CDN dependencies. Requires a DNS change at the registrar.

## Accessibility (core to the brief)

Atkinson Hyperlegible for UI text, IBM Plex Mono for data/citations; 17px minimum
body text; WCAG-AA contrast; nothing hidden behind hover; 2px ink borders on
interactive cards for non-color affordance; 44px+ hit targets.

## Notes

- The chat AI, legal content, and case data are illustrative/canned in this build.
  Production would need persistence plus real AI and legal-content backends.
- Icons are unicode glyphs from the prototype; swap for a matched icon set in production.
