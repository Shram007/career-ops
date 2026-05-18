import test from 'node:test';
import assert from 'node:assert/strict';

import { detectUrlType, resolveScannerRoute } from '../scan-single-url.mjs';

test('detectUrlType classifies known API endpoints', () => {
  assert.equal(detectUrlType('https://boards-api.greenhouse.io/v1/boards/openai/jobs'), 'api');
  assert.equal(detectUrlType('https://api.lever.co/v0/postings/company'), 'api');
});

test('detectUrlType classifies job detail pages across ATS providers', () => {
  assert.equal(detectUrlType('https://jobs.lever.co/company/123e4567-e89b-12d3-a456-426614174000'), 'job_detail');
  assert.equal(detectUrlType('https://jobs.ashbyhq.com/company/123e4567-e89b-12d3-a456-426614174000'), 'job_detail');
  assert.equal(detectUrlType('https://boards.greenhouse.io/company/jobs/1234567'), 'job_detail');
  assert.equal(detectUrlType('https://www.google.com/about/careers/applications/jobs/results/123456789-software-engineer'), 'job_detail');
});

test('detectUrlType classifies listing/search pages', () => {
  assert.equal(detectUrlType('https://www.amazon.jobs/en/search?base_query=software+engineer'), 'listing');
  assert.equal(detectUrlType('https://jobs.careers.microsoft.com/global/en/search?q=backend+engineer'), 'listing');
  assert.equal(detectUrlType('https://jobs.ashbyhq.com/company'), 'listing');
});

test('unknown URLs fall back safely to playwright', () => {
  const route = resolveScannerRoute('https://example.com/careers');
  assert.equal(route.urlType, 'listing');
  assert.equal(route.script, 'scan-playwright.mjs');
  assert.deepEqual(route.scriptArgs, ['--url', 'https://example.com/careers']);
});

test('api URLs route to scan.mjs', () => {
  const route = resolveScannerRoute('https://boards-api.greenhouse.io/v1/boards/openai/jobs');
  assert.equal(route.script, 'scan.mjs');
  assert.deepEqual(route.scriptArgs, ['--url', 'https://boards-api.greenhouse.io/v1/boards/openai/jobs']);
});
