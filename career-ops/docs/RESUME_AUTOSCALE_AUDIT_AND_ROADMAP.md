# Resume Autoscale Audit and Roadmap

Date: 2026-05-22

## Executive status

- Autoscale logic is still present and executing in runtime.
- Wiring from user-facing PDF commands to the autoscale implementation is intact.
- Script-level fallback pass for >1 page is now implemented in `generate-pdf.mjs`.
- Current issue is quality/effectiveness in edge cases, not missing plumbing.

## Verified wiring map

1. Command entry points
- `package.json`
  - `pdf` -> `node generate-pdf.mjs`
  - `pdf:id` -> `node pdf-from-id.mjs`
  - `pdf:queue` -> `node pdf-queue.mjs`

2. ID-based flow
- `pdf-from-id.mjs`
  - Resolves tracker row and URL fallback chain (report -> batch -> notes -> pipeline -> scan history)
  - Invokes Claude with `modes/pdf.md`
  - `modes/pdf.md` instructs `node generate-pdf.mjs ...`

3. Autoscale implementation
- `generate-pdf.mjs`
  - Runs `validate-resume-html.mjs` (unless `--skip-validate`)
  - Computes page usable height from page format and margins
  - If overflow: binary-searches scale down
  - If underflow: scales up to fill whitespace
  - Generates PDF via Playwright `page.pdf(...)`

## Runtime verification performed

Command run:

`node generate-pdf.mjs tmp/Shram_Kadia_Google_Cloud_Forward_Deployed_Engineer.html output/_autoscale_wiring_check.pdf --format=letter`

Observed output summary:
- Validation ran successfully (warnings only).
- Autoscale log emitted: `Autoscale (fit 1 page): 99%`.
- PDF generated successfully.
- Final page count: 2 pages.

Interpretation:
- Autoscale is wired and active.
- This sample still overflows to 2 pages, so tuning/measurement logic needs improvement.

Additional verification after fallback implementation:
- Command: `node generate-pdf.mjs tmp/Shram_Kadia_Google_Cloud_Forward_Deployed_Engineer.html output/_autoscale_fallback_check.pdf --format=letter`
- Pass 1 autoscale executed.
- Fallback decision executed.
- Fallback skipped for this specific HTML because no removable legacy optional section was detected.

## Why validator alone was not enough

`validate-resume-html.mjs` is a validator/linter. It reports violations and warnings, but it does not mutate HTML and does not perform a second PDF render pass. The fallback requirement needs active runtime behavior in `generate-pdf.mjs` (trim section + regenerate), which is now in place.

## Implemented fallback behavior

When output page count is greater than 1, `generate-pdf.mjs` now:
1. Attempts to remove legacy optional sections from in-memory HTML (Core Competencies/Certifications blocks in older templates).
2. Applies compact layout fallback (reduced spacing/type scale) and regenerates.
3. Applies content-trim fallback (condenses overlong bullets, then optional list capping) and regenerates.
4. Accepts fallback output only when page count is improved or equal.
5. Logs fallback outcome and writes fallback metadata in run receipt.

Control flag:
- `--no-trim-fallback` disables this fallback.
- `--save-final-html` writes the transformed in-memory HTML snapshot next to the output PDF.

Latest verification:
- Command: `node generate-pdf.mjs tmp/Shram_Kadia_Google_Cloud_Forward_Deployed_Engineer.html output/_autoscale_content_trim_check.pdf --format=letter --save-final-html`
- Result: fallback chain `compact-layout+content-trim`, final output `1 page`.

## Improvement roadmap (prioritized)

### P0 - Reliability and determinism

1. Add hard one-page guard mode
- Add `--target-pages=1` (default off for backward compatibility).
- If output page count > target, fail with actionable diagnostics or auto-run fallback steps.

2. Extend script-level fallback pass for >1 page
- Keep trimming legacy optional sections in-memory and regenerate when page count >1.
- Keep original input HTML untouched.

3. Improve overflow measurement accuracy
- Current scaling logic mixes transformed layout with derived height math.
- Use consistent measurement based on unscaled content and explicit post-transform checks.
- Compare `document.documentElement.scrollHeight`, `body.scrollHeight`, and rendered box metrics; store debug snapshot in receipt.

4. Add autoscale diagnostics to run receipt
- Persist: original content height, usable height, chosen scale, overflow flag, post-scale measured height, output page count, fallback applied or not.

### P1 - Better control and tuning

5. Expose scale tunables as CLI flags
- `--max-scale-up` (default 1.15)
- `--min-scale-down` (default 0.60)
- `--safety-margin-pct` (default 1%)
- `--whitespace-threshold-px` (default 30)

6. Add optional margin profiles
- `--margin=compact|default|comfortable` mapped to predefined values.
- Keep existing default unchanged.

7. Add validation severity mode
- `validate-resume-html.mjs` can emit warnings for long bullets; optionally introduce `--fail-on-overflow-risk` to block known high-risk layouts before PDF render.

### P2 - Maintainability and test coverage

8. Add regression tests for autoscale
- Unit tests for sizing helper calculations.
- Golden integration tests with sample HTML fixtures:
  - natural one-page fit
  - slight overflow (requires scale-down)
  - severe overflow (requires fallback trim)

9. Add end-to-end smoke check script
- Example: `npm run pdf:smoke` to render fixture resumes and assert page counts.

10. Unify policy docs with script behavior
- Ensure `modes/pdf.md` and `generate-pdf.mjs` guarantees match exactly.
- Prefer implementing critical guarantees in script, not only in prompt instructions.

## Suggested quick wins (low-risk)

1. Implement `--target-pages=1` and fail-fast diagnostic (no mutation).
2. Add receipt metrics for autoscale internals.
3. Add fallback tuning flags (section selectors and pass limits).
4. Add one integration test reproducing this Google Cloud HTML overflow case.

## Source files to consult first next time

- `generate-pdf.mjs`
- `validate-resume-html.mjs`
- `pdf-from-id.mjs`
- `modes/pdf.md`
- `package.json`

This document is intended as the primary reference for autoscale status and future changes.
