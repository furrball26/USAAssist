# Legal content dataset

Structured, **source-cited** employment-law data that the app renders per jurisdiction.
Built to be reviewed **in its entirety by legal counsel** before any state is shown as
authoritative.

## Layers (merged at runtime)

```
content/
  _federal.json        # applies everywhere (FLSA, Title VII, ADA, ADEA, EPA, NLRA, FMLA)
  states/<ABBR>.json   # per-state overlay (50 + DC + PR)
  local/<ABBR>/<x>.json # county/city ordinances, keyed to counties[] (see below)
  sources.md           # registry of official .gov source sites per jurisdiction
  index.json           # which files exist (drives the review page)
```

The app merges `_federal` + `states/<abbr>` + any `local/*` keyed off the user's selected
state/county. Federal is the floor; state/local values apply where they give the worker more.

## Every datum is a cited fact

```json
{
  "topic": "overtime.salaryLevelWeekly",
  "value": 684,
  "summary": "EAP exemption requires a salary of at least $684/week ($35,568/yr).",
  "citation": "29 C.F.R. § 541.600; 29 U.S.C. § 213(a)(1)",
  "sourceUrl": "https://www.dol.gov/agencies/whd/overtime/salary-levels",
  "sourceAgency": "U.S. Department of Labor, Wage and Hour Division",
  "lastChecked": "2026-07-30",
  "reviewed": false,
  "reviewedBy": null,
  "notes": "2024 increase vacated 2024-11-15 (E.D. Tex.); 2019 level restored, effective 2026-05-15."
}
```

Rules:
- **`sourceUrl` is required** and must point to an official government page (`.gov`, `.us`,
  eCFR, U.S. Code, state code, or a state/county agency).
- `reviewed` starts `false`. Counsel flips it to `true` (with `reviewedBy` + date) per datum.
- `lastChecked` is when the value was last confirmed against the source. Thresholds change
  yearly — anything past a review cadence is re-checked.

## Local files are shaped differently, on purpose

A county is almost never one answer, so `local/<ABBR>/<slug>.json` nests its facts one
level down, under `localities[]`:

```json
{
  "state": "CA",
  "counties": ["Los Angeles County"],
  "name": "Los Angeles County",
  "localities": [
    { "name": "Unincorporated Los Angeles County",
      "covers": "Work performed in unincorporated areas of the county — not inside any incorporated city. …",
      "facts": [ /* same cited-fact shape as above */ ] }
  ]
}
```

- **`counties[]` is the join key** against the county the reader picked, and it must match
  the app's own `US_COUNTIES` spelling exactly. A typo does not fail loudly — the ordinance
  simply never matches and never renders, which looks identical to "this county has no
  local law". `validate-content.mjs` cross-checks it against the app and hard-fails.
- One file can serve several counties: New York City's `counties[]` lists all five boroughs.
- **`covers` is required on every locality** and must say, in words, who the ordinance
  applies to. It is what stops five different rates in one county collapsing into a single
  wrong number — Los Angeles County's own rate covers unincorporated areas only, and the
  City of Los Angeles pays *less* than the county around it. The app renders each locality
  as its own card with this sentence above the figures, and never merges them.
- `index.json`'s `local{}` is the manifest the app fetches by; the validator keeps it and
  the files on disk in sync in both directions.

## Rendering gate

The app renders a state as **authoritative only when its data is `reviewed: true`**. Until
then it falls back to the federal baseline and shows a "not yet reviewed for {state}" banner
(Phase 0). This keeps the live app honest while the dataset is built and reviewed.

## Build/verification pipeline

Data is compiled from the official sources in `sources.md` (see that file for the agency per
jurisdiction). Each state is: (1) drafted from its primary `.gov` source with citations,
(2) machine-checked that every `sourceUrl` resolves, (3) reviewed by counsel. See
`../docs/state-content-scope.md` for phasing and `../docs/legal-content-review.html` for the
counsel review view.
