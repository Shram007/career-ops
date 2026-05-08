#!/usr/bin/env node

/**
 * deduplicate-websearch.mjs
 *
 * Deduplicates WebSearch result lines against existing project sources:
 * - data/scan-history.tsv (URL column)
 * - data/pipeline.md (URL text match)
 * - data/applications.md (URL text match)
 *
 * Input format (one per line):
 *   <url> | <company> | <role>
 *
 * Usage:
 *   node scripts/deduplicate-websearch.mjs
 *   node scripts/deduplicate-websearch.mjs --results /tmp/websearch-results.txt
 *   node scripts/deduplicate-websearch.mjs --output /tmp/new-websearch-jobs.json
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const DEFAULT_RESULTS = '/tmp/websearch-results.txt';
const DEFAULT_OUTPUT = '/tmp/new-websearch-jobs.json';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    resultsPath: DEFAULT_RESULTS,
    outputPath: DEFAULT_OUTPUT,
    repoRoot: process.cwd(),
    allowMissingResults: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--results') {
      out.resultsPath = args[++i] || '';
      if (!out.resultsPath) throw new Error('Invalid --results value');
      continue;
    }

    if (arg === '--output') {
      out.outputPath = args[++i] || '';
      if (!out.outputPath) throw new Error('Invalid --output value');
      continue;
    }

    if (arg === '--repo-root') {
      out.repoRoot = args[++i] || '';
      if (!out.repoRoot) throw new Error('Invalid --repo-root value');
      continue;
    }

    if (arg === '--allow-missing-results') {
      out.allowMissingResults = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      console.log('Usage:');
      console.log('  node scripts/deduplicate-websearch.mjs [--results <path>] [--output <path>] [--repo-root <path>] [--allow-missing-results]');
      console.log('');
      console.log('Defaults:');
      console.log(`  --results   ${DEFAULT_RESULTS}`);
      console.log(`  --output    ${DEFAULT_OUTPUT}`);
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return out;
}

function readTextOrEmpty(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function loadScanUrlSet(scanHistoryPath) {
  const text = readTextOrEmpty(scanHistoryPath);
  if (!text.trim()) return new Set();

  const lines = text.split(/\r?\n/).slice(1); // skip header
  const set = new Set();

  for (const line of lines) {
    if (!line.trim()) continue;
    const url = line.split('\t')[0]?.trim();
    if (url) set.add(url);
  }

  return set;
}

function loadWebsearchResults(resultsPath, allowMissingResults) {
  if (!existsSync(resultsPath)) {
    if (allowMissingResults) {
      console.log(`Results file not found; continuing with empty input: ${resultsPath}`);
      return [];
    }
    throw new Error(`Results file not found: ${resultsPath}`);
  }

  const text = readFileSync(resultsPath, 'utf8');
  const rows = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const parts = line.split(' | ');
    if (parts.length < 3) continue;

    const [url, company, ...roleParts] = parts;
    const role = roleParts.join(' | ');

    rows.push({
      url: url.trim(),
      company: company.trim(),
      role: role.trim(),
    });
  }

  return rows;
}

function main() {
  const { resultsPath, outputPath, repoRoot, allowMissingResults } = parseArgs(process.argv);

  const scanHistoryPath = resolve(repoRoot, 'data/scan-history.tsv');
  const pipelinePath = resolve(repoRoot, 'data/pipeline.md');
  const applicationsPath = resolve(repoRoot, 'data/applications.md');

  const scanSet = loadScanUrlSet(scanHistoryPath);
  const pipelineText = readTextOrEmpty(pipelinePath);
  const applicationsText = readTextOrEmpty(applicationsPath);
  const results = loadWebsearchResults(resultsPath, allowMissingResults);

  let duplicates = 0;
  const newJobs = [];

  for (const job of results) {
    const isDup =
      scanSet.has(job.url) ||
      pipelineText.includes(job.url) ||
      applicationsText.includes(job.url);

    if (isDup) {
      duplicates += 1;
    } else {
      newJobs.push(job);
    }
  }

  console.log(`Total WebSearch results: ${results.length}`);
  console.log(`Duplicates found: ${duplicates}`);
  console.log(`New jobs to add: ${newJobs.length}`);

  if (newJobs.length > 0) {
    console.log('\nNew jobs from WebSearch:');
    for (const job of newJobs) {
      console.log(`  + ${job.company} | ${job.role}`);
    }
  }

  writeFileSync(outputPath, `${JSON.stringify(newJobs, null, 2)}\n`, 'utf8');
  console.log(`\nSaved: ${outputPath}`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
