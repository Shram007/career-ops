#!/usr/bin/env node

/**
 * scan-single-url.mjs
 *
 * Accept a single URL and route to appropriate scanner:
 * - API endpoints → scan.mjs (zero-cost API)
 * - SPA domains → scan-playwright.mjs (required)
 * - Listing pages → scan-playwright.mjs
 * - Single jobs → WebFetch + fallback to Playwright
 */

import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scan-single-url.mjs <url>');
  process.exit(1);
}

const url = args[0].trim();

if (!url.toLowerCase().startsWith('http')) {
  console.error('Error: must be a valid URL (https://...)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1 — Normalize: transform known ATS single-job page URLs → public API URLs
// This avoids Playwright for pages that are fully accessible via zero-cost APIs.
// ---------------------------------------------------------------------------
let resolvedUrl = url;

// Lever: jobs.lever.co/{company}/{uuid}[/apply][?...]
// API:   api.lever.co/v0/postings/{company}/{uuid}
const leverJob = url.match(
  /^https?:\/\/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
);
if (leverJob) {
  resolvedUrl = `https://api.lever.co/v0/postings/${leverJob[1]}/${leverJob[2]}`;
}

// Greenhouse: boards.greenhouse.io/{company}/jobs/{id}
// API:        api.greenhouse.io/v1/boards/{company}/jobs/{id}
const greenhouseJob = url.match(
  /^https?:\/\/boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i
);
if (greenhouseJob) {
  resolvedUrl = `https://api.greenhouse.io/v1/boards/${greenhouseJob[1]}/jobs/${greenhouseJob[2]}`;
}

// Ashby: jobs.ashbyhq.com/{company}/{uuid}
// API:   api.ashbyhq.com/posting-api/job-board?jobPostingId={uuid}&organizationHostedJobsPageName={company}
const ashbyJob = url.match(
  /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
);
if (ashbyJob) {
  resolvedUrl = `https://api.ashbyhq.com/posting-api/job-board?jobPostingId=${ashbyJob[2]}&organizationHostedJobsPageName=${ashbyJob[1]}`;
}

const wasTransformed = resolvedUrl !== url;
const lowerUrl = resolvedUrl.toLowerCase();

// Detect URL type
function detectUrlType() {
  // API endpoints (zero-cost)
  const apiPatterns = [
    '/api/',
    '/v1/',
    '/v2/',
    'api.greenhouse.io',
    'api.ashbyhq.com',
    'api.lever.co',
  ];
  for (const pattern of apiPatterns) {
    if (lowerUrl.includes(pattern)) {
      return 'api';
    }
  }

  // SPA domains requiring Playwright
  const spaPatterns = [
    'metacareers.com',
    'uber.com/careers',
    'apply.careers.microsoft.com',
    'careers.cisco.com',
  ];
  for (const pattern of spaPatterns) {
    if (lowerUrl.includes(pattern)) {
      return 'spa';
    }
  }

  // Single job detail page (CHECK BEFORE listing — more specific patterns)
  const jobDetailPatterns = [
    '/job_details/',
    '/careers/job/',
    '/jobs/view/',
    '/apply?',
    '/apply#',
    'gh_jid=',
    'jobid=',
    '/profile/job_details/',
  ];
  for (const pattern of jobDetailPatterns) {
    if (lowerUrl.includes(pattern)) {
      return 'job_detail';
    }
  }

  // Listing pages (search/results/jobs)
  // Note: jobs.lever.co is NOT here — single Lever job URLs are transformed to
  // api.lever.co above. Only non-transformed lever.co URLs (edge cases) land here.
  const listingPatterns = [
    '/search',
    '/results',
    '/jobs?',
    '/jobs/',
    '?q=',
    '?query=',
    '?keywords=',
    '/jobsearch',
    'job-boards.greenhouse.io',
    'boards.greenhouse.io',
    'jobs.ashbyhq.com',
    'jobs.lever.co',
  ];
  for (const pattern of listingPatterns) {
    if (lowerUrl.includes(pattern)) {
      return 'listing';
    }
  }

  return 'unknown';
}

function runScript(script, scriptArgs = []) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  process.exit(result.status ?? 1);
}

const urlType = detectUrlType();

console.log(`📍 URL detected: ${urlType.toUpperCase()}`);
if (wasTransformed) {
  console.log(`🔗 Original:  ${url}`);
  console.log(`🔀 Resolved:  ${resolvedUrl}`);
} else {
  console.log(`🔗 ${resolvedUrl}`);
}
console.log('');

switch (urlType) {
  case 'api':
    console.log('🚀 Routing to: scan.mjs (API endpoint)');
    console.log('💰 Cost: 0 credits (direct API call)');
    console.log('');
    runScript('scan.mjs', ['--url', resolvedUrl]);
    break;

  case 'spa':
    console.log('🚀 Routing to: scan-playwright.mjs (SPA domain requires Playwright)');
    console.log('⏱️  Cost: 1-2 credits (Playwright browser automation)');
    console.log('');
    runScript('scan-playwright.mjs', ['--url', resolvedUrl]);
    break;

  case 'listing':
    console.log('🚀 Routing to: scan-playwright.mjs (listing page)');
    console.log('⏱️  Cost: 1-2 credits (Playwright browser automation)');
    console.log('');
    runScript('scan-playwright.mjs', ['--url', resolvedUrl]);
    break;

  case 'job_detail':
    console.log('🚀 Routing to: scan-playwright.mjs (single job detail)');
    console.log('⏱️  Cost: 1-2 credits (Playwright for dynamic content)');
    console.log('');
    runScript('scan-playwright.mjs', ['--url', resolvedUrl]);
    break;

  case 'unknown':
  default:
    console.log('❓ URL type: unknown (could be API, SPA, or listing)');
    console.log('🚀 Routing to: scan-playwright.mjs (safest option)');
    console.log('⏱️  Cost: 1-2 credits');
    console.log('');
    runScript('scan-playwright.mjs', ['--url', resolvedUrl]);
    break;
}
