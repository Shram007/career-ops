#!/usr/bin/env node

/**
 * scan-websearch.mjs
 *
 * Executes websearch queries from portals.yml and extracts result URLs.
 * Sources:
 * - tracked_companies[].scan_query (enabled companies)
 * - search_queries[] (enabled entries, unless --company is used)
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';

const parseYaml = yaml.load;

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

mkdirSync('data', { recursive: true });

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    dryRun: false,
    companyFilter: null,
    maxResultsPerQuery: 12,
    pauseMs: 600,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }

    if (arg === '--company') {
      const v = (args[++i] || '').trim().toLowerCase();
      if (!v) throw new Error('Invalid --company value');
      out.companyFilter = v;
      continue;
    }

    if (arg === '--max-results') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('Invalid --max-results value');
      out.maxResultsPerQuery = Math.floor(v);
      continue;
    }

    if (arg === '--pause-ms') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error('Invalid --pause-ms value');
      out.pauseMs = Math.floor(v);
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      console.log('Usage:');
      console.log('  node scan-websearch.mjs [--dry-run] [--company <name>] [--max-results <n>] [--pause-ms <ms>]');
      process.exit(0);
    }
  }

  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readTextOrEmpty(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => String(k).toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => String(k).toLowerCase());

  return (title) => {
    const lower = String(title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
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

  const pipelineText = readTextOrEmpty(PIPELINE_PATH);
  for (const match of pipelineText.matchAll(/https?:\/\/[^\s|)]+/g)) {
    seen.add(match[0]);
  }

  const applicationsText = readTextOrEmpty(APPLICATIONS_PATH);
  for (const match of applicationsText.matchAll(/https?:\/\/[^\s|)]+/g)) {
    seen.add(match[0]);
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  const text = readTextOrEmpty(APPLICATIONS_PATH);

  for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
    const company = match[1].trim().toLowerCase();
    const role = match[2].trim().toLowerCase();
    if (company && role && company !== 'company') {
      seen.add(`${company}::${role}`);
    }
  }

  return seen;
}

function ensureScanHistoryHeader() {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf8');
  }
}

function appendToPipeline(jobs) {
  if (jobs.length === 0) return;

  let text = readTextOrEmpty(PIPELINE_PATH);
  if (!text) {
    text = '# Pipeline\n\n## Pendientes\n\n## Procesadas\n';
  }

  const marker = '## Pendientes';
  const markerIndex = text.indexOf(marker);
  const nextSection = text.indexOf('\n## ', markerIndex + marker.length);
  const insertAt = nextSection === -1 ? text.length : nextSection;

  const block = '\n' + jobs.map(job =>
    `- [ ] ${job.posted_date} | ${job.url} | ${job.company} | ${job.title}`
  ).join('\n') + '\n';

  const out = markerIndex === -1
    ? `${text.trimEnd()}\n\n## Pendientes\n${block}\n`
    : text.slice(0, insertAt) + block + text.slice(insertAt);

  writeFileSync(PIPELINE_PATH, out, 'utf8');
}

function appendToScanHistory(jobs, date) {
  if (jobs.length === 0) return;
  ensureScanHistoryHeader();

  const lines = jobs.map(job =>
    `${job.url}\t${date}\t${job.source}\t${job.title}\t${job.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf8');
}

function decodeDuckDuckGoHref(raw) {
  const href = String(raw || '').trim();
  if (!href) return null;

  let absolute = href;
  if (href.startsWith('//')) absolute = `https:${href}`;
  if (href.startsWith('/')) absolute = `https://duckduckgo.com${href}`;

  try {
    const u = new URL(absolute);
    if (u.hostname.includes('duckduckgo.com') && u.pathname.startsWith('/l/')) {
      const redirect = u.searchParams.get('uddg');
      if (redirect) return decodeURIComponent(redirect);
    }
    return u.href;
  } catch {
    return null;
  }
}

function extractResultsFromHtml(html, maxResults) {
  const out = [];
  const seen = new Set();

  const anchorRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const url = decodeDuckDuckGoHref(match[1]);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;

    const title = String(match[2] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    seen.add(url);
    out.push({ url, title: title || 'Web result' });

    if (out.length >= maxResults) break;
  }

  return out;
}

async function fetchSearchResults(query, maxResults) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const html = await res.text();
  return extractResultsFromHtml(html, maxResults);
}

function buildQueryTargets(config, companyFilter) {
  const targets = [];

  const companies = config?.tracked_companies || [];
  for (const c of companies) {
    if (c?.enabled === false) continue;
    const name = String(c?.name || '').trim();
    if (!name) continue;
    if (companyFilter && !name.toLowerCase().includes(companyFilter)) continue;

    const q = String(c?.scan_query || '').trim();
    if (!q) continue;

    targets.push({
      sourceType: 'company_scan_query',
      label: name,
      company: name,
      query: q,
    });
  }

  // Global search queries are broad discovery; skip when user requested a single company.
  if (!companyFilter) {
    const searchQueries = config?.search_queries || [];
    for (const sq of searchQueries) {
      if (sq?.enabled === false) continue;
      const name = String(sq?.name || 'WebSearch').trim();
      const query = String(sq?.query || '').trim();
      if (!query) continue;

      targets.push({
        sourceType: 'global_search_query',
        label: name,
        company: 'WebSearch',
        query,
      });
    }
  }

  return targets;
}

async function main() {
  const { dryRun, companyFilter, maxResultsPerQuery, pauseMs } = parseArgs(process.argv);

  if (!existsSync(PORTALS_PATH)) {
    throw new Error('portals.yml not found.');
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf8'));
  const titleFilter = buildTitleFilter(config?.title_filter);
  const targets = buildQueryTargets(config, companyFilter);

  if (targets.length === 0) {
    console.log('No websearch queries matched.');
    return;
  }

  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const date = new Date().toISOString().slice(0, 10);
  const newJobs = [];
  let rawResults = 0;
  let filteredOut = 0;
  let duplicates = 0;
  let failures = 0;

  console.log(`WebSearch scan: running ${targets.length} queries`);
  if (dryRun) console.log('(dry run — no files will be written)');

  for (const t of targets) {
    try {
      const results = await fetchSearchResults(t.query, maxResultsPerQuery);
      rawResults += results.length;

      let acceptedForTarget = 0;
      for (const r of results) {
        if (!titleFilter(r.title)) {
          filteredOut += 1;
          continue;
        }

        if (seenUrls.has(r.url)) {
          duplicates += 1;
          continue;
        }

        const roleKey = `${String(t.company).toLowerCase()}::${String(r.title).toLowerCase()}`;
        if (seenCompanyRoles.has(roleKey)) {
          duplicates += 1;
          continue;
        }

        seenUrls.add(r.url);
        seenCompanyRoles.add(roleKey);
        newJobs.push({
          url: r.url,
          title: r.title,
          company: t.company,
          posted_date: date,
          source: 'websearch',
        });
        acceptedForTarget += 1;
      }

      console.log(`  ${t.label}: ${results.length} results (${acceptedForTarget} accepted)`);
      if (pauseMs > 0) await sleep(pauseMs);
    } catch (err) {
      failures += 1;
      console.log(`  ${t.label}: failed (${String(err?.message || err).split('\n')[0]})`);
    }
  }

  if (!dryRun && newJobs.length > 0) {
    appendToPipeline(newJobs);
    appendToScanHistory(newJobs, date);
  }

  console.log('');
  console.log('WebSearch summary');
  console.log('-----------------');
  console.log(`Queries run:          ${targets.length}`);
  console.log(`Raw results:          ${rawResults}`);
  console.log(`Filtered out:         ${filteredOut}`);
  console.log(`Duplicates:           ${duplicates}`);
  console.log(`Failures:             ${failures}`);
  console.log(`New jobs:             ${newJobs.length}`);

  if (newJobs.length > 0) {
    console.log('');
    for (const job of newJobs.slice(0, 25)) {
      console.log(`  + ${job.company} | ${job.title}`);
    }
    if (newJobs.length > 25) {
      console.log(`  ... and ${newJobs.length - 25} more`);
    }
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
