#!/usr/bin/env node

/**
 * scan-single-url.mjs
 *
 * Accept a single URL and route to appropriate scanner:
 * - Explicit API URLs (api.lever.co, api.greenhouse.io, etc.) → scan.mjs
 * - Known SPA domains → scan-playwright.mjs
 * - Single job detail pages → scan-playwright.mjs (Playwright has special
 *   Lever/Greenhouse/Ashby title extraction for UUID-style job pages)
 * - Listing/search pages → scan-playwright.mjs
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

const lowerUrl = url.toLowerCase();

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

  // ATS single-job UUID patterns — must be checked BEFORE listingPatterns
  // because those patterns also match the same domains for listing pages.
  // Lever:      jobs.lever.co/{company}/{uuid}
  // Ashby:      jobs.ashbyhq.com/{company}/{uuid}
  // Greenhouse: boards.greenhouse.io/{company}/jobs/{numeric-id}
  if (/jobs\.lever\.co\/[^/?#]+\/[0-9a-f]{8}-[0-9a-f]{4}/i.test(lowerUrl)) return 'job_detail';
  if (/jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f]{8}-[0-9a-f]{4}/i.test(lowerUrl)) return 'job_detail';
  if (/boards\.greenhouse\.io\/[^/?#]+\/jobs\/\d+/i.test(lowerUrl)) return 'job_detail';

  // Listing pages (search/results/jobs)
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
console.log(`🔗 ${url}`);
console.log('');

switch (urlType) {
  case 'api':
    console.log('🚀 Routing to: scan.mjs (API endpoint)');
    console.log('💰 Cost: 0 credits (direct API call)');
    console.log('');
    runScript('scan.mjs', ['--url', url]);
    break;

  case 'spa':
    console.log('🚀 Routing to: scan-playwright.mjs (SPA domain requires Playwright)');
    console.log('⏱️  Cost: 1-2 credits (Playwright browser automation)');
    console.log('');
    runScript('scan-playwright.mjs', ['--url', url]);
    break;

  case 'listing':
    console.log('🚀 Routing to: scan-playwright.mjs (listing page)');
    console.log('⏱️  Cost: 1-2 credits (Playwright browser automation)');
    console.log('');
    runScript('scan-playwright.mjs', ['--url', url]);
    break;

  case 'job_detail':
    console.log('🚀 Routing to: scan-playwright.mjs (single job detail)');
    console.log('⏱️  Cost: 1-2 credits (Playwright for dynamic content)');
    console.log('');
    runScript('scan-playwright.mjs', ['--url', url]);
    break;

  case 'unknown':
  default:
    console.log('❓ URL type: unknown (could be API, SPA, or listing)');
    console.log('🚀 Routing to: scan-playwright.mjs (safest option)');
    console.log('⏱️  Cost: 1-2 credits');
    console.log('');
    runScript('scan-playwright.mjs', ['--url', url]);
    break;
}
