#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeRunReceipt } from './scripts/run-receipt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const wantsLegacy = args.includes('--legacy');
const isDiscovery = args.includes('--discovery');
const scope = isDiscovery ? 'discovery' : 'referral';

function hasBash() {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const out = spawnSync(whichCmd, ['bash'], { encoding: 'utf8' });
  return out.status === 0;
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: __dirname,
    stdio: 'inherit',
    encoding: 'utf8',
    env: { ...process.env },
  });
}

const start = Date.now();
let engine = wantsLegacy ? 'legacy-deterministic' : 'primary-batch';
let result;

if (engine === 'primary-batch') {
  if (!hasBash()) {
    console.warn('[scorer] bash unavailable; falling back to legacy deterministic scorer');
    engine = 'legacy-deterministic';
  } else {
    const batchArgs = ['batch/score-pipeline.sh', scope === 'discovery' ? '--discovery' : '--referral'];
    if (args.includes('--dry-run')) batchArgs.push('--dry-run');
    if (args.includes('--no-prescreen')) batchArgs.push('--no-prescreen');
    result = run('bash', batchArgs);
  }
}

if (engine === 'legacy-deterministic') {
  const legacyArgs = ['score-pipeline.mjs', scope === 'discovery' ? '--legacy-discovery' : '--legacy-referral'];
  result = run(process.execPath, legacyArgs);
}

const durationMs = Date.now() - start;
const receiptPath = writeRunReceipt(__dirname, 'score', {
  engine,
  scope,
  commandArgs: args,
  durationMs,
  exitCode: result?.status ?? 1,
});

console.log(`[scorer] receipt=${receiptPath}`);
process.exit(result?.status ?? 1);
