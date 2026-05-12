# Mode: scan-tracked — Scan Tracked Companies Only

Scans **tracked companies only** (from `portals.yml` `tracked_companies` section) using direct Playwright + API extraction. This provides deep coverage of companies you're actively following without broad-sweep WebSearch discovery.

**Speed/Scope Tradeoff:** Faster than full scan (no WebSearch), narrower discovery (tracked companies only).

> **Note:** This mode executes Levels 1+2 (Playwright + APIs). It **skips Level 3 (WebSearch)** for broad discovery. Use `/career-ops scan api` for WebSearch + API discovery, or `/career-ops scan` for all three levels combined.

## Recommended Execution

Run as a subagent to avoid consuming main context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + specific data]",
    run_in_background=True
)
```

**CRITICAL: LEVELS 1 + 2 MUST EXECUTE.** Level 1 (Playwright) is mandatory. Do NOT skip either level.

## Configuration

**Pre-step (REQUIRED): run Playwright access preflight before Level 1 extraction.**

```bash
npm run playwright:bypass
```

Use `reports/playwright-bypass.tsv` to classify targets:
- `bypassed`: proceed with full Level 1 extraction
- `unclear`: attempt Level 1 extraction, but be ready to fallback
- `blocked`/`failed`: still attempt a quick Level 1 probe once, then fallback to Level 2 API if still blocked

This prevents scan failures from stopping coverage when some careers sites trigger anti-bot defenses.

Read `portals.yml` which contains:
- `tracked_companies`: Specific companies with `careers_url` for direct navigation
- `title_filter`: Positive/negative/seniority_boost keywords for title filtering

## Discovery Strategy (Levels 1 + 2 Only)

### Level 1 — Direct Playwright (PRIMARY — MANDATORY)

**CRITICAL: Level 1 is MANDATORY. Must execute for all tracked companies.** Do NOT skip even if time-consuming.

**For each company in `tracked_companies`:** Navigate to its `careers_url` with Playwright (`browser_navigate` + `browser_snapshot`), read ALL visible job listings, and extract title + URL from each. This is the most reliable method because:
- Sees the page in real-time (not cached Google results)
- Works with SPAs (Ashby, Lever, Workday)
- Detects new jobs instantly
- Doesn't depend on Google indexing
- **Only source of truth for companies with custom careers sites**

**Each company MUST have `careers_url` in portals.yml.** If it doesn't, find it once, save it, and use it in future scans.

**Failure modes handled:**
- If `careers_url` 404/timeout: use `scan_query` as fallback, but try Playwright first
- If page is JS-heavy: Playwright waits for `networkidle` (content fully loaded)
- If pagination: navigate all pages, extract all jobs

### Level 2 — ATS APIs / Feeds (COMPLEMENTARY)

For companies with public API or structured feed, use the JSON/XML response as a quick complement to Level 1. It's faster than Playwright and reduces visual scraping errors.

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

### Level 3 (SKIPPED in this mode)

WebSearch discovery is intentionally skipped. Use `/career-ops scan api` for WebSearch + API discovery, or `/career-ops scan` for comprehensive scanning with all three levels.

## Workflow

1. **Read configuration**: `portals.yml`
2. **Read history**: `data/scan-history.tsv` → URLs already seen
3. **Read dedup sources**: `data/applications.md` + `data/pipeline.md`

4. **STEP 4: Level 1 — Playwright scan (MANDATORY — EXECUTE FIRST)** (parallel in batches of 3-5):
   
   **This step MUST complete before proceeding to Level 2.**
   
   For EACH company in `tracked_companies` with `enabled: true` AND `careers_url` defined:
   a. `browser_navigate` to the `careers_url`
   b. `browser_snapshot` to read ALL visible job listings (wait for networkidle)
   c. If the page has filters/departments, navigate relevant sections (Engineering, AI/ML, etc.)
   d. For each job listing extract: `{title, url, company, posted_date if available}`
   e. If the page paginates results, navigate additional pages — extract from ALL pages
   f. If pagination limit reached, note partial results and continue
   g. Accumulate in candidate list
   h. If `careers_url` fails (404, timeout, 403, anti-bot challenge page):
      - Log the failure
      - Attempt fallback: use `scan_query` from portals.yml if available
      - If the site remains blocked after one retry, mark company as `playwright_blocked` for this run and continue (do not stop scan)
      - Ensure the company is still covered via Level 2 API (if available)
      - Note URL issue for manual update
   i. **Do NOT skip a company because Level 1 takes time.** Time cost is acceptable for comprehensive coverage.
   j. **Report Level 1 results**: How many jobs extracted from each company, any failures

5. **STEP 5: Level 2 — ATS APIs / feeds (REQUIRED — execute after or parallel to Level 1)** (parallel):
   
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
   g. Accumulate in candidate list (dedup with Level 1 results)

6. **Filter by title** using `title_filter` from `portals.yml`:
   - At least 1 keyword from `positive` must appear in title (case-insensitive)
   - 0 keywords from `negative` must appear
   - `seniority_boost` keywords give priority but are not required

7. **Deduplicate** against 3 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → normalized company + role already evaluated
   - `pipeline.md` → exact URL already pending or processed

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
   
   **Note**: `{posted_date}` (YYYY-MM-DD) comes from each portal's API (Greenhouse `created_at`, Ashby `publishedDate`, Lever `createdAt`). This allows filtering by age and avoiding expired jobs.

10. **Jobs filtered by title (portals.yml)**: record in `scan-history.tsv` with status `skipped_title`
11. **Jobs failing strict validation (seniority keywords)**: record with status `skipped_title_validation`
12. **Duplicate jobs**: record with status `skipped_dup`

## Scan History

`data/scan-history.tsv` tracks ALL URLs seen:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
```

## Output Summary

```
Portal Scan (Tracked Companies) — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Companies scanned: N (tracked only)
Jobs found: N total
Filtered by title (portals.yml): N removed
Title validation (seniority check): N rejected
Duplicates: N (already evaluated or in pipeline)
New added to pipeline.md: N

  + {company} | {title} | {source}
  ...

→ Run /career-ops pipeline to evaluate the new jobs.
```

## ENFORCEMENT: Levels 1 + 2 Required

**If you are an agent executing this mode:**

1. **Do NOT skip Level 1.** Playwright careers page scraping is mandatory.
2. **Do NOT prioritize Level 2 over Level 1.** APIs are complementary, not primary.
3. **This mode intentionally skips Level 3 (WebSearch).** Use `/career-ops scan api` or `/career-ops scan` if you need broad discovery.

**Expected output from scan execution:**
- Level 1 results: N jobs from M companies (Playwright)
- Level 2 results: N jobs from M companies (APIs)
- Total: X new jobs added to pipeline after filtering/dedup
- Failed companies: list with reason

**RULE: Always use the company's corporate URL; fall back to ATS endpoint only if no corporate page exists.**

The `careers_url` should point to the company's own jobs page whenever available. Many companies use Workday, Greenhouse, or Lever underneath, but expose job IDs only through their corporate domain. Using the direct ATS URL when a corporate page exists can cause false 410 errors because job IDs don't match.

| ✅ Correct (corporate) | ❌ Incorrect as first choice (ATS direct) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: if you only have the direct ATS URL, first navigate to the company's website and locate their corporate jobs page. Use the direct ATS URL only if the company has no corporate jobs page.

## Managing careers_url

Each company in `tracked_companies` must have `careers_url` — the direct URL to its jobs page. This avoids looking it up each time.
