---
name: career-ops
description: AI job search command center -- evaluate jobs, generate CVs, scan portals, track applications
user_invocable: true
args: mode
argument-hint: "[run | scan [discovery|referral|all] | enrich [discovery|referral] | score [discovery|referral] | pdf [queue|id <num>] | tracker | apply | prep | oferta | ofertas | contacto | deep | training | project | batch | patterns | followup | interview-prep | update]"
---

# career-ops -- Router

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `run` | `run` (scan -> enrich -> score; default `discovery`) |
| `run referral` | `run` (scan -> enrich -> score; referral queue) |
| `run all` | `run` (scan all sources -> enrich discovery -> score discovery) |
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
| `scan all` | `scan` (all sources: Playwright + APIs + WebSearch) |
| `scan referral` | `scan-referral` (Playwright + APIs + conditional WebSearch for referral companies) |
| `scan discovery` | `scan-discovery` (WebSearch discovery queries only) |
| `enrich` | `enrich` (tag extraction + JD cache enrichment for `data/pipeline.md`) |
| `enrich referral` | `enrich` (same mode with referral scope for `data/pipeline-referral.md`) |
| `enrich discovery` | `enrich` (alias of enrich discovery queue) |
| `score all` | `score-pipeline` (`--discovery` alias for streamlined UX) |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |
| `interview-prep` | `interview-prep` |
| `prep` | `interview-prep` (short alias) |

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
  /career-ops {JD}                → AUTO-PIPELINE: evaluate + report + PDF + tracker
  /career-ops run [referral|all] → End-to-end pipeline: scan -> enrich -> score
  /career-ops scan [discovery|referral|all]   → Source ingestion
  /career-ops enrich [discovery|referral]     → Queue enrichment
  /career-ops score [discovery|referral]      → Queue scoring
  /career-ops pdf [queue|id N]    → PDF generation workflows
  /career-ops tracker              → Application status overview
  /career-ops apply                → Live application assistant
  /career-ops prep                 → Interview prep report (alias: interview-prep)
  /career-ops oferta | ofertas | contacto | deep | training | project | batch | patterns | followup

  Compatibility aliases kept: pipeline, score pipeline*, score legacy*, scan discovery/referral, enrich referral, interview-prep

Inbox: scan discovery/all writes to data/pipeline.md → run /career-ops score discovery
Inbox: scan referral writes to data/pipeline-referral.md → run /career-ops score referral
Or paste a JD directly to run the full pipeline.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Scan modes — run directly, no subagent:

For `run`, `scan`, `scan-single-url`, `scan-referral`, `scan-discovery`, `enrich`, and `score-pipeline`, **do not launch a subagent**. Run the pre-built script directly and report the terminal output to the user.

| Mode | Command |
|------|---------|
| `scan-single-url <url>` | `node scan-single-url.mjs <url>` |
| `scan` | `node scan-with-instrumentation.mjs` |
| `scan referral` | `node scan-with-instrumentation.mjs --referral` |
| `scan discovery` | `node scan-with-instrumentation.mjs --skip-level1 --skip-level2` |
| `enrich` | `node enrich-pipeline.mjs` |
| `enrich referral` | `node enrich-pipeline.mjs --referral` |
| `score` | `node score-pipeline-wrapper.mjs --referral` (primary scorer, default referral) |
| `score referral` | `node score-pipeline-wrapper.mjs --referral` |
| `score discovery` | `node score-pipeline-wrapper.mjs --discovery` |
| `run` | `node scan-with-instrumentation.mjs --skip-level1 --skip-level2 ; node enrich-pipeline.mjs ; node score-pipeline-wrapper.mjs --discovery` |
| `run referral` | `node scan-with-instrumentation.mjs --referral ; node enrich-pipeline.mjs --referral ; node score-pipeline-wrapper.mjs --referral` |
| `run all` | `node scan-with-instrumentation.mjs ; node enrich-pipeline.mjs ; node score-pipeline-wrapper.mjs --discovery` |
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
