# WorkLaw — review #2 (bugs, functionality, smoke) + referral removal

**Build:** `main` @ `45da3fe` (live). **Method:** 7 auditors in parallel (QA/smoke, persona/functionality, UX/a11y, visual design, security, content, build/pipeline), all briefed on `docs/gap-report.md` + `docs/functionality-gaps.md` to avoid re-reporting fixed items. Read-only.

**Smoke test: ✅ PASS** — `npm run verify` (build + validate-content + artifact-freshness + 29 Puppeteer suites) is 100% green on a clean re-run. The intermittent failures were **environmental** (each test cold-boots its own Chrome with no `try/finally` cleanup, so a timeout orphans Chrome processes and compounds contention — worsened by concurrent auditor Chrome fleets on a 6-core box), not a product bug.

**Lawyer referral: ✅ removed & live** — tab renamed "Agencies"/"Where to file", official DOL/EEOC/OSHA/state links + case-file download kept, all attorney-referral pieces gone, copy is honest ("WorkLaw does not operate a referral service"). Confirmed clean by persona + UX + design audits.

**Owners:** `wl-builder` (app code), `wl-content` (facts/copy), `wl-backend`/`wl-qa` (test infra).

---

## CRITICAL

**R1 — Desktop (≥1024px) shows a stray navy phone-bezel frame around the whole app.** *[design]* → `wl-builder`
The `@media (min-width:1024px)` block resets `.device` width/height but **not** `background`/`padding`/`border-radius`/`box-shadow`, so the base `#14181F` bezel + 52px radius + 10px padding leak through as a dark rounded frame on every desktop screen. This is **live on worklaw.app now.** Fix: in the ≥1024 block add to `.device`: `background:#FFFDF8; padding:0; border-radius:0; box-shadow:none;` (mirror the 768–1023 tier). Note: the shell CSS auto-syncs from `index.dev.html` via render-shell, so fixing the source fixes both surfaces on redeploy.

---

## HIGH

**R2 — No beige "desk" gutter at ≥1024px; the mode color floods the full viewport.** *[design]* → `wl-builder`
`screenBg` (navy for Action-first, white for Plain) paints `.screen`, which is now full-width — so Action-first is a wall of navy at 1920px instead of a bounded column on a calm beige desk (the spec's stated intent). Fix: confine the mode color to the 680px reading column (or set `.screen` background to `#F3EFE7` and paint the mode color only on the column wrapper).

**R3 — Desktop left rail is LAST in keyboard tab order though visually first.** *[ux/a11y, WCAG 2.4.3]* → `wl-builder`
DOM renders `<main>` before `<nav className="tabbar">`; the grid reorders them visually only. A keyboard user tabs through the whole dashboard before reaching the nav. Fix: put `<nav>` before `<main>` in the JSX (grid-area placement is DOM-order-independent).

**R4 — Returning/second-issue case bleeds evidence across issues.** *[functionality — the un-fixed half of F11]* → `wl-builder`
Changing the issue via the ◉ location pill resets the `done` checklist but **not** `entries` — so a new discrimination case inherits the prior wage entry, which counts toward its Case Strength and would appear in its exported case file. Only "Start a fresh case" clears entries, and it isn't the control offered when editing via the pill. Fix: reset `entries` (with a clear warning) when the pill's Save changes the issue, or unify into one confirmed path.

**R5 — `verify` green-gate is unreliable (test-infra flakiness).** *[build]* → `wl-qa`/`wl-backend`
29 serial cold Chrome launches, fixed 20s `networkidle0` timeout, no `try/finally` cleanup → a single timeout orphans ~5 Chrome procs and compounds. Fix: (a) wrap each suite body in `try{…}finally{await browser.close();server.close();}`; (b) raise nav timeout to ~45s + retry-once on `TimeoutError`; (c, bigger) share one browser across suites via `puppeteer.connect`. Also: don't run `verify` concurrently with the screenshot auditors.

---

## MEDIUM

**R6 — Action-first focus ring ~1.5:1 on the navy background (invisible).** *[ux, WCAG 1.4.11]* → `wl-builder` — add a light `:focus-visible` outline for dark-bg screens.
**R7 — Agencies tab still uses the scales/justice icon** (reads "lawyer/court" on a "file with a free gov agency" screen). *[design]* → `wl-builder` — swap to a building/"filed" glyph in the same 24×24/2px idiom.
**R8 — Agencies state links aren't issue-gated** (F19 only gated the federal links; `ag.wageHour`/`ag.discrimination` push unconditionally), so a doc-review/harassment case shows an irrelevant wage-agency link first. *[functionality]* → `wl-builder`.
**R9 — Doc-scan misses "non-competition"** (regex `non-?compete` doesn't match `non-competition`). *[functionality]* → `wl-builder` — broaden to `non-?compet\w*`.
**R10 — Severance/document users get no Home "Deadline Watch"** for the 21/7-day OWBPA clock (only shown on the Doc screen). *[functionality]* → `wl-builder` — add a generic (non-jurisdiction-sourced) deadline card for the document issue.
**R11 — Log entry Edit/Delete buttons are 36px** (below the app's 44px standard). *[ux]* → `wl-builder` — `min-height:44px`.
**R12 — `saveCase()` silently swallows `QuotaExceededError`** — now reachable via file attachments (a few 1.5MB photos blow the localStorage quota); user thinks evidence saved when it wasn't. *[security/data-integrity]* → `wl-builder` — surface a "storage full — not saved, export now" warning + cap total attachment bytes.
**R13 — Content: FL minimum wage steps $14→$15 on 2026-09-30** (self-flagged) — correct today, needs the update on that date. *[content]* → `wl-content`. Plus verification debt: NY salary thresholds, WY discrimination coverage, AZ admin cap, NM (DWS bot-blocks fetch).
**R14 — render-shell `<style>` injection has no test coverage.** *[build]* → `wl-backend` — add `automation/check-shell-fresh.mjs` (one `<style>`, equals `index.dev.html`'s, no `{{SHA}}` left).

---

## LOW

- **R15** — Blocked "Continue" button contrast ~2.67:1 + no `aria-describedby` to its reason text. *[ux]* → `wl-builder`
- **R16** — Programmatic focus after Back/Forward/nav has `outline:none` (no visible ring); focus the destination `<h1>` instead. *[ux]* → `wl-builder`
- **R17** — Desktop chat prompt-chip row still needs horizontal scroll (worse under the 680px cap) — wrap chips at ≥1024. *[design/qa]* → `wl-builder`
- **R18** — Attachment MIME trusted + raw `data:` URL used as href (SVG-script risk only if opened directly; opaque-origin isolation holds). *[security]* → `wl-builder` — image allowlist + Blob download.
- **R19** — Deadline Watch card lacks the "View →" cue Case Strength has (affordance inconsistency). *[ux/design]* → `wl-builder`
- **R20** — Rail is top-heavy at tall/ultrawide viewports (no `justify-content:center`). *[design]* → `wl-builder`
- **R21** — Onboarding rainbow stripe is louder on the wider desktop card — drop it or restyle as a palette hairline. *[design]* → `wl-builder`
- **R22** — Chat ADA reply says "add it to your case file," but the case-file export omits letter text. *[content/copy]* → `wl-content`
- **R23** — `CONTENT_FALLBACK_BASE` pinned to a stale SHA (behind HEAD) — automate the bump. *[build]* → `wl-backend`
- **R24** — AK wage-claim 3-yr figure lacks a codified citation (DOL FAQ only). *[content]* → `wl-content`

## Test-coverage gaps (add alongside fixes)
- `agencies-links.mjs` only samples one state — loop a few states with distinct agency data.
- `desktop-layout.mjs` only checks home/onboarding — sweep the other 9 screens for the rail + 680px cap.
- No orphan-Chrome-process guard around `verify`.

## Verified sound (no action)
Referral removal is clean/honest; personas 1–4 complete end-to-end (correct wage math, ADA letter, NY 3-yr deadline, OSHA 30-day card); icons all `aria-hidden` + labeled; radiogroup/`aria-pressed` correct; external links `rel="noopener noreferrer"`; CSP + all security headers + SRI live; `safeUrl` https-only; History state carries no case data; letter/print output HTML-escaped; no telemetry; `npm audit` clean; content validates clean, `reviewed:false` everywhere, index == disk; build byte-reproducible; MA/AZ SOLs + OSHA fact + retaliation keys confirmed fixed.

## Suggested fix order
1. **R1** (live critical bezel), **R2/R3** (desktop gutter + tab order) — the desktop layout shipped with these.
2. **R4** (evidence bleed) and **R5** (test flakiness — makes the gate trustworthy for everything else).
3. **R6–R12** mediums.
4. Lows + content (R13 on/after 2026-09-30) + coverage tests.
