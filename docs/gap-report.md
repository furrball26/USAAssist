# WorkLaw — site gap review

**Build reviewed:** `6ba4d3d` · **Method:** 7 specialized auditors run in parallel (QA, UX/a11y, visual design, security/privacy, usability/personas, legal-content, build/CDN). Read-only — no app code or content changed.

**Overall:** the site is in good shape — no crashes, no console errors, no XSS sinks, no telemetry, disclaimers everywhere and non-overreaching, `npm audit` clean, build idempotent, all 50 states load. The gaps below are refinements, a few real bugs, and infra/process hardening — not a broken product.

**Owners:** `wl-builder` (app code / `index.dev.html`), `wl-content` (legal facts / `content/`), `wl-backend` (build, CDN, Vercel shell, docs). Items marked *product* need a scope decision.

---

## CRITICAL

**C1 — Production Vercel shell (`vercel/`) is git-ignored, stale (~19 commits), and not reproducible.** *[build, security]* → `wl-backend` + human w/ Vercel access
The committed `vercel/index.html` loads a local `./app.js` and never sets `window.CONTENT_BASE`, while live worklaw.app sets `CONTENT_BASE` to a jsDelivr SHA URL and loads the bundle from jsDelivr — so the repo has no source of truth for what's actually deployed, and hardening added to `index.dev.html` (SRI) never reaches production. Fix: track `vercel/` (or generate the shell from `build.mjs` with a `{{SHA}}` placeholder) so CONTENT_BASE + SRI + CSP live in one green-gated artifact.

---

## HIGH

**H1 — "No state selected" produces broken, sendable text.** *[QA]* → `wl-builder`
Via "Skip to dashboard" (no state): the records-request letter reads `…within the time required by  law` (double space, no jurisdiction) [`index.dev.html:426`], and the overtime-wizard result panel renders `(DRAFT)` on its own line + `follows the federal overtime standard.` with no state name [`:1067`, `:1072`]. Root cause: raw `stateSel` instead of the `stateLabel` (`stateSel || 'your state'`) fallback other screens use. Small fix, user-facing.

**H2 — Retaliation citations silently dropped for ~58% of states (content/app key mismatch).** *[legal-content]* → `wl-content`
24 states store the fact under key `whistleblower`, but the app looks up `retaliation.whistleblower`, so the assistant omits the state citation for them (+5 states have none: CO, OK, SD, UT, WY). IA's disability fact has the same exact-match miss. Mostly a mechanical rename, zero new research.

**H3 — Live shell loads React from unpkg without SRI.** *[security, build]* → `wl-backend`
The app bundle is SHA-pinned (good) but the React/ReactDOM `<script>`s on worklaw.app have no `integrity=` — a unpkg compromise could run arbitrary JS in an origin holding case data. The SRI hashes already exist in `index.dev.html:56-58`; they just never reached the production shell (see C1).

**H4 — No Content-Security-Policy and no clickjacking protection.** *[security]* → `wl-backend` (Vercel headers) + `wl-builder` (Pages `<meta>`)
No CSP header/meta anywhere and no `frame-ancestors`/`X-Frame-Options` on a form-heavy app holding wage/employer/incident data. No XSS sink exists today, but there's no defense-in-depth backstop and the app can be iframed for clickjacking. Add `vercel.json` headers (CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`).

**H5 — Tap targets below 44px, worst on the statute-source links.** *[UX/a11y]* → `wl-builder`
Inline `[source ↗]` links in the wizard result and Deadline Watch are ~15–38px tall (below WCAG 2.5.8's 24px floor) [`:1059`, `:1276`]; Rights "Source ↗" badges ~35px, repeated ~26×/screen [`:1297`]; Log entry chips ~41px [`:1116`]; "Skip to dashboard" 32px [`:763`]. Pad to ≥44px hit area.

**H6 — Onboarding promises "add more issues later," but issue is single-select with no add path.** *[usability]* → `wl-builder` (add capability) or `wl-content` (fix copy)

**H7 — Plain-language home omits Deadline Watch and breaks the design system.** *[usability, design]* → `wl-builder`
Plain mode drops the Deadline Watch card that Standard/Action show [`HomePlain`], and uses an off-palette look (`#FFEB6B`, `4px #000`, `0` radius) vs. the app's `2px #14181F`/rounded language. Bring it into the system (express "plain" via type scale, not a second visual language) and include the deadline.

**H8 — Severance-review users dead-end.** *[usability]* → `wl-builder`
The "Draft a letter" tile routes a document/severance user to a records-request (personnel-file) letter — nothing useful for a 21-day severance clock.

**H9 — No content validator or CI gate, despite docs promising one.** *[build]* → `wl-backend`
No schema/`sourceUrl`-domain/`index.json`-consistency check exists; `npm run verify` omits the persona test and has no "artifacts regenerated from source" freshness check. Add `automation/validate-content.mjs` + an artifact-freshness check and wire both into `verify`.

---

## MEDIUM

**M1 — Color semantics collide.** *[design]* → `wl-builder`
Risk-pink `#FFE7EC` (doc-analyzer "READ CLOSELY") is reused for the neutral Deadline Watch card and a tool tile; three uncoordinated color systems (severity / category / decoration) share no key. Reserve red/amber/green for severity; give wayfinding one documented categorical palette.

**M2 — Inconsistent selected-control styling; dead `chip()` helper.** *[design]* → `wl-builder`
`chip()` (`:665`) is never called; selected pills are blue on some screens, black on Log; native `<select>` half-mimics the custom input style. Standardize on one selected-state token.

**M3 — Content coverage gaps.** *[legal-content]* → `wl-content`
Disability overlay missing for ~39 states (federal floor still applies); final-pay/severance missing in ~14; `deadlines.discriminationComplaint` missing NC/SD/WY; thinnest files WY/SD/CO/OK/UT. Prioritize states with real state-law daylight (NJ, NY, IL, WA, PA, MD, OH, MI).

**M4 — A few non-official source domains.** *[legal-content]* → `wl-content`
Swap LA `laworks.net` → `lwc.la.gov`; migrate OK `oscn.net` → `oklegislature.gov`; NM cites the bare statute-portal homepage (deep-link needed) and had bot-blocked pages; document FL/KS exceptions. (No aggregators anywhere — good.)

**M5 — Re-verify self-flagged values.** *[legal-content]* → `wl-content`
CA min wage provisional `$16.90`; NM figures bot-blocked; FL step-up display convention ($14→$15 on 9/30/2026); SD inferred statute subsections.

**M6 — No ADA/accommodation onboarding option.** *[usability]* → `wl-builder` + `wl-content`
Users self-sort into generic "Discrimination"; the good cited ADA answer only lives in chat; Discrimination "next steps" never mention accommodation/interactive process.

**M7 — No content-fetch fallback if jsDelivr is blocked.** *[build]* → `wl-builder` (spec by `wl-backend`)
Error state is honest but a dead end; add a SHA-pinned `raw.githubusercontent.com` fallback fetch before surfacing the error.

**M8 — No committed lockfile.** *[build]* → `wl-backend`
`package-lock.json` is git-ignored and deps use caret ranges → minified output not byte-reproducible. Commit the lockfile; use `npm ci`.

**M9 — Manual deploy has an unguarded silent-drift failure mode.** *[build]* → `wl-backend`
Evidenced by C1. Add a read-only `check-live-drift.mjs` (compare live shell's SHA vs `main`) and a rollback note.

**M10 — Referrals framing.** *[usability, design]* → `wl-builder` + `wl-content`
"Talk to a real attorney" headline sits over mostly real agency links plus clearly-labeled fictional "Sample —" cards with a live "Export case file for this firm" button. Reframe so the real agency help leads.

**M11 — Wizard Q2 reads as a non-sequitur.** *[usability]* → `wl-content`
"Do you mainly do computer systems work at $27.63/hour or more?" — lead with context before the number for an hourly warehouse worker.

---

## LOW

- **L1** — `href={f.sourceUrl}` rendered without an `https:`-only allowlist (safe today; add a one-line guard + schema rule). *[security]* → `wl-builder`/`wl-content`
- **L2** — Third-party CDNs/Google Fonts observe visitor IP on a sensitive app; self-host fonts on the Vercel shell or document as accepted risk. *[security]* → `wl-backend`
- **L3** — Unicode icon set mixes stroke weights/metaphors; move to one matched set. *[design]* → `wl-builder`
- **L4** — No consistent H1 scale (six sizes for one level); define 2–3. *[design]* → `wl-builder`
- **L5** — Dashed border means both "empty" and "tap me"; chat prompt chips clip at the edge with no scroll affordance. *[design]* → `wl-builder`
- **L6** — Action-first "Why this matters" border is 2.8:1 (needs 3:1). *[UX]* → `wl-builder`
- **L7** — Draft banner labels statute-sourced hard numbers the same as interpretive gloss (e.g., 45-day federal EEO deadline). *[usability]* → `wl-content`/`wl-builder`
- **L8** — Desktop/tablet render a fixed small phone frame; no responsive layout / larger reading column. *[UX/design]* → *product/design decision*
- **L9** — No DC / territory option in the picker (may be intentional). *[QA]* → *product decision*
- **L10** — No browser back/forward integration (intentional per smoke test). *[QA]* → *product decision*
- **L11** — Future backend (AI proxy + attorney directory) undocumented beyond a stub; author `docs/backend-architecture.md`. *[build]* → `wl-backend`
- **L12** — Doc-review upload dropzone visually fights its "not analyzed" disclaimer. *[usability/design]* → `wl-builder`

---

## Verified sound (no action)
No `dangerouslySetInnerHTML`/`eval`/unescaped `innerHTML`; letter-print `document.write` is HTML-escaped; **zero telemetry/analytics**; `npm audit` clean; case data stays in `localStorage` with a real "delete my case" control and clear disclosure; disclaimers on every screen and non-overreaching; draft banner calm and explanatory; **no dead buttons** (export/print, letter edit, delete all real); honest content-fetch error states; focus rings preserved; proper ARIA on checkboxes, chat log, and selects; dynamic county label (County/Parish/Borough); no horizontal scroll on long inputs; all 50 states load with correct headers; no cross-state citation leakage in sampled letters; deadline-fallback logic works; build is idempotent and all suites (smoke/persona/deadline/privacy) pass.

---

## Suggested fix order (highest ROI first)
1. **H1** broken no-state text — tiny, user-facing (`wl-builder`)
2. **H2** retaliation key rename — mechanical (`wl-content`)
3. **H5** tap targets (`wl-builder`)
4. **C1 + H3 + H4** track the shell + add SRI + CSP/headers — one `wl-backend` pass
5. **H7 / H8 / H6** plain-mode deadline+design, severance routing, add-issue/copy (`wl-builder`)
6. **H9 + M7 + M8** content validator, fetch fallback, lockfile (`wl-backend`/`wl-builder`)
7. **M3 / M4 / M5** content coverage, source swaps, re-verify (`wl-content`)
8. Design-system consolidation **M1 / M2 / L3–L5** (`wl-builder`)
