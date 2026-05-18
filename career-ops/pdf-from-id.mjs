#!/usr/bin/env node

/**
 * pdf-from-id.mjs
 *
 * Generate a tailored PDF flow from an existing tracker entry number,
 * without re-pasting JD URL or report details.
 *
 * Usage:
 *   node pdf-from-id.mjs --id 42
 *   node pdf-from-id.mjs --id 42 --allow-low-score
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPS_PATH = existsSync(join(__dirname, 'data', 'applications.md'))
  ? join(__dirname, 'data', 'applications.md')
  : join(__dirname, 'applications.md');
const MODE_PATH = join(__dirname, 'modes', 'pdf.md');
const BATCH_INPUT_PATH = join(__dirname, 'batch', 'batch-input.tsv');
const PIPELINE_PATHS = [
  join(__dirname, 'data', 'pipeline-referral.md'),
  join(__dirname, 'data', 'pipeline.md'),
];
const SCAN_HISTORY_PATH = join(__dirname, 'data', 'scan-history.tsv');

function usage() {
  console.log('Usage: node pdf-from-id.mjs --id <tracker-number> [--allow-low-score] [--dry-run]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let id = null;
  let allowLowScore = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--id') {
      id = Number(args[++i]);
      continue;
    }
    if (a === '--allow-low-score') {
      allowLowScore = true;
      continue;
    }
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '-h' || a === '--help') {
      usage();
    }
  }

  if (!Number.isFinite(id) || id <= 0) usage();
  return { id: Math.floor(id), allowLowScore, dryRun };
}

function parseScoreNum(scoreRaw) {
  const m = String(scoreRaw || '').match(/([\d.]+)\/5/);
  return m ? Number(m[1]) : NaN;
}

function parseReportPath(reportCell) {
  const m = String(reportCell || '').match(/\[[^\]]+\]\(([^)]+)\)/);
  return m ? m[1] : '';
}

function parseApplicationsTable(text) {
  const out = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('|---')) continue;
    if (line.toLowerCase().includes('| # |')) continue;

    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 10) continue;

    const num = Number(parts[1]);
    if (!Number.isFinite(num)) continue;

    out.push({
      number: num,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      scoreRaw: parts[5],
      status: parts[6],
      pdf: parts[7],
      reportRaw: parts[8],
      notes: parts[9] || '',
      scoreNum: parseScoreNum(parts[5]),
      reportPath: parseReportPath(parts[8]),
    });
  }

  return out;
}

function extractUrlFromReport(reportAbsPath) {
  if (!existsSync(reportAbsPath)) return '';
  const content = readFileSync(reportAbsPath, 'utf8');

  const urlMatch = content.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/m);
  if (urlMatch) return urlMatch[1];

  const batchIdMatch = content.match(/\*\*Batch ID:\*\*\s*(\d+)/m);
  if (batchIdMatch) {
    const batchId = batchIdMatch[1];
    return extractUrlFromBatchInput(batchId);
  }

  return '';
}

function extractUrlFromBatchInput(batchId) {
  if (!existsSync(BATCH_INPUT_PATH)) return '';
  const lines = readFileSync(BATCH_INPUT_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 4 || cols[0] === 'id') continue;
    if (cols[0] !== String(batchId)) continue;

    const notes = cols[3] || '';
    const idx = notes.lastIndexOf('| ');
    if (idx >= 0) {
      const extracted = notes.slice(idx + 2).trim();
      if (extracted.startsWith('http')) return extracted;
    }

    if ((cols[1] || '').startsWith('http')) return cols[1];
  }
  return '';
}

function extractUrlFromNotes(notes) {
  const m = String(notes || '').match(/https?:\/\/[^\s|)]+/i);
  return m ? m[0] : '';
}

function normalizeToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenizeRole(s) {
  const stop = new Set(['software', 'engineer', 'full', 'stack', 'backend', 'front', 'end', 'the', 'and', 'for', 'with']);
  return normalizeToken(s)
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => t.length >= 3 && !stop.has(t));
}

function extractUrlFromBatchInputByCompanyRole(row) {
  if (!existsSync(BATCH_INPUT_PATH)) return '';

  const roleTokens = tokenizeRole(row.role);
  const companyKey = normalizeToken(row.company);
  const lines = readFileSync(BATCH_INPUT_PATH, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 4 || cols[0] === 'id') continue;

    const urlCol = (cols[1] || '').trim();
    const notes = (cols[3] || '').trim();
    const haystack = normalizeToken(`${urlCol} ${notes}`);

    if (!haystack.includes(companyKey)) continue;

    if (roleTokens.length > 0) {
      const overlap = roleTokens.filter(t => haystack.includes(t)).length;
      if (overlap === 0) continue;
    }

    const idx = notes.lastIndexOf('| ');
    if (idx >= 0) {
      const extracted = notes.slice(idx + 2).trim();
      if (extracted.startsWith('http')) return extracted;
    }

    if (urlCol.startsWith('http')) return urlCol;
  }

  return '';
}

function extractUrlFromPipelineFiles(row) {
  const companyKey = normalizeToken(row.company);
  const roleKey = normalizeToken(row.role).slice(0, 30);

  for (const p of PIPELINE_PATHS) {
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const lower = normalizeToken(line);
      if (!lower.includes(companyKey)) continue;
      if (roleKey && !lower.includes(roleKey.slice(0, 15))) continue;
      const m = line.match(/https?:\/\/\S+/i);
      if (m) return m[0].trim();
    }
  }

  // Looser fallback: company match only.
  for (const p of PIPELINE_PATHS) {
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const lower = normalizeToken(line);
      if (!lower.includes(companyKey)) continue;
      const m = line.match(/https?:\/\/\S+/i);
      if (m) return m[0].trim();
    }
  }

  return '';
}

function extractUrlFromScanHistory(row) {
  if (!existsSync(SCAN_HISTORY_PATH)) return '';

  const companyKey = normalizeToken(row.company);
  const roleTokens = tokenizeRole(row.role);
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf8').split(/\r?\n/).slice(1);

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 5) continue;
    const [url, , , title, company] = cols;
    if (!url || !/^https?:\/\//i.test(url)) continue;

    const companyText = normalizeToken(company);
    if (!companyText.includes(companyKey)) continue;

    if (roleTokens.length > 0) {
      const titleText = normalizeToken(title);
      const overlap = roleTokens.filter(t => titleText.includes(t)).length;
      if (overlap === 0) continue;
    }

    return url.trim();
  }

  return '';
}

function main() {
  const { id, allowLowScore, dryRun } = parseArgs(process.argv);

  if (!existsSync(APPS_PATH)) {
    console.error(`applications tracker not found: ${APPS_PATH}`);
    process.exit(1);
  }
  if (!existsSync(MODE_PATH)) {
    console.error(`pdf mode file not found: ${MODE_PATH}`);
    process.exit(1);
  }

  const apps = parseApplicationsTable(readFileSync(APPS_PATH, 'utf8'));
  const row = apps.find((a) => a.number === id);

  if (!row) {
    console.error(`job #${id} not found in applications tracker`);
    process.exit(1);
  }

  if (!allowLowScore && Number.isFinite(row.scoreNum) && row.scoreNum < 3.5) {
    console.error(`job #${id} has score ${row.scoreRaw} (< 3.5). Use --allow-low-score to override.`);
    process.exit(1);
  }

  let jobUrl = '';
  if (row.reportPath) {
    const reportAbsPath = resolve(__dirname, row.reportPath);
    jobUrl = extractUrlFromReport(reportAbsPath);
  }

  // Fallbacks for tracker rows without report links.
  if (!jobUrl) jobUrl = extractUrlFromNotes(row.notes);
  if (!jobUrl) jobUrl = extractUrlFromBatchInputByCompanyRole(row);
  if (!jobUrl) jobUrl = extractUrlFromPipelineFiles(row);
  if (!jobUrl) jobUrl = extractUrlFromScanHistory(row);

  if (!jobUrl) {
    console.error(`could not resolve JD URL for job #${id}. Checked report, notes, batch-input.tsv, pipeline files, and scan-history.tsv.`);
    process.exit(1);
  }

  const prompt = [
    'Generate an ATS-optimized tailored resume for this existing tracked application.',
    'Do not create or update any evaluation report.',
    `Tracker Number: ${row.number}`,
    `Company: ${row.company}`,
    `Role: ${row.role}`,
    `Current Score: ${row.scoreRaw}`,
    `JD URL: ${jobUrl}`,
    'Run only the PDF/resume flow from the system prompt.',
  ].join(' ');

  console.log(`Job #${row.number}: ${row.company} | ${row.role}`);
  console.log(`Score: ${row.scoreRaw}`);
  console.log(`URL:   ${jobUrl}`);

  if (dryRun) {
    console.log('Dry run: resolved inputs successfully.');
    return;
  }

  const result = spawnSync('claude', [
    '-p',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file',
    MODE_PATH,
    prompt,
  ], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

main();
