# Career-Ops End-to-End Flow Audit and Improvement Plan

## Purpose
This document is a high-detail map of the current application flow, operational invariants, concrete gaps, and smallest-change improvement paths.

Goal: allow fast future edits from natural-language requests without re-reading the entire codebase each time.

Last reviewed: 2026-05-18

---

## 1. System Topology (Current)

### 1.1 Core interaction layers
1. Agent routing layer
- Command router and mode mapping: .claude/skills/career-ops/SKILL.md
- Agent guidance and onboarding: CLAUDE.md
- Mode behavior specs: modes/*.md

2. Script execution layer
- Node scripts: *.mjs
- Shell orchestrators: batch/*.sh
- Dashboard runtime: dashboard/ (Go)

3. Persistent data layer
- data/applications.md (canonical tracker)
- data/pipeline.md and data/pipeline-referral.md (queue inboxes)
- data/scan-history.tsv (scanner memory)
- batch/*.tsv (batch state and merge intermediates)
- reports/*.md and output/*.pdf

### 1.2 Primary user journeys
1. Journey A: Auto-pipeline from JD/URL
- Routed by skill router to auto-pipeline mode.
- Evaluation report generation (A-G).
- PDF generation.
- Tracker update.

2. Journey B: Scan -> Enrich -> Score -> Tracker
- scan-with-instrumentation.mjs runs Level 1/2/3 scanners.
- enrich-pipeline.mjs adds metadata tags and caches JD text.
- scoring via either score-pipeline.mjs (deterministic path) or batch/score-pipeline.sh (parallel LLM scoring path).
- merge/normalize/verify maintain tracker quality.

3. Journey C: PDF from tracker ID
- pdf-queue.mjs lists candidates.
- pdf-from-id.mjs resolves JD URL and runs PDF flow.

4. Journey D: Operations and review
- Dashboard reads tracker + enrichments, opens URLs, updates status.
- Maintenance scripts ensure consistency (verify/normalize/dedup).

---

## 2. Command and Script Routing Map

## 2.1 NPM script map
Source: package.json

1. Setup and health
- doctor -> doctor.mjs
- sync-check -> cv-sync-check.mjs

2. Scan and queue
- scan -> scan-with-instrumentation.mjs
- scan:referral -> scan-with-instrumentation.mjs --referral
- scan:playwright -> scan-playwright.mjs
- scan:websearch -> scan-websearch.mjs

3. Enrich and score
- enrich -> enrich-pipeline.mjs
- enrich:referral -> enrich-pipeline.mjs --referral
- score-pipeline -> bash batch/score-pipeline.sh
- score-pipeline:referral -> bash batch/score-pipeline.sh --referral
- score-pipeline:dry-run -> bash batch/score-pipeline.sh --dry-run
- gemini:eval -> gemini-eval.mjs
- re-eval -> re-eval.mjs

4. Tracker maintenance
- merge -> merge-tracker.mjs
- normalize -> normalize-statuses.mjs
- verify -> verify-pipeline.mjs
- dedup -> dedup-tracker.mjs

5. PDF flow
- pdf -> generate-pdf.mjs
- pdf:id -> pdf-from-id.mjs
- pdf:queue -> pdf-queue.mjs

6. Update lifecycle
- update:check, update, rollback -> update-system.mjs

## 2.2 Slash routing map (high-level)
Sources: .claude/skills/career-ops/SKILL.md, CLAUDE.md

1. /career-ops scan
- Runs scan-with-instrumentation.mjs

2. /career-ops scan referral
- Runs scan-with-instrumentation.mjs --referral

3. /career-ops scan discovery
- Runs scan-with-instrumentation.mjs --skip-level1 --skip-level2

4. /career-ops score referral/discovery
- Runs score-pipeline.mjs with --referral or --discovery

5. /career-ops score pipeline referral/discovery
- Runs batch/score-pipeline.sh with scope flag

6. /career-ops pdf id N
- Runs pdf-from-id.mjs --id N

Important: there are two scoring implementations in active routing (score-pipeline.mjs and batch/score-pipeline.sh). This is a major architecture fork and source of drift (details in gap section).

---

## 3. Data Model and State Transitions

## 3.1 Canonical artifacts
1. data/applications.md
- Canonical application tracker table.
- Columns: #, Date, Company, Role, Score, Status, PDF, Report, Notes

2. data/pipeline*.md
- Queue files with sections: Pending, In Progress, Processed
- Line format: - [ ] date | url | company | role | tags...

3. data/scan-history.tsv
- URL memory and dedup history

4. batch files
- batch-input.tsv, batch-state.tsv, tracker-additions/*.tsv

## 3.2 Status lifecycle (intended)
Typical progression:
Scored -> PDF'd -> Applied -> Responded -> Interview -> Offer

Recent enhancement supports status history chains in dashboard write path:
Scored > PDF'd > Applied

Display expectation:
- UI should show latest stage only.
- Data should preserve prior stages for traceability.

## 3.3 Data contract boundaries
Source: DATA_CONTRACT.md

1. User layer (must not be overwritten): cv.md, config/profile.yml, modes/_profile.md, portals.yml, data/*, reports/*, output/*
2. System layer (safe updates): scripts, shared modes, templates, dashboard, docs

---

## 4. Detailed Runtime Flows

## 4.1 Scan orchestration flow
Entry: scan-with-instrumentation.mjs

Flow:
1. refresh-search-query-dates.mjs
2. Level 1 scan-playwright.mjs
3. Level 2 scan.mjs
4. Level 3 scan-websearch.mjs
5. Write run ledger: reports/scan-level-execution.tsv
6. Write run summary: reports/scan-run-{id}.json

Current behavior notes:
- Level 2 failure is fatal; Level 1/3 failures are logged but do not hard-stop.
- Referral mode detection supports multiple shorthand forms.

## 4.2 Enrichment flow
Entry: enrich-pipeline.mjs

Flow:
1. Parse pending entries.
2. Reject junk URLs early.
3. Fetch JD text (Playwright preferred, HTTP fallback).
4. Extract tags: location, experience years, remote policy.
5. Persist JD cache under tmp/jd-cache.
6. Rewrite pipeline line with tags.

Operational value:
- Reduces expensive scoring on obvious no-fit entries.
- Enables pre-screening by location/experience.

## 4.3 Scoring flow A (deterministic)
Entry: score-pipeline.mjs

Flow:
1. Read pending queue.
2. Fetch JD by Playwright.
3. Keyword/archetype heuristic scoring.
4. Write processed queue lines.
5. Append tracker rows for score >= 3.0.

Characteristics:
- Deterministic and simple.
- Lower reasoning quality than LLM path.
- Fast fallback if LLM path unavailable.

## 4.4 Scoring flow B (parallel LLM)
Entry: batch/score-pipeline.sh

Flow:
1. Parse pending queue.
2. Pre-screen location/experience using tags.
3. Spawn parallel claude -p workers with score-pipeline-prompt.md.
4. Parse JSON outputs.
5. Update pipeline markers.
6. Queue tracker additions.
7. Run consistency checks.

Characteristics:
- Higher quality scoring and richer rationale.
- More moving parts (locks, worker logs, JSON extraction robustness).

## 4.5 PDF flow
Entries:
- generate-pdf.mjs (HTML -> PDF)
- pdf-queue.mjs (candidate list)
- pdf-from-id.mjs (ID-first resolution)

Current strengths:
1. ATS normalization and HTML validation gate in generate-pdf.mjs.
2. Multi-source URL resolution recently improved in pdf-from-id.mjs:
- report URL
- notes URL
- batch-input match by company/role
- pipeline fallback
- scan history fallback

## 4.6 Dashboard flow
Entries:
- dashboard/main.go
- dashboard/internal/data/career.go
- dashboard/internal/ui/screens/pipeline.go

Flow:
1. Parse tracker and enrich with job URLs.
2. Filter/group/sort by normalized status.
3. Open report or URL.
4. Update status inline (now appends history chain).

---

## 5. Gap Analysis (Prioritized)

## 5.1 Critical (P0)

1. Multi-status history compatibility across scripts is incomplete
What exists:
- Dashboard write path appends status chains.

What breaks:
- Several non-dashboard scripts still assume Status is a single token.
- Risks: verify false negatives, queue filtering errors, blocked PDF queue logic, status regressions.

Impacted files:
- verify-pipeline.mjs
- normalize-statuses.mjs
- pdf-queue.mjs
- re-eval.mjs (status overwrite path)
- check-score-decision-consistency.mjs

Smallest fix:
- Add shared status parser utility in a new script module (for example scripts/status-utils.mjs).
- Parse latest status token from chains and reuse in all scripts.

2. check-score-decision-consistency.mjs parses score/status columns incorrectly
Observation:
- The script reads score and status from swapped table indexes.
- Auto-fix path can write incorrect status changes.

Smallest fix:
- Correct column indexes and add unit tests with sample table rows.

3. scan history path mismatch in dashboard enrichment
Observation:
- dashboard/internal/data/career.go reads scan-history.tsv at repo root.
- Scanners write data/scan-history.tsv.

Impact:
- URL enrichment may silently miss scan history source.

Smallest fix:
- Probe both paths (data/scan-history.tsv first, then root fallback).

## 5.2 High (P1)

1. Dual scoring engines create decision drift
Observation:
- score-pipeline.mjs and batch/score-pipeline.sh implement different logic.
- Routing uses both depending command variant.

Risk:
- Same role can score differently by command choice.

Smallest fix:
- Declare one primary scorer.
- Keep second as explicit fallback mode only.
- Add command-level banner showing which scorer ran.

2. Status canonical sets are inconsistent across modules
Observation:
- verify-pipeline canonical set differs from dashboard normalization vocabulary.
- PDF'd handling and chain-aware states are uneven.

Smallest fix:
- Single canonical states source consumed by Node and Go (for example templates/states.yml adapter generated for Go build).

3. Tracker row identity collisions and duplicates
Observation:
- applications.md contains duplicate IDs in real data.
- Some scripts infer next ID by regex scanning and may not handle malformed rows robustly.

Smallest fix:
- Add unique ID checker as hard gate in verify-pipeline.mjs.
- Add repair script to reindex IDs safely while preserving report links.

4. Batch shell dependency friction on Windows
Observation:
- score-pipeline default npm path relies on bash.

Smallest fix:
- Add Node wrapper script with platform detection and fallback to Git Bash path.

## 5.3 Medium (P2)

1. Missing unified observability for non-scan stages
Observation:
- Scan has instrumentation ledger.
- Enrich/score/pdf/merge do not have consistent run receipts.

Smallest fix:
- Introduce per-stage run logs in reports/pipeline-runs/ with JSON summary schema.

2. No first-class end-to-end integration test for full pipeline
Observation:
- Scan tests exist.
- Full path (scan->enrich->score->tracker->pdf) not integration-tested.

Smallest fix:
- Add smoke tests with fixture data and mocked fetch/playwright.

3. Parser brittleness for markdown table lines with extra pipes
Observation:
- Multiple scripts split rows by '|'.
- Notes field often contains symbols and optional pipeline metadata.

Smallest fix:
- Introduce shared table-row parser utility and migrate scripts incrementally.

---

## 6. Improvement Backlog (Implementation-ready)

## 6.1 Phase 1: Stability hardening (recommended first)
1. Chain-aware status utilities and script adoption.
2. Fix score/status consistency script indexes and tests.
3. Fix scan-history path fallback in dashboard data loader.
4. Add verify check for duplicate tracker IDs.

Acceptance criteria:
- Existing workflow behavior unchanged except bug fixes.
- go test ./... and node checks pass.
- verify-pipeline handles status chains without false failures.

## 6.2 Phase 2: Flow unification
1. Decide primary scoring engine and route all slash commands to it.
2. Add explicit fallback command for secondary scorer.
3. Normalize output shape between scoring paths.

Acceptance criteria:
- Same queue input yields same decision across command variants.

## 6.3 Phase 3: Operability and quality
1. Add run receipts for enrich, score, pdf stages.
2. Add full pipeline smoke tests with fixtures.
3. Add keyword coverage validator in PDF flow (the recent proposal).

Acceptance criteria:
- Each stage produces machine-readable outcome summary.
- Regression detection exists before merge.

---

## 7. Smallest-Change Playbook (Fast Edits)

Use this section as a quick dispatch map for future requests.

## 7.1 Tracker and status requests

1. Request:
"Support multi-status but show latest only"
Edit:
- dashboard/internal/data/career.go
- dashboard/internal/ui/screens/pipeline.go
Also update:
- verify-pipeline.mjs
- normalize-statuses.mjs
- pdf-queue.mjs
- re-eval.mjs
- check-score-decision-consistency.mjs
Validation:
- go test ./dashboard/...
- node verify-pipeline.mjs

2. Request:
"Change allowed status vocabulary"
Edit:
- templates/states.yml
- dashboard/internal/data/career.go NormalizeStatus
- normalize-statuses.mjs
- verify-pipeline.mjs
Validation:
- go test ./dashboard/internal/...
- node verify-pipeline.mjs

## 7.2 Scan requests

1. Request:
"Improve scan coverage for a portal"
Edit:
- scan-playwright.mjs (URL and title heuristics)
- scan-single-url.mjs (route detection)
- portals.yml (company search/fallback URLs)
Validation:
- npm run test:scan
- RUN_NETWORK_TESTS=1 npm run test:scan:integration
- dry-run company scan

2. Request:
"Prove which scan levels ran"
Edit:
- scan-with-instrumentation.mjs
Output files:
- reports/scan-level-execution.tsv
- reports/scan-run-*.json
Validation:
- node scan-with-instrumentation.mjs --dry-run equivalent path

## 7.3 Score requests

1. Request:
"Adjust threshold from 3.0 to X"
Likely edit points:
- batch/score-pipeline.sh
- score-pipeline.mjs
- modes/score.md
- check-score-decision-consistency.mjs
Validation:
- run scorer on fixture queue
- run consistency checker

2. Request:
"Improve location pre-screen"
Edit:
- enrich-pipeline.mjs (tag extraction)
- batch/score-pipeline.sh (prescreen rules)
- modes/score.md (policy text)
Validation:
- enrich single URL --url mode
- score dry-run on tagged entries

## 7.4 PDF requests

1. Request:
"Fix PDF from tracker ID not finding URL"
Edit:
- pdf-from-id.mjs URL resolver chain
Related:
- re-eval.mjs URL resolver (keep parity)
Validation:
- node pdf-from-id.mjs --id N --dry-run
- node re-eval.mjs --id N --no-save

2. Request:
"Add keyword coverage gate"
Edit:
- new validate-keyword-coverage.mjs
- modes/pdf.md gate step
- optional generate-pdf.mjs or orchestration caller to enforce retry cap
Validation:
- unit tests with JD fixture and generated HTML fixture

## 7.5 Dashboard requests

1. Request:
"Change grouping/sort/filter behavior"
Edit:
- dashboard/internal/ui/screens/pipeline.go
- dashboard/internal/data/career.go (normalization/priority)
Validation:
- go test ./dashboard/internal/ui/screens ./dashboard/internal/data
- go build ./dashboard

---

## 8. Recommended Metrics to Track Continuously

1. Scan quality
- candidate_links_extracted_per_run
- new_jobs_added_per_run
- duplicate_rate
- extraction_failure_rate_by_company

2. Queue quality
- enrich_success_rate
- percent_entries_with_loc_tag
- percent_entries_with_exp_tag

3. Scoring quality
- advance_rate by source (referral vs discovery)
- consistency_failures (score-decision checker)
- median_time_per_scored_entry

4. Tracker quality
- duplicate_id_count
- duplicate_company_role_count
- invalid_status_count

5. PDF quality
- generation_success_rate
- avg_pages
- keyword_coverage_required
- keyword_coverage_nice_to_have

---

## 9. Test Coverage Matrix (Current vs Needed)

1. Current
- Scan unit and integration tests:
  - tests/scan-single-url.test.mjs
  - tests/scan-playwright.test.mjs
  - tests/scan-playwright.integration.test.mjs
- Dashboard tests:
  - dashboard/internal/data/career_test.go
  - dashboard/internal/ui/screens/* tests

2. Needed
- Status chain compatibility tests across Node scripts.
- Tracker parser fuzz tests with complex notes and pipe characters.
- Full pipeline fixture test (scan->enrich->score->tracker update).
- PDF keyword coverage validator tests.

---

## 10. Immediate Next Actions (Low Risk / High Value)

1. Implement status-chain compatibility in all Node scripts listed in P0.
2. Fix check-score-decision-consistency column index bug and add tests.
3. Correct scan-history path in dashboard enrichment.
4. Add a short architecture decision record:
- single primary scoring engine
- fallback behavior and command naming

---

## 11. File Index for Fast Navigation

1. Routing and modes
- .claude/skills/career-ops/SKILL.md
- CLAUDE.md
- modes/auto-pipeline.md
- modes/score.md
- modes/pdf.md

2. Scan and ingest
- scan-with-instrumentation.mjs
- scan-playwright.mjs
- scan-single-url.mjs
- scan.mjs
- scan-websearch.mjs
- enrich-pipeline.mjs

3. Scoring
- score-pipeline.mjs
- batch/score-pipeline.sh
- check-score-decision-consistency.mjs

4. PDF
- pdf-queue.mjs
- pdf-from-id.mjs
- generate-pdf.mjs
- validate-resume-html.mjs

5. Tracker integrity
- merge-tracker.mjs
- normalize-statuses.mjs
- verify-pipeline.mjs
- dedup-tracker.mjs

6. Dashboard
- dashboard/main.go
- dashboard/internal/data/career.go
- dashboard/internal/ui/screens/pipeline.go

---

## 12. Notes and Assumptions

1. This analysis reflects current scripts and docs in the repository at review time.
2. The highest immediate risk is cross-script incompatibility caused by status history chains.
3. The second highest risk is score-path drift due to dual scoring engines and mixed routing.
4. Prioritize correctness and consistency first; then optimize throughput and ergonomics.
