#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const QUEUE = resolve('batch/followup-queue.tsv');
const ACTIONS = new Set(['pdf', 'custom_resume', 'cv_changes', 'interview_prep']);
const STATES = new Set(['pending', 'done']);

function usage() {
  console.log('Usage:');
  console.log('  node batch/followup-queue.mjs list [--pending]');
  console.log('  node batch/followup-queue.mjs update --id <id> --action <pdf|custom_resume|cv_changes|interview_prep> --state <pending|done>');
  console.log('');
  console.log('Columns: id, date, score, company, role, url, pdf, custom_resume, cv_changes, interview_prep, notes');
  process.exit(1);
}

if (!existsSync(QUEUE)) {
  console.error(`Queue file not found: ${QUEUE}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const cmd = args[0];
if (!cmd) usage();

const raw = readFileSync(QUEUE, 'utf-8').trimEnd();
const lines = raw.split('\n');
const header = lines[0];
const rows = lines.slice(1).map((line) => line.split('\t'));

if (cmd === 'list') {
  const pendingOnly = args.includes('--pending');
  console.log(header);
  for (const row of rows) {
    if (row.length < 11) continue;
    if (pendingOnly && !row.slice(6, 10).some((v) => v === 'pending')) continue;
    console.log(row.join('\t'));
  }
  process.exit(0);
}

if (cmd === 'update') {
  const idIndex = args.indexOf('--id');
  const actionIndex = args.indexOf('--action');
  const stateIndex = args.indexOf('--state');
  if (idIndex === -1 || actionIndex === -1 || stateIndex === -1) usage();

  const id = args[idIndex + 1];
  const action = args[actionIndex + 1];
  const state = args[stateIndex + 1];

  if (!id || !action || !state) usage();
  if (!ACTIONS.has(action)) {
    console.error(`Invalid action: ${action}`);
    process.exit(1);
  }
  if (!STATES.has(state)) {
    console.error(`Invalid state: ${state}`);
    process.exit(1);
  }

  const colMap = {
    pdf: 6,
    custom_resume: 7,
    cv_changes: 8,
    interview_prep: 9,
  };

  let found = false;
  for (const row of rows) {
    if (row[0] === id) {
      row[colMap[action]] = state;
      found = true;
      break;
    }
  }

  if (!found) {
    console.error(`ID not found in queue: ${id}`);
    process.exit(1);
  }

  const out = [header, ...rows.map((r) => r.join('\t'))].join('\n') + '\n';
  writeFileSync(QUEUE, out, 'utf-8');
  console.log(`Updated ${id}: ${action}=${state}`);
  process.exit(0);
}

usage();
