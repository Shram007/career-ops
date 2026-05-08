#!/usr/bin/env node

/**
 * refresh-search-query-dates.mjs
 *
 * Updates `after:YYYY-MM-DD` date filters inside portals.yml search queries
 * to a rolling date relative to today.
 *
 * Usage:
 *   node refresh-search-query-dates.mjs
 *   node refresh-search-query-dates.mjs --days 14
 *   node refresh-search-query-dates.mjs --dry-run
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

const PORTALS_PATH = 'portals.yml';
const DEFAULT_DAYS = 14;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    days: DEFAULT_DAYS,
    dryRun: false,
    quiet: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--days') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error('Invalid --days value. Expected a positive integer.');
      }
      out.days = v;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--quiet') {
      out.quiet = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log('Usage:');
      console.log('  node refresh-search-query-dates.mjs [--days <N>] [--dry-run] [--quiet]');
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return out;
}

function formatDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function buildAfterDate(days) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return formatDateUTC(cutoff);
}

function main() {
  const { days, dryRun, quiet } = parseArgs(process.argv);

  if (!existsSync(PORTALS_PATH)) {
    throw new Error(`${PORTALS_PATH} not found`);
  }

  const before = readFileSync(PORTALS_PATH, 'utf-8');
  const afterDate = buildAfterDate(days);

  // Replace any existing fixed date after:YYYY-MM-DD inside query strings.
  const pattern = /after:\d{4}-\d{2}-\d{2}/g;
  let replaceCount = 0;
  const after = before.replace(pattern, () => {
    replaceCount += 1;
    return `after:${afterDate}`;
  });

  const changed = after !== before;

  if (!dryRun && changed) {
    writeFileSync(PORTALS_PATH, after, 'utf-8');
  }

  if (!quiet) {
    console.log(`Rolling window: past ${days} day(s)`);
    console.log(`Cutoff date: ${afterDate}`);
    console.log(`after: filters found: ${replaceCount}`);
    if (dryRun) {
      console.log('Mode: dry-run (no file changes written)');
    } else {
      console.log(changed ? `Updated: ${PORTALS_PATH}` : 'No changes needed (already current).');
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
