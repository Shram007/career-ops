# Mode: scan-api — API + WebSearch Discovery

Scans job portals using API queries and WebSearch discovery (Levels 2+3). This mode is optimized for **broad discovery** of new companies and opportunities across multiple job boards without the overhead of Playwright careers page scraping.

**Speed/Scope Tradeoff:** Fast discovery across many job boards, broader reach than tracked companies only, but results may be slightly outdated (Level 3 uses cached search results).

> **Note:** This mode executes Levels 2+3 (APIs + WebSearch). It **skips Level 1 (Playwright tracked companies)** for speed. Use `/career-ops scan tracked` for deep scraping of tracked companies, or `/career-ops scan` for all three levels combined.

## Recommended Execution

Run as a subagent to avoid consuming main context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + specific data]",
    run_in_background=True
)
```

**CRITICAL: LEVELS 2 + 3 MUST EXECUTE.** Do NOT skip either level.

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
- `tracked_companies`: Specific companies for API configuration reference
- `title_filter`: Positive/negative/seniority_boost keywords for title filtering

## Discovery Strategy (Levels 2 + 3 Only)

### Level 1 (SKIPPED in this mode)

Direct Playwright scraping is intentionally skipped. Use `/career-ops scan tracked` for deep scraping of tracked companies, or `/career-ops scan` for comprehensive scanning with all three levels.

### Level 2 — ATS APIs / Feeds (FIRST LEVEL IN THIS MODE)

For companies with public API or structured feed, use the JSON/XML response. It's faster than Playwright and reduces visual scraping errors.

**Current Support (variables in `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: list `https://{company}.bamboohr.com/careers/list`; job detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Parsing convention by provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` with `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; build public URL if not in payload)
- `bamboohr`: list `result[]` → `jobOpeningName`, `id`; build detail URL `https://{company}.bamboohr.com/careers/{id}/detail`; to read full JD, GET detail and use `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: root array `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (per tenant) → `title`, `externalPath` or URL built from host

### Level 3 — WebSearch queries (BROAD DISCOVERY)

The `search_queries` with `site:` filters cover portals across the board (all Ashby, all Greenhouse, etc.). Useful for discovering NEW companies not yet in `tracked_companies`, but results may be outdated.

**Key advantage:** Discovers opportunities beyond tracked companies.
**Key limitation:** WebSearch results are cached (potentially 1-4 weeks old). Liveness verification is REQUIRED before adding to pipeline.

## Workflow

1. **Read configuration**: `portals.yml`
2. **Read history**: `data/scan-history.tsv` → URLs already seen
3. **Read dedup sources**: `data/applications.md` + `data/pipeline.md`

4. **STEP 4: Level 2 — ATS APIs / feeds (REQUIRED — EXECUTE FIRST)** (parallel):
   
   For each company in `tracked_companies` with `api:` defined and `enabled: true`:
   a. WebFetch from the API/feed URL
   b. If `api_provider` is defined, use its parser; if not defined, infer by domain (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`)
   c. For **Ashby**, send POST with:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - GraphQL query of `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. For **BambooHR**, the list only brings basic metadata. For each relevant item, read `id`, GET to `https://{company}.bamboohr.com/careers/{id}/detail`, and extract full JD from `result.jobOpening`. Use `jobOpeningShareUrl` as public URL if available; if not, use the detail URL.
   e. For **Workday**, send POST JSON with at least `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` and paginate by `offset` until results exhausted
   f. For each job extract and normalize: `{title, url, company, posted_date}`
   g. Accumulate in candidate list

5. **STEP 5: Level 3 — WebSearch queries (REQUIRED — execute after or parallel to Level 2)**:
   
   For each query in `search_queries` with `enabled: true`:
   a. Execute WebSearch with the defined `query`
   b. From each result extract: `{title, url, company}`
      - **title**: from result title (before " @ " or " | ")
      - **url**: result URL
      - **company**: after " @ " in title, or extract from domain/path
   c. Accumulate in candidate list (dedup with Level 2 results)

6. **Filter by title** using `title_filter` from `portals.yml`:
   - At least 1 keyword from `positive` must appear in title (case-insensitive)
   - 0 keywords from `negative` must appear
   - `seniority_boost` keywords give priority but are not required

7. **Deduplicate** against 3 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → normalized company + role already evaluated
   - `pipeline.md` → exact URL already pending or processed

7.5. **Verify liveness of WebSearch results (Level 3)** — BEFORE adding to pipeline:

   WebSearch results can be outdated (Google caches results for weeks or months). To avoid evaluating expired jobs, verify each new URL from Level 3 with Playwright. Level 2 APIs are inherently real-time and don't require this verification.

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
   e. If active: proceed to step 8

   **Don't interrupt entire scan if a URL fails.** If `browser_navigate` errors (timeout, 403, etc.), mark as `skipped_expired` and continue to next.

8. **Strict title validation** (BEFORE adding to pipeline):
   
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

9. **For each job that passes ALL filters** (title + seniority + age + experience + dedup + validation):
   a. Add to `pipeline.md` "Pending" section: `- [ ] {posted_date} | {url} | {company} | {title}`
   b. Record in `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`
   
   **Note**: `{posted_date}` (YYYY-MM-DD) comes from each portal's API (Greenhouse `created_at`, Ashby `publishedDate`, Lever `createdAt`). For WebSearch results, use today's date as posted_date is typically unavailable.

10. **Jobs filtered by title (portals.yml)**: record in `scan-history.tsv` with status `skipped_title`
11. **Jobs failing strict validation (seniority keywords)**: record with status `skipped_title_validation`
12. **Duplicate jobs**: record with status `skipped_dup`
13. **Expired jobs (Level 3)**: record with status `skipped_expired`

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
https://...	2026-02-10	Ashby API	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	WebSearch — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Output Summary

```
Portal Scan (API + WebSearch) — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
API queries executed: N (Level 2)
WebSearch queries executed: N (Level 3)
Jobs found: N total
Filtered by title (portals.yml): N removed
Title validation (seniority check): N rejected
Duplicates: N (already evaluated or in pipeline)
Expired discarded: N (dead links, Level 3)
New added to pipeline.md: N

  + {company} | {title} | {query_name}
  ...

→ Run /career-ops pipeline to evaluate the new jobs.
```

## ENFORCEMENT: Levels 2 + 3 Required

**If you are an agent executing this mode:**

1. **Do NOT skip Level 2.** API extraction is required.
2. **Do NOT skip Level 3.** WebSearch discovery is required.
3. **This mode intentionally skips Level 1 (Playwright).** Use `/career-ops scan tracked` or `/career-ops scan` if you need deep scraping of tracked companies.

**Expected output from scan execution:**
- Level 2 results: N jobs from M companies (APIs)
- Level 3 results: N jobs from M companies (WebSearch)
- Total: X new jobs added to pipeline after filtering/dedup/liveness check
- Failed queries: list with reason
