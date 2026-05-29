#!/usr/bin/env node
/**
 * score-url.mjs
 *
 * Single-purpose: Score a job URL and append to tracker if score >= 3.0
 * Usage: node score-url.mjs --url <url>
 *
 * Flow:
 * 1. Validate URL (not listing, not non-job)
 * 2. Dedup check (exact URL + fuzzy company+role)
 * 3. Scope filters (location + seniority blocks)
 * 4. Scrape JD via Playwright
 * 5. Score via gemini-eval.mjs
 * 6. If >= 3.0: append to applications.md with status Scored
 * 7. Output summary
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { tmpdir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
if (urlIdx < 0 || !args[urlIdx + 1]) {
  console.error('Usage: node score-url.mjs --url <url>');
  process.exit(1);
}

const url = args[urlIdx + 1];

// State tracking
let errors = [];
let decision = null; // 'advance', 'hold', or 'error'
let score = null;
let company = null;
let role = null;
let reasonTags = '';

// ============================================================================
// 1. VALIDATE URL TYPE (listing vs job vs non-job)
// ============================================================================

function detectUrlType(urlStr) {
  try {
    const u = new URL(urlStr);
    const path = u.pathname.toLowerCase();

    // Job URL patterns (specific posting) — check FIRST
    if (path.match(/\/job[s]?\/view\/\d+/) ||
        path.match(/\/job[s]?\/\d+/) ||
        path.match(/\/careers\/job\/[a-zA-Z0-9]+/) ||
        path.match(/\/career/) ||
        u.hostname.includes('lever.co') ||
        u.hostname.includes('ashbyhq.com') ||
        u.hostname.includes('linkedin.com') && path.includes('/jobs/')) {
      return 'job';
    }

    // Listing URL patterns — check AFTER specific job
    if (path.includes('/jobs') || path.includes('/careers') ||
        path.includes('/job-board') || path.includes('/search') ||
        path.includes('/positions') || path.includes('/apply')) {
      return 'listing';
    }

    // Likely non-job
    if (path === '/' || path === '' || path.includes('about') ||
        path.includes('contact') || path.includes('blog')) {
      return 'other';
    }

    // Assume job if domain matches job board
    return 'job';
  } catch {
    return 'invalid';
  }
}

const urlType = detectUrlType(url);
if (urlType === 'listing') {
  console.log(`❌ Listing URL detected. Use \`node scan-playwright.mjs --url <url>\` to discover jobs.`);
  process.exit(0);
}

if (urlType === 'invalid') {
  console.log(`❌ Invalid URL: ${url}`);
  process.exit(1);
}

if (urlType === 'other') {
  console.log(`❌ Not a job posting. URL appears to be: company homepage, contact page, or blog.`);
  process.exit(1);
}

// ============================================================================
// 2. DEDUP CHECK
// ============================================================================

function readAllTrackers() {
  const apps = existsSync('data/applications.md') ? readFileSync('data/applications.md', 'utf8') : '';
  const pipeline = existsSync('data/pipeline.md') ? readFileSync('data/pipeline.md', 'utf8') : '';
  const pipelineRef = existsSync('data/pipeline-referral.md') ? readFileSync('data/pipeline-referral.md', 'utf8') : '';
  return { apps, pipeline, pipelineRef };
}

const trackers = readAllTrackers();
const allText = trackers.apps + trackers.pipeline + trackers.pipelineRef;

// Exact URL match
if (allText.includes(url)) {
  const lines = trackers.apps.split('\n');
  for (const line of lines) {
    if (line.includes(url)) {
      const parts = line.split('|');
      if (parts.length > 1) {
        const num = parseInt(parts[1].trim());
        if (!isNaN(num)) {
          console.log(`⚠️  URL already tracked as #${num}`);
          process.exit(0);
        }
      }
    }
  }
  console.log(`⚠️  URL already tracked`);
  process.exit(0);
}

// ============================================================================
// 3. SCRAPE JD (Playwright)
// ============================================================================

let jdText = '';
let pageTitle = '';

async function scrapeJD() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    pageTitle = await page.title();

    // Extract main content
    const content = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.substring(0, 5000); // Cap at 5KB
    });

    jdText = content;

    // Extract company and role from page
    const heading = await page.evaluate(() => document.querySelector('h1')?.innerText || '');
    if (heading) {
      const parts = heading.split('|').map(s => s.trim());
      if (parts.length >= 2) {
        role = parts[0];
        company = parts[1];
      } else {
        role = parts[0];
      }
    }

    await browser.close();
  } catch (err) {
    await browser.close();
    errors.push(`Scrape failed: ${err.message}`);
    decision = 'error';
  }
}

await scrapeJD();
if (decision === 'error') {
  console.log(`❌ ${errors[0]}`);
  process.exit(1);
}

// ============================================================================
// 4. SCOPE FILTERS (location + seniority blocks)
// ============================================================================

const LOCATION_BLOCKS = [
  'emea', 'europe', 'uk', 'united kingdom', 'germany', 'france', 'netherlands',
  'spain', 'italy', 'sweden', 'poland', 'india', 'apac', 'asia pacific',
  'singapore', 'australia', 'latin america', 'latam', 'dubai', 'uae', 'middle east'
];

const SENIORITY_BLOCKS = [
  'staff', 'principal', 'director', 'vp', 'vice president', 'head of'
];

const jdLower = jdText.toLowerCase();
const roleLower = (role || pageTitle).toLowerCase();

// Location block
let locationBlock = false;
let blockedLocation = '';

for (const loc of LOCATION_BLOCKS) {
  if ((jdLower.includes(loc) || roleLower.includes(loc)) &&
      !jdLower.includes('remote') && !jdLower.includes('global') && !jdLower.includes('work from anywhere')) {
    locationBlock = true;
    blockedLocation = loc.toUpperCase();
    break;
  }
}

if (locationBlock) {
  console.log(`⏸️  Location block: ${company || 'Company'} | ${role || pageTitle} | hold | location:${blockedLocation}`);
  process.exit(0);
}

// Seniority block
let seniorityBlock = false;
let blockedLevel = '';

for (const level of SENIORITY_BLOCKS) {
  if (roleLower.includes(level)) {
    seniorityBlock = true;
    blockedLevel = level;
    break;
  }
}

if (seniorityBlock) {
  console.log(`⏸️  Seniority block: ${company || 'Company'} | ${role || pageTitle} | hold | seniority:overleveled`);
  process.exit(0);
}

// ============================================================================
// 5. SCORE (via gemini-eval.mjs)
// ============================================================================

const tempJdFile = join(tmpdir(), `jd_${Date.now()}.txt`);
writeFileSync(tempJdFile, jdText);

let scoreOutput = '';
try {
  scoreOutput = execSync(`node gemini-eval.mjs --file ${tempJdFile}`, { encoding: 'utf8' });
} catch (err) {
  errors.push(`Scoring failed: ${err.message}`);
  decision = 'error';
}

if (decision === 'error') {
  console.log(`❌ Scoring failed`);
  process.exit(1);
}

// Parse score from output: look for "Score: X.X/5"
const scoreMatch = scoreOutput.match(/score[:\s]+([0-9.]+)/i);
if (scoreMatch) {
  score = parseFloat(scoreMatch[1]);
} else {
  // Try to find any number/5 pattern
  const altMatch = scoreOutput.match(/([0-9.]+)\/5/);
  if (altMatch) {
    score = parseFloat(altMatch[1]);
  }
}

if (score === null || isNaN(score)) {
  console.log(`❌ Could not parse score from output`);
  process.exit(1);
}

// ============================================================================
// 6. DECISION + APPEND (if score >= 3.0)
// ============================================================================

decision = score >= 3.0 ? 'advance' : 'hold';
reasonTags = 'from:dashboard-url';

if (decision === 'advance') {
  // Get next ID
  const apps = readFileSync('data/applications.md', 'utf8');
  let maxId = 0;
  for (const line of apps.split('\n')) {
    const parts = line.split('|');
    if (parts.length > 1) {
      const num = parseInt(parts[1].trim());
      if (!isNaN(num)) maxId = Math.max(maxId, num);
    }
  }

  const nextId = maxId + 1;
  const today = new Date().toISOString().split('T')[0];

  // Format tracker row
  const trackerRow = `| ${nextId} | ${today} | ${company || 'Unknown'} | ${role || pageTitle} | ${score}/5 | Scored | ❌ | - | ${reasonTags} | Unknown |`;

  // Append to applications.md
  let newApps = apps;
  if (!newApps.endsWith('\n')) newApps += '\n';
  newApps += trackerRow + '\n';

  try {
    writeFileSync('data/applications.md', newApps);
    console.log(`✅ Added as #${nextId} | ${company || 'Unknown'} | ${role || pageTitle} | ${score}/5 | advance`);
  } catch (err) {
    console.log(`❌ Failed to append to tracker: ${err.message}`);
    process.exit(1);
  }
} else {
  console.log(`⏸️  Held | ${company || 'Unknown'} | ${role || pageTitle} | ${score}/5 | hold`);
}

process.exit(0);
