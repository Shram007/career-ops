#!/usr/bin/env node
/**
 * score-pipeline.mjs
 *
 * Deterministic job scoring for pipeline.md or pipeline-referral.md
 * - Reads pipeline file (Pending entries)
 * - Fetches JD for each URL
 * - Scores via keyword matching against CV + archetype fit
 * - Updates pipeline (move to Processed)
 * - Appends to applications.md if score >= 3.0
 *
 * Usage:
 *   node score-pipeline.mjs --referral
 *   node score-pipeline.mjs --discovery
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const isReferral = args.includes('--referral');
const isDiscovery = args.includes('--discovery');

if (!isReferral && !isDiscovery) {
  console.error('Usage: node score-pipeline.mjs --referral|--discovery');
  process.exit(1);
}

const pipelineFile = isReferral ? 'data/pipeline-referral.md' : 'data/pipeline.md';
const mode = isReferral ? 'referral' : 'discovery';

console.log(`\n🚀 Scoring ${mode} pipeline: ${pipelineFile}\n`);

// ============================================================================
// Load context
// ============================================================================

const cv = readFileSync('cv.md', 'utf8');
const profile = yaml.load(readFileSync('config/profile.yml', 'utf8'));

// CV keywords (skills, techs, experience)
const cvKeywords = [
  'python', 'typescript', 'javascript', 'fastapi', 'react', 'backend',
  'frontend', 'full-stack', 'rag', 'langchain', 'llm', 'ai', 'ml',
  'gcp', 'aws', 'postgres', 'redis', 'docker', 'kubernetes',
  'observability', 'tracing', 'monitoring', 'agents', 'agentic',
  'multi-tenant', 'api', 'microservice'
];

// Primary archetype keywords (from profile)
const archetypeKeywords = {
  'ai-platform': ['observability', 'evals', 'pipelines', 'monitoring', 'reliability', 'llm'],
  'agentic': ['agent', 'hitl', 'orchestration', 'workflow', 'multi-agent'],
  'solutions-architect': ['architecture', 'enterprise', 'integration', 'design', 'systems'],
  'forward-deployed': ['client-facing', 'deploy', 'prototype', 'fast delivery', 'field']
};

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

  // Location hard-block
  const locationBlocks = ['emea', 'europe', 'uk', 'india', 'apac', 'australia', 'singapore', 'asia pacific'];
  const isLocationBlocked = locationBlocks.some(loc => jdLower.includes(loc)) &&
    !['remote', 'global', 'work from anywhere'].some(r => jdLower.includes(r));

  if (isLocationBlocked) {
    return { score: null, decision: 'hold', tags: 'location:non-us', strength: 'location-block' };
  }

  // Count keyword matches
  const cvMatches = cvKeywords.filter(kw => jdLower.includes(kw)).length;
  const maxCVMatches = cvKeywords.length;
  const cvFit = cvMatches / maxCVMatches;

  // Archetype fit
  let archetypeFit = 0;
  let bestArchetype = null;
  for (const [arch, keywords] of Object.entries(archetypeKeywords)) {
    const matches = keywords.filter(kw => jdLower.includes(kw)).length;
    const fit = matches / keywords.length;
    if (fit > archetypeFit) {
      archetypeFit = fit;
      bestArchetype = arch;
    }
  }

  // Seniority check (candidate is entry-level / new grad)
  const seniorityBlocks = ['staff', 'principal', 'director', 'vp', 'vice president'];
  const isSeniorityBlocked = seniorityBlocks.some(lvl => roleLower.includes(lvl));

  if (isSeniorityBlocked) {
    return { score: null, decision: 'hold', tags: 'seniority:overleveled', strength: 'seniority-block' };
  }

  // Calculate overall score
  // CV fit: 40%, archetype fit: 40%, other signals: 20%
  const score = (cvFit * 0.4) + (archetypeFit * 0.4) + (0.2 * 0.5); // baseline 0.5 for other signals
  const scaledScore = Math.min(5.0, Math.max(1.0, score * 5.0));

  const tags = bestArchetype ? `fit:${bestArchetype}` : 'fit:partial';
  const decision = scaledScore >= 3.0 ? 'advance' : 'hold';

  return {
    score: Math.round(scaledScore * 10) / 10,
    decision,
    tags,
    cvFit: Math.round(cvFit * 100),
    archetypeFit: Math.round(archetypeFit * 100)
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
    tracker: (scoreData.score && scoreData.score >= 3.0) ? '✓' : '✗'
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

// Append to applications.md if score >= 3.0
const tracker = readFileSync('data/applications.md', 'utf8');
const lastIdMatch = tracker.match(/\| (\d+) \|/g);
let nextId = 1;
if (lastIdMatch && lastIdMatch.length > 0) {
  const ids = lastIdMatch.map(m => parseInt(m.match(/\d+/)[0]));
  nextId = Math.max(...ids) + 1;
}

const advances = processed.filter(p => p.score && p.score >= 3.0);
if (advances.length > 0) {
  const newEntries = advances.map(job => {
    const id = nextId++;
    return `| ${id} | ${job.date} | ${job.company} | ${job.role} | ${job.score}/5 | Scored | ❌ | - | ${job.tags} |`;
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
