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
- Add only strong matches to tracker (`score >= 3.5`)

## Workflow

1. **Select queue file by scope**
   - discovery: `data/pipeline.md`
   - referral: `data/pipeline-referral.md`

2. **Read pending items**
   - Parse `- [ ]` entries under `## Pending`

3. **For each pending URL**
   a. Extract JD text using this order: Playwright → WebFetch → WebSearch
   b. If inaccessible, mark item as `- [!]` with reason and continue
   c. Score CV against JD only (no full A-G writeup)
   d. Produce compact scoring output:
      - Overall score `/5`
      - Top strengths (3 bullets)
      - Top gaps (3 bullets)
      - Decision: `advance` when score >= 3.5, else `hold`
      - Reason tags: 1-3 comma-separated tags explaining the key decision driver (see Reason Tag Vocabulary below)
   e. Move item to `## Processed` in the same queue:
      - `- [x] {date} | {url} | {company} | {role} | {score}/5 | {decision} | {reason_tags}`
   f. If score >= 3.5, append to `data/applications.md` with status `Scored`
      - Prepend reason tags to the Notes column: `{reason_tags} | {any other notes}`
      - Do not create report links at this stage
      - Set PDF as `❌` until user runs PDF stage

4. **Parallelism & Batching**
   - Skip `- [~]` entries entirely (junk URLs marked by `enrich-pipeline.mjs`)
   - **Pre-screen** entries that already have enrichment tags — no JD fetch needed:
     - If `loc:{non-US/non-remote}` is set (e.g. `loc:Sydney-AU`, `loc:Singapore-SG`) → mark `hold | location:{value}` without fetching
     - If `exp:{X}yr` where X > 3 → mark `hold | exp:{X}yr` without fetching
   - Group remaining URLs into **batches of 5**
   - Within each batch: launch parallel sub-agents (one per URL)
   - After each batch completes: write all results to the queue file and tracker before starting the next batch
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
- [!] 2026-05-11 | https://private.example.com/role — Error: login required

## Processed
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

## Rules

- No report generation in this stage
- No PDF generation in this stage
- Tracker write threshold is strict: only `score >= 3.5`
- Keep scoring language concise and evidence-based
