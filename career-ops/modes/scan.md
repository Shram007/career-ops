# Mode: scan — Portal Scanner (Job Discovery)

Scans configured job portals, filters by title relevance, and adds new jobs to the pipeline for later evaluation.

> **Note (v1.5+):** The default scanner (`scan.mjs` / `npm run scan`) is **zero-token** and only queries the public APIs of Greenhouse, Ashby, and Lever directly. The levels with Playwright/WebSearch described below are the **agent** flow (executed by Claude/Codex), not what `scan.mjs` does. If a company doesn't have a Greenhouse/Ashby/Lever API, `scan.mjs` will ignore it; for those cases, the agent must manually complete Level 1 (Playwright) or Level 3 (WebSearch).

## Recommended Execution

Run as a subagent to avoid consuming main context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + specific data]",
    run_in_background=True
)
```

**CRITICAL: ALL 3 LEVELS MUST EXECUTE.** Level 1 (Playwright) is mandatory. Do NOT skip any level or prioritize one over others. All levels are required.

## Configuration

**Pre-step (REQUIRED for both agent flow and CLI flow): refresh rolling `after:` cutoff before reading queries.**

Run one of:

```bash
npm run scan:refresh-after
```

or

```bash
node refresh-search-query-dates.mjs --days 14
```

This updates all `after:YYYY-MM-DD` filters in `portals.yml` to a rolling 14-day window based on the current date. Do this first so Level 3 WebSearch queries always use fresh recency bounds.

**Pre-step (REQUIRED): run Playwright access preflight before Level 1 extraction.**

```bash
npm run playwright:bypass
```

Use `reports/playwright-bypass.tsv` to classify targets:
- `bypassed`: proceed with full Level 1 extraction
- `unclear`: attempt Level 1 extraction, but be ready to fallback
- `blocked`/`failed`: still attempt a quick Level 1 probe once, then fallback to Level 2 API + Level 3 WebSearch if still blocked

This prevents scan failures from stopping coverage when some careers sites trigger anti-bot defenses.

Read `portals.yml` which contains:
- `search_queries`: List of WebSearch queries with `site:` filters per portal (broad discovery)
- `tracked_companies`: Specific companies with `careers_url` for direct navigation
- `title_filter`: Positive/negative/seniority_boost keywords for title filtering

**CLI Flags (zero-token `scan.mjs` only):**
- `--days N`: Filter jobs by age (default: 7 days). Example: `node scan.mjs --days 14`
- `--company NAME`: Scan a single company. Example: `node scan.mjs --company Anthropic`
- `--dry-run`: Preview without writing files

## Discovery Strategy (3 Levels)

### Level 1 — Direct Playwright (PRIMARY — MANDATORY)

**CRITICAL: Level 1 is MANDATORY. Must execute for all companies.** Do NOT skip even if time-consuming.

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

### Level 3 — WebSearch queries (BROAD DISCOVERY)

The `search_queries` with `site:` filters cover portals across the board (all Ashby, all Greenhouse, etc.). Useful for discovering NEW companies not yet in `tracked_companies`, but results may be outdated.

**Execution sequence (ALL THREE MUST RUN):**
1. **Level 1 (MANDATORY)**: Playwright → all `tracked_companies` with `careers_url` → sequential or parallel batches
2. **Level 2 (REQUIRED)**: API → all `tracked_companies` with `api:` → parallel to Level 1 or after Level 1
3. **Level 3 (REQUIRED)**: WebSearch → all `search_queries` with `enabled: true` → parallel or after Levels 1+2

**Levels are NOT optional.** All three MUST execute. Results are mixed and deduplicated at step 6.

**DO NOT SKIP LEVEL 1 UNDER ANY CIRCUMSTANCES.** If an agent says "Level 1 is heavy, skipping it" or "API results are sufficient, no need for Playwright", that is a violation of this spec. Force execution of all 3 levels.

## Workflow

1. **Read configuration**: `portals.yml`
2. **Read history**: `data/scan-history.tsv` → URLs already seen
3. **Read dedup sources**: `data/applications.md` + `data/pipeline.md` + `data/pipeline-referral.md`

4. **STEP 4: Level 1 — Playwright scan (MANDATORY — EXECUTE FIRST)** (parallel in batches of 3-5):
   
   **This step MUST complete before proceeding to Level 2 or Level 3.**
   
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
      - Ensure the company is still covered via Level 2 API (if available) and Level 3 WebSearch
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

6. **STEP 6: Level 3 — WebSearch queries (REQUIRED — execute after or parallel to Levels 1+2)**:
   
   For each query in `search_queries` with `enabled: true`:
   a. Execute WebSearch with the defined `query`
   b. From each result extract: `{title, url, company}`
      - **title**: from result title (before " @ " or " | ")
      - **url**: result URL
      - **company**: after " @ " in title, or extract from domain/path
   c. Accumulate in candidate list (dedup with Level 1+2 results)

6. **Filter by title** using `title_filter` from `portals.yml`:
   - At least 1 keyword from `positive` must appear in title (case-insensitive)
   - 0 keywords from `negative` must appear
   - `seniority_boost` keywords give priority but are not required

7. **Deduplicate** against 4 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → normalized company + role already evaluated
   - `pipeline.md` → exact URL already pending or processed in discovery queue
   - `pipeline-referral.md` → exact URL already pending or processed in referral queue

7.5. **Verify liveness of WebSearch results (Level 3)** — BEFORE adding to pipeline:

   WebSearch results can be outdated (Google caches results for weeks or months). To avoid evaluating expired jobs, verify each new URL from Level 3 with Playwright. Levels 1 and 2 are inherently real-time and don't require this verification.

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
   
   **Note**: `{posted_date}` (YYYY-MM-DD) comes from each portal's API (Greenhouse `created_at`, Ashby `publishedDate`, Lever `createdAt`). This allows filtering by age and avoiding expired jobs.

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

## Private URLs

If a non-publicly accessible URL is found:
1. Save the JD in `jds/{company}-{role-slug}.md`
2. Add to pipeline.md as: `- [ ] local:jds/{company}-{role-slug}.md | {company} | {title}`

## Scan History

`data/scan-history.tsv` tracks ALL URLs seen:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Output Summary

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Queries executed: N
Jobs found: N total
Filtered by title (portals.yml): N removed
Title validation (seniority check): N rejected
Duplicates: N (already evaluated or in pipeline)
Expired discarded: N (dead links, Level 3)
New added to pipeline.md: N

  + {company} | {title} | {query_name}
  ...

→ Run /career-ops score discovery to score the new jobs.
```

## Managing careers_url

Each company in `tracked_companies` must have `careers_url` — the direct URL to its jobs page. This avoids looking it up each time.

---

## ENFORCEMENT: All 3 Levels Required

**If you are an agent executing this mode:**

1. **Do NOT skip Level 1.** Playwright careers page scraping is mandatory.
2. **Do NOT prioritize Level 2 over Level 1.** APIs are complementary, not primary.
3. **Do NOT skip Level 3.** WebSearch discovers new companies.
4. **Do NOT claim "Level 1 is too heavy" or "APIs already covered everything."** All 3 levels are required.

**Expected output from scan execution:**
- Level 1 results: N jobs from M companies (Playwright)
- Level 2 results: N jobs from M companies (APIs)
- Level 3 results: N jobs from M companies (WebSearch)
- Total: X new jobs added to pipeline after filtering/dedup
- Failed companies/queries: list with reason

**If you execute a scan and only report Level 2 results, the scan is INCOMPLETE and should be re-run with all 3 levels.**

**RULE: Always use the company's corporate URL; fall back to ATS endpoint only if no corporate page exists.**

The `careers_url` should point to the company's own jobs page whenever available. Many companies use Workday, Greenhouse, or Lever underneath, but expose job IDs only through their corporate domain. Using the direct ATS URL when a corporate page exists can cause false 410 errors because job IDs don't match.

| ✅ Correct (corporate) | ❌ Incorrect as first choice (ATS direct) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: if you only have the direct ATS URL, first navigate to the company's website and locate their corporate jobs page. Use the direct ATS URL only if the company has no corporate jobs page.

**Known patterns by platform:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** Company's own URL (e.g., `https://openai.com/careers`)

**API/feed patterns by platform:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**If `careers_url` doesn't exist** for a company:
1. Try the pattern for its known platform
2. If it fails, do a quick WebSearch: `"{company}" careers jobs`
3. Navigate with Playwright to confirm it works
4. **Save the found URL in portals.yml** for future scans

**If `careers_url` returns 404 or redirect:**
1. Note in output summary
2. Try scan_query as fallback
3. Mark for manual update

## Maintaining portals.yml

- **ALWAYS save `careers_url`** when adding a new company
- Add new queries as you discover portals or interesting roles
- Disable queries with `enabled: false` if they generate too much noise
- Adjust filter keywords as target roles evolve
- Add companies to `tracked_companies` when you want to follow them closely
- Check `careers_url` periodically — companies change ATS platforms
