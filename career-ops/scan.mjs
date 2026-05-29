#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new jobs to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                          # scan all enabled companies
 *   node scan.mjs --referral               # scan referral_companies and write to pipeline-referral.md
 *   node scan.mjs --dry-run                # preview without writing files
 *   node scan.mjs --company Cohere         # scan a single company
 *   node scan.mjs --days 14                # filter for jobs posted in last 14 days (default: 7)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const REFERRAL_PIPELINE_PATH = 'data/pipeline-referral.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 15_000;  // Ashby API can take 10-11s; P95 observed at 10.5s

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    posted_at: j.created_at || j.updated_at || new Date().toISOString(),
    description: j.description || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    posted_at: j.publishedDate || j.createdAt || new Date().toISOString(),
    description: j.description || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    posted_at: j.createdAt || j.postedAt || new Date().toISOString(),
    description: j.description || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title validation — STRICT exclusions ───────────────────────────

function validateTitle(title) {
  const exclusions = [
    /\bSr\.?(?:\s|$)/i,
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
      return { valid: false, reason: `Contains excluded keyword: "${title.match(regex)[0].trim()}"` };
    }
  }

  return { valid: true, reason: null };
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => ({ pass: true, reason: null });
  const positive = (locationFilter?.positive || []).map(k => String(k).toLowerCase());
  const negative = (locationFilter?.negative || []).map(k => String(k).toLowerCase());
  const strictUSOrRemote = Boolean(locationFilter?.strict_us_or_remote);

  return (title, location = '') => {
    const corpus = `${String(title || '')} ${String(location || '')}`.toLowerCase();
    const negativeHit = negative.find(k => corpus.includes(k));
    if (negativeHit) return { pass: false, reason: `loc:${negativeHit}` };

    if (!strictUSOrRemote) return { pass: true, reason: null };

    const positiveHit = positive.find(k => corpus.includes(k));
    if (!positiveHit) return { pass: false, reason: 'loc:unknown-or-non-us' };
    return { pass: true, reason: null };
  };
}

// ── Date filter (7 days old) ────────────────────────────────────────

function isRecentPosting(postedAtStr, daysCutoff = 7) {
  if (!postedAtStr) return true; // No date = assume recent
  const posted = new Date(postedAtStr);
  const now = new Date();
  const ageMs = now - posted;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays <= daysCutoff;
}

function extractDate(postedAtStr) {
  try {
    return new Date(postedAtStr).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ── Experience filter ───────────────────────────────────────────────

function meetExperienceRequirement(description, maxYears = 3) {
  if (!description) return true; // No description = assume OK
  const lower = description.toLowerCase();

  // Match patterns like "3+ years", "5+ years of experience", etc.
  const xpPatterns = [
    /(\d+)\+?\s+years?(?:\s+of)?\s+(?:professional\s+)?(?:work\s+)?experience/gi,
    /(\d+)\+?\s+years?(?:\s+of)?\s+(?:in\s+)?(?:the\s+)?(?:industry|development|software|programming)/gi,
    /(\d+)\+?\s+years?.*?required/gi,
    /required:?\s+(\d+)\+?\s+years?/gi,
  ];

  const foundRequirements = [];
  for (const pattern of xpPatterns) {
    let match;
    while ((match = pattern.exec(lower)) !== null) {
      const years = parseInt(match[1], 10);
      if (!isNaN(years)) foundRequirements.push(years);
    }
  }

  // If no experience requirement found, assume OK
  if (foundRequirements.length === 0) return true;

  // Check if any requirement exceeds maxYears
  const maxRequired = Math.max(...foundRequirements);
  return maxRequired <= maxYears;
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls(pipelinePaths) {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // queue files — extract URLs from checkbox lines (with or without dates)
  for (const path of pipelinePaths) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (?:\d{4}-\d{2}-\d{2} \| )?(https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(jobs, pipelinePath) {
  if (jobs.length === 0) return;

  let text = existsSync(pipelinePath)
    ? readFileSync(pipelinePath, 'utf-8')
    : '## Pending\n\n## Processed\n';

  // Support both EN and legacy ES section titles.
  const marker = text.includes('## Pending') ? '## Pending' : '## Pendientes';
  const fallbackMarker = marker === '## Pending' ? '## Processed' : '## Procesadas';
  const idx = text.indexOf(marker);

  const block = '\n' + jobs.map(o =>
    `- [ ] ${o.posted_date} | ${o.url} | ${o.company} | ${o.title}`
  ).join('\n') + '\n';

  if (idx === -1) {
    const procIdx = text.indexOf(fallbackMarker);
    const insertAt = procIdx === -1 ? text.length : procIdx;
    text = `${text.slice(0, insertAt).trimEnd()}\n\n## Pending\n${block}\n${text.slice(insertAt)}`;
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(pipelinePath, text, 'utf-8');
}

function appendToScanHistory(jobs, date, status = 'added') {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = jobs.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\t${status}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const referralMode = args.includes('--referral');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const daysFlag = args.indexOf('--days');
  const daysCutoff = daysFlag !== -1 ? parseInt(args[daysFlag + 1], 10) : 7;
  const pipelinePath = referralMode ? REFERRAL_PIPELINE_PATH : PIPELINE_PATH;
  const dedupQueuePaths = [PIPELINE_PATH, REFERRAL_PIPELINE_PATH];

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = referralMode
    ? (config.referral_companies || [])
    : (config.tracked_companies || []);
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const maxYears = config.experience_filter?.max_years || 3;

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .filter(c => c.scan_method !== 'playwright' && c.scan_method !== 'websearch')
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  console.log(`Age filter: ${daysCutoff} days | Experience filter: max ${maxYears} years`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls(dedupQueuePaths);
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalValidationRejected = 0;
  let totalDupes = 0;
  const newJobs = [];
  const validationRejected = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        const locResult = locationFilter(job.title, job.location);
        if (!locResult.pass) {
          totalFiltered++;
          continue;
        }
        if (!isRecentPosting(job.posted_at, daysCutoff)) {
          totalFiltered++;
          continue;
        }
        if (!meetExperienceRequirement(job.description, maxYears)) {
          totalFiltered++;
          continue;
        }
        // STRICT validation: reject Sr, Lead, Senior, etc.
        const validation = validateTitle(job.title);
        if (!validation.valid) {
          totalValidationRejected++;
          validationRejected.push({ ...job, reason: validation.reason });
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newJobs.push({
          ...job,
          posted_date: extractDate(job.posted_at),
          source: `${type}-api`
        });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newJobs.length > 0) {
    appendToPipeline(newJobs, pipelinePath);
    appendToScanHistory(newJobs, date);
  }
  // Log validation-rejected to history (for audit)
  if (!dryRun && validationRejected.length > 0) {
    appendToScanHistory(validationRejected.map(j => ({
      ...j,
      title: j.title,
      posted_date: extractDate(j.posted_at),
      source: 'validation-rejected'
    })), date, 'skipped_title_validation');
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered (title+location+age+xp): ${totalFiltered} removed`);
  console.log(`Title validation:      ${totalValidationRejected} rejected`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New jobs added:        ${newJobs.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newJobs.length > 0) {
    console.log('\nNew jobs:');
    for (const o of newJobs) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${pipelinePath} and ${SCAN_HISTORY_PATH}`);
    }
  }

  if (referralMode) {
    console.log(`\n→ Run /career-ops score referral to evaluate new jobs.`);
  } else {
    console.log(`\n→ Run /career-ops score discovery to evaluate new jobs.`);
  }
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
