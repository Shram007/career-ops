#!/usr/bin/env node

/**
 * scan-playwright.mjs
 *
 * Playwright-based careers page extractor for companies without stable APIs.
 * Extracts job-like links from each enabled company's careers URL and appends
 * non-duplicate results to pipeline + scan history.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
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
    timeoutMs: 15000,
    maxLinksPerCompany: 150,
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

    if (arg === '--timeout') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('Invalid --timeout value');
      out.timeoutMs = v;
      continue;
    }

    if (arg === '--max-links') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('Invalid --max-links value');
      out.maxLinksPerCompany = Math.floor(v);
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      console.log('Usage:');
      console.log('  node scan-playwright.mjs [--dry-run] [--company <name>] [--timeout <ms>] [--max-links <n>]');
      process.exit(0);
    }
  }

  return out;
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

function looksLikeJobLink(url, title) {
  const href = String(url || '').toLowerCase();
  const text = String(title || '').toLowerCase();

  const urlSignal = /((\/jobs?\/\d+)|(\/jobs?\/[a-z0-9-]{6,})|(\/careers\/list\/\d+)|(\/careers\/job\/\d+)|(\/profile\/job_details\/\d+)|(\/about\/careers\/applications\/jobs\/results\/\d+[a-z0-9-]*)|(\/en\/sites\/jobsearch\/job\/\d+)|(\/us\/en\/job\/[a-z0-9-]+)|(boards?\.greenhouse\.io\/[^\s]+\/jobs\/\d+)|(jobs\.lever\.co\/[^\s]+)|(jobs\.ashbyhq\.com\/[^\s]+)|(myworkdayjobs\.com\/[^\s]+\/job\/[^\s]+)|(jobid=\d+)|(gh_jid=\d+))/i;
  const weakCareersPath = /\/careers?\//i;
  const textSignal = /(engineer|developer|scientist|analyst|architect|intern|graduate|new grad|software|backend|frontend|full stack|machine learning|ai|ml)/i;

  if (urlSignal.test(href)) return true;
  if (weakCareersPath.test(href) && textSignal.test(text)) return true;
  return false;
}

function normalizeTitle(rawTitle, href) {
  const cleaned = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (cleaned) return cleaned;

  try {
    const p = new URL(href).pathname.split('/').filter(Boolean).pop() || 'Job Opening';
    return decodeURIComponent(p).replace(/[-_]+/g, ' ').trim() || 'Job Opening';
  } catch {
    return 'Job Opening';
  }
}

async function extractJobLinks(page, careersUrl, maxLinks) {
  await page.goto(careersUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2500);

  // Trigger lazy rendering on SPAs.
  await page.mouse.wheel(0, 2000).catch(() => {});
  await page.waitForTimeout(800);

  const links = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a[href]'));
    return nodes.map(a => {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      return { href, text };
    });
  });

  const out = [];
  const seen = new Set();

  for (const item of links) {
    const href = (item?.href || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;

    let absolute = '';
    try {
      absolute = new URL(href, page.url()).href;
    } catch {
      continue;
    }

    if (!/^https?:\/\//i.test(absolute)) continue;
    if (seen.has(absolute)) continue;

    const title = normalizeTitle(item?.text || '', absolute);
    if (!looksLikeJobLink(absolute, title)) continue;

    seen.add(absolute);
    out.push({ url: absolute, title });

    if (out.length >= maxLinks) break;
  }

  return out;
}

function parseRssItems(xml, maxItems) {
  const out = [];
  const seen = new Set();
  const parseBlocks = (regex, linkTagRegex) => {
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const block = match[1] || '';
      const title = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1] || block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || 'Job Opening')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const linkMatch = block.match(linkTagRegex);
      const link = ((linkMatch?.[1] || linkMatch?.[2]) || '').trim();
      if (!/^https?:\/\//i.test(link) || seen.has(link)) continue;
      seen.add(link);
      out.push({ url: link, title: title || 'Job Opening' });
      if (out.length >= maxItems) break;
    }
  };

  // Standard RSS format.
  parseBlocks(/<item>([\s\S]*?)<\/item>/gi, /<link>([\s\S]*?)<\/link>/i);

  // Salesforce feed format uses <job> + <url>.
  if (out.length < maxItems) {
    parseBlocks(/<job>([\s\S]*?)<\/job>/gi, /<url><!\[CDATA\[([\s\S]*?)\]\]><\/url>|<url>([\s\S]*?)<\/url>/i);
  }

  return out;
}

async function fetchSalesforceRss(rssUrl, maxLinks) {
  try {
    // If passed a careers URL, derive the RSS URL; otherwise use directly
    let url = rssUrl;
    if (!rssUrl.includes('rss=true')) {
      const u = new URL(rssUrl);
      url = `${u.origin}/en/jobs/xml/?rss=true`;
    }
    
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml, maxLinks);
  } catch {
    return [];
  }
}

async function fetchUberListRoute(page, maxLinks) {
  const probeUrl = 'https://www.uber.com/us/en/careers/list/?query=software%20engineer';
  try {
    return await extractJobLinks(page, probeUrl, maxLinks);
  } catch {
    return [];
  }
}

function buildHostProbeUrls(fallbackUrl) {
  if (!fallbackUrl) return [];
  return [fallbackUrl];
}

async function main() {
  const { dryRun, companyFilter, timeoutMs, maxLinksPerCompany } = parseArgs(process.argv);

  if (!existsSync(PORTALS_PATH)) {
    throw new Error('portals.yml not found.');
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf8'));
  const referralCompanies = config?.referral_companies || [];
  const trackedCompanies = config?.tracked_companies || [];
  const companies = [...referralCompanies, ...trackedCompanies];
  const titleFilter = buildTitleFilter(config?.title_filter);

  const targets = companies
    .filter(c => c?.enabled !== false)
    .filter(c => !companyFilter || String(c?.name || '').toLowerCase().includes(companyFilter))
    .filter(c => typeof c?.careers_url === 'string' && c.careers_url.trim().length > 0)
    .map(c => ({
      name: c.name,
      careers_url: c.careers_url,
      fallback_url: c.fallback_url,
      scan_method: c.scan_method || '-',
    }));

  if (targets.length === 0) {
    console.log('No careers targets matched.');
    return;
  }

  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const date = new Date().toISOString().slice(0, 10);
  const newJobs = [];
  const errors = [];
  let extractedCandidates = 0;
  let filteredOut = 0;
  let duplicates = 0;

  console.log(`Playwright extraction: scanning ${targets.length} companies`);
  if (dryRun) console.log('(dry run — no files will be written)');

  for (const t of targets) {
    try {
      let links = await extractJobLinks(page, t.careers_url, maxLinksPerCompany);

      const careersHost = (() => {
        try {
          return new URL(t.careers_url).hostname.toLowerCase();
        } catch {
          return '';
        }
      })();

      const probeUrls = buildHostProbeUrls(t.fallback_url);
      if (links.length < 20 && probeUrls.length > 0) {
        const seen = new Set(links.map(x => x.url));
        for (const probeUrl of probeUrls) {
          let extra = [];
          
          // Special handling for RSS feeds (Salesforce)
          if (probeUrl.includes('rss=true')) {
            extra = await fetchSalesforceRss(probeUrl, maxLinksPerCompany);
          } else if (probeUrl.includes('uber.com/us/en/careers/list/')) {
            extra = await fetchUberListRoute(page, maxLinksPerCompany);
          } else {
            try {
              extra = await extractJobLinks(page, probeUrl, maxLinksPerCompany);
            } catch {
              extra = [];
            }
          }

          for (const e of extra) {
            if (seen.has(e.url)) continue;
            seen.add(e.url);
            links.push(e);
            if (links.length >= maxLinksPerCompany) break;
          }

          if (links.length >= maxLinksPerCompany) break;
        }
      }

      extractedCandidates += links.length;

      for (const link of links) {
        if (!titleFilter(link.title)) {
          filteredOut += 1;
          continue;
        }

        if (seenUrls.has(link.url)) {
          duplicates += 1;
          continue;
        }

        const roleKey = `${String(t.name).toLowerCase()}::${String(link.title).toLowerCase()}`;
        if (seenCompanyRoles.has(roleKey)) {
          duplicates += 1;
          continue;
        }

        seenUrls.add(link.url);
        seenCompanyRoles.add(roleKey);
        newJobs.push({
          url: link.url,
          title: link.title,
          company: t.name,
          posted_date: date,
          source: 'playwright',
        });
      }

      console.log(`  ${t.name}: ${links.length} candidate links`);
    } catch (err) {
      errors.push({ company: t.name, error: String(err?.message || err) });
      console.log(`  ${t.name}: failed (${String(err?.message || err).split('\n')[0]})`);
    }
  }

  await context.close();
  await browser.close();

  if (!dryRun && newJobs.length > 0) {
    appendToPipeline(newJobs);
    appendToScanHistory(newJobs, date);
  }

  console.log('');
  console.log('Playwright extraction summary');
  console.log('----------------------------');
  console.log(`Targets scanned:      ${targets.length}`);
  console.log(`Candidates extracted: ${extractedCandidates}`);
  console.log(`Filtered out:         ${filteredOut}`);
  console.log(`Duplicates:           ${duplicates}`);
  console.log(`New jobs:             ${newJobs.length}`);

  if (errors.length > 0) {
    console.log(`Errors:               ${errors.length}`);
  }

  if (newJobs.length > 0) {
    console.log('');
    for (const job of newJobs.slice(0, 30)) {
      console.log(`  + ${job.company} | ${job.title}`);
    }
    if (newJobs.length > 30) {
      console.log(`  ... and ${newJobs.length - 30} more`);
    }
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
