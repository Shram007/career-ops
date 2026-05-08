#!/usr/bin/env node

/**
 * check-playwright-bypass.mjs
 *
 * Tests whether Playwright can access each tracked company's careers page.
 * Classifies each target as: bypassed, blocked, failed, or unclear.
 *
 * Usage:
 *   node check-playwright-bypass.mjs
 *   node check-playwright-bypass.mjs --company Anthropic
 *   node check-playwright-bypass.mjs --headful
 *   node check-playwright-bypass.mjs --timeout 20000
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';

const parseYaml = yaml.load;

const PORTALS_PATH = 'portals.yml';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_OUTPUT_PATH = 'reports/playwright-bypass.tsv';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    headless: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    companyFilter: null,
    outputPath: DEFAULT_OUTPUT_PATH,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--headful') {
      out.headless = false;
      continue;
    }
    if (arg === '--timeout') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error('Invalid --timeout value. Expected positive integer milliseconds.');
      }
      out.timeoutMs = v;
      continue;
    }
    if (arg === '--company') {
      out.companyFilter = (args[++i] || '').toLowerCase().trim();
      if (!out.companyFilter) {
        throw new Error('Invalid --company value.');
      }
      continue;
    }
    if (arg === '--output') {
      out.outputPath = args[++i] || DEFAULT_OUTPUT_PATH;
      if (!out.outputPath) {
        throw new Error('Invalid --output value.');
      }
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log('Usage:');
      console.log('  node check-playwright-bypass.mjs [--company <name>] [--headful] [--timeout <ms>] [--output <path>]');
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return out;
}

function classifyAccess({ status, finalUrl, title, bodyText, navError }) {
  if (navError) {
    return {
      result: 'failed',
      reason: `navigation error: ${navError}`,
    };
  }

  const statusCode = Number(status || 0);
  const lowerTitle = (title || '').toLowerCase();
  const lowerBody = (bodyText || '').toLowerCase();
  const lowerFinalUrl = (finalUrl || '').toLowerCase();

  const blockedRegex = /(captcha|verify you are human|are you human|security check|access denied|forbidden|unusual traffic|bot detection|just a moment|cloudflare|request blocked)/i;
  const blockedByText = blockedRegex.test(lowerTitle) || blockedRegex.test(lowerBody);
  const blockedByUrl = /captcha|challenge|cf_chl|blocked|forbidden/.test(lowerFinalUrl);

  if ([401, 403, 429, 503].includes(statusCode) || blockedByText || blockedByUrl) {
    return {
      result: 'blocked',
      reason: `status=${statusCode || '-'}${blockedByText || blockedByUrl ? ', anti-bot/challenge detected' : ''}`,
    };
  }

  if (statusCode >= 400) {
    return {
      result: 'failed',
      reason: `HTTP ${statusCode}`,
    };
  }

  const contentLen = lowerBody.replace(/\s+/g, ' ').trim().length;
  const careerSignals = /(job|jobs|career|careers|openings|position|positions|we'?re hiring|apply)/i.test(lowerBody);

  if (contentLen >= 350 && careerSignals) {
    return {
      result: 'bypassed',
      reason: `status=${statusCode || '-'}, content=${contentLen}`,
    };
  }

  return {
    result: 'unclear',
    reason: `status=${statusCode || '-'}, weak career signals (content=${contentLen})`,
  };
}

function loadTargets(companyFilter) {
  if (!existsSync(PORTALS_PATH)) {
    throw new Error('portals.yml not found.');
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config?.tracked_companies || [];

  return companies
    .filter((c) => c?.enabled !== false)
    .filter((c) => typeof c?.careers_url === 'string' && c.careers_url.trim().length > 0)
    .filter((c) => !companyFilter || String(c.name || '').toLowerCase().includes(companyFilter))
    .map((c) => ({
      name: c.name || 'Unknown',
      careers_url: c.careers_url,
      scan_method: c.scan_method || '-',
    }));
}

async function checkCompany(page, target, timeoutMs) {
  let response = null;
  let navError = null;

  try {
    response = await page.goto(target.careers_url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    await page.waitForTimeout(2000);
  } catch (err) {
    navError = String(err?.message || err).split('\n')[0];
  }

  const status = response?.status?.() ?? 0;
  const finalUrl = page.url();

  let title = '';
  let bodyText = '';
  if (!navError) {
    title = await page.title().catch(() => '');
    bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  }

  const classification = classifyAccess({
    status,
    finalUrl,
    title,
    bodyText,
    navError,
  });

  return {
    company: target.name,
    scan_method: target.scan_method,
    careers_url: target.careers_url,
    status,
    final_url: finalUrl,
    result: classification.result,
    reason: classification.reason,
  };
}

function printSummary(rows) {
  const counts = rows.reduce((acc, row) => {
    acc[row.result] = (acc[row.result] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log('Summary');
  console.log('-------');
  console.log(`Bypassed: ${counts.bypassed || 0}`);
  console.log(`Blocked:  ${counts.blocked || 0}`);
  console.log(`Failed:   ${counts.failed || 0}`);
  console.log(`Unclear:  ${counts.unclear || 0}`);
}

function writeReport(rows, outputPath) {
  const dir = outputPath.includes('/') ? outputPath.slice(0, outputPath.lastIndexOf('/')) : '';
  if (dir) mkdirSync(dir, { recursive: true });

  const header = 'company\tscan_method\tresult\thttp_status\tcareers_url\tfinal_url\treason\n';
  const lines = rows
    .map((r) => [
      r.company,
      r.scan_method,
      r.result,
      String(r.status || '-'),
      r.careers_url,
      r.final_url,
      r.reason,
    ].join('\t'))
    .join('\n');

  writeFileSync(outputPath, header + lines + (lines ? '\n' : ''), 'utf-8');
}

async function main() {
  const { headless, timeoutMs, companyFilter, outputPath } = parseArgs(process.argv);
  const targets = loadTargets(companyFilter);

  if (targets.length === 0) {
    console.log('No tracked companies matched the filter.');
    return;
  }

  console.log(`Checking ${targets.length} tracked companies with Playwright...`);
  console.log(`Mode: ${headless ? 'headless' : 'headful'} | Timeout: ${timeoutMs}ms\n`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const rows = [];

  // Sequential by design. Project guidance avoids parallel Playwright runs.
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const row = await checkCompany(page, t, timeoutMs);
    rows.push(row);

    const icon = row.result === 'bypassed' ? '✅' : row.result === 'blocked' ? '🚫' : row.result === 'failed' ? '❌' : '⚠️';
    console.log(`${icon} [${String(i + 1).padStart(2, '0')}/${targets.length}] ${row.company} -> ${row.result} (${row.reason})`);
  }

  await context.close();
  await browser.close();

  printSummary(rows);
  writeReport(rows, outputPath);
  console.log(`\nReport written: ${outputPath}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
