# Scope: state-aware legal content

Today only the **location selector** is jurisdiction-aware. Every piece of *legal content*
behind it is hardcoded to California / Alameda County. This document scopes the work to make
the content itself vary by jurisdiction, and — critically — to do it without misleading users
of an app whose entire promise is "legal information."

> **Framing constraint.** Wrong per-state law is worse than honest generality. A user in Texas
> seeing California daily-overtime rules presented as *their* law is a trust and liability
> failure. So the first move is a guardrail (Phase 0), and every state we "turn on" must be
> reviewed before it ships as authoritative.

---

## 1. What's hardcoded today (inventory)

Every jurisdictional string lives in constants in `index.dev.html`. Mapping each to the legal
layer it belongs to:

| Area | Constant | Layer | What actually varies by state |
| --- | --- | --- | --- |
| Overtime wizard results | `RESULTS` | Federal + **State** | Salary floor (CA $1,352/wk vs federal $684), daily OT, state exemption tests, state citations |
| Overtime wizard tree | `TREE` | Federal | FLSA §541 logic is national — mostly reusable |
| Fed-vs-state compare block | inline in `Wizard` | **State** | Hardcoded "California: daily OT past 8…" — must be per-state |
| Rights library | `RIGHTS` (9 cards) | Federal + **State** + **Local** | 3 federal cards reusable; FEHA/Lab. Code/Oakland cards are CA/Alameda-only |
| AI chat replies | `REPLIES`, `ADA_REPLY` | Federal + **State** | Cites CA Lab. Code §510, §1102.5 |
| Case strength / deadlines | `FACTORS` + "Deadline watch" | **State** | Statute of limitations (CA 3yr; federal 2/3yr) |
| Document review | `CLAUSES` | Federal + **State** | Severance/wage-waiver rules differ by state |
| Letter generator | inline in `Letter` | Federal + **State** | Citations (29 U.S.C. §207 + CA Lab. Code §510) |
| Attorney referrals | `LAWYERS` | **Local + dynamic** | Real directory, licensed per state, near the county |
| Sample case | state defaults | demo seed | Illustrative only — lower priority |

**Takeaway:** the wizard *logic* and ~1/3 of content is federal (reusable everywhere). The rest
is a **state layer** (overtime specifics, protected classes, SOL, thresholds) plus a thin
**local layer** (minimum wage, city ordinances) and two **dynamic** systems (AI, attorney list).

---

## 2. Content model

Split content into three static layers + two dynamic services.

```
content/
  _federal.json         // FLSA, Title VII, ADA, NLRA, ADEA — applies everywhere
  states/CA.json        // overtime overlay, protected classes (FEHA), SOL, thresholds, rights cards
  states/NY.json
  ...                   // 50 + DC + PR
  local/CA/alameda.json // min wage, local ordinances (optional overrides)
```

Per-state schema (illustrative):

```json
{
  "abbr": "CA", "name": "California", "reviewed": true, "reviewedAt": "2026-07",
  "overtime": {
    "dailyOT": true, "dailyThreshold": 8, "doubleTime": 12,
    "salaryFloorWeekly": 1352, "notes": "…", "cites": ["CA Lab. Code §510", "§515.5"]
  },
  "statuteOfLimitations": { "wage": "3 years", "cite": "CCP §338" },
  "protectedClasses": ["…FEHA additions…"],
  "rights": [ { "kicker": "...", "title": "...", "body": "...", "cite": "...", "scope": "CALIFORNIA" } ],
  "minWage": 16.5
}
```

The app merges `_federal` + `states/<abbr>` + optional `local/<...>` at runtime, keyed off the
existing `stateSel` / `county`. Rights cards, wizard overlay, SOL, and letter citations all read
from the merged object instead of the current hardcoded constants.

---

## 3. Sourcing & accuracy (the real cost)

This is a legal dataset, not UI copy. Options, roughly in order of cost/quality:

1. **License a legal-content provider** (e.g., a labor-law data vendor) — fastest to breadth,
   ongoing cost, cleanest liability story. Recommended if budget allows.
2. **Author + attorney-review in-house** — draft each state from DOL / state labor-agency sources,
   then have a licensed employment attorney review before flipping `reviewed: true`. Highest
   control, slowest, needs legal counsel in the loop.
3. **LLM-drafted + human-reviewed** — generate first drafts per state from primary sources with
   citations, attorney verifies. Fast drafts, but **must not ship unreviewed** — hallucinated
   citations are the top risk.

Cross-cutting requirements regardless of source:
- **Freshness:** thresholds change yearly (the $684/$1,352 figures are 2026-dated). Needs an
  annual review cadence and a visible "last reviewed" date per state.
- **Citations must resolve** to real statutes.
- **Only `reviewed: true` states render as authoritative;** the rest fall back to federal-only
  with a clear banner (Phase 0).

---

## 4. Dynamic services (separate track)

- **AI consult:** replace canned `REPLIES` with a real LLM call that takes the selected
  jurisdiction + a retrieval layer over the reviewed content, and refuses/flags outside covered
  states. Needs a backend + prompt/guardrails + logging.
- **Attorney referrals:** replace `LAWYERS` with a real directory (state bar / partner API),
  filtered by state licensure and proximity to `county`.

Both need backends and are independent of the static content work — can run in parallel.

---

## 5. Phasing & rough effort

| Phase | Deliverable | Effort |
| --- | --- | --- |
| **0 — Guardrail (now)** | Federal-only fallback + "content is illustrative / not yet reviewed for {state}" banner for any non-reviewed state; keep CA as the fully-authored example. Ships today, removes the trust risk. | ~half a day |
| **1 — Schema + baseline** | Extract federal content to `_federal.json`; build the merge layer; author + attorney-review **5 states** (CA, NY, TX, FL, IL ≈ 40% of workforce). | ~1–2 wks + legal review |
| **2 — Breadth** | State layer for the remaining 45 (+DC, PR), reviewed. Pace gated by legal review throughput or a licensed dataset. | weeks–months (or license) |
| **3 — Local** | County/city minimum wage + ordinances for major metros. | ~1 wk + data source |
| **4 — Dynamic** | Real AI consult (jurisdiction-aware, guarded) + live attorney directory. | separate backend project |

---

## 6. Risks & decisions

- **Accuracy/liability (highest).** Never present unreviewed law as authoritative. Phase 0 makes
  this safe immediately.
- **Maintenance.** Annual threshold refresh; someone owns it.
- **Build vs. buy** the legal content — the biggest cost/quality/liability lever.
- **Decisions needed from you:**
  1. Build in-house (with attorney review) or license a legal-content provider?
  2. Which 5 states for Phase 1?
  3. Is there a licensed employment attorney who can review before states go live?

---

## 7. Recommended immediate step

Ship **Phase 0** now: it's cheap, it removes the misleading-content risk for the 51 non-CA
jurisdictions, and it makes the app honest while the content is built out. Everything else is
gated on the build-vs-buy and legal-review decisions above.
