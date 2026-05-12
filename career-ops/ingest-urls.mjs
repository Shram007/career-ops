#!/usr/bin/env node

/**
 * ingest-urls.mjs
 *
 * Batch-ingest manually collected job URLs into the pipeline.
 *
 * Input file: tmp/ingest-urls.txt
 *   - One URL per line
 *   - Optional inline title:  https://... | Software Engineer, AI Platform
 *   - Lines starting with # are comments (ignored)
 *   - Blank lines are ignored
 *
 * What this does:
 *   1. Reads all URLs from the input file
 *   2. Fetches page <title> for any URL that has no inline title
 *   3. Deduplicates against scan-history.tsv, pipeline.md, applications.md
 *   4. Appends new jobs to pipeline.md + scan-history.tsv
 *   5. Clears processed URLs from the input file (leaves comments intact)
 *
 * Usage:
 *   node ingest-urls.mjs [--dry-run] [--no-fetch-titles]
 *   npm run ingest
 *   npm run ingest -- --dry-run
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';

const INPUT_PATH = 'tmp/ingest-urls.txt';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

mkdirSync('tmp', { recursive: true });
mkdirSync('data', { recursive: true });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { dryRun: false, fetchTitles: true };
  for (const arg of args) {
    if (arg === '--dry-run') out.dryRun = true;
    if (arg === '--no-fetch-titles') out.fetchTitles = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedup helpers  (mirrors scan-playwright.mjs patterns)
// ---------------------------------------------------------------------------

function readTextOrEmpty(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function loadSeenUrls() {
  const seen = new Set();

  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf8').split(/\r?\n/).slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const url = line.split('\t')[0]?.trim();
      if (url) seen.add(url);
    }
  }

  for (const match of readTextOrEmpty(PIPELINE_PATH).matchAll(/https?:\/\/[^\s|)]+/g)) {
    seen.add(match[0]);
  }

  for (const match of readTextOrEmpty(APPLICATIONS_PATH).matchAll(/https?:\/\/[^\s|)]+/g)) {
    seen.add(match[0]);
  }

  return seen;
}

// ---------------------------------------------------------------------------
// Title fetcher  (plain HTTP, no Playwright)
// ---------------------------------------------------------------------------

async function fetchTitle(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });

    if (!res.ok) return null;

    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]{2,200})<\/title>/i);
    if (!match) return null;

    return match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*[|–—]\s*[^|–—]*$/, '') // Strip trailing "| Company Name" / "– Site Name" suffixes
      .trim();
  } catch {
    return null;
  }
}

// Derive a best-effort title from the URL path if HTTP fetch fails.
function titleFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    const decoded = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim();
    // Greenhouse / Lever job IDs are just numbers — not useful as titles
    if (/^\d+$/.test(decoded)) return null;
    return decoded.length > 3 ? decoded : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input file parser
// ---------------------------------------------------------------------------

function parseInputFile(text) {
  const entries = [];
  const commentLines = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (!line || line.startsWith('#')) {
      commentLines.push(raw);
      continue;
    }

    const [rawUrl, ...titleParts] = line.split('|');
    const url = rawUrl.trim();

    if (!/^https?:\/\/.+/i.test(url)) {
      console.warn(`  Skipping invalid URL: ${url}`);
      continue;
    }

    const inlineTitle = titleParts.join('|').trim() || null;
    entries.push({ url, inlineTitle });
  }

  return { entries, commentLines };
}

// ---------------------------------------------------------------------------
// Pipeline / history writers  (mirrors scan-playwright.mjs)
// ---------------------------------------------------------------------------

function ensureScanHistoryHeader() {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf8');
  }
}

function appendToPipeline(jobs) {
  if (jobs.length === 0) return;

  let text = readTextOrEmpty(PIPELINE_PATH);
  if (!text) text = '# Pipeline\n\n## Pendientes\n\n## Procesadas\n';

  const marker = '## Pendientes';
  const markerIndex = text.indexOf(marker);
  const nextSection = text.indexOf('\n## ', markerIndex + marker.length);
  const insertAt = nextSection === -1 ? text.length : nextSection;

  const block = '\n' + jobs.map(j =>
    `- [ ] ${j.posted_date} | ${j.url} | ${j.company} | ${j.title}`
  ).join('\n') + '\n';

  const out = markerIndex === -1
    ? `${text.trimEnd()}\n\n## Pendientes\n${block}\n`
    : text.slice(0, insertAt) + block + text.slice(insertAt);

  writeFileSync(PIPELINE_PATH, out, 'utf8');
}

function appendToScanHistory(jobs, date) {
  if (jobs.length === 0) return;
  ensureScanHistoryHeader();

  const lines = jobs.map(j =>
    `${j.url}\t${date}\tmanual\t${j.title}\t${j.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf8');
}

function writeExtractionCsv(accepted, rejected, date) {
  const csvPath = `data/ingest-extraction-${date}.csv`;

  // CSV header: Date, Company, Title, URL, Status, Rejection Reason
  const header = 'Date,Company,Title,URL,Status,Rejection Reason\n';

  const acceptedLines = accepted.map(j =>
    `${date},"${j.company}","${j.title.replace(/"/g, '""')}",${j.url},ACCEPTED,`
  ).join('\n');

  const rejectedLines = rejected.map(j =>
    `${date},"${j.company}","${j.title.replace(/"/g, '""')}",${j.url},REJECTED,"${j.reason.replace(/"/g, '""')}"`
  ).join('\n');

  const csvContent = header + acceptedLines + (acceptedLines && rejectedLines ? '\n' : '') + rejectedLines;
  writeFileSync(csvPath, csvContent, 'utf8');

  return csvPath;
}

// ---------------------------------------------------------------------------
// Title validation — STRICT exclusions
// ---------------------------------------------------------------------------

function validateTitle(title) {
  // Excluded seniority keywords (case-insensitive, word boundaries)
  const exclusions = [
    /\bSr\.?(?:\s|$)/i,          // "Sr" or "Sr." followed by space or end
    /\bSenior\b/i,
    /\bLead\b/i,
    /\bStaff\b/i,
    /\bPrincipal\b/i,
    /\bHead\s+of\b/i,
    /\bDirector\b/i,
    /\bManager\b/i,
  ];

  for (const regex of exclusions) {
    if (regex.test(title)) {
      const match = title.match(regex);
      return { valid: false, reason: `Contains excluded keyword: "${match[0].trim()}"` };
    }
  }

  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Infer company from known job board hostnames
// ---------------------------------------------------------------------------

function inferCompany(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const h = hostname.toLowerCase();

    // Direct company career sites
    const directHosts = [
      [/careers\.salesforce\.com/, 'Salesforce'],
      [/careers\.adobe\.com/, 'Adobe'],
      [/amazon\.jobs/, 'Amazon'],
      [/careers\.google\.com|google\.com\/about\/careers/, 'Google'],
      [/metacareers\.com/, 'Meta'],
      [/jobs\.careers\.microsoft\.com/, 'Microsoft'],
      [/careers\.oracle\.com/, 'Oracle'],
      [/careers\.pypl\.com|paypal\.eightfold\.ai/, 'PayPal'],
      [/uber\.com\/.*careers/, 'Uber'],
      [/jobs\.cisco\.com/, 'Cisco'],
      [/scale\.com\/careers/, 'Scale AI'],
      [/databricks\.com/, 'Databricks'],
    ];

    for (const [re, name] of directHosts) {
      if (re.test(`${h}${pathname}`)) return name;
    }

    // Job board patterns: extract company slug
    if (h.includes('greenhouse.io')) {
      const slug = pathname.split('/').find((p, i, arr) => arr[i - 1] === undefined || arr[i - 1] === '') || '';
      // boards.greenhouse.io/<company>/jobs/<id>
      const parts = pathname.split('/').filter(Boolean);
      return parts[0] ? ucFirst(parts[0].replace(/-/g, ' ')) : 'Unknown';
    }

    if (h.includes('lever.co')) {
      // jobs.lever.co/<company>/<id>
      const parts = pathname.split('/').filter(Boolean);
      return parts[0] ? ucFirst(parts[0].replace(/-/g, ' ')) : 'Unknown';
    }

    if (h.includes('ashbyhq.com')) {
      // jobs.ashbyhq.com/<company>/<id>
      const parts = pathname.split('/').filter(Boolean);
      return parts[0] ? ucFirst(parts[0].replace(/-/g, ' ')) : 'Unknown';
    }

    // eightfold.ai: <company>.eightfold.ai
    if (h.includes('eightfold.ai')) {
      return ucFirst(h.split('.')[0].replace(/-/g, ' '));
    }

    // myworkdayjobs.com: <company>.myworkdayjobs.com
    if (h.includes('myworkdayjobs.com')) {
      return ucFirst(h.split('.')[0].replace(/-/g, ' '));
    }

    // smartrecruiters.com: jobs.smartrecruiters.com/<company>/...
    if (h.includes('smartrecruiters.com')) {
      const parts = pathname.split('/').filter(Boolean);
      return parts[0] ? ucFirst(parts[0].replace(/-/g, ' ')) : 'Unknown';
    }

    return 'Unknown';
  } catch {
    return 'Unknown';
  }
}

function ucFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { dryRun, fetchTitles } = parseArgs(process.argv);

  if (!existsSync(INPUT_PATH)) {
    writeFileSync(INPUT_PATH, [
      '# ingest-urls.txt — paste job URLs here, one per line',
      '# Format: https://... | Optional Title',
      '# Lines starting with # are kept; blank lines are removed after processing',
      '#',
      '# Examples:',
      '#   https://jobs.ashbyhq.com/langchain/abc123',
      '#   https://boards.greenhouse.io/gleanwork/jobs/456 | Software Engineer, AI Platform',
      '',
    ].join('\n'), 'utf8');
    console.log(`Created ${INPUT_PATH} — add URLs there and re-run.`);
    return;
  }

  const rawText = readFileSync(INPUT_PATH, 'utf8');
  const { entries, commentLines } = parseInputFile(rawText);

  if (entries.length === 0) {
    console.log('No URLs found in tmp/ingest-urls.txt — nothing to do.');
    return;
  }

  console.log(`Found ${entries.length} URL(s) to process`);
  if (dryRun) console.log('(dry run — no files will be written)');

  const seenUrls = loadSeenUrls();
  const date = new Date().toISOString().slice(0, 10);
  const newJobs = [];
  const skippedDupes = [];
  const titleFetchErrors = [];
  const rejectedByValidation = [];

  for (const { url, inlineTitle } of entries) {
    if (seenUrls.has(url)) {
      skippedDupes.push(url);
      continue;
    }

    let title = inlineTitle;

    if (!title && fetchTitles) {
      process.stdout.write(`  Fetching title for ${url.slice(0, 70)}... `);
      title = await fetchTitle(url);
      if (title) {
        console.log(`"${title}"`);
      } else {
        title = titleFromUrl(url);
        if (title) {
          console.log(`(from URL: "${title}")`);
        } else {
          console.log('(title unavailable)');
          titleFetchErrors.push(url);
          title = 'Job Opening';
        }
      }
    } else if (!title) {
      title = titleFromUrl(url) || 'Job Opening';
    }

    // VALIDATION: reject titles with excluded keywords
    const validation = validateTitle(title);
    if (!validation.valid) {
      const company = inferCompany(url);
      rejectedByValidation.push({ url, title, company, reason: validation.reason });
      continue;
    }

    const company = inferCompany(url);
    seenUrls.add(url);

    newJobs.push({ url, title, company, posted_date: date, source: 'manual' });
  }

  // Summary
  console.log('');
  console.log('Ingest summary');
  console.log('--------------');
  console.log(`Processed:        ${entries.length}`);
  console.log(`New:              ${newJobs.length}`);
  console.log(`Duplicates:       ${skippedDupes.length}`);
  console.log(`Rejected (title): ${rejectedByValidation.length}`);
  if (titleFetchErrors.length > 0) {
    console.log(`Title errors:     ${titleFetchErrors.length} (used "Job Opening")`);
  }

  if (newJobs.length > 0) {
    console.log('');
    for (const j of newJobs) {
      console.log(`  + [${j.company}] ${j.title}`);
      console.log(`    ${j.url}`);
    }
  }

  if (skippedDupes.length > 0) {
    console.log('');
    console.log('Skipped (already tracked):');
    for (const u of skippedDupes) {
      console.log(`  - ${u}`);
    }
  }

  if (rejectedByValidation.length > 0) {
    console.log('');
    console.log('Rejected (title validation):');
    for (const r of rejectedByValidation) {
      console.log(`  - [${r.company}] ${r.title}`);
      console.log(`    ${r.reason}`);
    }
  }

  if (dryRun) {
    console.log('');
    console.log('(dry run — no files written)');
    return;
  }

  // Write extraction CSV (both accepted + rejected for visibility)
  if (newJobs.length > 0 || rejectedByValidation.length > 0) {
    const csvPath = writeExtractionCsv(newJobs, rejectedByValidation, date);
    console.log('');
    console.log(`✓ Extraction log: ${csvPath}`);
  }

  if (newJobs.length === 0) {
    console.log('');
    console.log('No jobs passed validation.');
    return;
  }

  // Write to pipeline + history
  appendToPipeline(newJobs);
  appendToScanHistory(newJobs, date);

  // Clear processed URLs from input file — keep only comment lines
  const clearedText = commentLines.join('\n').trimEnd() + '\n';
  writeFileSync(INPUT_PATH, clearedText, 'utf8');

  console.log(`✓ Added ${newJobs.length} job(s) to pipeline.md and scan-history.tsv`);
  console.log(`✓ Cleared processed URLs from ${INPUT_PATH}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
