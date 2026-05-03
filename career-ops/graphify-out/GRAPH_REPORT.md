# Graph Report - .  (2026-04-30)

## Corpus Check
- Large corpus: 130 files · ~1,317,878 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 558 nodes · 917 edges · 28 communities detected
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 88 edges (avg confidence: 0.82)
- Token cost: 4,800 input · 1,800 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Batch Processing & Agents|Batch Processing & Agents]]
- [[_COMMUNITY_User Profile & Core Concepts|User Profile & Core Concepts]]
- [[_COMMUNITY_Pipeline & Outreach Modes|Pipeline & Outreach Modes]]
- [[_COMMUNITY_Dashboard Data Layer|Dashboard Data Layer]]
- [[_COMMUNITY_Batch Infrastructure|Batch Infrastructure]]
- [[_COMMUNITY_Dashboard App & Tests|Dashboard App & Tests]]
- [[_COMMUNITY_Examples & Apply Workflow|Examples & Apply Workflow]]
- [[_COMMUNITY_CV Template & Portal Config|CV Template & Portal Config]]
- [[_COMMUNITY_Applications Tracker|Applications Tracker]]
- [[_COMMUNITY_Dashboard Report Viewer|Dashboard Report Viewer]]
- [[_COMMUNITY_Dashboard Progress UI|Dashboard Progress UI]]
- [[_COMMUNITY_Follow-up Cadence Engine|Follow-up Cadence Engine]]
- [[_COMMUNITY_Tracker Merge Script|Tracker Merge Script]]
- [[_COMMUNITY_System Health Check|System Health Check]]
- [[_COMMUNITY_Portal Scanner Engine|Portal Scanner Engine]]
- [[_COMMUNITY_Update System|Update System]]
- [[_COMMUNITY_LaTeX CV Generation|LaTeX CV Generation]]
- [[_COMMUNITY_Pattern Analysis|Pattern Analysis]]
- [[_COMMUNITY_Career Data Models|Career Data Models]]
- [[_COMMUNITY_Dedup Tracker|Dedup Tracker]]
- [[_COMMUNITY_Roadmap & Vision|Roadmap & Vision]]
- [[_COMMUNITY_Project Evaluation Mode|Project Evaluation Mode]]
- [[_COMMUNITY_Training Evaluation Mode|Training Evaluation Mode]]
- [[_COMMUNITY_Marketing Assets|Marketing Assets]]
- [[_COMMUNITY_Contributors|Contributors]]
- [[_COMMUNITY_Security Policy|Security Policy]]
- [[_COMMUNITY_OpenCode CLI|OpenCode CLI]]
- [[_COMMUNITY_Demo Animation|Demo Animation]]

## God Nodes (most connected - your core abstractions)
1. `Career-Ops System (CLAUDE.md)` - 36 edges
2. `PipelineModel` - 30 edges
3. `Article & Project Digest (article-digest.md)` - 14 edges
4. `applications.md — Application Tracker` - 14 edges
5. `Offer Evaluation Mode (A-G Blocks)` - 14 edges
6. `Portuguese BR Shared Context (_shared.md)` - 14 edges
7. `main()` - 12 edges
8. `readFile()` - 12 edges
9. `ProgressModel` - 12 edges
10. `ViewerModel` - 12 edges

## Surprising Connections (you probably didn't know these)
- `Block G — Posting Legitimacy Assessment` --semantically_similar_to--> `check-liveness.mjs — Job Posting Liveness Checker`  [INFERRED] [semantically similar]
  batch/batch-prompt.md → docs/SCRIPTS.md
- `main()` --calls--> `readFile()`  [INFERRED]
  generate-latex.mjs → test-all.mjs
- `Codex Agent Instructions (AGENTS.md)` --semantically_similar_to--> `Gemini CLI Instructions (GEMINI.md)`  [INFERRED] [semantically similar]
  AGENTS.md → GEMINI.md
- `Human-in-the-Loop Principle` --semantically_similar_to--> `Ethical Use Policy`  [INFERRED] [semantically similar]
  CLAUDE.md → LEGAL_DISCLAIMER.md
- `Keyword Injection Strategy — Ethical ATS Optimization` --semantically_similar_to--> `Unicode Normalization — ATS Compatibility Pass`  [INFERRED] [semantically similar]
  batch/batch-prompt.md → examples/ats-normalization-test.md

## Hyperedges (group relationships)
- **Claude Code, Gemini CLI, OpenCode, and Codex all share the same modes/*.md evaluation logic** — claude_code_cli, gemini_cli, opencode_cli, codex_cli, mode_shared, mode_oferta [EXTRACTED 0.95]
- **User Layer files (cv.md, profile.yml, _profile.md, portals.yml) are jointly protected by the Data Contract and must never be auto-updated** — data_contract_md, cv_md_user_cv, profile_yml, mode_profile, portals_yml [EXTRACTED 1.00]
- **Evaluation → batch TSV addition → merge-tracker → applications.md form the pipeline integrity chain** — mode_oferta, batch_tracker_additions, merge_tracker_mjs, applications_md, verify_pipeline_mjs [EXTRACTED 0.92]
- **Batch Worker Full Output Pipeline: Report + PDF + Tracker TSV** — concept_batch_worker, concept_ag_evaluation, concept_ats_pdf_generation, concept_tsv_tracker_line [EXTRACTED 1.00]
- **Pipeline Integrity: Merge + Verify + Dedup + Normalize** — concept_merge_tracker, concept_verify_pipeline, concept_dedup_tracker, concept_normalize_statuses [EXTRACTED 1.00]
- **Evaluation Context Sources: CV + Article Digest + Profile** — concept_block_b, examples_article_digest_example, config_profile_yml [EXTRACTED 0.95]
- **CV Generation Pipeline (pdf_mode + latex_mode share template, keyword injection, and ATS rules)** — pdf_mode, latex_mode, pdf_keyword_injection [INFERRED 0.85]
- **Offer Evaluation A-G Blocks (oferta_mode orchestrates all 7 assessment blocks)** — oferta_mode, oferta_block_b, oferta_block_g [EXTRACTED 1.00]
- **Discovery-to-Pipeline Flow (scan discovers, pipeline processes, tracker records)** — scan_mode, pipeline_mode, tracker_applications_file [INFERRED 0.90]
- **All Localized Offer Evaluation Modes Implementing Shared oferta.md Pattern** — de_angebot, fr_offre, ja_kyujin, pt_oferta, ru_oferta [EXTRACTED 1.00]
- **All Localized Pipeline Modes Implementing Shared pipeline.md Pattern** — de_pipeline, fr_pipeline, ja_pipeline, pt_pipeline, ru_pipeline [EXTRACTED 1.00]
- **Sources of Truth Required Before Every Evaluation (cv.md, article-digest.md, profile.yml, _profile.md)** — cv_md, article_digest_md, config_profile_yml, modes_profile_md [EXTRACTED 1.00]
- **CV Generation Pipeline — Template + Generated HTML + User Identity** — cv_template_html_template, tmp_cv_microsoft_html, tmp_cv_new_html [INFERRED 0.90]
- **Application Pipeline State Machine — canonical states governing tracker lifecycle** — states_yml_canonical_states, states_yml_state_evaluated, states_yml_state_applied, states_yml_state_interview, states_yml_state_offer, states_yml_state_rejected, states_yml_state_discarded, states_yml_state_skip [EXTRACTED 1.00]
- **Documentation Marketing Assets — hero, og-image, vision, roadmap** — docs_hero_banner, docs_og_image, docs_vision_banner, docs_roadmap_phases [INFERRED 0.85]

## Communities

### Community 0 - "Batch Processing & Agents"
Cohesion: 0.03
Nodes (62): Codex Agent Instructions (AGENTS.md), Batch Conductor Chrome Mode, batch-input.tsv (URL List), Batch Processing Mode, Batch Worker Prompt (batch-prompt.md), Batch Runner Script (batch-runner.sh), Batch Standalone Script Mode, batch-state.tsv (Progress Tracker) (+54 more)

### Community 1 - "User Profile & Core Concepts"
Cohesion: 0.06
Nodes (70): Candidate: Shram Kadia, Code of Conduct, 6-Archetype Classification System, Ashby ATS — Job Board Platform, Auto-Pipeline Workflow (evaluate + report + PDF + tracker), Block F — Interview Plan (STAR Stories), Evaluation Blocks A-F Structure, Greenhouse ATS — Job Board Platform (+62 more)

### Community 2 - "Pipeline & Outreach Modes"
Cohesion: 0.04
Nodes (65): Draft Application Answers (Score >= 4.5), JD Extraction Strategy (Auto-Pipeline), Auto-Pipeline Mode, Application Answer Tone Framework (I'm Choosing You), Contact Type Classification (Recruiter/HM/Peer/Interviewer), 3-Sentence LinkedIn Message Framework, Contact Mode (LinkedIn Power Move), DACH Compensation Checks (13. Monatsgehalt, Tarifvertrag, bAV) (+57 more)

### Community 3 - "Dashboard Data Layer"
Cohesion: 0.09
Nodes (14): NormalizeStatus(), StatusPriority(), statusLabel(), truncateRunes(), PipelineClosedMsg, PipelineLoadReportMsg, PipelineModel, PipelineOpenProgressMsg (+6 more)

### Community 4 - "Batch Infrastructure"
Cohesion: 0.09
Nodes (37): batch-input.tsv — Batch Input Offers File, batch-runner.sh — Batch Orchestrator Script, batch-state.tsv — Resumable Processing State, Batch Prompt — Self-Contained Worker Prompt Template, Batch README — Batch Processing Documentation, Batch Tracker Additions (batch/tracker-additions/*.tsv), AGENTS.md — Codex Project Instructions File, ATS-Optimized PDF Generation Pipeline (+29 more)

### Community 5 - "Dashboard App & Tests"
Cohesion: 0.1
Nodes (26): readFile(), appModel, main(), viewState, batchEntry, cleanTableCell(), ComputeMetrics(), ComputeProgressMetrics() (+18 more)

### Community 6 - "Examples & Apply Workflow"
Cohesion: 0.08
Nodes (29): Candidate: Alex Chen (Fictional Single-Track Example), Candidate: Sam Rivera (Fictional Dual-Track Example), A-G Evaluation — 7-Block Offer Scoring System, Apply Mode Workflow — Live Form Filling Assistant, Archetype: Agentic Workflows / Automation, Archetype: AI Platform / LLMOps Engineer, Archetype: Technical AI Product Manager, Archetype Detection — Role Classification Into 6 Types (+21 more)

### Community 7 - "CV Template & Portal Config"
Cohesion: 0.1
Nodes (26): CV Template Fonts (Space Grotesk + DM Sans), CV Template ATS-Safe Single-Column Layout, CV Template Placeholders ({{NAME}}, {{SUMMARY_TEXT}}, etc.), CV HTML Template (cv-template.html), 3-Level Scan Strategy (Playwright / Greenhouse API / WebSearch), Portal Title Filter (positive/negative/seniority_boost keywords), Portal Scanner Example Configuration (portals.example.yml), Russian Market Archetypes (+18 more)

### Community 8 - "Applications Tracker"
Cohesion: 0.14
Nodes (24): Application Tracker (data/applications.md), Article & Project Digest (article-digest.md), Target Company: Anthropic, Target Company: ElevenLabs, Target Company: LangChain, Target Company: OpenAI, User CV (cv.md), Data Contract (+16 more)

### Community 9 - "Dashboard Report Viewer"
Cohesion: 0.22
Nodes (6): computeColumnWidths(), isTableLine(), isTableSeparator(), parseTableCells(), ViewerClosedMsg, ViewerModel

### Community 10 - "Dashboard Progress UI"
Cohesion: 0.2
Nodes (3): NewProgressModel(), ProgressClosedMsg, ProgressModel

### Community 11 - "Follow-up Cadence Engine"
Cohesion: 0.27
Nodes (12): addDays(), analyze(), computeNextFollowupDate(), computeUrgency(), daysBetween(), extractContacts(), normalizeStatus(), parseDate() (+4 more)

### Community 12 - "Tracker Merge Script"
Cohesion: 0.15
Nodes (4): parseTsvContent(), validateStatus(), Pipeline Integrity Rules, Canonical Status Definitions (states.yml)

### Community 13 - "System Health Check"
Cohesion: 0.29
Nodes (12): checkAutoDir(), checkCv(), checkDependencies(), checkFonts(), checkNodeVersion(), checkPlaywright(), checkPortals(), checkProfile() (+4 more)

### Community 14 - "Portal Scanner Engine"
Cohesion: 0.23
Nodes (7): appendToPipeline(), appendToScanHistory(), buildTitleFilter(), loadSeenCompanyRoles(), loadSeenUrls(), main(), parallelFetch()

### Community 15 - "Update System"
Cohesion: 0.4
Nodes (9): addPaths(), apply(), check(), compareVersions(), git(), gitStatusEntries(), localVersion(), revertPaths() (+1 more)

### Community 16 - "LaTeX CV Generation"
Cohesion: 0.22
Nodes (11): LaTeX ATS Compatibility Rules, LaTeX Content Escaping Rules, generate-latex.mjs Script, LaTeX/Overleaf CV Export Mode, templates/cv-template.tex (LaTeX Template), PDF ATS Rules (Single-column, Standard Headers), Canva CV Generation Workflow (Optional), generate-pdf.mjs Script (+3 more)

### Community 17 - "Pattern Analysis"
Cohesion: 0.27
Nodes (5): analyze(), classifyOutcome(), extractBlockerType(), normalizeStatus(), parseTracker()

### Community 18 - "Career Data Models"
Cohesion: 0.29
Nodes (6): CareerApplication, FunnelStage, PipelineMetrics, ProgressMetrics, ScoreBucket, WeekActivity

### Community 19 - "Dedup Tracker"
Cohesion: 0.4
Nodes (2): normalizeRole(), roleMatch()

### Community 20 - "Roadmap & Vision"
Cohesion: 0.4
Nodes (5): Roadmap Phases Diagram (NOW / NEXT / LATER), Vision Banner Image (Free for everyone — diverse people walking through open door), Roadmap Phase: LATER — Desktop App for Everyone, Roadmap Phase: NEXT — Free Local AI, Roadmap Phase: NOW — Community and Foundation

### Community 22 - "Project Evaluation Mode"
Cohesion: 1.0
Nodes (2): Portfolio Project Evaluation Mode, Project 6-Dimension Scoring (Signal, Uniqueness, Demo-ability, Metrics, Time-to-MVP, STAR Potential)

### Community 23 - "Training Evaluation Mode"
Cohesion: 1.0
Nodes (2): Training/Certification Evaluation Mode, Training 6-Dimension Evaluation (North Star, Recruiter Signal, Time, Opportunity Cost, Risks, Portfolio Deliverable)

### Community 24 - "Marketing Assets"
Cohesion: 1.0
Nodes (2): Hero Banner Image (You got the job. And it didn't cost you a thing.), Open Graph Image (og-image.jpg) — same design as hero banner

### Community 25 - "Contributors"
Cohesion: 1.0
Nodes (1): Contributors List

### Community 26 - "Security Policy"
Cohesion: 1.0
Nodes (1): Security Policy

### Community 27 - "OpenCode CLI"
Cohesion: 1.0
Nodes (1): OpenCode CLI

### Community 28 - "Demo Animation"
Cohesion: 1.0
Nodes (1): Demo GIF (animated product walkthrough)

## Knowledge Gaps
- **147 isolated node(s):** `viewState`, `batchEntry`, `CareerApplication`, `PipelineMetrics`, `ProgressMetrics` (+142 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Dedup Tracker`** (6 nodes): `normalizeCompany()`, `normalizeRole()`, `parseAppLine()`, `parseScore()`, `roleMatch()`, `dedup-tracker.mjs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Project Evaluation Mode`** (2 nodes): `Portfolio Project Evaluation Mode`, `Project 6-Dimension Scoring (Signal, Uniqueness, Demo-ability, Metrics, Time-to-MVP, STAR Potential)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Training Evaluation Mode`** (2 nodes): `Training/Certification Evaluation Mode`, `Training 6-Dimension Evaluation (North Star, Recruiter Signal, Time, Opportunity Cost, Risks, Portfolio Deliverable)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Marketing Assets`** (2 nodes): `Hero Banner Image (You got the job. And it didn't cost you a thing.)`, `Open Graph Image (og-image.jpg) — same design as hero banner`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Contributors`** (1 nodes): `Contributors List`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Security Policy`** (1 nodes): `Security Policy`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `OpenCode CLI`** (1 nodes): `OpenCode CLI`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Demo Animation`** (1 nodes): `Demo GIF (animated product walkthrough)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Career-Ops System (CLAUDE.md)` connect `Batch Processing & Agents` to `Applications Tracker`, `Follow-up Cadence Engine`, `Tracker Merge Script`, `Portal Scanner Engine`, `Update System`, `Pattern Analysis`?**
  _High betweenness centrality (0.364) - this node is a cross-community bridge._
- **Why does `readFile()` connect `Dashboard App & Tests` to `Batch Processing & Agents`?**
  _High betweenness centrality (0.274) - this node is a cross-community bridge._
- **Why does `generatePDF()` connect `Batch Processing & Agents` to `Dashboard App & Tests`?**
  _High betweenness centrality (0.123) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Offer Evaluation Mode (A-G Blocks)` (e.g. with `German Evaluation Mode (angebot.md)` and `modes/_profile.md (User Customization Layer)`) actually correct?**
  _`Offer Evaluation Mode (A-G Blocks)` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `viewState`, `batchEntry`, `CareerApplication` to the rest of the system?**
  _147 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Batch Processing & Agents` be split into smaller, more focused modules?**
  _Cohesion score 0.03 - nodes in this community are weakly interconnected._
- **Should `User Profile & Core Concepts` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._