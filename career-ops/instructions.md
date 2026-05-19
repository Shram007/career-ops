This is a design alignment briefing for the career-ops pipeline. Read and internalize before doing any score, scan, or dashboard work.

## Data ownership

- pipeline.md and pipeline-referral.md are temporary queues. Entries flow Pending → Processed and are never the source of truth.
- applications.md is the authoritative tracker. All graduated entries live here permanently.
- The Go dashboard is a read-only view + action trigger. It calls scripts; it never writes files directly.

## Three-stage pipeline (canonical)

Stage 1 — scan:      Playwright/API portal discovery → appends to pipeline.md or pipeline-referral.md
Stage 2 — score:     Processes pending queue entries → scores → appends advances to applications.md
Stage 3 — PDF:       pdf-from-id.mjs generates output for specific tracker entries

Commands:
  /career-ops scan [referral]
  /career-ops score [discovery|referral]
  /career-ops pdf [--id N | --url U]
  /career-ops oferta    ← bypasses all stages, full A-G report immediately

## Score mode — the rule that must never break

Score is ground truth. Tags are explanatory only. They do NOT veto decisions.

- score >= 3.0 → decision is always "advance", entry goes to applications.md
- score < 3.0  → decision is always "hold"
- A tag like domain:backend or fit:partial NEVER overrides a numeric score
- This rule applies to score mode AND oferta mode

## Scope filtering — three layers, all required

1. Scan time: enrich-pipeline.mjs tags entries with loc:Sydney-AU, exp:7yr. Score mode skips fetch for pre-tagged out-of-scope entries.
2. Score time: after fetching JD, hard location block checks for EMEA/non-US keywords. Seniority block checks for Staff/Principal/Director/VP in title. Both abort before scoring.
3. Dashboard i-key submission: score-url.mjs runs the same checks inline before writing anything to any file.

Location policy: candidate is in San Jose, CA, USA. Target market is US + global remote only. EMEA, UK, India, APAC, Canada (onsite/hybrid), LATAM, UAE = hard block → hold | location:{region}.

Seniority policy: Staff, Principal, Director, VP, Head of = hard block → hold | seniority:overleveled.

## Dashboard i-key routing (URL input)

Listing URL (e.g. greenhouse.io/arizeai, ashbyhq.com/company):
  → scan-playwright.mjs --url <url>
  → discovers job links, adds to pipeline.md
  → does NOT score

Specific job URL (e.g. greenhouse.io/arizeai/jobs/12345, apply.careers.microsoft.com/careers/job/ID):
  → score-url.mjs --url <url>   ← THIS SCRIPT DOES NOT EXIST YET, needs to be created
  → scrape JD → scope check → gemini-eval → if score >= 3.0 append to applications.md → show result summary

Unknown/non-job URL:
  → score-url.mjs detects it is not a job posting → abort with 1-2 line explanation

## Dedup logic for score-url.mjs

Check in this order before doing anything:
1. Exact URL match in applications.md + pipeline.md + pipeline-referral.md → abort "already tracked as #N"
2. Same company + role title (case-insensitive fuzzy) → warn "possible duplicate of #N" and show existing entry, let user confirm

## Dashboard x-key (re-eval)

re-eval.mjs --id N --update-status already handles this correctly:
- Finds entry #N in applications.md
- Scrapes original URL
- Runs Gemini eval
- Updates score + sets status to Evaluated in place
- Never creates a new entry, never risks duplicate

## What needs to be built

The only unimplemented piece is score-url.mjs. Everything else described above is already working.

score-url.mjs should:
- Accept --url <url>
- Run dedup check against all three data files
- Detect URL type (listing vs specific job) and route accordingly
- For specific job: Playwright scrape → scope filter (location + seniority) → gemini-eval.mjs --file → parse score → if >= 3.0 append to applications.md with status Scored
- For listing: print "this is a listing URL, use scan-playwright.mjs --url instead" and exit 1
- For non-job: print 1-2 line summary of what the URL actually is and exit 1
- Print summary line: "Company | Role | Score/5 | decision | Added as #N" or "Not added: reason"