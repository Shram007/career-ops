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
import { pathToFileURL } from 'url';
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

function slugToTitle(slug) {
  return String(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyJobDetailUrl(url) {
  try {
    const u = new URL(url);
    const lower = u.href.toLowerCase();
    if (/(gh_jid=|jobid=|job_details|\/jobs\/view\/|\/careers\/job\/|\/apply(?:\?|#|$)|\/job\/\d+)/i.test(lower)) {
      return true;
    }
    if (/jobs\.lever\.co\/[a-z0-9_-]+\/[a-z0-9-]{8,}/i.test(lower)) return true;
    if (/jobs\.ashbyhq\.com\/[a-z0-9_-]+\/[a-z0-9-]{8,}/i.test(lower)) return true;
    if (/boards?\.greenhouse\.io\/[a-z0-9_-]+\/jobs\/\d+/i.test(lower)) return true;
    if (/myworkdayjobs\.com\/.+\/job\//i.test(lower)) return true;
    if (/\/jobs\/results\/\d+-[a-z0-9-]+/i.test(lower)) return true;
    return false;
  } catch {
    return false;
  }
}

function isLikelyFeedUrl(url) {
  const lower = String(url || '').toLowerCase();
  return lower.includes('rss=true') || /\.(xml|rss)(?:$|\?)/i.test(lower) || /\/rss(?:$|\?)/i.test(lower);
}

function isMeaningfulDetailTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t.length < 6 || t.length > 200) return false;
  if (!/[a-z]/i.test(t)) return false;
  if (/^(job opening|careers?|apply|job details?)$/i.test(t)) return false;
  return true;
}

function normalizeTitleCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!isMeaningfulDetailTitle(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

async function extractJobTitleFromDetail(page, detailUrl) {
  try {
    const u = new URL(detailUrl);
    const candidates = [];

    for (const key of ['title', 'jobTitle', 'job_title', 'requisitionTitle', 'position']) {
      const v = u.searchParams.get(key);
      if (v) {
        try {
          candidates.push(decodeURIComponent(v).replace(/\+/g, ' ').trim());
        } catch {
          candidates.push(v.trim());
        }
      }
    }

    const slugMatch = u.pathname.match(/\/(?:jobs\/results\/\d+-)?([a-z][a-z0-9_-]{6,})$/i);
    if (slugMatch?.[1]) {
      const slugTitle = slugToTitle(slugMatch[1]);
      if (slugTitle) candidates.push(slugTitle);
    }

    const seeded = normalizeTitleCandidates(candidates);
    if (seeded.length > 0) {
      return [{ url: detailUrl, title: seeded[0] }];
    }

    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);

    const pageCandidates = await page.evaluate(() => {
      const out = [];
      const push = (v) => {
        const t = String(v || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      };

      const metaSelectors = [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
        'meta[name="title"]',
      ];
      for (const selector of metaSelectors) {
        const el = document.querySelector(selector);
        if (el) push(el.getAttribute('content'));
      }

      push(document.title || '');

      const selectors = [
        'h1',
        'h2',
        '[role="heading"]',
        '[class*="job-title"]',
        '[class*="jobTitle"]',
        '[class*="title"]',
      ];
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 6);
        for (const node of nodes) {
          push(node?.textContent || '');
        }
      }

      return out;
    });

    const normalized = normalizeTitleCandidates(pageCandidates)
      .filter(t => !/(job details|back to|all jobs|careers? at)/i.test(t));

    if (normalized.length > 0) {
      return [{ url: detailUrl, title: normalized[0] }];
    }
  } catch {
    // Ignore and fall through
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

async function fetchFeedLinks(feedUrl, maxLinks) {
  try {
    const res = await fetch(feedUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) return [];
    const body = await res.text();
    if (!/<(rss|feed|item|job)\b/i.test(body)) return [];
    return parseRssItems(body, maxLinks);
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

async function extractFromUrlWithFallback(page, url, maxLinks) {
  if (isLikelyFeedUrl(url)) {
    const feedLinks = await fetchFeedLinks(url, maxLinks);
    if (feedLinks.length > 0) return feedLinks;
  }

  try {
    const links = await extractJobLinks(page, url, maxLinks);
    if (links.length > 0) return links;
  } catch {
    // Continue to feed fallback below.
  }

  // Some listing URLs redirect or expose XML feed behind alternate endpoints.
  if (/salesforce\.com/i.test(url)) {
    return fetchSalesforceRss(url, maxLinks);
  }

  return [];
}

async function resolveTargetLinks(page, target, maxLinksPerCompany, isDirectUrlScan) {
  const links = [];
  const seen = new Set();

  const pushUnique = (items) => {
    for (const item of items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      links.push(item);
      if (links.length >= maxLinksPerCompany) break;
    }
  };

  if (isDirectUrlScan && isLikelyJobDetailUrl(target.careers_url)) {
    return extractJobTitleFromDetail(page, target.careers_url);
  }

  if (target.search_urls && target.search_urls.length > 0) {
    for (const searchUrl of target.search_urls) {
      const extra = await extractFromUrlWithFallback(page, searchUrl, maxLinksPerCompany);
      pushUnique(extra);
      if (links.length >= maxLinksPerCompany) break;
    }
  } else {
    const primary = await extractFromUrlWithFallback(page, target.careers_url, maxLinksPerCompany);
    pushUnique(primary);
  }

  const probeUrls = buildHostProbeUrls(target.fallback_url);
  if (!target.search_urls && links.length < 20 && probeUrls.length > 0) {
    for (const probeUrl of probeUrls) {
      let extra = [];
      if (probeUrl.includes('uber.com/us/en/careers/list/')) {
        extra = await fetchUberListRoute(page, maxLinksPerCompany);
      } else {
        extra = await extractFromUrlWithFallback(page, probeUrl, maxLinksPerCompany);
      }
      pushUnique(extra);
      if (links.length >= maxLinksPerCompany) break;
    }
  }

  return links;
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
      const links = await resolveTargetLinks(page, t, maxLinksPerCompany, Boolean(directUrl));

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

const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

export {
  normalizeUrl,
  dedupeKey,
  looksLikeJobLink,
  normalizeTitle,
  parseRssItems,
  isLikelyJobDetailUrl,
  isLikelyFeedUrl,
  normalizeTitleCandidates,
  resolveTargetLinks,
};
