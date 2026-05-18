#!/usr/bin/env node
/**
 * enrich-pipeline.mjs — Fetch JD text and extract key fields for pipeline entries.
 *
 * For each - [ ] entry in a pipeline file:
 *   1. Detect and mark junk URLs (category pages, PDFs, pagination, nav links) as [~]
 *   2. Fetch JD text via Playwright → fetch fallback
 *   3. Extract: location, years of experience, remote policy, corrected title
 *   4. Append extracted tags inline on the pipeline line: | loc:Sydney-AU | exp:3yr | remote:onsite
 *   5. Cache full JD text in tmp/jd-cache/{hash}.txt for reuse by score stage
 *
 * Usage:
 *   node enrich-pipeline.mjs [--referral] [--dry-run] [--url <url>]
 *
 * Flags:
 *   --referral     Process data/pipeline-referral.md (default: data/pipeline.md)
 *   --dry-run      Print changes without writing files
 *   --url <url>    Test a single URL and dump extracted fields (no pipeline edits)
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'node:crypto';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeRunReceipt } from './scripts/run-receipt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PIPELINE_PATH       = 'data/pipeline.md';
const REFERRAL_PATH       = 'data/pipeline-referral.md';
const JD_CACHE_DIR        = 'tmp/jd-cache';

mkdirSync(JD_CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const urlIdx = args.indexOf('--url');
  return {
    referralMode: args.includes('--referral'),
    dryRun:       args.includes('--dry-run'),
    singleUrl:    urlIdx !== -1 ? args[urlIdx + 1] : null,
  };
}

// ---------------------------------------------------------------------------
// Junk URL detection — category pages, pagination, PDF, nav links, etc.
// ---------------------------------------------------------------------------
function isJunkUrl(url) {
  const u = url.toLowerCase();
  return (
    u.endsWith('.pdf') ||
    /\/job[_-]?categor/i.test(u) ||
    /\/saved-jobs\//i.test(u) ||
    /\/jobsearch\/?(\?|#|$)/i.test(u) ||
    /\/jobs\/dist\//i.test(u) ||
    /\/(jobs|careers)\/?#/i.test(u) ||
    /\/(jobs|careers)\/?(se\/|[a-z]{2}\/)?jobb\/?$/i.test(u) ||
    /\/jobs\/?(\?page=\d+)?#results/i.test(u) ||
    /\?page=\d+$/.test(u) ||
    /\/company\/[^/]+\/jobs\/?$/.test(u) ||        // LinkedIn company jobs page
    /\/jobs\/results\/?$/.test(u) ||               // bare search results
    /\/jobs\/?$/.test(u) ||                        // bare jobs root
    /#onetrust/i.test(u)
  );
}

// ---------------------------------------------------------------------------
// JD cache helpers
// ---------------------------------------------------------------------------
function urlHash(url) {
  return createHash('md5').update(url).digest('hex').slice(0, 16);
}

function cachePath(url) {
  return `${JD_CACHE_DIR}/${urlHash(url)}.txt`;
}

// ---------------------------------------------------------------------------
// Fetch JD text
// ---------------------------------------------------------------------------
async function fetchWithPlaywright(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);

  return page.evaluate(() => {
    // Remove noisy elements before extracting text
    ['nav', 'header', 'footer', 'script', 'style', '[aria-hidden="true"]'].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });
    return (document.body?.innerText || '').replace(/[ \t]{2,}/g, ' ').trim();
  });
}

async function fetchWithHttp(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return html.replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJd(page, url) {
  const cp = cachePath(url);
  if (existsSync(cp)) {
    return { text: readFileSync(cp, 'utf8'), fromCache: true };
  }

  let text;
  try {
    text = await fetchWithPlaywright(page, url);
  } catch (_) {
    text = await fetchWithHttp(url);  // may throw — caller handles it
  }

  writeFileSync(cp, text, 'utf8');
  return { text, fromCache: false };
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/** Extract the required years of experience from JD text. */
function extractExpYears(text) {
  const patterns = [
    // "3+ years of software development experience" / "3+ years of relevant experience"
    /(\d+)\+?\s*years?\s+of\s+(?:\w+\s+){0,3}experience/i,
    // "minimum of 3 years" / "minimum 3 years"
    /minimum\s+(?:of\s+)?(\d+)\s*\+?\s*years?/i,
    // "at least 3 years"
    /at\s+least\s+(\d+)\s*\+?\s*years?/i,
    // "3+ years experience" (no 'of')
    /(\d+)\+\s*years?\s+experience/i,
    // "3-5 years of experience"
    /(\d+)\s*[-\u2013]\s*\d+\s*years?\s+(?:of\s+)?(?:relevant\s+)?experience/i,
    // "3+ yrs experience"
    /(\d+)\s*\+\s*yrs?\s+(?:of\s+)?(?:\w+\s+)?experience/i,
    // "requires 3+ years"
    /requires?\s+(\d+)\+?\s*years?/i,
    // "3 years working"
    /(\d+)\+?\s*years?\s+working/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}

/** Extract location from JD text. */
function extractLocation(text) {
  const patterns = [
    // Amazon Job details section: "Job details\nAUS, NSW, Sydney"
    /Job\s+details\s*\n\s*([A-Z]{2,3},\s+[^\n]{3,40})/i,
    // Amazon inline: "Job ID: 123 | Amazon Web Services Australia"
    /Amazon\s+Web\s+Services\s+(\w+(?:\s+\w+)?)\s+Pty|Amazon\s+Web\s+Services\s+(\w+)/i,
    // Country code format: "AUS, NSW, Sydney" or "US, WA, Seattle"
    /\n([A-Z]{2,3},\s+[A-Z][a-zA-Z]+,\s+[A-Z][a-zA-Z]+)\s*\n/m,
    // Location label with colon
    /(?:Job\s+)?(?:Location|Office\s+Location|Work\s+Location|City)[:\s]+([^\n\r|]{3,60}?)(?:\s*\n|\s*[|,]|\s*$)/im,
    // "based in / located in / office in"
    /(?:based\s+in|located\s+in|office\s+in)\s+([A-Z][a-zA-Z\s]+(?:,\s*[A-Z][a-zA-Z\s]+)*)/i,
    // Amazon entity name: "Amazon.com Services LLC" (implies US), "Amazon Web Services Australia"
    /Amazon\s+(?:Web\s+Services\s+)?(Australia|Canada|UK|Germany|India|Singapore|Netherlands)\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const raw = (m[1] || m[2] || '').trim().replace(/\s+/g, ' ');
      if (raw.length < 3 || raw.length > 60) continue;
      // Skip obviously wrong matches
      if (/\b(CORE|AmazeCon|confer|event|culture|inclusion)\b/i.test(raw)) continue;
      return raw;
    }
  }
  return null;
}

/** Compress location string to a short tag-friendly code. */
function compressLocation(loc) {
  return loc
    .replace(/United\s*States\b|U\.S\.A\.?|USA\b/gi, 'US')
    .replace(/United\s*Kingdom\b|U\.K\.?/gi, 'UK')
    .replace(/Australia\b/gi, 'AU')
    .replace(/Canada\b/gi, 'CA')
    .replace(/Germany\b/gi, 'DE')
    .replace(/Singapore\b/gi, 'SG')
    .replace(/Netherlands\b/gi, 'NL')
    .replace(/India\b/gi, 'IN')
    .replace(/\s*,\s*/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 25);
}

/** Extract remote policy from JD text. */
function extractRemotePolicy(text) {
  const lower = text.toLowerCase();
  if (/\b(fully\s+remote|100%\s+remote|work\s+from\s+anywhere|remote[-\s]first)\b/.test(lower)) return 'remote';
  if (/\bhybrid\b/.test(lower) && /\b(office|onsite|in-person)\b/.test(lower)) return 'hybrid';
  if (/\b(on-?site|in-?office|in-?person|must\s+be\s+located|required\s+to\s+work)\b/.test(lower)) return 'onsite';
  if (/\bremote\b/.test(lower)) return 'remote';
  return null;
}

/** Reject location strings that look like sentence fragments rather than place names. */
function isValidLocation(loc) {
  if (!loc || loc.length < 2 || loc.length > 45) return false;
  if (!/^[A-Za-z0-9]/.test(loc)) return false;
  // Reject if it contains 3+ lowercase filler words (indicates a sentence fragment)
  const fillerWords = /\b(and|the|of|in|for|must|be|during|requirements|resources|level|leveling|hiring|process|team|based|may|require|maximum|metropolitan|area)\b/gi;
  const fillerCount = (loc.match(fillerWords) || []).length;
  if (fillerCount >= 2) return false;
  // Reject obvious non-place patterns
  if (/[()[\]]/.test(loc)) return false;
  return true;
}

/** Build tag array from extracted JD fields. */
function buildMetaTags(text) {
  const tags = [];
  const exp = extractExpYears(text);
  if (exp !== null) tags.push(`exp:${exp}yr`);

  const loc = extractLocation(text);
  if (loc && isValidLocation(loc)) tags.push(`loc:${compressLocation(loc)}`);

  const remote = extractRemotePolicy(text);
  if (remote && remote !== 'remote') tags.push(`remote:${remote}`);

  return tags;
}

// ---------------------------------------------------------------------------
// Pipeline line parser
// ---------------------------------------------------------------------------
function parseLine(line) {
  const m = line.match(/^(-\s*\[(.)\])\s+(.+)$/);
  if (!m) return null;
  const parts = m[3].split('|').map(s => s.trim());
  return {
    marker: m[1],       // "- [ ]"
    status: m[2],       // ' ', 'x', '!', '~'
    date:    parts[0],
    url:     parts[1],
    company: parts[2],
    title:   parts[3],
    extras:  parts.slice(4),  // any existing extra fields
  };
}

function rebuildLine(parsed, extraTags) {
  const allExtras = [...extraTags, ...parsed.extras].filter(Boolean);
  const suffix = allExtras.length > 0 ? ' | ' + allExtras.join(' | ') : '';
  return `- [ ] ${parsed.date} | ${parsed.url} | ${parsed.company} | ${parsed.title}${suffix}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startTime = Date.now();
  const { referralMode, dryRun, singleUrl } = parseArgs(process.argv);

  // ---- Single URL test mode ------------------------------------------------
  if (singleUrl) {
    console.log(`Testing: ${singleUrl}\n`);
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    try {
      if (isJunkUrl(singleUrl)) {
        console.log('Result: JUNK URL (would be marked [~])');
        return;
      }
      const { text, fromCache } = await fetchJd(page, singleUrl);
      console.log(`Fetched ${text.length.toLocaleString()} chars ${fromCache ? '(from cache)' : '(live)'}`);
      console.log('\n--- JD Text (first 3,000 chars) ---');
      console.log(text.slice(0, 3000));
      console.log('\n--- Extracted Fields ---');
      const exp     = extractExpYears(text);
      const loc     = extractLocation(text);
      const remote  = extractRemotePolicy(text);
      const tags    = buildMetaTags(text);
      console.log(`Location:    ${loc && isValidLocation(loc) ? loc : `(not found)${loc ? ' [raw: ' + loc + ']' : ''}`}`);
      console.log(`Exp years:   ${exp    ?? '(not found)'}`);
      console.log(`Remote:      ${remote ?? '(not found)'}`);
      console.log(`Tags:        ${tags.join(', ') || '(none)'}`);
    } catch (err) {
      console.error('Error:', err.message);
    } finally {
      await browser.close();
    }
    return;
  }

  // ---- Pipeline enrichment mode -------------------------------------------
  const pipelinePath = referralMode ? REFERRAL_PATH : PIPELINE_PATH;
  if (!existsSync(pipelinePath)) {
    console.error(`Pipeline file not found: ${pipelinePath}`);
    process.exit(1);
  }

  const raw = readFileSync(pipelinePath, 'utf8');
  const lines = raw.split('\n');

  const pendingCount = lines.filter(l => /^-\s*\[ \]/.test(l)).length;
  console.log(`Found ${pendingCount} pending entries in ${pipelinePath}`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  const outLines  = [];
  let enriched    = 0;
  let junkMarked  = 0;
  let alreadyDone = 0;
  let failed      = 0;
  let fromCache   = 0;

  for (const line of lines) {
    if (!/^-\s*\[ \]/.test(line)) {
      outLines.push(line);
      continue;
    }

    const parsed = parseLine(line);
    if (!parsed?.url) {
      outLines.push(line);
      continue;
    }

    // Already enriched — skip
    if (parsed.extras.some(e => /^(loc:|exp:|remote:)/.test(e))) {
      outLines.push(line);
      alreadyDone++;
      continue;
    }

    // Junk URL
    if (isJunkUrl(parsed.url)) {
      const newLine = `- [~] ${parsed.date} | ${parsed.url} | ${parsed.company} | ${parsed.title} — skip:not-a-job`;
      console.log(`  [JUNK]  ${parsed.url}`);
      outLines.push(newLine);
      junkMarked++;
      continue;
    }

    // Fetch + extract
    const label = `${parsed.company} | ${(parsed.title || parsed.url).slice(0, 45)}`;
    process.stdout.write(`  ${label.padEnd(55)} `);

    try {
      const result = await fetchJd(page, parsed.url);
      if (result.fromCache) fromCache++;

      const tags = buildMetaTags(result.text);
      outLines.push(rebuildLine(parsed, tags));
      enriched++;
      console.log(`✓  ${tags.join(', ') || '(no tags)'}${result.fromCache ? '  [cached]' : ''}`);
    } catch (err) {
      outLines.push(line); // preserve original on error
      failed++;
      console.log(`✗  ${err.message.split('\n')[0].slice(0, 60)}`);
    }
  }

  await ctx.close();
  await browser.close();

  if (!dryRun && (enriched > 0 || junkMarked > 0)) {
    writeFileSync(pipelinePath, outLines.join('\n'), 'utf8');
  }

  console.log('\nEnrichment summary');
  console.log('------------------');
  console.log(`Enriched:      ${enriched} (${fromCache} from cache)`);
  console.log(`Junk marked:   ${junkMarked}`);
  console.log(`Already done:  ${alreadyDone}`);
  console.log(`Errors:        ${failed}`);
  if (!dryRun && (enriched > 0 || junkMarked > 0)) {
    console.log(`\nWrote: ${pipelinePath}`);
  }

  const receiptPath = writeRunReceipt(__dirname, 'enrich', {
    scope: referralMode ? 'referral' : 'discovery',
    dryRun,
    enriched,
    junkMarked,
    alreadyDone,
    failed,
    fromCache,
    durationMs: Date.now() - startTime,
  });
  console.log(`Receipt:      ${receiptPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
