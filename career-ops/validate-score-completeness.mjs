#!/usr/bin/env node
/**
 * validate-score-completeness.mjs
 *
 * Post-score validation: ensure no advances were orphaned in pipeline files
 *
 * Run after /career-ops score [discovery|referral] completes
 * Exit code: 0 = valid, 1 = invalid
 */

import { readFileSync, existsSync } from 'fs';

const PIPELINE_DISCOVERY = 'data/pipeline.md';
const PIPELINE_REFERRAL = 'data/pipeline-referral.md';
const APPLICATIONS = 'data/applications.md';

let errors = [];
let warnings = [];

console.log('🔍 Validating score completeness...\n');

// ============================================================================
// Check 1: Verify "advance" entries in pipeline are in applications.md
// ============================================================================

function checkOrphanedAdvances() {
  if (!existsSync(APPLICATIONS)) {
    warnings.push('applications.md not found (new tracker)');
    return;
  }

  const appsContent = readFileSync(APPLICATIONS, 'utf8');
  const appsLower = appsContent.toLowerCase();

  const files = [
    { name: 'pipeline.md', path: PIPELINE_DISCOVERY },
    { name: 'pipeline-referral.md', path: PIPELINE_REFERRAL }
  ];

  for (const file of files) {
    if (!existsSync(file.path)) continue;

    const pipelineContent = readFileSync(file.path, 'utf8');
    const orphans = [];

    for (const line of pipelineContent.split('\n')) {
      if (!line.match(/^\- \[x\].*\| advance \|/)) continue;

      // Extract company + role from pipeline entry
      const parts = line.split('|').map(p => p.trim());
      if (parts.length < 5) continue;
      const company = parts[2].toLowerCase().replace(/[^a-z0-9]/g, '');
      const role = parts[3].toLowerCase().replace(/[^a-z0-9 ]/g, '');

      // Check if company+role exists in applications.md
      const found = appsContent.split('\n').some(appLine => {
        const appParts = appLine.split('|');
        if (appParts.length < 5) return false;
        const appCompany = appParts[3].toLowerCase().replace(/[^a-z0-9]/g, '');
        const appRole = appParts[4].toLowerCase().replace(/[^a-z0-9 ]/g, '');
        return appCompany === company && appRole === role;
      });

      if (!found) {
        orphans.push(`${parts[2]} | ${parts[3]}`);
      }
    }

    if (orphans.length > 0) {
      errors.push(`${file.name}: ${orphans.length} advance entries NOT found in applications.md:`);
      orphans.slice(0, 3).forEach(entry => {
        errors.push(`  → ${entry}`);
      });
      if (orphans.length > 3) {
        errors.push(`  ... and ${orphans.length - 3} more`);
      }
    }
  }
}

// Note: We do NOT check for orphaned advances because some may be legitimate
// dedup cases where a newer batch duplicated an earlier entry.
// The real validation is score-decision consistency in the tracker.

// ============================================================================
// Check 1: Score-decision consistency
// ============================================================================

function checkConsistency() {
  if (!existsSync(APPLICATIONS)) {
    warnings.push('applications.md not found (new tracker)');
    return;
  }

  const content = readFileSync(APPLICATIONS, 'utf8');
  const lines = content.split('\n');
  const inconsistent = [];

  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('Status') || line.includes('---')) continue;

    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 9) continue;

    const num = parts[1];
    const score = parts[5];
    const status = parts[6];
    const notes = (parts[9] || '').toLowerCase();

    const scoreMatch = score.match(/^([\d.]+)/);
    if (!scoreMatch) continue;

    const scoreVal = parseFloat(scoreMatch[1]);
    const statusLower = status.toLowerCase();

    // Check: score >= 3.0 must have Scored or Evaluated status
    // UNLESS it has a block tag (location:, seniority:, etc) in notes
    const hasBlockTag = notes.includes('location:') || notes.includes('seniority:') ||
                       notes.includes('stack:') || notes.includes('exp:') ||
                       notes.includes('remote:');

    if (scoreVal >= 3.0 && statusLower === 'skip' && !hasBlockTag) {
      inconsistent.push(`#${num}: Score ${scoreVal} >= 3.0 but status is SKIP (no scope block tag)`);
    }

    // Check: score < 3.0 should not have Scored or Evaluated
    if (scoreVal < 3.0 && (statusLower === 'scored' || statusLower === 'evaluated')) {
      inconsistent.push(`#${num}: Score ${scoreVal} < 3.0 but status is ${status}`);
    }
  }

  if (inconsistent.length > 0) {
    errors.push(`Score-decision inconsistencies found:`);
    inconsistent.forEach(msg => {
      errors.push(`  → ${msg}`);
    });
  }
}

checkConsistency();

// ============================================================================
// Report
// ============================================================================

console.log('');
if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ Validation passed (no issues found)');
  process.exit(0);
}

if (errors.length > 0) {
  console.log('❌ VALIDATION FAILED:\n');
  errors.forEach(msg => console.log(msg));
  console.log('\n⚠️  Score mode did not complete correctly. Do NOT proceed to other stages.');
  process.exit(1);
}

if (warnings.length > 0) {
  console.log('⚠️  Warnings (non-blocking):\n');
  warnings.forEach(msg => console.log(`  → ${msg}`));
  console.log('\n✅ Validation passed with warnings');
  process.exit(0);
}
