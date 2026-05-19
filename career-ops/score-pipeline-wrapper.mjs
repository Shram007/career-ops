#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeRunReceipt } from './scripts/run-receipt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const isDiscovery = args.includes('--discovery');
const scope = isDiscovery ? 'discovery' : 'referral';

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: __dirname,
    stdio: 'inherit',
    encoding: 'utf8',
    env: { ...process.env },
  });
}

const start = Date.now();
const engine = 'universal-deterministic';
const scorerArgs = ['score-pipeline.mjs', scope === 'discovery' ? '--legacy-discovery' : '--legacy-referral'];
if (args.includes('--dry-run')) {
  scorerArgs.push('--dry-run');
}
const result = run(process.execPath, scorerArgs);

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
