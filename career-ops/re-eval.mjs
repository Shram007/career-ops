#!/usr/bin/env node
/**
 * re-eval.mjs — Re-evaluate a specific tracker entry using Gemini
 *
 * Finds the job URL for entry #N, scrapes the JD with Playwright,
 * pipes the text through gemini-eval, and optionally updates the
 * tracker status from "skip" (or anything) to "Evaluated".
 *
 * Usage:
 *   node re-eval.mjs --id <N>
 *   node re-eval.mjs --id <N> --no-save     (print eval, don't write report)
 *   node re-eval.mjs --id <N> --update-status  (auto-update status if score >= 3.5)
 *   npm run re-eval -- --id 5
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';
import { appendStatusHistory } from './scripts/status-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const APPS_PATH = existsSync(join(__dirname, 'data', 'applications.md'))
  ? join(__dirname, 'data', 'applications.md')
  : join(__dirname, 'applications.md');

const BATCH_INPUT_PATH = join(__dirname, 'batch', 'batch-input.tsv');
const PIPELINE_PATHS = [
  join(__dirname, 'data', 'pipeline-referral.md'),
  join(__dirname, 'data', 'pipeline.md'),
];
const TMP_DIR = join(__dirname, 'tmp');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  let id = null;
  let noSave = false;
  let updateStatus = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--id') { id = Number(args[++i]); continue; }
    if (a === '--no-save') { noSave = true; continue; }
    if (a === '--update-status') { updateStatus = true; continue; }
    if (a === '-h' || a === '--help') {
      console.log('Usage: node re-eval.mjs --id <N> [--no-save] [--update-status]');
      process.exit(0);
    }
  }

  if (!Number.isFinite(id) || id <= 0) {
    console.error('Usage: node re-eval.mjs --id <N>');
    process.exit(1);
  }
  return { id: Math.floor(id), noSave, updateStatus };
}

// ---------------------------------------------------------------------------
// Parse applications.md
// ---------------------------------------------------------------------------
function parseApplicationsTable(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    if (line.includes('|---')) continue;
    if (line.toLowerCase().includes('| # |')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 10) continue;
    const num = Number(parts[1]);
    if (!Number.isFinite(num)) continue;
    const reportMatch = (parts[8] || '').match(/\[[^\]]+\]\(([^)]+)\)/);
    out.push({
      number: num,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      scoreRaw: parts[5],
      status: parts[6],
      reportPath: reportMatch ? reportMatch[1] : '',
      notes: parts[9] || '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL extraction — try report file, batch-input.tsv, and pipeline files
// ---------------------------------------------------------------------------
function extractUrlFromReport(reportAbsPath) {
  if (!existsSync(reportAbsPath)) return '';
  const content = readFileSync(reportAbsPath, 'utf8');
  const m = content.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/m);
  return m ? m[1].trim() : '';
}

function extractUrlFromBatchInput(row) {
  if (!existsSync(BATCH_INPUT_PATH)) return '';
  const lines = readFileSync(BATCH_INPUT_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 4 || cols[0] === 'id') continue;
    // Match by company + role in notes field
    const notes = cols[3] || '';
    const company = cols[1] ? String(cols[1]).trim() : '';
    if (
      company.toLowerCase() === row.company.toLowerCase() ||
      notes.toLowerCase().includes(row.company.toLowerCase())
    ) {
      const idx = notes.lastIndexOf('| ');
      if (idx >= 0) {
        const candidate = notes.slice(idx + 2).trim();
        if (candidate.startsWith('http')) return candidate;
      }
      if ((cols[1] || '').startsWith('http')) return cols[1].trim();
    }
  }
  return '';
}

function extractUrlFromPipelineFiles(row) {
  const nameKey = row.company.toLowerCase();
  const roleKey = row.role.toLowerCase().slice(0, 30);
  for (const p of PIPELINE_PATHS) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const lower = line.toLowerCase();
      if (!lower.includes(nameKey)) continue;
      // Pipeline format: - [ ] DATE | URL | Company | Role
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (urlMatch && lower.includes(roleKey.slice(0, 15))) return urlMatch[0].trim();
    }
  }
  // Looser pass: just company name
  for (const p of PIPELINE_PATHS) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.toLowerCase().includes(nameKey)) continue;
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (urlMatch) return urlMatch[0].trim();
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Playwright: scrape JD text from job URL
// ---------------------------------------------------------------------------
async function scrapeJobText(url) {
  console.log(`\n🌐  Scraping JD from: ${url}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Extract visible text — prefer main content selectors, fallback to body
    const text = await page.evaluate(() => {
      const selectors = [
        '[data-automation="job-description"]',
        '[class*="job-description"]',
        '[class*="jobDescription"]',
        '[id*="job-description"]',
        '[id*="jobDescription"]',
        'article',
        'main',
        '#content',
        '.content',
        'body',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const t = el.innerText || el.textContent || '';
          if (t.trim().length > 300) return t.trim();
        }
      }
      return document.body.innerText || document.body.textContent || '';
    });

    return text.replace(/\s{3,}/g, '\n\n').trim();
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Status update in applications.md
// ---------------------------------------------------------------------------
function updateStatus(id, newStatus) {
  const text = readFileSync(APPS_PATH, 'utf8');
  const lines = text.split(/\r?\n/);
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (Number(parts[1]) !== id) continue;

    // Append status to preserve history and show latest state.
    const cols = line.split('|');
    const currentStatus = (cols[6] || '').trim();
    cols[6] = ` ${appendStatusHistory(currentStatus, newStatus)} `;
    lines[i] = cols.join('|');
    updated = true;
    break;
  }

  if (updated) {
    writeFileSync(APPS_PATH, lines.join('\n'), 'utf8');
    console.log(`\n✅  Status updated → ${newStatus} in applications.md`);
  } else {
    console.warn(`\n⚠️  Could not find entry #${id} in applications.md to update status`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { id, noSave, updateStatus: doUpdateStatus } = parseArgs(process.argv);

  if (!existsSync(APPS_PATH)) {
    console.error(`applications.md not found: ${APPS_PATH}`);
    process.exit(1);
  }

  const apps = parseApplicationsTable(readFileSync(APPS_PATH, 'utf8'));
  const row = apps.find(a => a.number === id);

  if (!row) {
    console.error(`Entry #${id} not found in applications.md`);
    process.exit(1);
  }

  console.log(`\n🔍  Re-evaluating: #${id} — ${row.company} | ${row.role}`);
  console.log(`    Current status: ${row.status}  score: ${row.scoreRaw || '—'}`);

  // --- Find job URL ---
  let jobUrl = '';

  if (row.reportPath) {
    const absReport = join(__dirname, row.reportPath);
    jobUrl = extractUrlFromReport(absReport);
    if (jobUrl) console.log(`    URL found in report file`);
  }
  if (!jobUrl) {
    jobUrl = extractUrlFromPipelineFiles(row);
    if (jobUrl) console.log(`    URL found in pipeline file`);
  }
  if (!jobUrl) {
    jobUrl = extractUrlFromBatchInput(row);
    if (jobUrl) console.log(`    URL found in batch-input.tsv`);
  }

  if (!jobUrl) {
    console.error(`\n❌  Could not find a job URL for entry #${id}.`);
    console.error(`    Try: node re-eval.mjs --id ${id}  (after adding URL to the report or pipeline file)`);
    process.exit(1);
  }

  console.log(`    Job URL: ${jobUrl}`);

  // --- Scrape JD ---
  let jdText;
  try {
    jdText = await scrapeJobText(jobUrl);
  } catch (err) {
    console.error(`\n❌  Failed to scrape job page: ${err.message}`);
    process.exit(1);
  }

  if (!jdText || jdText.length < 100) {
    console.error(`\n❌  Scraped page is too short (${jdText?.length ?? 0} chars) — may be behind auth or redirected`);
    process.exit(1);
  }

  console.log(`    JD scraped: ${jdText.length} chars`);

  // --- Write to tmp file ---
  mkdirSync(TMP_DIR, { recursive: true });
  const jdTmpPath = join(TMP_DIR, `jd-reeval-${id}.txt`);
  writeFileSync(jdTmpPath, `# Re-eval: ${row.company} — ${row.role}\n# URL: ${jobUrl}\n# Original status: ${row.status}\n\n${jdText}`, 'utf8');
  console.log(`    JD written to: tmp/jd-reeval-${id}.txt`);

  // --- Run gemini-eval ---
  const evalArgs = ['gemini-eval.mjs', '--file', jdTmpPath];
  if (noSave) evalArgs.push('--no-save');

  console.log(`\n🤖  Running Gemini evaluation...\n${'─'.repeat(60)}`);

  const result = spawnSync(process.execPath, evalArgs, {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env },
  });

  const output = (result.stdout || '') + (result.stderr || '');
  process.stdout.write(output);

  if (result.status !== 0) {
    console.error(`\n❌  gemini-eval exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }

  // --- Optionally update status ---
  if (doUpdateStatus) {
    // Parse score from gemini-eval output
    const scoreMatch = output.match(/SCORE:\s*([\d.]+)/);
    const newScore = scoreMatch ? Number(scoreMatch[1]) : NaN;
    if (Number.isFinite(newScore) && newScore >= 3.5) {
      updateStatus(id, 'Evaluated');
    } else if (Number.isFinite(newScore)) {
      console.log(`\n⚠️  Score ${newScore} < 3.5 — status left as "${row.status}"`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
