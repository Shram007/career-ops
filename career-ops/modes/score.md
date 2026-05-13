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
   e. Move item to `## Processed` in the same queue:
      - `- [x] {date} | {url} | {company} | {role} | {score}/5 | {decision}`
   f. If score >= 3.5, append to `data/applications.md` with status `Scored`
      - Do not create report links at this stage
      - Set PDF as `❌` until user runs PDF stage

4. **Parallelism**
   - If 3+ pending URLs, process with agents in parallel

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
- [x] 2026-05-12 | https://jobs.example.com/123 | Acme | Software Engineer | 3.8/5 | advance
- [x] 2026-05-12 | https://jobs.example.com/999 | OldCo | Senior SWE | 2.7/5 | hold
```

## Rules

- No report generation in this stage
- No PDF generation in this stage
- Tracker write threshold is strict: only `score >= 3.5`
- Keep scoring language concise and evidence-based
