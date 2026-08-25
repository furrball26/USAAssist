# FLSA Process-Fidelity Gap Analysis & Implementation Spec

**Status:** Draft for review. Source of truth for the FLSA (wage/overtime) remediation work.
**Date:** 2026-08-24
**Scope:** The wage/overtime (`issueKey === 'wage'`) journey in `index.dev.html` and the federal wage facts in `content/_federal.json`.
**Constraint:** All new content facts land `reviewed:false` (attorney-review-pending), consistent with the app's existing honesty model. Branch-only (`auto/agents`); nothing deployed.

---

## 1. Purpose

The app's wage/overtime **diagnostic** is strong and should not be rebuilt. The gaps are in how the app represents the FLSA **enforcement process** — the steps a worker must actually take to recover money, and the timing/remedy realities that decide whether they recover it at all. Left unaddressed, the app can lead a user to under-claim by ~half, forgo attorney's fees, forfeit the right to sue, or let the statute of limitations run.

This doc pins down (a) what FLSA actually requires/provides, (b) what the app offers today, (c) the ranked gaps, and (d) the exact facts and copy changes to close them.

---

## 2. What the app already gets right (do not touch)

- **3-prong exemption wizard** (`TREE`/`RESULTS`, index.dev.html:341–364): salary-basis → salary-level ($684/wk) → duties, in correct legal order, correctly cited (§541.600, §541.602, §213(a)(1)). Below $684 → non-exempt regardless of duties. Keep.
- **SOL fact present** — `deadlines.flsaWageClaim` = "2 years (3 if willful)," cite 29 U.S.C. §255(a) (`_federal.json`), surfaced in Deadline Watch.
- **Agency routing** — Agencies tab points wage users to DOL WHD + state wage agency, framed as free.
- **Honest degrade** — no fabricated dollar figure when no hours are logged.

---

## 3. The FLSA process the site must match (authoritative reference)

Sources: DOL WHD ([Complaints & Investigation FAQ](https://www.dol.gov/agencies/whd/faq/workers), [How to File a Complaint](https://www.dol.gov/agencies/whd/contact/complaints), [Fact Sheet #17A](https://www.dol.gov/agencies/whd/fact-sheets/17a-overtime), [Handy Reference Guide](https://www.dol.gov/agencies/whd/compliance-assistance/handy-reference-guide-flsa), [Fact Sheet #77A retaliation](https://www.dol.gov/agencies/whd/fact-sheets/77a-flsa-prohibiting-retaliation), [WHD ending liquidated damages in investigations, June 2025](https://www.dol.gov/newsroom/releases/whd/whd20250627), [May 2026 technical amendment](https://www.dol.gov/newsroom/releases/whd/whd20260514)); 29 U.S.C. §§206–216, 255; 29 C.F.R. Part 541; *Anderson v. Mt. Clemens Pottery Co.*, 328 U.S. 680 (1946); *Kasten v. Saint-Gobain*, 563 U.S. 1 (2011).

1. **Exemption = 3 prongs, ALL required to be exempt:** salary basis + salary level (≥$684/wk) + duties. Job title is irrelevant. Highly-compensated employees ($107,432/yr) have a relaxed duties test.
2. **Substantive rights:** minimum wage $7.25/hr (higher state/local applies); overtime 1.5× regular rate over 40 hrs/workweek; no federal daily OT. Regular rate includes nondiscretionary bonuses.
3. **Two enforcement paths, and they interact:**
   - **DOL WHD complaint** — free, confidential (name/nature not disclosed), any immigration status. Recovers **back wages**. **As of June 2025, WHD no longer seeks liquidated damages in administrative matters** — the admin route is back-pay-only.
   - **Private lawsuit (§216(b))** — back wages **+ equal liquidated damages (doubling) + attorney's fees + costs**; can be collective. **Bar:** you may NOT sue if you accepted back wages under WHD supervision, or if the Secretary of Labor already filed suit.
4. **Statute of limitations:** 2 years, 3 for willful. Each paycheck is a separate violation; the clock runs continuously. **Filing a WHD complaint does NOT toll the SOL for a private lawsuit** — waiting on an investigation can time-bar the oldest weeks.
5. **Recordkeeping:** employer must keep records (§211(c), 29 C.F.R. 516). Where records are inadequate, the employee's reasonable estimate shifts the burden (*Mt. Clemens*). The employee's own hour log is evidence.
6. **Anti-retaliation (§215(a)(3)):** protects filing/cooperating, including internal and oral complaints (*Kasten*). It is itself an FLSA violation with its own remedies.
7. **No demand letter or internal exhaustion is required** by FLSA before a complaint or suit. A demand letter is optional/tactical.

---

## 4. Ranked gaps

### P0 — process misrepresents the law / risks the user's money

**G1 — SOL timing trap invisible.** App shows "2 yrs (3 if willful)" as a static deadline but never conveys that the clock runs continuously, that each paycheck is a separate violation, or that a WHD complaint does not pause it for a lawsuit. A demand-letter → wait → WHD sequence can silently age out the oldest recoverable weeks.

**G2 — Liquidated damages + attorney's fees entirely absent.** No fact and no copy anywhere mentions §216(b) doubling or fee-shifting. The demand figure = straight unpaid premium only, so the claim is understated ~50%, and the mechanism that lets workers retain counsel on contingency is hidden. The on-screen "totals approximately $X" reads as precise but is roughly half the true exposure.

**G3 — WHD-vs-lawsuit trade-off missing, including the waiver trap.** App routes to WHD as "free/first" without describing the lawsuit path, that the lawsuit recovers ~double + fees, that WHD admin no longer awards liquidated damages (2025), or that accepting WHD-supervised back pay waives the right to sue.

### P1 — important omissions in the offered process

**G4 — No FLSA §215(a)(3) anti-retaliation warning for wage users.** The app instructs the user to ask HR in writing, send a demand, and file with WHD — all protected activity — but never tells them they're protected. The only retaliation content is Title VII/discrimination.

**G5 — Demand-letter-first framing overshadows the real, time-limited paths.** The directive 4-step path ends in a self-sent demand with a self-imposed 14-day deadline; the letter cites §207 but omits any reference to WHD filing or liquidated damages as leverage.

**G6 — Hour-log's legal significance unexplained.** The log is framed only as "feeds the letter's dollar figure," not as evidence, and the employer's recordkeeping duty (and the *Mt. Clemens* burden-shift when records are missing) is never mentioned.

### P2 — accuracy refinements

**G7 — Highly-compensated employee path not in wizard.** A high earner with one management duty can be exempt via HCE; the wizard doesn't ask, risking a false "non-exempt."

**G8 — FLSA coverage (enterprise/individual) not checked.** Low priority — nearly all workers covered and state law backstops — but unstated.

---

## 5. Implementation

### 5.1 Content — `wl-content`, `content/_federal.json`, all `reviewed:false`

Add these federal facts (topic keys are contractual — the app copy in §5.2 references them). Each needs `topic`, `value`, `summary`, `citation`, `sourceUrl`, `sourceAgency`, `lastChecked`, `reviewed:false`, sourced to official DOL/U.S. Code pages.

- **`remedies.liquidatedDamages`** — value e.g. "Equal to back wages (double)"; summary: in a private FLSA lawsuit the worker can recover unpaid wages **plus an equal amount in liquidated damages**, unless the employer proves good faith. Cite 29 U.S.C. §216(b).
- **`remedies.attorneysFees`** — summary: a prevailing FLSA plaintiff is awarded **reasonable attorney's fees and costs**, which is why many wage lawyers take these cases at no upfront cost. Cite 29 U.S.C. §216(b).
- **`retaliation.flsa`** — summary: it is illegal to fire, demote, or punish a worker for asking about, complaining about, or filing a wage/overtime claim — including internal or verbal complaints. Cite 29 U.S.C. §215(a)(3); *Kasten v. Saint-Gobain*. (`sourceUrl` = DOL Fact Sheet #77A.)
- **`deadlines.flsaWageClaim` companion note** — extend the existing fact's `summary`/`note` (do not change its `value`) to add: the clock runs from each unpaid payday and keeps running; **filing a complaint with the Labor Department does not pause it for a lawsuit**; act well before the deadline. Cite 29 U.S.C. §255(a).
- **`enforcement.paths`** (new) — summary contrasting the two routes: WHD complaint (free, back wages, no liquidated damages administratively since 2025) vs. private lawsuit (back wages + liquidated damages + attorney's fees); **accepting WHD-supervised back pay or a Secretary's suit bars a private suit.** Cite 29 U.S.C. §216(b),(c); DOL Handy Reference Guide + June 2025 release.

> `wl-content` should verify each `sourceUrl` resolves (200) against an official domain before adding, and may split/rename keys if a cleaner structure emerges — but must report the final keys so `wl-builder` can wire them.

### 5.2 App copy/flow — `wl-builder`, `index.dev.html` (green-gated, committed to `auto/agents`)

- **G1:** Add a plain-language timing line to Deadline Watch (index.dev.html:1429–1440, 2069–2088) and the wizard non-exempt result: *"This 2–3 year deadline keeps running while you wait. Filing with the Labor Department does not pause it for a lawsuit — talk to an attorney before the oldest weeks age out."* Drive from the extended `deadlines.flsaWageClaim` note.
- **G2/G3:** On the wizard non-exempt result (index.dev.html:1752–1753 area) and the wage dashboard, add a **"How to actually recover this"** panel: WHD complaint vs. lawsuit; lawsuit can recover **about double plus attorney's fees**; accepting a WHD-supervised payment can waive the right to sue. Source from `enforcement.paths`, `remedies.liquidatedDamages`, `remedies.attorneysFees`.
- **G2 (letter + estimate):** Add a liquidated-damages sentence to the `wage-demand` letter body (`buildLetter`, index.dev.html:696–735) referencing §216(b) as leverage; label the on-screen owed estimate **"back wages only — actual recovery may be up to double plus attorney's fees."**
- **G4:** Surface `retaliation.flsa` wherever the app tells a wage user to complain in writing (classification-request step, demand step, Agencies tab) — a short protected-activity note, matching how the discrimination "complaint" letter already includes a retaliation statement (index.dev.html:746).
- **G5:** Reframe the demand letter as an **optional first step** in the step copy (index.dev.html:549–554), not "the process."
- **G6:** Reframe the hour log (index.dev.html:855, 1841–1856) as **evidence**; add a one-line note that the employer must keep records and that a good personal log strengthens the claim when the employer's records are missing.
- **G7:** Add an HCE branch to the wizard `TREE` (index.dev.html:357–364): for a salaried worker at/above the highly-compensated threshold with at least one exempt duty, route to a "possibly exempt (highly compensated)" result citing `overtime.highlyCompensatedAnnual` / 29 C.F.R. §541.601.

### 5.3 Verification

- `npm run verify` (build + smoke) must stay green.
- Extend the QA suite to assert the new wage-flow copy renders (liquidated-damages note on the estimate, retaliation note on the wage flow, WHD-vs-lawsuit panel on a non-exempt result).
- `automation/validate-content.mjs` must pass with the new facts.

---

## 6. Out of scope (flagged, not built here)

- No private-lawsuit *filing* tool (app remains letters + agency routing + attorney referral).
- State-by-state liquidated-damages / fee-shifting variations (many states add their own — future `wl-content` pass).
- Regular-rate refinements (nondiscretionary bonuses, fluctuating workweek) beyond the existing §778.113 salary→hourly disclaimer.
