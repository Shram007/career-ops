# Mode: pdf — ATS-Optimized PDF Generation

## Full Pipeline

1. Reads `cv.md` as source of truth
2. Asks user for JD if not in context (text or URL)
3. Extracts 15-20 keywords from JD
4. Detects JD language → CV language (EN default)
5. Detects company location → paper format:
   - US/Canada → `letter`
   - Rest of world → `a4`
6. Detects role archetype → adapts framing
7. Rewrites Professional Summary:
   - **Start with WHO YOU ARE**, not technologies: "Backend engineer building [archetype domain]..." or "Full-stack builder shipping [type of systems]..."
   - **NEVER include**: visa status, sponsorship details, full tech stacks, employment classifications
   - **DO include**: your core craft, what you ship, outcomes you drive (speed, scale, reliability, cost)
   - **Pattern**: "[Role/Craft]. [What systems you build]. [How you work / your superpower]. [2-3 concrete proof points with numbers]."
   - Example: "Backend engineer building discovery systems at scale. Design for relevance and latency. Own full lifecycle architecture→deployment, shipping concept to production in 2-8 weeks. 30% throughput gain via data-driven debugging, hours→seconds data sync, 100% test coverage."
   - Inject top 5 JD keywords naturally into this narrative (DON'T force them; only if they fit your truthful story)
8. **Orders Work Experience: reverse chronological (most recent first)** — Ignore JD relevance; dates drive order
9. Reorders experience bullets within each role by JD relevance (optional; preserve role structure)
10. Builds competency grid from JD requirements (6-8 keyword phrases)
11. Injects keywords naturally into existing achievements (NEVER invents)
12. Generates full HTML from template + personalized content
13. Reads `name` from `config/profile.yml` → normalizes to kebab-case lowercase (e.g. "John Doe" → "john-doe") → `{candidate}`
14. Writes HTML to `/tmp/cv-{candidate}-{company}.html`
15. Executes: `node generate-pdf.mjs /tmp/cv-{candidate}-{company}.html output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}`
15. Reports: PDF path, number of pages, % keyword coverage

## ATS Rules (Clean Parsing)

- Single-column layout (no sidebars, no parallel columns)
- Standard headers: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects"
- No text in images/SVGs
- No critical info in PDF headers/footers (ATS ignores them)
- UTF-8, selectable text (not rasterized)
- No nested tables
- JD keywords distributed: Summary (top 5), first bullet of each role, Skills section

## PDF Design

- **Fonts**: Space Grotesk (headings, 600-700) + DM Sans (body, 400-500)
- **Self-hosted fonts**: `fonts/`
- **Header**: name in Space Grotesk 24px bold + gradient line `linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%))` 2px + contact row
- **Section headers**: Space Grotesk 13px, uppercase, letter-spacing 0.05em, cyan primary color
- **Body**: DM Sans 11px, line-height 1.5
- **Company names**: purple accent color `hsl(270,70%,45%)`
- **Margins**: 0.1in (all sides: top, bottom, left, right)
- **Background**: pure white

## Section Order (optimized "6-second recruiter scan")

1. Header (large name, gradient, contact, portfolio link)
2. Professional Summary (3-4 lines, keyword-dense)
3. Core Competencies (4-5 keyword phrases in EXACTLY 1 LINE)
4. **Work Experience (reverse chronological—most recent first, always)**
5. Projects (top 3-4 most relevant)
6. Education & Certifications
7. Skills (3-4 groups, each fitting EXACTLY 1 LINE)

**Work Experience order is NEVER influenced by JD relevance.** Sort by date descending (newest at top). This is ATS standard and matches recruiter expectations.

## Keyword Injection Strategy (Ethical, Truth-based)

Examples of legitimate rewording:
- JD says "RAG pipelines" and CV says "LLM workflows with retrieval" → change to "RAG pipeline design and LLM orchestration workflows"
- JD says "MLOps" and CV says "observability, evals, error handling" → change to "MLOps and observability: evals, error handling, cost monitoring"
- JD says "stakeholder management" and CV says "collaborated with team" → change to "stakeholder management across engineering, operations, and business"

**NEVER add skills the candidate doesn't have. Only rephrase real experience with the exact vocabulary from the JD.**

## Formatting Rules for Tight 1-Page Layout

### Bullet Points
- **Maximum 1 line per bullet** — if a bullet exceeds to a new line by a couple of words, rewrite it to fit on a single line
- Avoid orphan words (1-2 words breaking to a new line) — condense the bullet instead
- Eliminate padding words: remove "in order to", "ability to", "responsible for" → use action verbs directly

### Projects Section
- **Total bullets per project:** max 3, min 2
- Each project: 1 title line + 2-3 bullet points describing impact
- Bullets must fit 1 line (apply orphan rule)

### Core Competencies Section
- **Total competencies:** exactly 4-5 keyword phrases maximum (down from 6-8)
- **Must fit EXACTLY 1 LINE** — no wrapping to second line
- Format: `<span class="competency-tag">keyword1</span> <span class="competency-tag">keyword2</span> ...`
- Select only the most critical JD-matched terms; delegate other skills to Skills section
- **Why:** Reduces section height by ~40%, gives body content breathing room, prevents autoscale algorithm from needing aggressive zoom

### Skills Section
- **Total skill groups:** max 3-4 groups
- **Each group must fit EXACTLY 1 LINE** — no wrapping to second line
- Format: "Category: skill1, skill2, skill3"
- If a group exceeds 1 line, split into 2 groups or remove lower-priority skills
- **Why:** Keeps resume height tight; combined with compact competencies, body content has room to breathe at 100% scale

## HTML Template

Use the template in `cv-template.html`. Replace `{{...}}` placeholders with personalized content:

| Placeholder | Content |
|-------------|---------|
| `{{LANG}}` | `en` or `es` |
| `{{PAGE_WIDTH}}` | `8.5in` (letter) or `210mm` (A4) |
| `{{NAME}}` | (from profile.yml) |
| `{{PHONE}}` | (from profile.yml — include with its separator only when `profile.yml` has a non-empty `phone` value; omit both `<span>` and `<span class="separator">` otherwise) |
| `{{EMAIL}}` | (from profile.yml) |
| `{{LINKEDIN_URL}}` | (from profile.yml) |
| `{{LINKEDIN_DISPLAY}}` | (from profile.yml) |
| `{{GITHUB_URL}}` | (from profile.yml) |
| `{{GITHUB_DISPLAY}}` | (from profile.yml) |
| `{{PORTFOLIO_URL}}` | (from profile.yml — MUST populate if portfolio_url exists; if empty, leave as-is so template skips it gracefully) |
| `{{PORTFOLIO_DISPLAY}}` | (from profile.yml, typically domain name e.g. "Portfolio" or "shram-kadia.vercel.app") |
| `{{LOCATION}}` | (from profile.yml) |
| `{{SECTION_SUMMARY}}` | Professional Summary / Resumen Profesional |
| `{{SUMMARY_TEXT}}` | Personalized summary with keywords |
| `{{SECTION_COMPETENCIES}}` | Core Competencies / Competencias Core |
| `{{COMPETENCIES}}` | 4-5 items max: `<span class="competency-tag">keyword1</span> <span class="competency-tag">keyword2</span>...` (MUST fit on 1 line, no wrapping) |
| `{{SECTION_EXPERIENCE}}` | Work Experience / Experiencia Laboral |
| `{{EXPERIENCE}}` | HTML of each job with reordered bullets |
| `{{SECTION_PROJECTS}}` | Projects / Proyectos |
| `{{PROJECTS}}` | HTML of top 3-4 projects with bullets: `<div class="project"><div class="project-title">title</div><ul><li>impact bullet</li><li>impact bullet</li></ul><div class="project-tech">Stack: ...</div></div>` (each project MUST have `<ul>` with 2-3 `<li>` bullets, each 1 line max) |
| `{{SECTION_EDUCATION}}` | Education / Formación |
| `{{EDUCATION}}` | HTML of education |
| `{{SECTION_CERTIFICATIONS}}` | Certifications / Certificaciones |
| `{{CERTIFICATIONS}}` | HTML of certifications |
| `{{SECTION_SKILLS}}` | Skills / Competencias |
| `{{SKILLS}}` | Max 3-4 skill groups, each fitting 1 line: `<div><span class="skill-category">Category:</span> skill1, skill2, skill3</div>` repeated. **CRITICAL:** measure text length per group; if category + skills > ~85 chars, split to new group. No group wraps to 2 lines. |

## Canva CV Generation (optional)

If `config/profile.yml` has `cv.canva_resume_design_id` set, offer the user a choice before generating:
- **"HTML/PDF (fast, ATS-optimized)"** — existing flow above
- **"Canva CV (visual, design-preserving)"** — new flow below

If the user has no `cv.canva_resume_design_id`, skip this prompt and use the HTML/PDF flow.

### Canva workflow

#### Step 1 — Duplicate the base design

a. `export-design` the base design (using `cv.canva_resume_design_id`) as PDF → get download URL
b. `import-design-from-url` using that download URL → creates a new editable design (the duplicate)
c. Note the new `design_id` for the duplicate

#### Step 2 — Read the design structure

a. `get-design-content` on the new design → returns all text elements (richtexts) with their content
b. Map text elements to CV sections by content matching:
   - Look for the candidate's name → header section
   - Look for "Summary" or "Professional Summary" → summary section
   - Look for company names from cv.md → experience sections
   - Look for degree/school names → education section
   - Look for skill keywords → skills section
c. If mapping fails, show the user what was found and ask for guidance

#### Step 3 — Generate tailored content

Same content generation as the HTML flow (Steps 1-11 above):
- Rewrite Professional Summary with JD keywords + exit narrative
- Reorder experience bullets by JD relevance
- Select top competencies from JD requirements
- Inject keywords naturally (NEVER invent)

**IMPORTANT — Character budget rule:** Each replacement text MUST be approximately the same length as the original text it replaces (within ±15% character count). If tailored content is longer, condense it. The Canva design has fixed-size text boxes — longer text causes overlapping with adjacent elements. Count the characters in each original element from Step 2 and enforce this budget when generating replacements.

#### Step 4 — Apply edits

a. `start-editing-transaction` on the duplicate design
b. `perform-editing-operations` with `find_and_replace_text` for each section:
   - Replace summary text with tailored summary
   - Replace each experience bullet with reordered/rewritten bullets
   - Replace competency/skills text with JD-matched terms
   - Replace project descriptions with top relevant projects
c. **Reflow layout after text replacement:**
   After applying all text replacements, the text boxes auto-resize but neighboring elements stay in place. This causes uneven spacing between work experience sections. Fix this:
   1. Read the updated element positions and dimensions from the `perform-editing-operations` response
   2. For each work experience section (top to bottom), calculate where the bullets text box ends: `end_y = top + height`
   3. The next section's header should start at `end_y + consistent_gap` (use the original gap from the template, typically ~30px)
   4. Use `position_element` to move the next section's date, company name, role title, and bullets elements to maintain even spacing
   5. Repeat for all work experience sections
d. **Verify layout before commit:**
   - `get-design-thumbnail` with the transaction_id and page_index=1
   - Visually inspect the thumbnail for: text overlapping, uneven spacing, text cut off, text too small
   - If issues remain, adjust with `position_element`, `resize_element`, or `format_text`
   - Repeat until layout is clean
d. Show the user the final preview and ask for approval
e. `commit-editing-transaction` to save (ONLY after user approval)

#### Step 5 — Export and download PDF

a. `export-design` the duplicate as PDF (format: a4 or letter based on JD location)
b. **IMMEDIATELY** download the PDF using Bash:
   ```bash
   curl -sL -o "output/cv-{candidate}-{company}-canva-{YYYY-MM-DD}.pdf" "{download_url}"
   ```
   The export URL is a pre-signed S3 link that expires in ~2 hours. Download it right away.
c. Verify the download:
   ```bash
   file output/cv-{candidate}-{company}-canva-{YYYY-MM-DD}.pdf
   ```
   Must show "PDF document". If it shows XML or HTML, the URL expired — re-export and retry.
d. Report: PDF path, file size, Canva design URL (for manual tweaking)

#### Error handling

- If `import-design-from-url` fails → fall back to HTML/PDF pipeline with message
- If text elements can't be mapped → warn user, show what was found, ask for manual mapping
- If `find_and_replace_text` finds no matches → try broader substring matching
- Always provide the Canva design URL so the user can edit manually if auto-edit fails

## Conditional Removal: Core Competencies if PDF > 1 Page

If after generating the initial PDF the page count is **> 1 page**, remove the entire "Core Competencies" section from the HTML and regenerate the PDF. This decision is **per resume only** — doesn't affect the global template.

**Steps:**
1. Generate initial PDF from personalized HTML
2. Count pages in generated PDF
3. If pageCount > 1: remove the `<div class="section">` containing `<div class="section-title">{{SECTION_COMPETENCIES}}</div>`
4. Regenerate PDF from modified HTML
5. Use final version (with or without competencies per result)

**Why:** Competencies (6-8 keyword tags) take ~120-150px height. Removing them automatically optimizes height when resume touches or exceeds 2 pages, allowing minimal zoom adjustment (95-98%) without cutting content.

## Post-generation

Update tracker if offer is already registered: change PDF from ❌ to ✅.
