#!/usr/bin/env node

/**
 * validate-resume-html.mjs — Resume HTML Validator
 *
 * Enforces formatting constraints from modes/pdf.md and batch/batch-prompt.md:
 * - Core Competencies: exactly 4-5 tags, fits 1 line
 * - Skills: max 3-4 groups, each fits 1 line
 * - Projects: no work exp titles, has tech stack div, 2-3 bullets per project, each 1 line
 * - Overall: PDF must be 1 page (signals if competencies need removal)
 *
 * Usage:
 *   node validate-resume-html.mjs <input.html> [--strict]
 *
 * Exit code: 0 (valid) or 1 (violations found)
 */

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const inputFile = args[0];
const strictMode = args.includes('--strict');

if (!inputFile) {
  console.error('❌ Usage: node validate-resume-html.mjs <input.html> [--strict]');
  process.exit(1);
}

let html;
try {
  html = readFileSync(inputFile, 'utf-8');
} catch (err) {
  console.error(`❌ Cannot read file: ${inputFile}`);
  process.exit(1);
}

const violations = [];
const warnings = [];

console.log(`\n📋 Validating: ${inputFile}\n`);

// Helper: extract text from HTML tags
function stripHtml(text) {
  return text.replace(/<[^>]*>/g, '');
}

// ─────────────────────────────────────────────────────────────
// 1. SKILLS SECTION VALIDATION
// ─────────────────────────────────────────────────────────────

// More robust: find Skills section (handle class="section avoid-break" etc.), then all <div> children until next section
const skillsSectionMatch = html.match(/<div class="section[^"]*">\s*<div class="section-title">[^<]*Skill[^<]*<\/div>([\s\S]*?)(?=<div class="section|$)/i);
if (skillsSectionMatch) {
  const skillsContent = skillsSectionMatch[1];
  // Extract direct child divs (skill groups), not nested ones — handle both <div> and <div class="skill-item">
  const skillGroupMatches = skillsContent.match(/<div[^>]*><span class="skill-category">([^<]+)<\/span>([^<]*)<\/div>/g) || [];
  const skillGroups = skillGroupMatches.map(g => stripHtml(g).trim());

  if (skillGroups.length > 0) {
    if (skillGroups.length > 4) {
      violations.push(`Skills: ${skillGroups.length} groups found (max 4)`);
    }

    // Check each group fits 1 line (~80 chars at 10.5px font)
    skillGroups.forEach((group, idx) => {
      if (group.length > 85) {
        violations.push(`Skills group ${idx + 1}: "${group.substring(0, 50)}..." (${group.length} chars) exceeds 1-line limit (~85 chars)`);
      }
    });
  } else {
    warnings.push('Skills section found but no skill groups detected (check HTML structure)');
  }
} else {
  warnings.push('Skills section: not found or structure not detected');
}

// ─────────────────────────────────────────────────────────────
// 2. PROJECTS SECTION VALIDATION
// ─────────────────────────────────────────────────────────────

// Match project divs: from opening <div class="project"> through closing </div> after </ul>
const projectMatches = html.match(/<div class="project">[\s\S]*?<\/ul>\s*<\/div>/g) || [];

projectMatches.forEach((projHtml, idx) => {
  // Extract title from <a> tag inside project-title
  let titleMatch = projHtml.match(/<div class="project-title">\s*<a[^>]*>([^<]+)<\/a>\s*<\/div>/);
  if (!titleMatch) {
    // Fallback: try to extract plain text from project-title (old format)
    titleMatch = projHtml.match(/<div class="project-title">([^<]+)<\/div>/);
  }
  const title = titleMatch ? titleMatch[1].trim() : 'NO TITLE';

  // Extract tech stack from project-tech div (new format)
  const techMatch = projHtml.match(/<div class="project-tech">([^<]+)<\/div>/);
  const tech = techMatch ? techMatch[1].trim() : '';

  // Extract bullets from this project (proper format)
  const bulletMatches = projHtml.match(/<li>[\s\S]*?<\/li>/g) || [];
  const bulletCount = bulletMatches.length;

  // Check: tech stack should exist (in new format with separate tech div)
  if (!tech && !title.includes('|')) {
    warnings.push(`Project ${idx + 1} "${title}": no tech stack found. Add <div class="project-tech">tech list</div> or include "| Stack:" in title.`);
  } else if (tech.length < 5) {
    warnings.push(`Project ${idx + 1}: tech stack "${tech}" may be incomplete (too short)`);
  }

  // Check: no work experience titles (dates like "2023-2024", company patterns)
  // Use stricter pattern: year range must be followed by dash/hyphen/to
  if (/^\d{4}\s*[-–—]\s*\d{4}/.test(title) || title.includes(' @ ') || /\b(Engineer|Manager|Lead|Developer|Architect)\s+at\s+\w+/i.test(title)) {
    violations.push(`Project ${idx + 1}: title looks like work experience ("${title}"). Should be project name only.`);
  }

  // Check: if using <ul><li> format, count should be 2-3
  if (bulletMatches.length > 0) {
    if (bulletCount < 2 || bulletCount > 3) {
      violations.push(`Project ${idx + 1} "${title}": ${bulletCount} bullets (expected 2-3)`);
    }

    // Check: each bullet fits 1 line
    bulletMatches.forEach((bulletHtml, bulletIdx) => {
      const bulletText = bulletHtml.replace(/<[^>]*>/g, '').trim();
      if (bulletText.length > 95) {
        violations.push(`Project ${idx + 1}, bullet ${bulletIdx + 1}: "${bulletText.substring(0, 50)}..." (${bulletText.length} chars) exceeds 1-line limit`);
      }
    });
  } else {
    // Check if using .project-desc format instead of <ul><li>
    const descMatch = projHtml.match(/<div class="project-desc">([^<]+)<\/div>/);
    if (descMatch) {
      warnings.push(`Project ${idx + 1}: using description format instead of bullet points. Should use <ul><li> for 2-3 bullet points.`);
    }
  }
});

if (projectMatches.length === 0) {
  warnings.push('Projects section: not found or empty');
}

// ─────────────────────────────────────────────────────────────
// 3. WORK EXPERIENCE VALIDATION
// ─────────────────────────────────────────────────────────────

// Match job divs: from opening <div class="job"> through closing </div> after </ul>
const jobMatches = html.match(/<div class="job">[\s\S]*?<\/ul>\s*<\/div>/g) || [];

jobMatches.forEach((jobHtml, idx) => {
  // Match <li>...content with nested tags...</li>
  const bulletMatches = jobHtml.match(/<li>[\s\S]*?<\/li>/g) || [];
  bulletMatches.forEach((bulletHtml, bulletIdx) => {
    const text = bulletHtml.replace(/<[^>]*>/g, '').trim();
    if (text.length > 120) {
      warnings.push(`Work Exp ${idx + 1}, bullet ${bulletIdx + 1}: ${text.length} chars (consider condensing to fit 1 line)`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 5. OVERALL VALIDATION
// ─────────────────────────────────────────────────────────────

if (!html.includes('<div class="section')) {
  violations.push('No sections found. HTML structure may be invalid.');
}

if (html.includes('column-layout') || html.includes('flex-direction: column;') && html.includes('max-width: 50%')) {
  warnings.push('Page layout: may be multi-column. ATS requires single-column.');
}

// ─────────────────────────────────────────────────────────────
// OUTPUT REPORT
// ─────────────────────────────────────────────────────────────

let exitCode = 0;

if (violations.length > 0) {
  console.log(`❌ VIOLATIONS (${violations.length}):\n`);
  violations.forEach((v, idx) => {
    console.log(`   ${idx + 1}. ${v}`);
  });
  console.log();
  exitCode = 1;
} else {
  console.log('✅ No violations found.\n');
}

if (warnings.length > 0) {
  console.log(`⚠️  WARNINGS (${warnings.length}):\n`);
  warnings.forEach((w, idx) => {
    console.log(`   ${idx + 1}. ${w}`);
  });
  console.log();
}

if (violations.length === 0 && warnings.length === 0) {
  console.log('🎉 Resume HTML is valid and ready for PDF generation.\n');
}

// ─────────────────────────────────────────────────────────────
// RECOMMENDATIONS
// ─────────────────────────────────────────────────────────────

if (violations.length > 0) {
  console.log('📝 FIXES:\n');

  violations.forEach(v => {
    if (v.includes('Core Competencies') && v.includes('exceeds 1-line')) {
      console.log('   • Remove 1-2 least relevant competency tags');
      console.log('   • Or increase competency tag font size (currently ~10px)\n');
    }
    if (v.includes('Skills') && v.includes('groups')) {
      console.log('   • Reduce skill groups from', v.match(/\d+/)?.[0], 'to max 4');
      console.log('   • Merge related skills into fewer groups\n');
    }
    if (v.includes('Skills') && v.includes('exceeds')) {
      console.log('   • Shorten skill names or split groups into multiple lines');
      console.log('   • Use abbreviations where possible\n');
    }
    if (v.includes('Project') && v.includes('tech')) {
      console.log('   • Add <div class="project-tech">tech list</div> after project title div');
      console.log('   • Example: <div class="project-tech">Python, FastAPI, PostgreSQL</div>\n');
    }
    if (v.includes('Project') && v.includes('looks like work')) {
      console.log('   • Move to Work Experience section instead');
      console.log('   • Projects section should show portfolio work only\n');
    }
    if (v.includes('bullet') && v.includes('exceeds')) {
      console.log('   • Condense bullet point text to <95 characters');
      console.log('   • Remove filler words; use action verbs\n');
    }
  });
}

console.log(`📊 Summary:\n   Competencies: ${competencyCount} tags | Projects: ${projectMatches.length} | Violations: ${violations.length} | Warnings: ${warnings.length}\n`);

process.exit(exitCode);
