# Release Notes - Wave Completion

Date: 2026-05-18
Scope: Wave 1, Wave 2, Wave 3 completion and operational checklist

## Included Commits

- 300bc05 wave3: add stage run receipts for enrich and pdf
- e7b6bab wave2: add id hard-gate, repair tool, and cross-platform scoring wrapper
- c2d679a wave2: unify canonical status vocabulary across node and go
- 9a88ba7 wave2: add scorer banners and align score mode docs
- d9c7951 wave2: unify score routing to primary engine
- 7017fce docs: add detailed app flow gap analysis
- 80dc254 dashboard: fix scan-history path fallback and add regression tests
- 7646027 stability: make status handling chain-aware across node scripts

## Completed Work

### Wave 1

- Status history made chain-aware across Node scripts.
- Score/status consistency checker fixed and covered with regression tests.
- Dashboard scan-history resolution fixed and tested.

### Wave 2

- Primary scorer routing unified through wrapper with explicit legacy fallback.
- Scorer engine/scope banners added for drift visibility.
- Canonical status vocabulary aligned between Node and Go.
- Duplicate tracker ID hard-gate added to verify checks.
- Repair utility added for ID reindexing with backup support.
- Parser hardening introduced via shared markdown table parser and adoption in high-risk scripts.

### Wave 3

- Stage run receipts added for enrich and pdf stages under reports/pipeline-runs/.
- Receipt utility and tests added.
- Smoke-oriented test scripts expanded.

## Validation Summary

### Test and syntax checks

- Node syntax checks: PASS
- Status and parser tests: PASS (14 tests)
- Dashboard data tests: PASS

### Operational checklist

1. npm run verify
- Result: FAIL
- Detail: 80 entries checked, 2 errors (duplicate IDs #103 and #104), 3 duplicate-role warnings
- Impact: hard-gate is functioning correctly and now blocks merge/verify until fixed

2. npm run score-pipeline:dry-run
- Result: FAIL
- Detail: claude CLI not found in PATH
- Impact: primary batch scorer cannot execute in this environment until CLI is available

3. npm run enrich:referral -- --dry-run
- Result: PASS
- Detail: 0 pending referral entries, no updates required

4. npm run pdf:queue
- Result: PASS
- Detail: 54 PDF-ready entries listed

## Known Blockers

1. Local environment missing claude CLI in PATH for batch scorer execution.
2. Tracker contains duplicate IDs and now fails verify by design.

## Immediate Actions

1. Repair duplicate IDs:
- node repair-tracker-ids.mjs --dry-run
- node repair-tracker-ids.mjs
- npm run verify

2. Restore primary scoring execution:
- ensure claude CLI is installed and reachable in PATH
- rerun: npm run score-pipeline:dry-run

3. Run smoke bundle:
- npm run test:pipeline:smoke

## Notes

- Run receipts are generated at runtime and are operational artifacts; they should generally remain uncommitted unless explicitly needed for audits.
