# Mode: scan-discovery — WebSearch Discovery Only

Scans job portals using WebSearch discovery queries (Level 3 only). This mode is optimized for **broad discovery** of new companies and opportunities across multiple job boards via search engine indexing.

**Speed/Scope Tradeoff:** Fast discovery across many job boards, broader reach than referral companies, but results may be slightly outdated (WebSearch uses cached results).

> **Note:** This mode executes Level 3 only (WebSearch discovery queries). It **skips Levels 1+2 (Playwright + APIs)** for referral companies. Use `/career-ops scan referral` for deep scraping of referral companies, or `/career-ops scan` for all three levels combined.

## Recommended Execution

Run as a subagent to avoid consuming main context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + specific data]",
    run_in_background=True
)
```

**CRITICAL: LEVEL 3 MUST EXECUTE.** Do NOT skip WebSearch queries.

## Configuration

**Pre-step (REQUIRED): refresh rolling `after:` cutoff before reading queries.**

Run one of:

```bash
npm run scan:refresh-after
```

or

```bash
node refresh-search-query-dates.mjs --days 14
```

This updates all `after:YYYY-MM-DD` filters in `portals.yml` to a rolling 14-day window based on the current date. Do this first so Level 3 WebSearch queries always use fresh recency bounds.

Read `portals.yml` which contains:
- `search_queries`: List of WebSearch queries with `site:` filters per portal (broad discovery)
- `title_filter`: Positive/negative/seniority_boost keywords for title filtering

## Discovery Strategy (Level 3 Only)

### Levels 1 + 2 (SKIPPED in this mode)

Direct Playwright scraping and ATS APIs are intentionally skipped. Use `/career-ops scan referral` for deep scraping of referral companies, or `/career-ops scan` for comprehensive scanning with all three levels.

### Level 3 — WebSearch queries (PRIMARY LEVEL IN THIS MODE)

The `search_queries` with `site:` filters cover portals across the board (all Ashby, all Greenhouse, etc.). Useful for discovering NEW companies not yet in `referral_companies`, but results may be outdated.

**Key advantage:** Discovers opportunities beyond referral companies.
**Key limitation:** WebSearch results are cached (potentially 1-4 weeks old). Liveness verification is REQUIRED before adding to pipeline.

## Workflow

1. **Read configuration**: `portals.yml`
2. **Read history**: `data/scan-history.tsv` → URLs already seen
3. **Read dedup sources**: `data/applications.md` + `data/pipeline.md` + `data/pipeline-referral.md`

4. **STEP 4: Level 3 — WebSearch queries (REQUIRED — EXECUTE)**:
   
   For each query in `search_queries` with `enabled: true`:
   a. Execute WebSearch with the defined `query`
   b. From each result extract: `{title, url, company}`
      - **title**: from result title (before " @ " or " | ")
      - **url**: result URL
      - **company**: after " @ " in title, or extract from domain/path
   c. Accumulate in candidate list

5. **Filter by title** using `title_filter` from `portals.yml`:
   - At least 1 keyword from `positive` must appear in title (case-insensitive)
   - 0 keywords from `negative` must appear
   - `seniority_boost` keywords give priority but are not required

6. **Deduplicate** against 4 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → normalized company + role already evaluated
   - `pipeline.md` → exact URL already pending or processed in discovery queue
   - `pipeline-referral.md` → exact URL already pending or processed in referral queue

6.5. **Verify liveness of WebSearch results** — BEFORE adding to pipeline:

   WebSearch results can be outdated (Google caches results for weeks or months). To avoid evaluating expired jobs, verify each new URL from Level 3 with Playwright. This is REQUIRED for all WebSearch results.

   For each new Level 3 URL (sequential — NEVER parallel Playwright):
   a. `browser_navigate` to the URL
   b. `browser_snapshot` to read content
   c. Classify:
      - **Active**: job title visible + role description + visible Apply/Submit/Apply control in main content. Don't count generic header/navbar/footer text.
      - **Expired** (any of these signals):
        - Final URL contains `?error=true` (Greenhouse redirects like this when offer is closed)
        - Page contains: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found"
        - Only navbar and footer visible, no JD content (content < ~300 chars)
   d. If expired: record in `scan-history.tsv` with status `skipped_expired` and discard
   e. If active: proceed to step 7

   **Don't interrupt entire scan if a URL fails.** If `browser_navigate` errors (timeout, 403, etc.), mark as `skipped_expired` and continue to next.

7. **Strict title validation** (BEFORE adding to pipeline):
   
   **MANDATORY:** Reject any title containing seniority keywords:
   - "Sr" or "Sr." (followed by space or end of string)
   - "Senior"
   - "Lead"
   - "Staff"
   - "Principal"
   - "Head of"
   - "Director"
   - "Manager"
   
   If rejected: record in `scan-history.tsv` with status `skipped_title_validation` and DO NOT add to pipeline.

8. **For each job that passes ALL filters** (title + seniority + age + experience + dedup + liveness + validation):
   a. Add to `pipeline.md` "Pending" section: `- [ ] {posted_date} | {url} | {company} | {title}`
   b. Record in `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`
   
   **Note**: For WebSearch results, use today's date as posted_date since it's typically unavailable.

9. **Jobs filtered by title (portals.yml)**: record in `scan-history.tsv` with status `skipped_title`
10. **Jobs failing strict validation (seniority keywords)**: record with status `skipped_title_validation`
11. **Duplicate jobs**: record with status `skipped_dup`
12. **Expired jobs**: record with status `skipped_expired`

## Title and Company Extraction from WebSearch Results

WebSearch results come in format: `"Job Title @ Company"` or `"Job Title | Company"` or `"Job Title — Company"`.

Extraction patterns by portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Generic regex: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## Scan History

`data/scan-history.tsv` tracks ALL URLs seen:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	WebSearch — AI PM	PM AI	NewCo	added
https://...	2026-02-10	WebSearch — Backend	Backend Eng	StartupX	skipped_title
https://...	2026-02-10	WebSearch — SWE	SW Eng	OldCorp	skipped_dup
https://...	2026-02-10	WebSearch — AI	AI Eng	ClosedCo	skipped_expired
```

## Output Summary

```
Portal Scan (WebSearch Discovery) — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WebSearch queries executed: N
Jobs found: N total
Filtered by title (portals.yml): N removed
Title validation (seniority check): N rejected
Duplicates: N (already evaluated or in pipeline)
Expired discarded: N (dead links, liveness check)
New added to pipeline.md: N

  + {company} | {title} | {query_name}
  ...

→ Run /career-ops score discovery to score the new jobs.
```

## ENFORCEMENT: Level 3 Required

**If you are an agent executing this mode:**

1. **Do NOT skip WebSearch queries.** Level 3 discovery is required.
2. **Do liveness verification for ALL Level 3 results.** WebSearch caches outdated results. Playwright check is MANDATORY before adding to pipeline.
3. **This mode intentionally skips Levels 1+2.** Use `/career-ops scan referral` or `/career-ops scan` if you need deep scraping of referral companies.

**Expected output from scan execution:**
- WebSearch queries executed: N
- Jobs found: N total
- Liveness verified: M URLs confirmed active
- Final: X new jobs added to pipeline after filtering/dedup/liveness/validation
- Failed queries: list with reason
