#!/usr/bin/env node

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildTrackerRow, parseTrackerRow } from './scripts/markdown-table-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

if (!existsSync(APPS_FILE)) {
  console.error('applications.md not found');
  process.exit(1);
}

const lines = readFileSync(APPS_FILE, 'utf8').split(/\r?\n/);
const rows = [];

for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i]);
  if (!row) continue;
  rows.push({ lineIndex: i, ...row });
}

if (rows.length === 0) {
  console.log('No tracker rows found to reindex.');
  process.exit(0);
}

const seen = new Set();
let hasDuplicate = false;
for (const row of rows) {
  if (seen.has(row.id)) {
    hasDuplicate = true;
    break;
  }
  seen.add(row.id);
}

if (!hasDuplicate) {
  console.log('No duplicate IDs found. Tracker ID repair not required.');
  process.exit(0);
}

let nextId = 1;
for (const row of rows) {
  const old = row.id;
  row.id = nextId++;
  lines[row.lineIndex] = buildTrackerRow(row);
  console.log(`#${old} -> #${row.id} (${row.company} | ${row.role})`);
}

if (DRY_RUN) {
  console.log('\n(dry-run) no file changes were written');
  process.exit(0);
}

copyFileSync(APPS_FILE, `${APPS_FILE}.bak`);
writeFileSync(APPS_FILE, lines.join('\n'), 'utf8');
console.log('\n✅ Reindexed tracker IDs and wrote backup:', `${APPS_FILE}.bak`);
