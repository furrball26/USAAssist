export const meta = {
  name: 'worklaw-orchestrator',
  description: 'Supervised WorkLaw pipeline: audit (qa + ux + content) in parallel and report-only, then a sequential fixer implements the safe findings, green-gated and committed to auto/agents. Never deploys, never flips content reviewed:true.',
  phases: [
    { title: 'Audit', detail: 'qa + ux + content in parallel, report only' },
    { title: 'Fix', detail: 'sequential fixer: implement, verify, commit each' },
  ],
};

const GUARDRAILS = `Follow AUTONOMY.md. Hard rules: work only on the auto/agents git branch; never commit to main; never push or deploy; never flip any content/*.json "reviewed" flag to true; never start items AUTONOMY.md marks BLOCKED (the federal-feature product pivot, legal sign-off, deploy).`;

const FINDINGS = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          area: { type: 'string', description: 'screen / file / state the finding is in' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          repro: { type: 'string' },
          suggestedFix: { type: 'string' },
          safeToAutomate: { type: 'boolean', description: 'false if it needs a product or legal decision per AUTONOMY.md' },
        },
        required: ['title', 'safeToAutomate'],
      },
    },
  },
  required: ['findings'],
};

const FIX_RESULT = {
  type: 'object', additionalProperties: false,
  properties: {
    committed: { type: 'boolean' },
    sha: { type: 'string' },
    testsPassed: { type: 'boolean' },
    summary: { type: 'string' },
    blockedReason: { type: 'string' },
  },
  required: ['committed', 'summary'],
};

// ── Audit: three specialists in parallel, REPORT ONLY (no writes/commits) ──
phase('Audit');
const REPORT_ONLY = 'ANALYSIS ONLY: do not modify files, do not run the build, do not commit. Just investigate and report findings.';
const [qa, ux, content] = await parallel([
  () => agent(`You are the QA reviewer for the WorkLaw app (repo at cwd; read AUTONOMY.md). ${REPORT_ONLY} Read test/smoke.mjs + test/persona.mjs and the app source; identify functional gaps and missing coverage: states/issues/letter-types not exercised, screens that could throw, persistence edge cases. Rank findings. ${GUARDRAILS}`,
    { agentType: 'general-purpose', phase: 'Audit', label: 'qa', schema: FINDINGS }),
  () => agent(`You are the UX/accessibility auditor for the WorkLaw app (read AUTONOMY.md). ${REPORT_ONLY} Read index.dev.html and reason about: a disclaimer on every screen, dead buttons, hit-target sizes, contrast, honest/consistent copy, empty + content-fetch-error states. Rank concrete issues. ${GUARDRAILS}`,
    { agentType: 'general-purpose', phase: 'Audit', label: 'ux', schema: FINDINGS }),
  () => agent(`You are the legal-content integrity auditor for the WorkLaw dataset (read AUTONOMY.md + content/README.md). ${REPORT_ONLY} Validate every content/*.json: required fields, reviewed is boolean, sourceUrl well-formed + official-domain, citation present. List malformed/suspect files and any non-official sourceUrls. Do NOT propose flipping reviewed. ${GUARDRAILS}`,
    { agentType: 'general-purpose', phase: 'Audit', label: 'content', schema: FINDINGS }),
]);

const all = [qa, ux, content].filter(Boolean).flatMap(r => r.findings || []);
const rank = { high: 0, medium: 1, low: 2 };
const safe = all.filter(f => f.safeToAutomate)
  .sort((a, b) => (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1))
  .slice(0, 4); // bound cost per supervised run
log(`audit complete: ${all.length} findings, ${safe.length} safe queued, ${all.length - all.filter(f => f.safeToAutomate).length} blocked/needs-human`);

// ── Fix: ONE sequential fixer per finding (shared working tree → never parallel) ──
phase('Fix');
const fixes = [];
for (const f of safe) {
  const r = await agent(
    `You are the WorkLaw fixer. ${GUARDRAILS}
Implement exactly ONE fix, then stop. Steps:
1. Confirm you are on branch auto/agents (git branch --show-current); if not, stop and report.
2. Make the smallest change that resolves the finding (edit index.dev.html for app code; test/ for tests; content/ for dataset formatting only — never legal wording or reviewed flags).
3. npm run build && node test/smoke.mjs && node test/persona.mjs. If anything fails, git checkout -- . and report committed:false with the reason.
4. If green, git commit to auto/agents with a clear message (do NOT push). Report the short SHA.
Finding:
${JSON.stringify(f, null, 2)}`,
    { agentType: 'general-purpose', phase: 'Fix', label: 'fix:' + String(f.area || f.title).slice(0, 20), schema: FIX_RESULT }
  );
  fixes.push({ finding: f.title, ...(r || { committed: false, summary: 'agent returned nothing' }) });
}

return {
  auditedCount: all.length,
  safeQueued: safe.length,
  committed: fixes.filter(x => x.committed).length,
  blocked: all.filter(f => !f.safeToAutomate).map(f => f.title),
  findings: all,
  fixes,
};
