---
name: career-ops
description: AI job search command center -- evaluate jobs, generate CVs, scan portals, track applications
user_invocable: true
args: mode
argument-hint: "[scan | scan referral | scan discovery | score | score referral | score discovery | deep | pdf | pdf queue | pdf id <num> | oferta | ofertas | apply | batch | tracker | contacto | training | project | interview-prep | update]"
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
| `score` | `score` |
| `score referral` | `score` (reads only `data/pipeline-referral.md`) |
| `score discovery` | `score` (reads only `data/pipeline.md`) |
| `pipeline` | `score` (legacy alias for `score discovery`) |
| `apply` | `apply` |
| `scan` | `scan` (all sources: Playwright + APIs + WebSearch) |
| `scan referral` | `scan-referral` (Playwright + APIs for referral companies only) |
| `scan discovery` | `scan-discovery` (WebSearch discovery queries only) |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |
| `interview-prep` | `interview-prep` |

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
  /career-ops scan referral   → Scan referral companies only (Playwright + APIs)
  /career-ops scan discovery  → Scan WebSearch discovery queries only
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

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `score`, `scan`, `scan-referral`, `scan-discovery`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `patterns`, `followup`, `interview-prep`

### Modes delegated to subagent:
For `scan`, `scan-referral`, `scan-discovery`, `apply` (with Playwright), and `score` (3+ URLs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.
