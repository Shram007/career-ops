import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupeKey,
  isLikelyFeedUrl,
  isLikelyJobDetailUrl,
  looksLikeJobLink,
  normalizeTitle,
  normalizeTitleCandidates,
  parseRssItems,
} from '../scan-playwright.mjs';

test('dedupeKey removes query and hash for equivalent jobs', () => {
  const a = dedupeKey('https://example.com/jobs/123?source=linkedin#apply');
  const b = dedupeKey('https://example.com/jobs/123?source=google#overview');
  assert.equal(a, b);
});

test('isLikelyJobDetailUrl detects multiple providers', () => {
  assert.equal(isLikelyJobDetailUrl('https://jobs.lever.co/company/123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(isLikelyJobDetailUrl('https://boards.greenhouse.io/company/jobs/1234567'), true);
  assert.equal(isLikelyJobDetailUrl('https://company.wd1.myworkdayjobs.com/en-US/careers/job/San-Francisco/Backend-Engineer_R12345'), true);
  assert.equal(isLikelyJobDetailUrl('https://www.amazon.jobs/en/search?base_query=software+engineer'), false);
});

test('isLikelyFeedUrl detects rss and xml feeds', () => {
  assert.equal(isLikelyFeedUrl('https://careers.salesforce.com/en/jobs/xml/?rss=true'), true);
  assert.equal(isLikelyFeedUrl('https://example.com/jobs.rss'), true);
  assert.equal(isLikelyFeedUrl('https://example.com/careers'), false);
});

test('looksLikeJobLink identifies job links and rejects generic pages', () => {
  assert.equal(looksLikeJobLink('https://boards.greenhouse.io/company/jobs/123456', 'Software Engineer'), true);
  assert.equal(looksLikeJobLink('https://jobs.ashbyhq.com/company/abcd1234-1234-5678-9abc-abcdef123456', 'Backend Engineer'), true);
  assert.equal(looksLikeJobLink('https://example.com/about', 'About Us'), false);
});

test('normalizeTitle derives fallback title from URL path when anchor text is empty', () => {
  const title = normalizeTitle('', 'https://example.com/jobs/senior-backend-engineer');
  assert.equal(title, 'senior backend engineer');
});

test('normalizeTitleCandidates keeps meaningful unique titles', () => {
  const actual = normalizeTitleCandidates([
    'Job Opening',
    'Software Engineer, AI Platform',
    'Software Engineer, AI Platform',
    'Careers',
  ]);
  assert.deepEqual(actual, ['Software Engineer, AI Platform']);
});

test('parseRssItems parses standard RSS items and salesforce style job items', () => {
  const xml = `
    <rss>
      <channel>
        <item><title>Software Engineer</title><link>https://example.com/jobs/1</link></item>
        <job><title><![CDATA[AI Engineer]]></title><url><![CDATA[https://example.com/jobs/2]]></url></job>
      </channel>
    </rss>
  `;
  const jobs = parseRssItems(xml, 10);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].url, 'https://example.com/jobs/1');
  assert.equal(jobs[1].url, 'https://example.com/jobs/2');
});
