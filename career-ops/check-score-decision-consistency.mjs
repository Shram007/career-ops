#!/usr/bin/env node
/**
 * check-score-decision-consistency.mjs
 * Validates that decision matches score threshold (>= 3.0 = advance, < 3.0 = hold)
 * Reports and optionally fixes inconsistencies
 */

import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { latestStatusToken } from './scripts/status-utils.mjs';

const APPS_FILE = 'data/applications.md';

export function findInconsistencies(lines) {
  const inconsistencies = [];

  lines.forEach((line, idx) => {
    if (!line.startsWith('|') || line.includes('Status') || line.includes('---')) return;

    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 7) return;

    const num = parts[1];
    const score = parts[5];
    const status = parts[6];

    // Parse score
    const scoreMatch = score.match(/^([\d.]+)/);
    if (!scoreMatch) return;

    const scoreVal = parseFloat(scoreMatch[1]);
    const latestStatus = latestStatusToken(status);

    const isApplicationInMotion = ['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded'].includes(latestStatus);

    if (isApplicationInMotion) return;

    if (latestStatus === 'scored' || latestStatus === 'evaluated') {
      if (scoreVal < 3.0) {
        inconsistencies.push({
          num,
          score: scoreVal,
          status,
          issue: `Score ${scoreVal} < 3.0 but status is "${status}" (should end in SKIP)`,
          line: idx,
          fix: 'Change latest status to SKIP',
        });
      }
    } else if (latestStatus === 'skip') {
      if (scoreVal >= 3.0) {
        inconsistencies.push({
          num,
          score: scoreVal,
          status,
          issue: `Score ${scoreVal} >= 3.0 but status is SKIP (should end in Scored)`,
          line: idx,
          fix: 'Change latest status to Scored',
        });
      }
    }
  });

  return inconsistencies;
}

export function applyFixes(lines, inconsistencies) {
  let fixed = 0;
  for (const inc of inconsistencies) {
    const lineIdx = inc.line;
    const cols = lines[lineIdx].split('|');
    const currentStatus = (cols[6] || '').trim();
    const segments = currentStatus.split(/\s*>\s*/).filter(Boolean);
    const target = inc.score >= 3.0 ? 'Scored' : 'SKIP';

    if (segments.length === 0) {
      segments.push(target);
    } else {
      segments[segments.length - 1] = target;
    }

    if (target === 'Scored') {
      console.log(`✅ #${inc.num}: Changed latest status to Scored`);
      fixed++;
    } else {
      console.log(`✅ #${inc.num}: Changed latest status to SKIP`);
      fixed++;
    }

    cols[6] = ` ${segments.join(' > ')} `;
    lines[lineIdx] = cols.join('|');
  }

  return fixed;
}

function main() {
  const content = readFileSync(APPS_FILE, 'utf8');
  const lines = content.split('\n');

  const inconsistencies = findInconsistencies(lines);

  if (inconsistencies.length === 0) {
    console.log('✅ All entries consistent (score matches decision)');
    process.exit(0);
  }

  console.log(`⚠️  Found ${inconsistencies.length} inconsistencies:\n`);
  inconsistencies.forEach(inc => {
    console.log(`❌ #${inc.num}: Score ${inc.score}/5, Status "${inc.status}"`);
    console.log(`   Issue: ${inc.issue}`);
    console.log(`   Fix: ${inc.fix}\n`);
  });

  console.log('🔧 Auto-fixing inconsistencies...\n');
  const fixed = applyFixes(lines, inconsistencies);

  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log(`\n📊 ${fixed} entries fixed. Tracker updated.`);
}

const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
