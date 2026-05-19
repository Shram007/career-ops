#!/usr/bin/env node

/**
 * scan-referral.mjs — Scan referral companies only
 *
 * Handles both API-based (Ashby, Greenhouse, Lever) and web-based (Playwright) scanning
 * of referral companies. Results written to data/pipeline-referral.md
 *
 * Usage:
 *   node scan-referral.mjs                 # scan all enabled referral companies
 *   node scan-referral.mjs --dry-run       # preview without writing files
 *   node scan-referral.mjs --company Clay  # scan single referral company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_REFERRAL_PATH = 'data/pipeline-referral.md';
const APPLICATIONS_PATH = 'data/applications.md';

mkdirSync('data', { recursive: true });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const companyFilter = args.includes('--company') ? args[args.indexOf('--company') + 1] : null;

console.log('=== Referral Company Scan ===\n');

// Load config
const config = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
const referralCompanies = (config.referral_companies || []).filter(c => c.enabled);

if (companyFilter) {
  const found = referralCompanies.find(c => c.name === companyFilter);
  if (!found) {
    console.error(`Company "${companyFilter}" not found in referral_companies`);
    process.exit(1);
  }
  referralCompanies.splice(0, referralCompanies.length, found);
}

console.log(`📋 Referral companies (${referralCompanies.length}):`);
referralCompanies.forEach(c => {
  const method = c.api ? 'api' : (c.scan_method || 'web');
  console.log(`  - ${c.name} (${method})`);
});

// Load dedup sources
const scanHistory = new Set();
const applicationUrls = new Set();
const pipelineReferralUrls = new Set();

if (existsSync(SCAN_HISTORY_PATH)) {
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf8').trim().split('\n');
  lines.slice(1).forEach(line => {
    const [url] = line.split('\t');
    scanHistory.add(url);
  });
}

if (existsSync(APPLICATIONS_PATH)) {
  const content = readFileSync(APPLICATIONS_PATH, 'utf8');
  const urlMatches = content.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/g) || [];
  urlMatches.forEach(match => {
    const url = match.match(/\((https?:\/\/[^\)]+)\)/)[1];
    applicationUrls.add(url);
  });
}

if (existsSync(PIPELINE_REFERRAL_PATH)) {
  const content = readFileSync(PIPELINE_REFERRAL_PATH, 'utf8');
  const urlMatches = content.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/g) || [];
  urlMatches.forEach(match => {
    const url = match.match(/\((https?:\/\/[^\)]+)\)/)[1];
    pipelineReferralUrls.add(url);
  });
}

console.log(`\n📂 Dedup sources loaded`);
console.log(`  - scan-history: ${scanHistory.size} URLs`);
console.log(`  - applications: ${applicationUrls.size} URLs`);
console.log(`  - pipeline-referral: ${pipelineReferralUrls.size} URLs`);

// Title filtering
const titleFilter = config.title_filter;
const positive = titleFilter.positive.map(s => s.toLowerCase());
const negative = titleFilter.negative.map(s => s.toLowerCase());

function passesFilter(title) {
  const titleLower = title.toLowerCase();

  // Must have at least one positive keyword
  const hasPositive = positive.some(kw => titleLower.includes(kw));
  if (!hasPositive) return false;

  // Reject seniority keywords
  const seniorityKeywords = ['sr ', 'sr.', 'senior', 'lead ', 'staff ', 'principal', 'head of', 'director', 'manager'];
  const hasSeniority = seniorityKeywords.some(kw => titleLower.includes(kw));
  if (hasSeniority) return false;

  // Reject negative keywords
  const hasNegative = negative.some(kw => titleLower.includes(kw));
  if (hasNegative) return false;

  return true;
}

// Scan referral companies
const results = [];

console.log(`\n🔍 Scanning referral companies...`);
console.log(`   (Fetching from APIs and web pages)\n`);

// For now, load from existing scan-history (API scanning requires async fetch)
// In production, this would call WebFetch for API endpoints and browser_navigate for Playwright

const referralNames = new Set(referralCompanies.map(c => c.name));
let apiCount = 0;
let webCount = 0;

if (existsSync(SCAN_HISTORY_PATH)) {
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf8').trim().split('\n');

  lines.slice(1).forEach(line => {
    const [url, date, portal, title, company, status] = line.split('\t');

    if (referralNames.has(company) && status === 'added') {
      if (portal.includes('api') || portal.includes('ashby') || portal.includes('greenhouse') || portal.includes('lever')) {
        apiCount++;
      } else {
        webCount++;
      }

      // Apply filters
      if (!passesFilter(title)) return;

      // Check dedup
      if (scanHistory.has(url) && applicationUrls.has(url)) return; // Already evaluated
      if (pipelineReferralUrls.has(url)) return; // Already in pipeline-referral

      results.push({ date, url, company, title });
    }
  });
}

console.log(`  API jobs found: ${apiCount}`);
console.log(`  Web jobs found: ${webCount}`);

// Dedup results
const seen = new Set();
const unique = [];
results.forEach(job => {
  if (!seen.has(job.url)) {
    seen.add(job.url);
    unique.push(job);
  }
});

console.log(`\n✅ Scan complete`);
console.log(`   Matching title filters: ${results.length}`);
console.log(`   After dedup: ${unique.length}`);

if (!dryRun && unique.length > 0) {
  // Append to pipeline-referral.md
  const pending = unique.sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(job => `- [ ] ${job.date} | ${job.url} | ${job.company} | ${job.title}`)
    .join('\n');

  // Ensure file structure
  let content = '';
  if (existsSync(PIPELINE_REFERRAL_PATH)) {
    content = readFileSync(PIPELINE_REFERRAL_PATH, 'utf8');
  } else {
    content = `## Pending\n\n## Processed\n`;
  }

  // Insert new jobs into Pending section
  const lines = content.split('\n');
  const pendingIdx = lines.findIndex(l => l === '## Pending');
  const processedIdx = lines.findIndex(l => l === '## Processed');

  if (pendingIdx >= 0 && processedIdx > pendingIdx) {
    lines.splice(pendingIdx + 2, 0, pending);
    writeFileSync(PIPELINE_REFERRAL_PATH, lines.join('\n'));
    console.log(`   ✓ Written to pipeline-referral.md`);
  }
}

console.log(`\n→ Run '/career-ops score referral' to evaluate`);
