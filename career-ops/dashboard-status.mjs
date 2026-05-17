#!/usr/bin/env node
/**
 * dashboard-status.mjs
 *
 * Status history tracker for applications.md jobs.
 * Maintains multi-status history per job ID.
 * Does NOT modify applications.md.
 *
 * Usage:
 *   node dashboard-status.mjs --view              # Show dashboard with status history
 *   node dashboard-status.mjs --add <id> <status> # Add status to job
 *   node dashboard-status.mjs --history <id>      # Show full history for a job
 *   node dashboard-status.mjs --filter <status>   # Show jobs with specific status
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const HISTORY_FILE = 'data/status-history.json';

// Load tracker
const tracker = readFileSync('data/applications.md', 'utf8');
const trackerLines = tracker.split('\n').slice(3); // Skip header

const jobs = {};
for (const line of trackerLines) {
  if (!line.includes('|')) continue;
  const parts = line.split('|').map(p => p.trim());
  if (parts.length >= 5 && /^\d+$/.test(parts[1])) {
    const id = parts[1];
    const date = parts[2];
    const company = parts[3];
    const role = parts[4];
    const score = parts[5];
    const status = parts[6];

    jobs[id] = { id, date, company, role, score, status };
  }
}

// Load status history
let history = {};
if (existsSync(HISTORY_FILE)) {
  try {
    history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    history = {};
  }
}

// ============================================================================
// Commands
// ============================================================================

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === '--view') {
  viewDashboard();
} else if (cmd === '--add' && args[1] && args[2]) {
  addStatus(args[1], args[2]);
} else if (cmd === '--history' && args[1]) {
  showHistory(args[1]);
} else if (cmd === '--filter' && args[1]) {
  filterByStatus(args[1]);
} else {
  console.log(`Usage:
  node dashboard-status.mjs --view              # Show dashboard
  node dashboard-status.mjs --add <id> <status> # Add status
  node dashboard-status.mjs --history <id>      # Show history
  node dashboard-status.mjs --filter <status>   # Filter by status`);
  process.exit(0);
}

// ============================================================================
// Functions
// ============================================================================

function viewDashboard() {
  console.log('\n=== APPLICATIONS DASHBOARD ===\n');

  const rows = [];
  for (const id in jobs) {
    const job = jobs[id];
    const statuses = history[id] || [job.status];
    const current = statuses[statuses.length - 1];

    rows.push({
      '#': id,
      'Company': job.company.substring(0, 15),
      'Role': job.role.substring(0, 25),
      'Score': job.score,
      'Current': current,
      'History': statuses.join(' → ')
    });
  }

  // Sort by ID desc
  rows.sort((a, b) => parseInt(b['#']) - parseInt(a['#']));

  console.table(rows);
  console.log('');
}

function addStatus(id, status) {
  if (!jobs[id]) {
    console.error(`Job #${id} not found`);
    process.exit(1);
  }

  if (!history[id]) {
    history[id] = [jobs[id].status];
  }

  // Don't add duplicate
  if (history[id][history[id].length - 1] === status) {
    console.log(`✓ #${id} already has status: ${status}`);
    process.exit(0);
  }

  history[id].push(status);
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  const job = jobs[id];
  console.log(`✓ Added "${status}" to #${id} | ${job.company} | ${job.role}`);
  console.log(`  History: ${history[id].join(' → ')}`);
}

function showHistory(id) {
  if (!jobs[id]) {
    console.error(`Job #${id} not found`);
    process.exit(1);
  }

  const job = jobs[id];
  const statuses = history[id] || [job.status];

  console.log(`\n#${id} | ${job.company} | ${job.role}\n`);
  console.log('Status History:');
  statuses.forEach((s, i) => {
    const marker = i === statuses.length - 1 ? '→' : ' ';
    console.log(`  ${marker} ${s}`);
  });
  console.log('');
}

function filterByStatus(status) {
  console.log(`\nJobs with status: "${status}"\n`);

  const matches = [];
  for (const id in jobs) {
    const job = jobs[id];
    const statuses = history[id] || [job.status];

    if (statuses.includes(status)) {
      matches.push({
        '#': id,
        'Company': job.company,
        'Role': job.role,
        'Score': job.score,
        'Current': statuses[statuses.length - 1]
      });
    }
  }

  if (matches.length === 0) {
    console.log('No matches');
  } else {
    console.table(matches);
  }

  console.log('');
}
