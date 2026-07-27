# WorkLaw — know your rights at work

An employee-side, US state- and county-aware workplace-rights app. It explains the
layered federal → state → local law that applies to the user's location and helps
them organize facts — positioned throughout as **legal information, not legal advice**.

Implemented from the Claude Design handoff *Stand — Workplace Rights App*
(`Workplace Rights App.dc.html` + `support.js`), screen **1a** (the full interactive
prototype), plus the two alternate homes (**1b** action-first, **1c** plain-language)
wired in as switchable display modes.

## Screens

Onboarding (state/county + issue pickers) · Dashboard · AI consult chat ·
Overtime-exemption wizard (FLSA §541 decision tree) · Incident log · Document
review · Wage-demand letter · Case strength · Rights library · Attorney referrals.
Five-tab bottom navigation; home has Standard / Action-first / Plain modes.

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

## Accessibility (core to the brief)

Atkinson Hyperlegible for UI text, IBM Plex Mono for data/citations; 17px minimum
body text; WCAG-AA contrast; nothing hidden behind hover; 2px ink borders on
interactive cards for non-color affordance; 44px+ hit targets.

## Notes

- The chat AI, legal content, and case data are illustrative/canned in this build.
  Production would need persistence plus real AI and legal-content backends.
- Icons are unicode glyphs from the prototype; swap for a matched icon set in production.
