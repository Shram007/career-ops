#!/usr/bin/env node

/**
 * scan-with-instrumentation.mjs
 *
 * Orchestrates the scan flow and writes per-level execution receipts so each
 * run can prove which levels executed and with what outcome.
 *
 * Levels:
 *  - Level 1: Playwright bypass/access pass
 *  - Level 2: API scan (scan.mjs)
 *  - Level 3: WebSearch dedup pass (scripts/deduplicate-websearch.mjs)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { spawnSync } from 'child_process';

const REPORTS_DIR = 'reports';
const DATA_DIR = 'data';
const RUN_LEDGER_PATH = `${REPORTS_DIR}/scan-level-execution.tsv`;

function nowIso() {
  return new Date().toISOString();
}

function toDate(iso) {
  return iso.slice(0, 10);
}

function runIdFromIso(iso) {
  return iso.replace(/[-:.TZ]/g, '').slice(0, 14);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const passthrough = [];
  let skipLevel1 = false;
  let skipLevel3 = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--skip-level1') {
      skipLevel1 = true;
      continue;
    }

    if (arg === '--skip-level3') {
      skipLevel3 = true;
      continue;
    }

    passthrough.push(arg);
  }

  return { passthrough, skipLevel1, skipLevel3 };
}

function ensureDirs() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
}

function ensureLedger() {
  if (!existsSync(RUN_LEDGER_PATH)) {
    writeFileSync(
      RUN_LEDGER_PATH,
      'run_id\tlevel\tstatus\tstarted_at\tfinished_at\tduration_ms\tevidence\tsummary\n',
      'utf8'
    );
  }
}

function runNodeScript(scriptPath, scriptArgs = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  return {
    statusCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function appendLedgerRow(row) {
  const safeSummary = String(row.summary || '').replace(/[\t\n\r]+/g, ' ').trim();
  const line = [
    row.runId,
    row.level,
    row.status,
    row.startedAt,
    row.finishedAt,
    String(row.durationMs),
    row.evidence || '-',
    safeSummary || '-',
  ].join('\t') + '\n';

  appendFileSync(RUN_LEDGER_PATH, line, 'utf8');
}

function countTodayWebsearchRows(date) {
  const path = `${DATA_DIR}/scan-history.tsv`;
  if (!existsSync(path)) return 0;

  const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(1);
  let count = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const firstSeen = (cols[1] || '').trim();
    const portal = (cols[2] || '').trim().toLowerCase();
    if (firstSeen === date && portal === 'websearch') {
      count += 1;
    }
  }

  return count;
}

function summarizeStdout(stdout, fallback) {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return fallback;
  return lines.slice(-3).join(' | ').slice(0, 400);
}

function runLevel({ runId, level, evidence, scriptPath, scriptArgs, skip, skipReason }) {
  const startedAt = nowIso();

  if (skip) {
    const finishedAt = nowIso();
    const row = {
      runId,
      level,
      status: 'skipped',
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      evidence,
      summary: skipReason,
    };
    appendLedgerRow(row);
    return { ok: true, row, output: '' };
  }

  const result = runNodeScript(scriptPath, scriptArgs);
  const finishedAt = nowIso();
  const ok = result.statusCode === 0;

  const row = {
    runId,
    level,
    status: ok ? 'ok' : 'failed',
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    evidence,
    summary: summarizeStdout(result.stdout, `exit=${result.statusCode}`),
  };

  appendLedgerRow(row);

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  return { ok, row, output: result.stdout };
}

function writeRunSummary(path, summary) {
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

function main() {
  const { passthrough, skipLevel1, skipLevel3 } = parseArgs(process.argv);

  ensureDirs();
  ensureLedger();

  const runStartedAt = nowIso();
  const runDate = toDate(runStartedAt);
  const runId = runIdFromIso(runStartedAt);
  const summaryPath = `${REPORTS_DIR}/scan-run-${runId}.json`;

  console.log(`Scan run: ${runId}`);
  console.log(`Date: ${runDate}`);
  console.log('');

  const beforeWebsearchCount = countTodayWebsearchRows(runDate);

  const refresh = runLevel({
    runId,
    level: 'refresh-after',
    evidence: 'portals.yml',
    scriptPath: 'refresh-search-query-dates.mjs',
    scriptArgs: ['--days', '14', '--quiet'],
    skip: false,
    skipReason: '',
  });

  if (!refresh.ok) {
    console.error('Refresh step failed. Aborting scan.');
    process.exit(1);
  }

  const level1 = runLevel({
    runId,
    level: 'level1-playwright',
    evidence: `${REPORTS_DIR}/playwright-bypass.tsv`,
    scriptPath: 'check-playwright-bypass.mjs',
    scriptArgs: ['--output', `${REPORTS_DIR}/playwright-bypass.tsv`],
    skip: skipLevel1,
    skipReason: '--skip-level1 flag',
  });

  const level2 = runLevel({
    runId,
    level: 'level2-api',
    evidence: `${DATA_DIR}/scan-history.tsv;${DATA_DIR}/pipeline.md`,
    scriptPath: 'scan.mjs',
    scriptArgs: passthrough,
    skip: false,
    skipReason: '',
  });

  const level3 = runLevel({
    runId,
    level: 'level3-websearch-dedup',
    evidence: '/tmp/new-websearch-jobs.json',
    scriptPath: 'scripts/deduplicate-websearch.mjs',
    scriptArgs: ['--allow-missing-results'],
    skip: skipLevel3,
    skipReason: '--skip-level3 flag',
  });

  const afterWebsearchCount = countTodayWebsearchRows(runDate);

  const runFinishedAt = nowIso();
  const summary = {
    run_id: runId,
    started_at: runStartedAt,
    finished_at: runFinishedAt,
    levels: {
      refresh_after: refresh.row,
      level1_playwright: level1.row,
      level2_api: level2.row,
      level3_websearch_dedup: level3.row,
    },
    websearch_history_rows_today: {
      before: beforeWebsearchCount,
      after: afterWebsearchCount,
      delta: afterWebsearchCount - beforeWebsearchCount,
    },
  };

  writeRunSummary(summaryPath, summary);

  console.log('');
  console.log('Execution Proof');
  console.log('---------------');
  console.log(`Ledger: ${RUN_LEDGER_PATH}`);
  console.log(`Summary: ${summaryPath}`);
  console.log(`Websearch rows today: ${beforeWebsearchCount} -> ${afterWebsearchCount} (delta ${afterWebsearchCount - beforeWebsearchCount})`);
  console.log('');
  console.log('Levels:');
  console.log(`  Level 1 (Playwright): ${level1.row.status}`);
  console.log(`  Level 2 (API):        ${level2.row.status}`);
  console.log(`  Level 3 (Websearch):  ${level3.row.status}`);

  if (!level2.ok) {
    process.exit(1);
  }
}

main();
