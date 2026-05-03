# Mode: auto-pipeline — Full Automatic Pipeline

When user pastes a JD (text or URL) without explicit sub-command, run the ENTIRE pipeline in sequence:

## Step 0 — Extract JD

If input is a **URL** (not pasted JD text), follow this strategy to extract content:

**Priority order:**

1. **Playwright (preferred):** Most job boards (Lever, Ashby, Greenhouse, Workday) are SPAs. Use `browser_navigate` + `browser_snapshot` to render and read JD.
2. **WebFetch (fallback):** For static pages (ZipRecruiter, WeLoveProduct, company career pages).
3. **WebSearch (last resort):** Search role title + company on secondary job boards that index JD in static HTML.

**If no method works:** Ask candidate to paste JD manually or share a screenshot.

**If input is JD text** (not URL): use directly, no fetch needed.

## Step 1 — A-G Evaluation
Execute exactly like `oferta` mode (read `modes/oferta.md` for all blocks A-G + Block G Posting Legitimacy).

## Step 2 — Save Report .md
Save complete evaluation to `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` (see format in `modes/oferta.md`).
Include Block G in the saved report. Add `**Legitimacy:** {tier}` to the report header.

## Step 3 — Generate PDF
Read `config/profile.yml`. Check `cv.output_format`:

- If `"latex"`, execute the full pipeline from `modes/latex.md`
- Otherwise (default), execute the full pipeline from `modes/pdf.md`

## Step 4 — Draft Application Answers (only if score >= 4.5)

If final score is >= 4.5, generate draft answers for application form:

1. **Extract form questions**: Use Playwright to navigate to form and snapshot. If can't extract, use generic questions.
2. **Generate answers** following the tone (see below).
3. **Save in report** as section `## H) Draft Application Answers`.

### Generic questions (use if can't extract from form)

- Why are you interested in this role?
- Why do you want to work at [Company]?
- Tell us about a relevant project or achievement
- What makes you a good fit for this position?
- How did you hear about this role?

### Tone for Form Answers

**Position: "I'm choosing you."** Candidate has options and is choosing this company for concrete reasons.

**Tone rules:**
- **Confident without arrogance**: "I've spent the past year building production AI agent systems — your role is where I want to apply that experience next"
- **Selective without snobbery**: "I've been intentional about finding a team where I can contribute meaningfully from day one"
- **Specific and concrete**: Always reference something REAL from JD or company, and something REAL from candidate's experience
- **Direct, no fluff**: 2-4 sentences per answer. No "I'm passionate about..." or "I would love the opportunity to..."
- **Hook is proof, not claim**: Instead of "I'm great at X", say "I built X that does Y"

**Framework per question:**
- **Why this role?** → "Your [specific thing] maps directly to [specific thing I built]."
- **Why this company?** → Mention something concrete about the company. "I've been using [product] for [time/purpose]."
- **Relevant experience?** → One quantified proof point. "Built [X] that [metric]. Sold the company in 2025."
- **Good fit?** → "I sit at the intersection of [A] and [B], which is exactly where this role lives."
- **How did you hear?** → Honest: "Found through [portal/scan], evaluated against my criteria, and it scored highest."

**Language**: Always in JD language (EN default). Apply `/tech-translate`.

## Step 5 — Update Tracker
Register in `data/applications.md` with all columns including Report and PDF in ✅.

**If any step fails**, continue with the following and mark the failed step as pending in tracker.
