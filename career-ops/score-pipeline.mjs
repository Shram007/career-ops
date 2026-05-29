#!/usr/bin/env node
/**
 * score-pipeline.mjs
 *
 * Deterministic job scoring for pipeline.md or pipeline-referral.md
 * - Reads pipeline file (Pending entries)
 * - Fetches JD for each URL
 * - Scores via weighted dimensions using target-role alignment + CV/proof-point fit
 * - Updates pipeline (move to Processed)
 * - Appends to applications.md if score >= 3.0
 *
 * Usage:
 *   node score-pipeline.mjs --referral
 *   node score-pipeline.mjs --discovery
 *   node score-pipeline.mjs --legacy-referral
 *   node score-pipeline.mjs --legacy-discovery
 */

import { readFileSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';
import { loadScoringConfig } from './scripts/scoring-config.mjs';

const args = process.argv.slice(2);
const isReferral = args.includes('--referral') || args.includes('--legacy-referral');
const isDiscovery = args.includes('--discovery') || args.includes('--legacy-discovery');

if (!isReferral && !isDiscovery) {
  console.error('Usage: node score-pipeline.mjs --referral|--discovery');
  process.exit(1);
}

const pipelineFile = isReferral ? 'data/pipeline-referral.md' : 'data/pipeline.md';
const mode = isReferral ? 'referral' : 'discovery';

console.log(`\n🚀 Scoring ${mode} pipeline: ${pipelineFile}\n`);
console.log(`[scorer] engine=legacy-deterministic scope=${mode} file=${pipelineFile}`);

// ============================================================================
// Load context
// ============================================================================

const cv = readFileSync('cv.md', 'utf8');
const profile = yaml.load(readFileSync('config/profile.yml', 'utf8')) || {};
const scoringConfig = loadScoringConfig();
const legacyScoring = scoringConfig.legacy;
const legacyDimensions = legacyScoring.dimensions;
const dimensionWeightTotal = Object.values(legacyDimensions).reduce((sum, weight) => sum + weight, 0);
const normalizedDimensionWeightTotal = dimensionWeightTotal > 0 ? dimensionWeightTotal : 1;

console.log(
  `[scorer] legacy_threshold=${legacyScoring.advance_threshold} comp_floor=${legacyScoring.comp_floor_usd}`,
);

function wordsFromText(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9+#-]+/)
    .filter(token => token.length >= 3);
}

function phraseTokens(text) {
  return wordsFromText(text).join(' ');
}

// CV keywords (skills, techs, experience)
const cvKeywords = [
  'python', 'typescript', 'javascript', 'fastapi', 'react', 'backend',
  'frontend', 'full-stack', 'rag', 'langchain', 'llm', 'ai', 'ml',
  'gcp', 'aws', 'postgres', 'redis', 'docker', 'kubernetes',
  'observability', 'tracing', 'monitoring', 'agents', 'agentic',
  'multi-tenant', 'api', 'microservice'
];

const profileProofText = [
  ...(profile?.narrative?.superpowers || []),
  ...(profile?.narrative?.proof_points || []).flatMap(point => [point?.name, point?.hero_metric]),
].filter(Boolean).join(' ');

const proofKeywords = Array.from(new Set([
  ...wordsFromText(profileProofText),
  ...cvKeywords,
]));

const configuredPrimaryRoles = profile?.target_roles?.primary || [];
const defaultPrimaryRoles = [
  'software engineer',
  'backend engineer',
  'backend developer',
  'full stack engineer',
  'full-stack engineer',
  'frontend engineer',
  'frontend developer',
  'platform engineer',
  'application engineer',
];
const targetRolePhrases = Array.from(new Set([
  ...configuredPrimaryRoles.map(phraseTokens),
  ...defaultPrimaryRoles.map(phraseTokens),
].filter(Boolean)));

const outsideUSRegions = [
  'uk', 'united kingdom', 'england', 'europe', 'emea', 'apac', 'india', 'australia', 'canada',
  'singapore', 'japan', 'germany', 'france', 'ireland', 'brazil', 'new zealand',
];
const positiveReputationSignals = ['microsoft', 'google', 'meta', 'amazon', 'openai', 'anthropic', 'stripe'];
const growthSignals = ['career growth', 'promotion', 'ownership', 'lead projects', 'mentorship', 'impact'];
const fastProcessSignals = ['hiring now', 'urgent', 'immediate start', 'fast process', 'expedited'];
const cultureSignals = ['collaborative', 'ownership', 'builder', 'inclusive', 'transparent', 'impact'];

function countMatches(haystack, keywords) {
  return keywords.reduce((count, keyword) => (haystack.includes(keyword) ? count + 1 : count), 0);
}

function ratioToScore(ratio, high = 0.6, medium = 0.35) {
  if (ratio >= high) return 5.0;
  if (ratio >= medium) return 4.0;
  if (ratio >= 0.2) return 3.5;
  if (ratio >= 0.1) return 3.0;
  return 2.0;
}

function isOutsideUSRequired(jdLower) {
  const allowsUS = /\b(united states|u\.?s\.?|usa|anywhere in us|remote us|us remote)\b/i.test(jdLower);
  if (allowsUS) return false;

  const requiresSpecificRegion = /\b(must be based in|must reside in|work authorization in|eligible to work in|located in)\b/i.test(jdLower);
  if (!requiresSpecificRegion) return false;

  return outsideUSRegions.some(region => jdLower.includes(region));
}

function parseSalaryMaxUSD(jdLower) {
  const salaryMatches = [...jdLower.matchAll(/\$\s?([0-9]{2,3})(?:[,\s]?([0-9]{3}))?(?:\+|k)?/g)];
  if (salaryMatches.length === 0) return null;

  const values = salaryMatches.map(match => {
    const major = Number(match[1]);
    const minor = match[2] ? Number(match[2]) : 0;
    if (minor > 0) return Number(`${major}${String(minor).padStart(3, '0')}`);
    if (major < 1000) return major * 1000;
    return major;
  });

  return Math.max(...values);
}

function inferRoleAlignment(roleLower, jdLower) {
  const corpus = `${roleLower} ${jdLower}`;
  const matches = targetRolePhrases.filter(phrase => phrase && corpus.includes(phrase)).length;
  const ratio = matches / Math.max(targetRolePhrases.length, 1);
  return ratioToScore(ratio, 0.22, 0.12);
}

function inferLevelScore(roleLower, jdLower) {
  const corpus = `${roleLower} ${jdLower}`;
  if (/\b(staff|principal|director|vp|vice president|distinguished)\b/i.test(corpus)) return 2.0;
  if (/\b(senior|sr\.?|lead)\b/i.test(corpus)) return 3.0;
  if (/\b(mid|intermediate|ii|iii)\b/i.test(corpus)) return 3.8;
  if (/\b(junior|new grad|graduate|entry|associate|i\b)\b/i.test(corpus)) return 4.8;
  return 4.2;
}

function inferCompScore(jdLower) {
  const parsedMax = parseSalaryMaxUSD(jdLower);
  if (!parsedMax) return 3.5;
  if (parsedMax >= legacyScoring.comp_floor_usd) return 4.5;
  if (parsedMax >= legacyScoring.comp_floor_usd * 0.9) return 3.5;
  return 2.5;
}

function inferRemoteScore(jdLower) {
  if (/\b(remote|distributed|work from anywhere)\b/i.test(jdLower)) return 4.5;
  if (/\b(hybrid)\b/i.test(jdLower)) return 3.8;
  if (/\b(onsite|on-site|in office)\b/i.test(jdLower)) return 3.0;
  return 3.5;
}

function inferSimpleSignalScore(jdLower, signals, strong = 4.3, neutral = 3.5, weak = 3.0) {
  const matches = countMatches(jdLower, signals);
  if (matches >= 2) return strong;
  if (matches === 1) return neutral;
  return weak;
}

function inferTrackerLocation(jdLower) {
  const isRemote = /\b(remote|work from anywhere|distributed)\b/i.test(jdLower);
  const hasUS = /\b(united states|u\.?s\.?|usa|us-only|us only|within the us|san francisco|bay area|california|new york|seattle|washington)\b/i.test(jdLower);
  const hasOutsideUS = outsideUSRegions.some(region => jdLower.includes(region));

  if (isRemote && hasUS) return 'Remote (US)';
  if (isRemote && !hasOutsideUS) return 'Remote';
  if (hasUS) return 'US';
  if (hasOutsideUS) return 'Outside US';
  return 'Unknown';
}

// ============================================================================
// Parse pipeline
// ============================================================================

const pipelineContent = readFileSync(pipelineFile, 'utf8');
const lines = pipelineContent.split('\n');

let inPending = false;
const pending = [];

for (const line of lines) {
  if (line.includes('## Pending')) {
    inPending = true;
    continue;
  }
  if (line.includes('##')) {
    inPending = false;
  }
  if (inPending && line.startsWith('- [ ]')) {
    const parts = line.substring(6).split('|').map(p => p.trim());
    if (parts.length >= 4) {
      pending.push({
        date: parts[0],
        url: parts[1],
        company: parts[2],
        role: parts[3],
        original: line
      });
    }
  }
}

if (pending.length === 0) {
  console.log('✓ No pending entries');
  process.exit(0);
}

console.log(`Found ${pending.length} pending entries\n`);

// ============================================================================
// Score each URL
// ============================================================================

const results = [];
const processed = [];

async function fetchJD(url) {
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    await browser.close();
    return text ? text.substring(0, 3000) : null;
  } catch (err) {
    return null;
  }
}

function scoreJob(job, jdText) {
  const jdLower = jdText.toLowerCase();
  const roleLower = job.role.toLowerCase();

  if (isOutsideUSRequired(jdLower)) {
    return { score: null, decision: 'hold', tags: 'location:outside-us-required', strength: 'location-block', trackerLocation: 'Outside US' };
  }

  const cvKeywordHits = countMatches(jdLower, cvKeywords);
  const proofKeywordHits = countMatches(jdLower, proofKeywords);
  const cvRatio = cvKeywordHits / Math.max(cvKeywords.length, 1);
  const proofRatio = proofKeywordHits / Math.max(proofKeywords.length, 1);

  const dimensionScores = {
    north_star_alignment: inferRoleAlignment(roleLower, jdLower),
    cv_match: ratioToScore((cvRatio * 0.35) + (proofRatio * 0.65), 0.28, 0.16),
    level: inferLevelScore(roleLower, jdLower),
    estimated_comp: inferCompScore(jdLower),
    growth_trajectory: inferSimpleSignalScore(jdLower, growthSignals, 4.2, 3.7, 3.2),
    remote_quality: inferRemoteScore(jdLower),
    company_reputation: inferSimpleSignalScore(jdLower, positiveReputationSignals, 4.2, 3.6, 3.3),
    tech_stack_modernity: ratioToScore((cvRatio * 0.65) + (proofRatio * 0.35), 0.3, 0.16),
    speed_to_offer: inferSimpleSignalScore(jdLower, fastProcessSignals, 4.0, 3.6, 3.3),
    cultural_signals: inferSimpleSignalScore(jdLower, cultureSignals, 4.1, 3.6, 3.2),
  };

  const weightedScore = Object.entries(legacyDimensions).reduce(
    (sum, [dimension, weight]) => sum + ((dimensionScores[dimension] || 3.0) * weight),
    0,
  );
  const finalScore = weightedScore / normalizedDimensionWeightTotal;
  const scaledScore = Math.min(5.0, Math.max(1.0, finalScore));

  let decision = scaledScore >= legacyScoring.advance_threshold ? 'advance' : 'hold';
  if (dimensionScores.level <= 2.5) {
    decision = 'hold';
  }

  const tags = [];
  if (dimensionScores.north_star_alignment >= 4.0) tags.push('fit:target-role');
  if (proofRatio >= 0.2) tags.push('proof:strong');
  if (dimensionScores.level <= 2.5) tags.push('seniority:overleveled');
  if (dimensionScores.estimated_comp >= 4.0) tags.push('comp:ok');
  if (tags.length === 0) tags.push(scaledScore >= legacyScoring.advance_threshold ? 'fit:strong' : 'fit:partial');

  return {
    score: Math.round(scaledScore * 10) / 10,
    decision,
    tags: tags.join(','),
    trackerLocation: inferTrackerLocation(jdLower),
    proofFit: Math.round(proofRatio * 100),
    cvFit: Math.round(cvRatio * 100),
    northStar: Math.round(dimensionScores.north_star_alignment * 10) / 10,
    level: Math.round(dimensionScores.level * 10) / 10,
    comp: Math.round(dimensionScores.estimated_comp * 10) / 10,
  };
}

for (const job of pending) {
  process.stdout.write(`${job.company.substring(0, 15).padEnd(15)} | ${job.role.substring(0, 30).padEnd(30)} `);

  const jdText = await fetchJD(job.url);
  if (!jdText) {
    console.log('[!] fetch-failed');
    processed.push({
      ...job,
      marker: '[!]',
      score: null,
      decision: null,
      tags: 'fetch-error'
    });
    continue;
  }

  const scoreData = scoreJob(job, jdText);
  if (scoreData.strength === 'location-block') {
    console.log(`hold | location`);
  } else if (scoreData.strength === 'seniority-block') {
    console.log(`hold | seniority`);
  } else {
    console.log(`${scoreData.score}/5 | ${scoreData.decision}`);
  }

  processed.push({
    ...job,
    marker: '[x]',
    ...scoreData
  });

  results.push({
    company: job.company,
    role: job.role.substring(0, 40),
    score: scoreData.score || 'n/a',
    decision: scoreData.decision || 'error',
    tracker: (scoreData.score && scoreData.score >= legacyScoring.advance_threshold) ? '✓' : '✗'
  });
}

// ============================================================================
// Update files
// ============================================================================

// Remove pending entries from pipeline
let updatedPipeline = pipelineContent;
for (const job of pending) {
  updatedPipeline = updatedPipeline.replace(job.original + '\n', '');
}

// Add to Processed
const processedLines = processed.map(p => {
  const scoreStr = p.score !== null && p.score !== undefined ? `${p.score}/5` : 'n/a';
  return `- ${p.marker} ${p.date} | ${p.url} | ${p.company} | ${p.role} | ${scoreStr} | ${p.decision || '—'} | ${p.tags}`;
});

const processedIdx = updatedPipeline.indexOf('## Processed');
if (processedIdx > -1) {
  const beforeProcessed = updatedPipeline.substring(0, processedIdx + '## Processed'.length + 1);
  const afterProcessed = updatedPipeline.substring(processedIdx + '## Processed'.length + 1);
  updatedPipeline = beforeProcessed + '\n' + processedLines.join('\n') + afterProcessed;
}

writeFileSync(pipelineFile, updatedPipeline);
console.log(`\n✓ Updated ${pipelineFile}`);

// Append to applications.md if score meets configured legacy threshold.
const tracker = readFileSync('data/applications.md', 'utf8');
const lastIdMatch = tracker.match(/\| (\d+) \|/g);
let nextId = 1;
if (lastIdMatch && lastIdMatch.length > 0) {
  const ids = lastIdMatch.map(m => parseInt(m.match(/\d+/)[0]));
  nextId = Math.max(...ids) + 1;
}

const advances = processed.filter(p => p.score && p.score >= legacyScoring.advance_threshold);
if (advances.length > 0) {
  const newEntries = advances.map(job => {
    const id = nextId++;
    return `| ${id} | ${job.date} | ${job.company} | ${job.role} | ${job.score}/5 | Scored | ❌ | - | ${job.tags} | ${job.trackerLocation || 'Unknown'} |`;
  }).join('\n');

  const trackerLines = tracker.split('\n');
  const headerIdx = trackerLines.findIndex(l => l.includes('|') && l.includes('Date'));
  if (headerIdx >= 0) {
    trackerLines.splice(headerIdx + 1, 0, newEntries);
    writeFileSync('data/applications.md', trackerLines.join('\n'));
    console.log(`✓ Added ${advances.length} entries to applications.md`);
  }
}

// ============================================================================
// Summary
// ============================================================================

console.log('\n=== SUMMARY ===\n');
console.table(results);
console.log(`\nAdvanced: ${results.filter(r => r.decision === 'advance').length}`);
console.log(`On hold: ${results.filter(r => r.decision === 'hold').length}`);
console.log(`Errors: ${results.filter(r => !r.score || r.score === 'n/a').length}\n`);
