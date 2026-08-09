# WorkLaw — functionality gap review

**Build:** `main` @ `ca3c6cb` (live). **Method:** 3 functionality-focused auditors (QA, persona task-completion, flow/interaction) driving the built app headlessly, briefed on `docs/gap-report.md` to avoid re-reporting fixed items. Read-only — no code changed.

**Framing:** these are *behavioral* gaps — wrong outputs, dead capabilities, broken flows, and missing case-data controls — distinct from the earlier quality/a11y/security pass. Several are **correctness bugs that put wrong legal information into documents users are told to send**, which for a legal-information app is the top tier.

**Owners:** `wl-builder` (app logic/flow), `wl-content` (fact data). Verify each fix with the Puppeteer suite; the QA agent listed exactly which assertions are missing (see end).

---

## TIER 1 — Wrong legal information reaching the user / a sent document

**F1 — Home "Deadline Watch" shows the vague federal deadline and hides the state-specific one for Discrimination/Harassment/Termination.** *HIGH* → `wl-builder`
`deadlineKeywordsFor` orders `eeoccharge` first; state files have no `eeoccharge` fact, so `pickDeadlineFactAcross` (`index.dev.html:132-142`) always resolves federal "180 or 300 days" before the state's own `discriminationComplaint`/`fehaComplaint` fact. **Home and Case Strength then disagree** (CA Home = "180 or 300 days"; CA Strength = "FEHA… 3 years"). Worse where a state's window is a hard 6 months (GA/HI/IN/KY/MI/MO/…). Fix: prefer the state fact; reorder keywords so state-specific wins.

**F2 — Wage-demand letter falsely asserts "additional overtime protection" for MA, MN, WA — with a real statute citation.** *HIGH* → `wl-builder` (+`wl-content`)
`stFollowsFederalOnly` (`:423-429`) only matches the literal `"follows federal FLSA"` and only reads the *first* overtime fact. MA/WA say "follows the federal weekly model" (no extra protection), MN's 48-hr threshold is *less* protective — none match the brittle string, so the letter adds a false "may increase what I am owed" clause + citation. A user could send this to their employer. Fix: make the "follows federal only" test robust (data flag, not string match) and read all overtime facts.

**F3 — Chat keyword router mis-fires on the substring "sign" (and "terminat"/"let go"), attaching a real OWBPA citation to off-topic replies.** *HIGH* → `wl-builder`
`isSeverance = …includes('sign')…` (`:635`) routes "Where do I **sign** the timesheet?" to the severance reply citing `29 U.S.C. §626(f)` — violating the code's own comment (`:653`) against attaching citations to unmatched answers. Fix: word-boundary/intent matching, not bare substring.

**F4 — Safety-retaliation users get the wrong deadline and no path to OSHA.** *HIGH* → `wl-content` + `wl-builder`
Fired-for-reporting-safety surfaces the EEOC 180/300-day deadline; the actual OSHA §11(c) whistleblower window is **30 days**, and there's no OSHA fact in `_federal.json` and no OSHA link in Referrals. A user could miss a 30-day window the app never mentions. Fix: add an OSHA-whistleblower fact + route safety-topic hits to it; add OSHA to Referrals.

**F5 — Owed-amount estimate overstates what's owed (assumes every logged hour was paid $0; no workweek grouping).** *HIGH* → `wl-builder`
`owedEstimate = unpaidHours * rate * 1.5` (`:687`) always uses 1.5×; for the common "paid straight-time, denied the premium" case the correct figure is the 0.5× differential (~3× overstatement), and hours are summed with no per-week concept so multi-week totals are all billed as ">40 in a workweek." This wrong figure goes into the demand letter. Fix: log-entry toggle (unpaid vs. straight-time-paid) → 1.5× vs 0.5×; group by week.

**F6 — No input bounds on hours/rate → absurd but sendable letter.** *MEDIUM* → `wl-builder`
99,999 hrs × $999,999 renders "$149,998,350,001.50" with no sanity check (`:1167`, `:766`). Fix: reasonable max/validation + a soft warning.

---

## TIER 2 — Core "inform → act" loop broken / dead capabilities

**F7 — Default (Standard) home "next steps" checkboxes don't navigate — pure self-report.** *CRITICAL* → `wl-builder`
Each step's only action is `setDone` toggling itself; it never opens `log`/`wizard`/`letter`. Users can mark 100% "done" having done nothing. (Action-first mode's CTA navigates correctly — the wiring exists, just not in the default mode most users see.) Fix: make Standard step buttons navigate to the relevant tool.

**F8 — "Review a document" cannot review any document.** *HIGH* → `wl-builder`
The picker only notes a filename; the 3 flagged clauses are a hardcoded example identical for everyone (`:188-192`). The whole document-review issue-type is inform-then-abandon. Fix: basic rules-based clause detection on pasted text, or reframe the copy so it doesn't promise analysis.

**F9 — Chat promises an ADA accommodation-request letter template that doesn't exist.** *HIGH* → `wl-builder` + `wl-content`
`ADA_REPLY` says "I can draft that request from a template," but `letterKindsFor` has no `accommodation-request` kind — the ADA user only gets a generic Title VII "complaint" letter. Fix: add the accommodation-request template (copy already lives in `ADA_REPLY`) or drop the promise.

---

## TIER 3 — Case data model, editing & persistence

**F10 — Editing your location silently commits an unconfirmed change; "Skip to dashboard" saves it rather than canceling.** *CRITICAL* → `wl-builder`
Change the state `<select>` in the pill-edit flow, tap the only exit ("Skip to dashboard") → jurisdiction silently switches (county blanked, all law re-cited) with no confirm/undo. Fix: stage edits until an explicit Save; add a real Cancel distinct from Skip.

**F11 — Switching issue leaks stale `done` state / corrupts the case; no second-case support.** *HIGH* → `wl-builder`
`done` is keyed by array index, never reset on `setIssue`, so a new issue shows steps pre-checked; `entries`/`caseOpened` also carry over, so a second issue inherits the first employer's evidence and "opened 90 days ago." Fix: reset/namespace `done` per issue; add a "start a fresh case" action (ideally a real multi-case model).

**F12 — Logged incidents have no per-entry edit or delete.** *HIGH* → `wl-builder`
`setEntries` only prepends or wipes-all; the evidence log the app calls its backbone can't be corrected without deleting the entire case. Fix: per-entry delete (edit nice-to-have), preserving timestamp integrity.

**F13 — Letter edits, wizard progress, and the doc filename are silently lost on reload.** *MEDIUM-HIGH* → `wl-builder`
`saveCase()` (`:573-576`) omits `letterEdit`, `wizNode`/`wizPath`, `docName` though it persists `entries`/`messages`/`done` — and the app tells users "everything you enter stays on this device." A hand-edited letter vanishes on reload. Fix: persist those fields.

**F14 — No owed estimate possible for salaried workers — though the wizard exists to catch misclassified salaried employees.** *HIGH* → `wl-builder`
`profile.rate` is only collected for Hourly; `owedEstimate` is always 0 for Salary. The exemption wizard's whole point is salaried misclassification, yet those users can never get a figure. Fix: collect salary/hourly-equivalent for salaried users.

**F15 — No file/photo attachment on log entries, despite steps that say "save documents/messages."** *MEDIUM* → `wl-builder`
Only free-text notes exist. Fix: attach files/images to entries (e.g., data-URL), or soften the instruction.

---

## TIER 4 — Navigation & flow

**F16 — No "‹ Back" in the 4-step onboarding/edit flow; no direct "edit profile/issue/location" entry.** *HIGH* → `wl-builder`
Every edit re-enters at step 1 and forces re-confirming everything; a typo two steps back can't be fixed without finishing or the unsafe Skip (F10). Fix: per-step Back + targeted edit entry points.

**F17 — Action-first & Plain home modes have no edit-location/profile control at all.** *MEDIUM* → `wl-builder`
The `◉` pill only renders in `HomeStandard`. Fix: surface the edit affordance (or a settings icon) in all three modes.

**F18 — "Export case file for this firm" always claims "opened in a new tab" even when it silently fell back to a download.** *MEDIUM* → `wl-builder`
`printLetter` falls back to a Blob download if `window.open` is blocked, but the caller always shows the "opened in a new tab" message. Fix: return the path taken; phrase accordingly.

---

## TIER 5 — Minor

- **F19** — Referrals links are identical regardless of issue (no OSHA for retaliation, no bar-referral for document review). *LOW-MED* → `wl-builder` (+`wl-content`)
- **F20** — Vestigial `countyQuery` state (dead code); large states show an unfiltered native `<select>` (TX 254, GA 159…). *LOW* → `wl-builder`
- **F21** — Doc-review file picker has no "remove file" control. *LOW* → `wl-builder`
- **F22** — No DC / U.S. territory in the state picker (known; product decision). *LOW* → *product*

---

## Missing test coverage (would have caught the above)
Per the QA agent, the suite doesn't assert: Home-vs-Strength deadline consistency per issue (F1); wage-letter "extra protection" clause vs each state's real overtime semantics (F2); chat keyword false-positive matrix for "sign"/"terminat"/"let go" (F3); reload-persistence of `letterEdit`/`wizNode`/`docName` (F13); salaried owed-estimate path (F14). Add these alongside the fixes.

## Suggested fix order
1. **Tier 1 correctness bugs** (F1–F5) — wrong legal info / wrong dollar amounts in sent documents.
2. **F7, F10** (the two Criticals: dead checklist, silent jurisdiction change).
3. **F8, F9, F11, F12, F14** (broken capabilities + case-data integrity).
4. **F13, F16** then the rest.
