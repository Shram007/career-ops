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
const REFERRAL_PIPELINE_PATH = 'data/pipeline-referral.md';
const APPLICATIONS_PATH = 'data/applications.md';

mkdirSync('data', { recursive: true });

function normalizeUrl(url) {
  return String(url || '').replace(/\/jobs\/results\/jobs\/results\//gi, '/jobs/results/');
}

// Strip query params + hash so the same job seen via different search queries dedupes correctly.
function dedupeKey(url) {
  try {
    const u = new URL(normalizeUrl(url));
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return normalizeUrl(url);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    dryRun: false,
    companyFilter: null,
    referralMode: false,
    timeoutMs: 30000,
    maxLinksPerCompany: 150,
    directUrl: null,   // --url <url>  ad-hoc single-URL scan
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }

    if (arg === '--url') {
      const v = (args[++i] || '').trim();
      if (!v || !/^https?:\/\//i.test(v)) throw new Error('Invalid --url value (must start with http/https)');
      out.directUrl = v;
      continue;
    }

    if (arg === '--company') {
      const v = (args[++i] || '').trim().toLowerCase();
      if (!v) throw new Error('Invalid --company value');
      out.companyFilter = v;
      continue;
    }

    if (arg === '--referral') {
      out.referralMode = true;
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
      console.log('  node scan-playwright.mjs [--dry-run] [--referral] [--company <name>] [--url <url>] [--timeout <ms>] [--max-links <n>]');
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

/**
 * Location filter: only rejects if a NEGATIVE location keyword appears in the title.
 * Allows through titles with no location info (we can't assume location from absence).
 */
function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => ({ pass: true, reason: null });
  const negative = (locationFilter?.negative || []).map(k => String(k).toLowerCase());

  return (title) => {
    const lower = String(title || '').toLowerCase();
    const hit = negative.find(k => lower.includes(k));
    if (hit) return { pass: false, reason: `loc:${hit}` };
    return { pass: true, reason: null };
  };
}

/**
 * Experience filter: rejects if the title explicitly states more years than max_years.
 * E.g. "Software Engineer, 5+ Years" or "Backend Engineer (3-5 years)" with max=3.
 * Titles with no year info pass through — years are unknown until JD is fetched.
 */
function buildExperienceFilter(experienceFilter) {
  const maxYears = Number(experienceFilter?.max_years);
  if (!maxYears || maxYears <= 0) return () => ({ pass: true, reason: null });

  return (title) => {
    const lower = String(title || '').toLowerCase();
    const m = lower.match(/(\d+)\s*(?:\+|-\s*\d+)?\s*(?:\+)?\s*years?/);
    if (!m) return { pass: true, reason: null };
    const years = parseInt(m[1], 10);
    if (years > maxYears) return { pass: false, reason: `exp:${years}yr` };
    return { pass: true, reason: null };
  };
}

function readTextOrEmpty(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function loadSeenUrls(pipelinePaths) {
  const seen = new Set();

  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf8').split(/\r?\n/).slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const url = line.split('\t')[0]?.trim();
      if (url) seen.add(dedupeKey(url));
    }
  }

  for (const path of pipelinePaths) {
    const pipelineText = readTextOrEmpty(path);
    for (const match of pipelineText.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(dedupeKey(match[0]));
    }
  }

  const applicationsText = readTextOrEmpty(APPLICATIONS_PATH);
  for (const match of applicationsText.matchAll(/https?:\/\/[^\s|)]+/g)) {
    seen.add(dedupeKey(match[0]));
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

function appendToPipeline(jobs, pipelinePath) {
  if (jobs.length === 0) return;

  let text = readTextOrEmpty(pipelinePath);
  if (!text) {
    text = '## Pending\n\n## Processed\n';
  }

  const marker = text.includes('## Pending') ? '## Pending' : '## Pendientes';
  const markerIndex = text.indexOf(marker);
  const nextSection = text.indexOf('\n## ', markerIndex + marker.length);
  const insertAt = nextSection === -1 ? text.length : nextSection;

  const block = '\n' + jobs.map(job =>
    `- [ ] ${job.posted_date} | ${normalizeUrl(job.url)} | ${job.company} | ${job.title}`
  ).join('\n') + '\n';

  const out = markerIndex === -1
    ? `${text.trimEnd()}\n\n## Pending\n${block}\n`
    : text.slice(0, insertAt) + block + text.slice(insertAt);

  writeFileSync(pipelinePath, out, 'utf8');
}

function appendToScanHistory(jobs, date) {
  if (jobs.length === 0) return;
  ensureScanHistoryHeader();

  const lines = jobs.map(job =>
    `${normalizeUrl(job.url)}\t${date}\t${job.source}\t${job.title}\t${job.company}\tadded`
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

async function extractJobTitleFromLeverDetail(page, leverUrl) {
  // For Lever single job detail/apply pages, extract the job title from page content
  try {
    await page.goto(leverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.evaluate(() => {
      // Try various selectors for Lever job title
      const selectors = [
        'h1',
        '[class*="title"]',
        '[class*="Title"]',
        '[class*="heading"]',
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (text && text.length > 5 && text.length < 200) {
            return text;
          }
        }
      }
      return document.title || '';
    });
    if (title && title.length > 5) {
      return [{ url: leverUrl, title }];
    }
  } catch {
    // Fallback to generic extraction
  }
  return [];
}

async function extractJobLinks(page, careersUrl, maxLinks) {
  await page.goto(careersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Trigger lazy rendering on SPAs.
  await page.mouse.wheel(0, 2000).catch(() => {});
  await page.waitForTimeout(800);

  const links = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a[href]'));
    return nodes.map(a => {
      const href = a.getAttribute('href') || '';
      let text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      // When <a> has no text (title in sibling element — e.g. Oracle), walk up to
      // nearest li/article/div card and grab the first heading or [class*=title] text.
      if (!text) {
        const card = a.closest('li, article, [class*="card"], [class*="result"], [class*="job-item"]');
        if (card) {
          const heading = card.querySelector('h1,h2,h3,h4,[class*="title"],[class*="Title"]');
          if (heading) text = (heading.textContent || '').replace(/\s+/g, ' ').trim();
        }
      }
      return { href, text, pageTitle: document.title };
    });
  });

  const out = [];
  const seen = new Set();

  for (const item of links) {
    const href = (item?.href || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;

    let absolute = '';
    try {
      absolute = normalizeUrl(new URL(href, page.url()).href);
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
  const { dryRun, companyFilter, referralMode, timeoutMs, maxLinksPerCompany, directUrl } = parseArgs(process.argv);

  if (!existsSync(PORTALS_PATH)) {
    throw new Error('portals.yml not found.');
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf8'));
  const referralCompanies = config?.referral_companies || [];
  const trackedCompanies = config?.tracked_companies || [];
  const companies = referralMode ? referralCompanies : [...referralCompanies, ...trackedCompanies];
  const pipelinePath = referralMode ? REFERRAL_PIPELINE_PATH : PIPELINE_PATH;
  const dedupQueuePaths = [PIPELINE_PATH, REFERRAL_PIPELINE_PATH];
  const titleFilter = buildTitleFilter(config?.title_filter);
  const locationFilter = buildLocationFilter(config?.location_filter);
  const experienceFilter = buildExperienceFilter(config?.experience_filter);

  // --url mode: bypass portals.yml and scan a single ad-hoc URL
  let targets;
  if (directUrl) {
    // Extract company name from URL
    let name = 'ad-hoc';

    // Lever: extract company slug from path (jobs.lever.co/{company}/...)
    const leverMatch = directUrl.match(/jobs\.lever\.co\/([^/?#]+)/);
    if (leverMatch) {
      name = leverMatch[1];
    } else {
      // Fallback: use domain name
      const domainMatch = directUrl.match(/^https?:\/\/(?:www\.)?([^/]+)/);
      name = domainMatch ? domainMatch[1].split('.')[0] : 'ad-hoc';
    }

    targets = [{
      name,
      careers_url: directUrl,
      fallback_url: null,
      search_urls: null,
      scan_method: 'playwright',
    }];
    console.log(`Direct URL scan: ${directUrl}`);
  } else {
    targets = companies
      .filter(c => c?.enabled !== false)
      .filter(c => !companyFilter || String(c?.name || '').toLowerCase().includes(companyFilter))
      .filter(c => {
        const hasSearchUrls = Array.isArray(c?.search_urls) && c.search_urls.length > 0;
        const hasCareersUrl = typeof c?.careers_url === 'string' && c.careers_url.trim().length > 0;
        return hasSearchUrls || hasCareersUrl;
      })
      .map(c => ({
        name: c.name,
        careers_url: c.careers_url || (Array.isArray(c.search_urls) ? c.search_urls[0] : ''),
        fallback_url: c.fallback_url,
        search_urls: Array.isArray(c.search_urls) && c.search_urls.length > 0 ? c.search_urls : null,
        scan_method: c.scan_method || '-',
      }));
  }

  if (targets.length === 0) {
    console.log('No careers targets matched.');
    return;
  }

  const seenUrls = loadSeenUrls(dedupQueuePaths);
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
  let filteredByTitle = 0;
  let filteredByLocation = 0;
  let filteredByExp = 0;
  let duplicates = 0;

  console.log(`Playwright extraction: scanning ${targets.length} companies`);
  if (dryRun) console.log('(dry run — no files will be written)');

  for (const t of targets) {
    try {
      let links = [];

      // Special handling for Lever single job URLs
      if (directUrl && t.careers_url.includes('jobs.lever.co')) {
        links = await extractJobTitleFromLeverDetail(page, t.careers_url);
      } else if (t.search_urls && t.search_urls.length > 0) {
        // Multi-query mode: visit every search URL and merge results
        const seen = new Set();
        for (const searchUrl of t.search_urls) {
          let extra = [];
          try {
            extra = await extractJobLinks(page, searchUrl, maxLinksPerCompany);
          } catch {
            extra = [];
          }
          for (const e of extra) {
            if (seen.has(e.url)) continue;
            seen.add(e.url);
            links.push(e);
          }
        }
      } else {
        links = await extractJobLinks(page, t.careers_url, maxLinksPerCompany);
      }

      const careersHost = (() => {
        try {
          return new URL(t.careers_url).hostname.toLowerCase();
        } catch {
          return '';
        }
      })();

      const probeUrls = buildHostProbeUrls(t.fallback_url);
      if (!t.search_urls && links.length < 20 && probeUrls.length > 0) {
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
          filteredByTitle += 1;
          if (dryRun || directUrl) console.log(`    [TITLE-FILTER] extracted="${link.title}" url=${link.url}`);
          continue;
        }

        const locResult = locationFilter(link.title);
        if (!locResult.pass) {
          filteredOut += 1;
          filteredByLocation += 1;
          if (dryRun) console.log(`    [LOC-FILTER] ${link.title} — ${locResult.reason}`);
          continue;
        }

        const expResult = experienceFilter(link.title);
        if (!expResult.pass) {
          filteredOut += 1;
          filteredByExp += 1;
          if (dryRun) console.log(`    [EXP-FILTER] ${link.title} — ${expResult.reason}`);
          continue;
        }

        if (seenUrls.has(dedupeKey(link.url))) {
          duplicates += 1;
          continue;
        }

        const roleKey = `${String(t.name).toLowerCase()}::${String(link.title).toLowerCase()}`;
        if (seenCompanyRoles.has(roleKey)) {
          duplicates += 1;
          continue;
        }

        seenUrls.add(dedupeKey(link.url));
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
    appendToPipeline(newJobs, pipelinePath);
    appendToScanHistory(newJobs, date);
  }

  console.log('');
  console.log('Playwright extraction summary');
  console.log('----------------------------');
  console.log(`Targets scanned:      ${targets.length}`);
  console.log(`Candidates extracted: ${extractedCandidates}`);
  console.log(`Filtered out:         ${filteredOut}  (title: ${filteredByTitle}, location: ${filteredByLocation}, exp: ${filteredByExp})`);
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
