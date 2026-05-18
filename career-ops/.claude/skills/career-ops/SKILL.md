---
name: career-ops
description: AI job search command center -- evaluate jobs, generate CVs, scan portals, track applications
user_invocable: true
args: mode
argument-hint: "[scan | scan referral | scan discovery | score | score referral | score discovery | score legacy referral | score legacy discovery | deep | pdf | pdf queue | pdf id <num> | oferta | ofertas | apply | batch | tracker | contacto | training | project | interview-prep | update]"
---

# career-ops -- Router

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `pdf` | `pdf` |
| `pdf queue` | `pdf` (list tracker IDs ready for PDF generation) |
| `pdf id <num>` | `pdf` (generate PDF from tracker number, no JD re-paste) |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `score` | `score-pipeline` (primary scorer via `batch/score-pipeline.sh`, defaults to referral) |
| `score referral` | `score-pipeline` (primary scorer for `data/pipeline-referral.md`) |
| `score discovery` | `score-pipeline` (primary scorer for `data/pipeline.md`) |
| `score pipeline` | `score-pipeline` (parallel `claude -p` workers via `batch/score-pipeline.sh`) |
| `score pipeline referral` | `score-pipeline` (`--referral` flag) |
| `score pipeline discovery` | `score-pipeline` (`--discovery` flag) |
| `score legacy` | `score-legacy` (deterministic fallback scorer via `score-pipeline.mjs`) |
| `score legacy referral` | `score-legacy` (`--referral` flag) |
| `score legacy discovery` | `score-legacy` (`--discovery` flag) |
| `pipeline` | `score` (legacy alias for `score discovery`) |
| `apply` | `apply` |
| `scan <url>` | `scan-single-url` (auto-detect: API → cost 0, SPA/listing → Playwright) |
| `scan referral <url>` | `scan-single-url` (with referral context) |
| `scan` | `scan` (all sources: Playwright + APIs + WebSearch) |
| `scan referral` | `scan-referral` (Playwright + APIs + conditional WebSearch for referral companies) |
| `scan discovery` | `scan-discovery` (WebSearch discovery queries only) |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |
| `interview-prep` | `interview-prep` |

**URL detection for scan:** If `{{mode}}` starts with `scan` and contains a URL (`https://...`):
- Extract URL and detect type (API, SPA domain, listing, single job)
- Route to `scan-single-url.mjs` with detected URL
- `scan referral <url>` → scan-single-url with referral flag

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `{{mode}}` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-ops -- Command Center

Available commands:
  /career-ops {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker (paste text or URL)
  /career-ops score discovery  → Score CV vs JD for discovery queue (data/pipeline.md)
  /career-ops score referral   → Score CV vs JD for referral queue (data/pipeline-referral.md)
  /career-ops score legacy discovery  → Deterministic fallback scorer for discovery queue
  /career-ops score legacy referral   → Deterministic fallback scorer for referral queue
  /career-ops pipeline         → Legacy alias of score discovery
  /career-ops oferta    → Evaluation only A-F (no auto PDF)
  /career-ops ofertas   → Compare and rank multiple jobs
  /career-ops contacto  → LinkedIn power move: find contacts + draft message
  /career-ops deep      → Deep research prompt about company
  /career-ops pdf       → PDF only, ATS-optimized CV
  /career-ops pdf queue → List tracker IDs ready for PDF generation
  /career-ops pdf id N  → PDF from tracker job number (no JD/URL re-paste)
  /career-ops training  → Evaluate course/cert against North Star
  /career-ops project   → Evaluate portfolio project idea
  /career-ops tracker   → Application status overview
  /career-ops apply     → Live application assistant (reads form + generates answers)
  /career-ops scan            → Scan all sources: Playwright + APIs + WebSearch
  /career-ops scan referral   → Scan referral companies (Playwright + APIs + conditional WebSearch)
  /career-ops scan discovery  → Scan WebSearch discovery queries only
  /career-ops score pipeline           → Parallel claude -p workers: score referral pipeline
  /career-ops score pipeline referral  → Parallel workers: score data/pipeline-referral.md
  /career-ops score pipeline discovery → Parallel workers: score data/pipeline.md
  /career-ops batch     → Batch processing with parallel workers
  /career-ops patterns  → Analyze rejection patterns and improve targeting
  /career-ops followup  → Follow-up cadence tracker: flag overdue, generate drafts
  /career-ops interview-prep → Company + role interview preparation report

Inbox: scan discovery/all writes to data/pipeline.md → run /career-ops score discovery
Inbox: scan referral writes to data/pipeline-referral.md → run /career-ops score referral
Or paste a JD directly to run the full pipeline.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Scan modes — run directly, no subagent:

For `scan`, `scan-single-url`, `scan-referral`, `scan-discovery`, and `score-pipeline`, **do not launch a subagent**. Run the pre-built script directly and report the terminal output to the user.

| Mode | Command |
|------|---------|
| `scan-single-url <url>` | `node scan-single-url.mjs <url>` |
| `scan` | `node scan-with-instrumentation.mjs` |
| `scan referral` | `node scan-with-instrumentation.mjs --referral` |
| `scan discovery` | `node scan-with-instrumentation.mjs --skip-level1 --skip-level2` |
| `score` | `node score-pipeline-wrapper.mjs --referral` (primary scorer, default referral) |
| `score referral` | `node score-pipeline-wrapper.mjs --referral` |
| `score discovery` | `node score-pipeline-wrapper.mjs --discovery` |
| `score pipeline` | `node score-pipeline-wrapper.mjs --referral` |
| `score pipeline referral` | `node score-pipeline-wrapper.mjs --referral` |
| `score pipeline discovery` | `node score-pipeline-wrapper.mjs --discovery` |
| `score legacy` | `node score-pipeline.mjs --referral` |
| `score legacy referral` | `node score-pipeline.mjs --referral` |
| `score legacy discovery` | `node score-pipeline.mjs --discovery` |

Do not read `modes/scan*.md` or `modes/score.md` before running score-pipeline. Do not implement any scoring logic manually. Run the command, wait for it to finish, and show the output.

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `patterns`, `followup`, `interview-prep`

### Modes delegated to subagent:
For `apply` (with Playwright): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.

> **ROUTING AGENT RULE — STRICTLY ENFORCED:**
> When routing to a delegated mode, your **only** job is to read the mode file and forward its contents to the subagent.
> - **DO NOT** edit, simplify, rewrite, or "improve" any `modes/*.md` file.
> - **DO NOT** analyse portals.yml to decide what the mode file "should" say.
> - **DO NOT** emit file edits before or after launching the subagent.
> Mode files are curated specifications. Modifying them during execution corrupts future runs.
