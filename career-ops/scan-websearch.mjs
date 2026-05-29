#!/usr/bin/env node

/**
 * scan-websearch.mjs
 *
 * Executes websearch queries from portals.yml and extracts result URLs.
 * Sources:
 * - referral mode: referral_companies[] with scan_method=websearch + scan_query
 * - discovery mode: tracked_companies[].scan_query and search_queries[]
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';

const parseYaml = yaml.load;

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const REFERRAL_PIPELINE_PATH = 'data/pipeline-referral.md';
const APPLICATIONS_PATH = 'data/applications.md';

mkdirSync('data', { recursive: true });

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    dryRun: false,
    companyFilter: null,
    referralMode: false,
    maxResultsPerQuery: 12,
    pauseMs: 600,
    engine: String(process.env.WEBSEARCH_ENGINE || 'ddg').toLowerCase(),
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

    if (arg === '--referral') {
      out.referralMode = true;
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

    if (arg === '--engine') {
      const v = String(args[++i] || '').trim().toLowerCase();
      if (!['ddg', 'google', 'exa', 'chain'].includes(v)) {
        throw new Error('Invalid --engine value (use ddg|google|exa|chain)');
      }
      out.engine = v;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      console.log('Usage:');
      console.log('  node scan-websearch.mjs [--dry-run] [--referral] [--company <name>] [--max-results <n>] [--pause-ms <ms>] [--engine ddg|google|exa|chain]');
      process.exit(0);
    }
  }

  return out;
}

function getEngineOrder(engine) {
  if (engine === 'chain') return ['exa', 'google', 'ddg'];
  if (engine === 'exa') return ['exa', 'google', 'ddg'];
  if (engine === 'google') return ['google', 'ddg'];
  return ['ddg'];
}

function getIntEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function normalizeKeywordList(values, maxItems = 12) {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    const clean = String(v || '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildSearchProfile(config) {
  const clampLimit = (value, fallback, min, max) => {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, min), max);
  };

  const roleTermsLimit = clampLimit(getIntEnv('EXA_ROLE_TERMS_LIMIT'), 12, 1, 24);
  const entryTermsLimit = clampLimit(getIntEnv('EXA_ENTRY_TERMS_LIMIT'), 8, 1, 16);
  const roleBooleanLimit = clampLimit(getIntEnv('EXA_ROLE_BOOLEAN_LIMIT'), 6, 1, 12);
  const entryBooleanLimit = clampLimit(getIntEnv('EXA_ENTRY_BOOLEAN_LIMIT'), 5, 1, 12);

  const titlePositive = normalizeKeywordList(config?.title_filter?.positive || [], 24);
  const seniorityBoost = normalizeKeywordList(config?.title_filter?.seniority_boost || [], 12);

  const entryTerms = normalizeKeywordList(
    [
      ...seniorityBoost,
      ...titlePositive.filter((k) => /new\s*grad|new\s*graduate|entry\s*level|early\s*career|university/i.test(k)),
    ],
    entryTermsLimit,
  );

  const roleTerms = normalizeKeywordList(
    titlePositive.filter((k) => !entryTerms.some((e) => e.toLowerCase() === k.toLowerCase())),
    roleTermsLimit,
  );

  const boolify = (terms, limit = 6) => terms.slice(0, limit).map((t) => `"${t}"`).join(' OR ');
  const roleTermsBoolean = boolify(roleTerms, roleBooleanLimit);
  const entryTermsBoolean = boolify(entryTerms, entryBooleanLimit);
  const highlightQuery = [roleTermsBoolean, entryTermsBoolean].filter(Boolean).join(' OR ') || 'Software Engineer OR AI Engineer OR New Grad';

  return {
    roleTerms,
    entryTerms,
    roleTermsBoolean,
    entryTermsBoolean,
    highlightQuery,
  };
}

function mergeQueryWithProfile(query, profile) {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return normalized;

  const knownTerms = [...(profile?.roleTerms || []), ...(profile?.entryTerms || [])].map((t) => t.toLowerCase());
  const hasKnownTerm = knownTerms.some((term) => term && normalized.toLowerCase().includes(term));
  if (hasKnownTerm) return normalized;

  const extra = [profile?.roleTermsBoolean, profile?.entryTermsBoolean].filter(Boolean).join(' ');
  return extra ? `${normalized} ${extra}` : normalized;
}

function buildExaRequestFromQuery(rawQuery, profile) {
  const q = String(rawQuery || '').replace(/\s+/g, ' ').trim();

  const includeDomains = Array.from(new Set(
    [...q.matchAll(/site:([^\s"']+)/gi)]
      .map((m) => String(m[1] || '').trim().toLowerCase())
      .filter(Boolean),
  ));

  const afterMatch = q.match(/after:(\d{4}-\d{2}-\d{2})/i);
  const startPublishedDate = afterMatch ? `${afterMatch[1]}T00:00:00.000Z` : undefined;

  const cleanedQuery = q
    .replace(/site:[^\s"']+/gi, ' ')
    .replace(/after:\d{4}-\d{2}-\d{2}/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const mergedQuery = mergeQueryWithProfile(cleanedQuery || q, profile);

  return {
    query: mergedQuery,
    includeDomains,
    startPublishedDate,
  };
}

async function fetchSearchResultsFromExa(query, maxResults, profile) {
  const apiKey = String(process.env.EXA_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('EXA_API_KEY is not set');
  }

  const req = buildExaRequestFromQuery(query, profile);
  const exaType = String(process.env.EXA_SEARCH_TYPE || 'auto').trim().toLowerCase();
  const allowedTypes = new Set(['auto', 'fast', 'instant', 'deep-lite', 'deep', 'deep-reasoning']);
  const searchType = allowedTypes.has(exaType) ? exaType : 'auto';

  const maxAgeHours = getIntEnv('EXA_MAX_AGE_HOURS');
  const highlightsMaxCharacters = getIntEnv('EXA_HIGHLIGHTS_MAX_CHARACTERS');
  const userLocation = String(process.env.EXA_USER_LOCATION || '').trim().toUpperCase();

  const highlights = {
    query: profile?.highlightQuery || 'Software Engineer OR AI Engineer OR New Grad',
  };
  if (highlightsMaxCharacters && highlightsMaxCharacters > 0) {
    highlights.maxCharacters = highlightsMaxCharacters;
  }

  const body = {
    query: req.query,
    type: searchType,
    numResults: Math.min(Math.max(maxResults, 1), 100),
    contents: {
      highlights,
      filterEmptyResults: true,
    },
  };

  if (Number.isFinite(maxAgeHours)) {
    body.contents.maxAgeHours = maxAgeHours;
  }

  if (req.includeDomains.length > 0) {
    body.includeDomains = req.includeDomains;
  }
  if (req.startPublishedDate) {
    body.startPublishedDate = req.startPublishedDate;
  }
  if (/^[A-Z]{2}$/.test(userLocation)) {
    body.userLocation = userLocation;
  }

  const exaCategory = String(process.env.EXA_CATEGORY || '').trim();
  if (exaCategory) {
    body.category = exaCategory;
  }

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Exa API HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
  }

  const payload = await res.json();
  const rows = Array.isArray(payload?.results) ? payload.results : [];

  return rows
    .map((r) => ({
      url: String(r?.url || '').trim(),
      title: String(r?.title || 'Web result').trim(),
    }))
    .filter((r) => /^https?:\/\//i.test(r.url));
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

function loadSeenUrls(pipelinePaths) {
  const seen = new Set();

  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf8').split(/\r?\n/).slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const url = line.split('\t')[0]?.trim();
      if (url) seen.add(url);
    }
  }

  for (const path of pipelinePaths) {
    const pipelineText = readTextOrEmpty(path);
    for (const match of pipelineText.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
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
    `- [ ] ${job.posted_date} | ${job.url} | ${job.company} | ${job.title}`
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

function extractResultsFromGoogleHtml(html, maxResults) {
  const out = [];
  const seen = new Set();

  // Google SERP links are usually in /url?q=<target>&...
  const anchorRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const href = String(match[1] || '');
    if (!href.startsWith('/url?') && !href.includes('/url?q=')) continue;

    let candidate = null;
    try {
      const u = new URL(`https://www.google.com${href}`);
      candidate = u.searchParams.get('q');
    } catch {
      candidate = null;
    }

    if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
    if (/google\./i.test(candidate)) continue;
    if (seen.has(candidate)) continue;

    const title = String(match[2] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    seen.add(candidate);
    out.push({ url: candidate, title: title || 'Web result' });
    if (out.length >= maxResults) break;
  }

  return out;
}

async function fetchSearchResults(query, maxResults, engine, profile) {
  if (engine === 'exa') {
    return fetchSearchResultsFromExa(query, maxResults, profile);
  }

  const url = engine === 'google'
    ? `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=${Math.min(Math.max(maxResults, 1), 20)}`
    : `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

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

  if (engine === 'google') {
    if (/unusual traffic|detected unusual traffic|consent\.google\.com/i.test(html)) {
      throw new Error('Google blocked automated access (consent/anti-bot page)');
    }
    return extractResultsFromGoogleHtml(html, maxResults);
  }

  return extractResultsFromHtml(html, maxResults);
}

function buildFallbackQueries(query, company, profile) {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const withoutAfter = normalized.replace(/\s*after:\d{4}-\d{2}-\d{2}/gi, '').trim();
  const siteMatches = Array.from(new Set((withoutAfter.match(/site:[^\s"']+/gi) || []).map(s => s.toLowerCase())));
  const primarySite = siteMatches[0] || '';

  const fallbackRoleTerms = profile?.roleTermsBoolean || '"Software Engineer" OR "Backend Engineer" OR "AI Engineer"';
  const fallbackEntryTerms = profile?.entryTermsBoolean || '"New Grad" OR "Early Career"';
  const companyTerm = String(company || '').trim();

  const candidates = [
    normalized,
    withoutAfter,
    [primarySite, companyTerm, fallbackRoleTerms, fallbackEntryTerms].filter(Boolean).join(' '),
    [companyTerm, fallbackRoleTerms, fallbackEntryTerms].filter(Boolean).join(' '),
  ];

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const c = String(candidate || '').replace(/\s+/g, ' ').trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    unique.push(c);
  }

  return unique;
}

async function fetchSearchResultsWithFallback(target, maxResults, engine, profile) {
  const attempts = [];
  const queries = buildFallbackQueries(target.query, target.company, profile);
  const engines = getEngineOrder(engine);

  for (const q of queries) {
    for (const e of engines) {
      try {
        const results = await fetchSearchResults(q, maxResults, e, profile);
        attempts.push({ engine: e, query: q, ok: true, resultCount: results.length });
        if (results.length > 0) {
          return { results, attempts, usedQuery: q, usedEngine: e, exhausted: false };
        }
      } catch (err) {
        attempts.push({
          engine: e,
          query: q,
          ok: false,
          resultCount: 0,
          error: String(err?.message || err).split('\n')[0],
        });
      }
    }
  }

  const errorAttempts = attempts.filter((a) => !a.ok && a.error);
  return {
    results: [],
    attempts,
    usedQuery: queries[0] || target.query,
    usedEngine: engines[0] || engine,
    exhausted: true,
    hadProviderError: errorAttempts.length > 0,
    lastProviderError: errorAttempts.length > 0 ? errorAttempts[errorAttempts.length - 1].error : null,
  };
}

function buildQueryTargets(config, companyFilter, referralMode) {
  const targets = [];

  if (referralMode) {
    const companies = config?.referral_companies || [];
    for (const c of companies) {
      if (c?.enabled === false) continue;
      const name = String(c?.name || '').trim();
      if (!name) continue;
      if (companyFilter && !name.toLowerCase().includes(companyFilter)) continue;

      const scanMethod = String(c?.scan_method || '').trim().toLowerCase();
      const query = String(c?.scan_query || '').trim();
      if (scanMethod !== 'websearch' || !query) continue;

      targets.push({
        sourceType: 'referral_company_scan_query',
        label: `${name} (referral websearch)`,
        company: name,
        query,
      });
    }

    return targets;
  }

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
  const { dryRun, companyFilter, referralMode, maxResultsPerQuery, pauseMs, engine } = parseArgs(process.argv);

  if (!existsSync(PORTALS_PATH)) {
    throw new Error('portals.yml not found.');
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf8'));
  const searchProfile = buildSearchProfile(config);
  const titleFilter = buildTitleFilter(config?.title_filter);
  const locationFilter = buildLocationFilter(config?.location_filter);
  const targets = buildQueryTargets(config, companyFilter, referralMode);
  const outputQueuePath = referralMode ? REFERRAL_PIPELINE_PATH : PIPELINE_PATH;
  const sourceTag = referralMode ? 'websearch-referral' : 'websearch';

  if (targets.length === 0) {
    console.log('No websearch queries matched.');
    return;
  }

  const seenUrls = loadSeenUrls([PIPELINE_PATH, REFERRAL_PIPELINE_PATH]);
  const seenCompanyRoles = loadSeenCompanyRoles();

  const date = new Date().toISOString().slice(0, 10);
  const newJobs = [];
  let rawResults = 0;
  let filteredOut = 0;
  let duplicates = 0;
  let failures = 0;
  const providerStats = {
    exa: { attempts: 0, errors: 0, rawResults: 0, selected: 0 },
    google: { attempts: 0, errors: 0, rawResults: 0, selected: 0 },
    ddg: { attempts: 0, errors: 0, rawResults: 0, selected: 0 },
  };
  const fallbackPaths = [];

  console.log(`WebSearch scan: running ${targets.length} queries`);
  console.log(`Engine: ${engine}`);
  if (referralMode) console.log('(referral mode: only referral_companies with scan_method=websearch)');
  if (dryRun) console.log('(dry run — no files will be written)');

  for (const t of targets) {
    try {
      const search = await fetchSearchResultsWithFallback(t, maxResultsPerQuery, engine, searchProfile);
      const results = search.results;
      rawResults += results.length;

      for (const a of search.attempts) {
        if (!providerStats[a.engine]) continue;
        providerStats[a.engine].attempts += 1;
        if (!a.ok) providerStats[a.engine].errors += 1;
        providerStats[a.engine].rawResults += Number(a.resultCount || 0);
      }
      if (providerStats[search.usedEngine]) {
        providerStats[search.usedEngine].selected += 1;
      }

      let acceptedForTarget = 0;
      for (const r of results) {
        if (!titleFilter(r.title)) {
          filteredOut += 1;
          continue;
        }

        const locResult = locationFilter(r.title);
        if (!locResult.pass) {
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
          source: sourceTag,
        });
        acceptedForTarget += 1;
      }

      const attemptsNote = search.attempts.length > 1
        ? `, attempts=${search.attempts.length}`
        : '';

      const path = search.attempts
        .map((a) => `${a.engine}:${a.ok ? a.resultCount : 'ERR'}`)
        .join(' -> ');
      fallbackPaths.push(`${t.label} | ${path}${search.usedEngine ? ` | selected=${search.usedEngine}` : ''}`);

      if (search.hadProviderError && results.length === 0) {
        failures += 1;
        console.log(`  ${t.label}: failed (${search.lastProviderError})`);
      } else {
        console.log(`  ${t.label}: ${results.length} results (${acceptedForTarget} accepted, engine=${search.usedEngine}${attemptsNote})`);
      }
      if (pauseMs > 0) await sleep(pauseMs);
    } catch (err) {
      failures += 1;
      console.log(`  ${t.label}: failed (${String(err?.message || err).split('\n')[0]})`);
    }
  }

  if (!dryRun && newJobs.length > 0) {
    appendToPipeline(newJobs, outputQueuePath);
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
  console.log('');
  console.log('Provider stats');
  console.log('--------------');
  for (const [name, stats] of Object.entries(providerStats)) {
    console.log(`  ${name.padEnd(6)} attempts=${String(stats.attempts).padEnd(3)} selected=${String(stats.selected).padEnd(3)} raw=${String(stats.rawResults).padEnd(4)} errors=${stats.errors}`);
  }

  if (fallbackPaths.length > 0) {
    console.log('');
    console.log('Fallback path per query');
    console.log('-----------------------');
    for (const row of fallbackPaths.slice(0, 50)) {
      console.log(`  - ${row}`);
    }
    if (fallbackPaths.length > 50) {
      console.log(`  ... and ${fallbackPaths.length - 50} more`);
    }
  }

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
