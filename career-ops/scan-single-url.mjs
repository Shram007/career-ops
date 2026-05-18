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
import { pathToFileURL } from 'url';

function toLower(value) {
  return String(value || '').toLowerCase();
}

function safeUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isLikelyApiUrl(inputUrl) {
  const u = safeUrl(inputUrl);
  if (!u) return false;

  const host = toLower(u.hostname);
  const path = toLower(u.pathname);

  if (host.startsWith('api.')) return true;
  if (/\b(boards-api\.greenhouse\.io|api\.greenhouse\.io|api\.ashbyhq\.com|api\.lever\.co)\b/i.test(host)) return true;
  if (/\/(api|graphql|v\d+)\//i.test(path)) return true;
  return false;
}

function isLikelyJobDetailUrl(inputUrl) {
  const u = safeUrl(inputUrl);
  if (!u) return false;

  const lowerHref = toLower(u.href);
  const lowerPath = toLower(u.pathname);

  if (/(gh_jid=|jobid=|job_details|\/jobs\/view\/|\/careers\/job\/|\/profile\/job_details\/|\/apply(?:\?|#|$))/i.test(lowerHref)) {
    return true;
  }

  if (/jobs\.lever\.co\/[a-z0-9_-]+\/[a-z0-9-]{8,}/i.test(lowerHref)) return true;
  if (/jobs\.ashbyhq\.com\/[a-z0-9_-]+\/[a-z0-9-]{8,}/i.test(lowerHref)) return true;
  if (/boards?\.greenhouse\.io\/[a-z0-9_-]+\/jobs\/\d+/i.test(lowerHref)) return true;
  if (/myworkdayjobs\.com\/.+\/job\//i.test(lowerHref)) return true;
  if (/\/jobs\/results\/\d+-[a-z0-9-]+/i.test(lowerPath)) return true;

  return false;
}

function isLikelyListingUrl(inputUrl) {
  const u = safeUrl(inputUrl);
  if (!u) return false;

  const lowerHref = toLower(u.href);
  const lowerPath = toLower(u.pathname);

  if (/(\?|&)(q|query|keywords|search|keyword)=/i.test(lowerHref)) return true;
  if (/\/(search|results|jobsearch)(\/|$)/i.test(lowerPath)) return true;
  if (/\/jobs?(\/|\?|$)/i.test(lowerPath)) return true;
  if (/\/(careers?|opportunities)(\/|$)/i.test(lowerPath)) return true;
  if (/\b(job-boards\.greenhouse\.io|boards\.greenhouse\.io|jobs\.ashbyhq\.com|jobs\.lever\.co)\b/i.test(lowerHref)) return true;

  return false;
}

export function detectUrlType(inputUrl) {
  if (isLikelyApiUrl(inputUrl)) return 'api';
  if (isLikelyJobDetailUrl(inputUrl)) return 'job_detail';
  if (isLikelyListingUrl(inputUrl)) return 'listing';
  return 'unknown';
}

export function resolveScannerRoute(inputUrl) {
  const urlType = detectUrlType(inputUrl);
  if (urlType === 'api') {
    return { urlType, script: 'scan.mjs', scriptArgs: ['--url', inputUrl], reason: 'api endpoint' };
  }
  if (urlType === 'job_detail') {
    return { urlType, script: 'scan-playwright.mjs', scriptArgs: ['--url', inputUrl], reason: 'single job detail' };
  }
  if (urlType === 'listing') {
    return { urlType, script: 'scan-playwright.mjs', scriptArgs: ['--url', inputUrl], reason: 'listing/search page' };
  }
  return { urlType, script: 'scan-playwright.mjs', scriptArgs: ['--url', inputUrl], reason: 'unknown URL, safest fallback' };
}

function runScript(script, scriptArgs = []) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  process.exit(result.status ?? 1);
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const first = args.find(a => !a.startsWith('-')) || '';
  return {
    url: first.trim(),
    routeOnly: args.includes('--route-only'),
  };
}

function main(argv = process.argv) {
  const { url, routeOnly } = parseCliArgs(argv);
  if (!url) {
    console.error('Usage: node scan-single-url.mjs <url> [--route-only]');
    process.exit(1);
  }

  if (!url.toLowerCase().startsWith('http')) {
    console.error('Error: must be a valid URL (https://...)');
    process.exit(1);
  }

  const route = resolveScannerRoute(url);

  console.log(`URL detected: ${route.urlType.toUpperCase()}`);
  console.log(`URL: ${url}`);
  console.log(`Routing to: ${route.script} (${route.reason})`);

  if (routeOnly) {
    return;
  }

  runScript(route.script, route.scriptArgs);
}

const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
