#!/usr/bin/env node

/**
 * pdf-queue.mjs
 *
 * List tracker entries that are ready for PDF generation:
 * - score >= 3.5
 * - PDF column is not marked complete
 * - status is not SKIP/Discarded/Rejected
 *
 * Usage:
 *   node pdf-queue.mjs
 *   node pdf-queue.mjs --top 10
 *   node pdf-queue.mjs --json
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isBlockedStatus } from './scripts/status-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPS_PATH = existsSync(join(__dirname, 'data', 'applications.md'))
  ? join(__dirname, 'data', 'applications.md')
  : join(__dirname, 'applications.md');

function parseArgs(argv) {
  const args = argv.slice(2);
  let top = null;
  let asJson = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--top') {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) top = Math.floor(n);
      continue;
    }
    if (a === '--json') {
      asJson = true;
    }
  }

  return { top, asJson };
}

function parseScore(scoreRaw) {
  const m = String(scoreRaw || '').match(/([\d.]+)\/5/);
  return m ? Number(m[1]) : NaN;
}

function parseRows(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('|---')) continue;
    if (line.toLowerCase().includes('| # |')) continue;

    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 10) continue;

    const number = Number(parts[1]);
    if (!Number.isFinite(number)) continue;

    rows.push({
      id: number,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      scoreRaw: parts[5],
      score: parseScore(parts[5]),
      status: parts[6],
      pdf: parts[7],
      report: parts[8],
      notes: parts[9] || '',
    });
  }

  return rows;
}

function isPdfDone(pdfCell) {
  return String(pdfCell || '').includes('✅');
}

function main() {
  const { top, asJson } = parseArgs(process.argv);

  if (!existsSync(APPS_PATH)) {
    console.error(`applications tracker not found: ${APPS_PATH}`);
    process.exit(1);
  }

  const rows = parseRows(readFileSync(APPS_PATH, 'utf8'));

  const ready = rows
    .filter((r) => Number.isFinite(r.score) && r.score >= 3.5)
    .filter((r) => !isPdfDone(r.pdf))
    .filter((r) => !isBlockedStatus(r.status))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.id - a.id;
    });

  const out = top ? ready.slice(0, top) : ready;

  if (asJson) {
    console.log(JSON.stringify({ count: out.length, items: out }, null, 2));
    return;
  }

  if (out.length === 0) {
    console.log('No PDF-ready jobs found.');
    return;
  }

  console.log('PDF-ready queue (score >= 3.5 and PDF pending)');
  console.log('------------------------------------------------');
  for (const r of out) {
    console.log(`#${r.id} | ${r.scoreRaw} | ${r.company} | ${r.role}`);
  }
  console.log('');
  console.log('Next: npm run pdf:id -- --id <number>');
}

main();
