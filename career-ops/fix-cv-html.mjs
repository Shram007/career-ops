#!/usr/bin/env node

/**
 * fix-cv-html.mjs — CV HTML Auto-Fixer
 *
 * Runs structural repairs on AI-generated CV HTML before validation and PDF
 * generation.  Catches known agent mistakes that are purely cosmetic / structural
 * (so we don't have to re-prompt the agent) and hard-stops on anything it can't
 * infer on its own (un-replaced placeholders).
 *
 * Repairs performed:
 *   1. "| Stack:" inline format → <div class="project-tech"> div
 *      Agents sometimes ignore the template and write:
 *        <div class="project-title"><a href="…">Name</a> | Stack: X, Y</div>
 *      This is auto-converted to the correct structure.
 *
 * Hard errors (exits 1):
 *   - Any {{PLACEHOLDER}} token left unreplaced in the final HTML
 *
 * Usage (standalone):
 *   node fix-cv-html.mjs <input.html> [--dry-run]
 *   node fix-cv-html.mjs <input.html> --out <output.html>
 *
 * When called from generate-pdf.mjs the input file is rewritten in place unless
 * --out is supplied.
 *
 * Exit codes:
 *   0 — all good (possibly with repairs applied)
 *   1 — unreplaced placeholders detected; pipeline must stop
 */

import { readFileSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const dryRun    = args.includes('--dry-run');
const outIdx    = args.indexOf('--out');
const outputFile = outIdx !== -1 ? args[outIdx + 1] : null;

if (!inputFile) {
  console.error('❌ Usage: node fix-cv-html.mjs <input.html> [--dry-run] [--out <output.html>]');
  process.exit(1);
}

let html;
try {
  html = readFileSync(inputFile, 'utf-8');
} catch (err) {
  console.error(`❌ Cannot read file: ${inputFile}`);
  process.exit(1);
}

const repairs = [];
const errors  = [];

// ─────────────────────────────────────────────────────────────────────────────
// REPAIR 1 — Convert "| Stack:" inline format to <div class="project-tech">
//
// Wrong (old format, agent mistake):
//   <div class="project-title"><a href="url">Name</a> | Stack: X, Y, Z</div>
//
// Correct (template format):
//   <div class="project-title"><a href="url">Name</a></div>
//   <div class="project-tech">X, Y, Z</div>
// ─────────────────────────────────────────────────────────────────────────────

const STACK_INLINE = /(<div class="project-title">)([\s\S]*?)\s*\|\s*Stack:\s*([^<]+?)(<\/div>)/gi;

let stackMatches = 0;
html = html.replace(STACK_INLINE, (_, openDiv, titleContent, techStack, _closeDiv) => {
  stackMatches++;
  const fixedTitle = `${openDiv}${titleContent.trimEnd()}</div>\n        <div class="project-tech">${techStack.trim()}</div>`;
  return fixedTitle;
});

if (stackMatches > 0) {
  repairs.push(`  • Converted ${stackMatches} "| Stack:" inline title(s) → <div class="project-tech"> format`);
}

// ─────────────────────────────────────────────────────────────────────────────
// REPAIR 2 — Convert "·" (interpunct bullet) separators in project-tech to ", "
//
// Some agents write "Python · FAISS · Redis" — valid, but inconsistent with
// template examples that use ", ".  Leave as-is (both render fine) — no repair.
// Only normalise if a mix of "·" and "," occurs in the same tech block.
// ─────────────────────────────────────────────────────────────────────────────
// (No-op for now — both formats are acceptable.)

// ─────────────────────────────────────────────────────────────────────────────
// HARD CHECK — Unreplaced {{PLACEHOLDER}} tokens
//
// These indicate the AI agent skipped filling a section.  We cannot infer the
// right content, so we must stop the pipeline and report clearly.
//
// Exceptions: none — every {{…}} in the template must be replaced before PDF.
// ─────────────────────────────────────────────────────────────────────────────

const placeholderMatches = [...html.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)];
if (placeholderMatches.length > 0) {
  const unique = [...new Set(placeholderMatches.map(m => `{{${m[1]}}}`))]
    .sort()
    .join(', ');
  errors.push(`Unreplaced placeholder(s): ${unique}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

const label = `\n🔧 fix-cv-html: ${inputFile}`;
let exitCode = 0;

if (repairs.length > 0) {
  console.log(`${label}`);
  console.log(`✅ Auto-fixed ${repairs.length} structural issue(s):`);
  repairs.forEach(r => console.log(r));
  console.log();
} else {
  console.log(`${label}`);
  console.log('✅ No structural issues to fix.\n');
}

if (errors.length > 0) {
  console.error('❌ Pipeline halted — unfilled placeholders detected:');
  errors.forEach(e => console.error(`   • ${e}`));
  console.error('\nThe AI agent did not replace all template placeholders.');
  console.error('Re-run the CV generation prompt and ensure every {{…}} section is filled.\n');
  exitCode = 1;
}

// Write repaired HTML only when there were structural fixes and no hard errors
if (!dryRun && repairs.length > 0 && exitCode === 0) {
  const dest = outputFile || inputFile;
  writeFileSync(dest, html, 'utf-8');
  console.log(`📝 Repaired HTML written to: ${dest}\n`);
} else if (dryRun && repairs.length > 0) {
  console.log('ℹ️  Dry run — file not modified.\n');
}

process.exit(exitCode);
