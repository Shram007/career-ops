# Mode: score — CV Scoring Queue (No Report Stage)

Scores CV fit against queued job descriptions and updates tracker only for high-fit roles. This mode does not generate reports or PDFs.

## Invocation

Use explicit scope:

- `/career-ops score discovery` → process `data/pipeline.md`
- `/career-ops score referral` → process `data/pipeline-referral.md`
- `/career-ops pipeline` → legacy alias of `score discovery`

If invoked as `/career-ops score` without scope, ask the user to choose `discovery` or `referral` before processing.

## Goal

- Score CV vs JD quickly (1.0-5.0)
- Keep queue hygiene (`Pending` → `Processed`)
- Add only strong matches to tracker (`score >= 3.0`)

## Workflow

1. **Select queue file by scope**
   - discovery: `data/pipeline.md`
   - referral: `data/pipeline-referral.md`

2. **Read pending items**
   - Parse `- [ ]` entries under `## Pending`

3. **For each pending URL**
   a. **Pre-flight dedup check:** Scan all sections of the queue file (`## Processed` and `## In Progress`) for an existing entry whose URL matches this one. If found → skip silently and continue to the next URL. This prevents double-scoring after interrupted or replayed runs.
   b. **Fetch JD text.** Known SPA domains require Playwright — do NOT fall back to WebFetch/WebSearch for these:

      | Domain pattern | Required fetcher |
      |---|---|
      | `metacareers.com` | Playwright only |
      | `uber.com/careers` | Playwright only |
      | `apply.careers.microsoft.com` | Playwright only |
      | `careers.cisco.com` | Playwright only |

      For all other domains use fallback order: Playwright → WebFetch → WebSearch.
      If Playwright fails on a known SPA domain → immediately mark `- [!]`; do NOT try fallbacks.
   c. If inaccessible for any other reason, mark item as `- [!]` with reason and continue
   d. Score CV against JD only (no full A-G writeup)
   e. Produce compact scoring output:
      - Overall score `/5`
      - Top strengths (3 bullets)
      - Top gaps (3 bullets)
      - **Decision: AUTOMATIC. If score >= 3.0 → `advance`. If score < 3.0 → `hold`. No exceptions.**
      - Reason tags: 1-3 comma-separated tags explaining context (see Reason Tag Vocabulary below). **Tags are EXPLANATORY ONLY — they DO NOT override the numeric threshold.**
   f. **MOVE item to `## Processed`:** Delete the `- [ ]` line from `## Pending` and append a new line at the bottom of `## Processed`. ⚠️ Never update the marker in-place while leaving the line in `## Pending`.
      - `- [x] {date} | {url} | {company} | {role} | {score}/5 | {decision} | {reason_tags}`
   g. **MANDATORY: If score >= 3.0, append to `data/applications.md` immediately with status `Scored`**
      - Format: `| {next_id} | {date} | {company} | {role} | {score}/5 | Scored | ❌ | - | {reason_tags} | {notes} |`
      - Prepend reason tags to Notes column: `{reason_tags} | {any other notes}`
      - Do not create report links at this stage
      - Set PDF as `❌` until user runs PDF stage
      - **If append fails (IO error, validation error), stop and report error. Do not silently skip.**
   h. **Pre-write gate:** Before writing any result, assert: if `score >= 3.0` and `decision == "hold"` → override to `advance` and log `[gate] {url}: hold → advance (score {score} >= 3.0 threshold)`. This catches cases where reason tags were incorrectly used to veto a qualifying score.
      
   **⚠️ CRITICAL:** Reason tags like `domain:backend` or `fit:partial` are CONTEXT. They do NOT veto a high score. If score >= 3.0, decision is always `advance` and entry goes to tracker. Do NOT mark as `hold` because tags suggest "not AI-focused" or "less hands-on." Score is ground truth.

4. **Parallelism & Batching**
   - Skip `- [~]` entries entirely (junk URLs marked by `enrich-pipeline.mjs`)
   - **Pre-screen** entries that already have enrichment tags — no JD fetch needed:
     - If `loc:{non-US/non-remote}` is set (e.g. `loc:Sydney-AU`, `loc:Singapore-SG`) → mark `hold | location:{value}` without fetching
     - If `exp:{X}yr` where X > 3 → mark `hold | exp:{X}yr` without fetching
   - **Hard location block — FETCH THE JD, then check immediately:**
     For every entry, after fetching the JD text, scan for location signals **before** scoring:
     - **EMEA / non-US geo keywords** in the JD or role title (case-insensitive):
       - `EMEA`, `Europe`, `UK`, `United Kingdom`, `Germany`, `France`, `Netherlands`, `Spain`, `Italy`, `Sweden`, `Poland`, `India`, `APAC`, `Asia Pacific`, `Singapore`, `Australia`, `Canada` (if onsite/hybrid), `Latin America`, `LATAM`, `Dubai`, `UAE`, `Middle East`
     - **Trigger rule:** If ANY of these terms appear AND the JD does NOT also say `remote`, `remote-first`, `remote OK`, `work from anywhere`, or `global remote` → **immediately mark `hold | location:EMEA` (or the specific region) without scoring**. Do NOT compute blocks A-F.
     - If the role says "EMEA team" but explicitly states global remote or async-first → do NOT block; flag with `remote:timezone-risk` tag instead.
     - Candidate is in **San Jose, CA, USA**. Target market is **US + global remote only**.
   - Group remaining URLs into **batches of 5**
   - **At batch start:** MOVE all batch entries from `## Pending` to `## In Progress` in the queue file before fetching
   - Within each batch: launch parallel sub-agents (one per URL)
   - **At batch end:** MOVE all batch entries from `## In Progress` to `## Processed` and write tracker entries, then start the next batch
   - **If interrupted:** entries remaining in `## In Progress` are crash-recovery markers — move them back to `## Pending` before re-running
   - Log progress: `Batch N/total complete (X/total processed)`

5. **Summary output**
   - Show table:

```text
| Company | Role | Score | Decision | Added To Tracker |
```

## Queue Format

```markdown
## Pending
- [ ] 2026-05-12 | https://jobs.example.com/123 | Acme | Software Engineer

## In Progress
<!-- Entries moved here at batch start; moved to Processed at batch end.
     If non-empty after an interrupted run → move entries back to Pending before re-running. -->

## Processed
- [!] 2026-05-11 | https://private.example.com/role — Error: login required
- [x] 2026-05-12 | https://jobs.example.com/123 | Acme | Software Engineer | 3.8/5 | advance | fit:strong,remote:global
- [x] 2026-05-12 | https://jobs.example.com/999 | OldCo | Senior SWE | 2.7/5 | hold | seniority:senior,location:US-only
```

## Reason Tag Vocabulary

Generate 1-3 comma-separated tags per job. Use the structured format `key:value`:

| Tag | When to use |
|-----|-------------|
| `location:{code}` | Geo-restricted or non-remote (e.g. `location:AU`, `location:US-only`) |
| `exp:{n}yr` | Experience requirement too high (e.g. `exp:5yr`) |
| `seniority:{level}` | Role is over/under leveled (e.g. `seniority:senior`, `seniority:staff`) |
| `stack:{tech}` | Primary stack mismatch (e.g. `stack:java`, `stack:ruby`) |
| `remote:onsite` / `remote:hybrid` | Office presence required |
| `domain:{name}` | Domain mismatch (e.g. `domain:finance`, `domain:gaming`) |
| `comp:low` | Compensation below target |
| `scope:narrow` | Too niche or specialized |
| `fit:strong` | Strong overall match (use on advance decisions) |
| `fit:partial` | Partial match, key gaps manageable |

Examples:
- `location:AU,exp:3yr` — Australia role requiring 3+ years
- `stack:java,domain:finance` — Java-first fintech role
- `fit:strong,remote:global` — Strong match, fully remote

## Post-Score Validation (CRITICAL)

After all entries are processed, validate that no advances were orphaned:

1. **Check for orphaned advances in pipeline files:**
   - Scan pipeline.md and pipeline-referral.md for entries marked `| advance |`
   - If found: **FAIL with error message** listing the orphaned entries
   - These should have been appended to applications.md — their presence indicates a bug

2. **Run consistency check:**
   - `node check-score-decision-consistency.mjs` must pass (0 inconsistencies)
   - If fails: report which entries have score/status mismatch and halt

3. **Report summary:**
   - Total processed
   - Total advanced (appended to tracker)
   - Total on hold
   - Total inaccessible

If validation fails, user intervention required. Do NOT proceed to other stages.

## Rules

- No report generation in this stage
- No PDF generation in this stage
- Tracker write threshold is strict: only `score >= 3.0`
- Keep scoring language concise and evidence-based
