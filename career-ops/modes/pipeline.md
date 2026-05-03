# Mode: pipeline — URL Inbox (Second Brain)

Processes URLs of offers accumulated in `data/pipeline.md`. User adds URLs anytime and then runs `/career-ops pipeline` to process all of them.

## Workflow

1. **Read** `data/pipeline.md` → search for `- [ ]` items in "Pending" section
2. **For each pending URL**:
   a. Calculate next sequential `REPORT_NUM` (read `reports/`, take highest number + 1)
   b. **Extract JD** using Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   c. If URL not accessible → mark as `- [!]` with note and continue
   d. **Run full auto-pipeline**: Evaluation A-G → Report .md → PDF (if score >= 3.0) → Tracker
   e. **Move from "Pending" to "Processed"**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`
3. **If 3+ pending URLs**, launch agents in parallel (Agent tool with `run_in_background`) to maximize speed.
4. **When done**, show summary table:

```
| # | Company | Role | Score | PDF | Recommended Action |
```

## pipeline.md Format

```markdown
## Pending
- [ ] 2026-05-02 | https://jobs.example.com/posting/123
- [ ] 2026-04-30 | https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] 2026-04-28 | https://private.url/job — Error: login required

## Processed
- [x] 2026-05-01 | #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] 2026-04-29 | #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

**Note:** Dates (YYYY-MM-DD) now appear automatically on new entries added by the scanner. This makes it easy to filter by age and avoid expired offers (> 7 days). Older entries without dates will process the same.

## Smart JD Detection from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright unavailable.
3. **WebSearch (last resort):** Search secondary job boards that index the JD.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask user to paste text
- **PDF**: If URL points to PDF, read directly with Read tool
- **`local:` prefix**: Read local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic Numbering

1. List all files in `reports/`
2. Extract number from prefix (e.g., `142-medispend...` → 142)
3. New number = highest found + 1

## Source Synchronization

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If desynchronized, warn user before proceeding.
