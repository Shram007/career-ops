import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const runNetworkTests = process.env.RUN_NETWORK_TESTS === '1';

function runReferralDryScan(company) {
  return spawnSync(
    process.execPath,
    ['scan-playwright.mjs', '--referral', '--dry-run', '--company', company, '--max-links', '10', '--timeout', '35000'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 180000,
    }
  );
}

function assertSummarySchema(stdout) {
  assert.match(stdout, /Playwright extraction summary/i);
  assert.match(stdout, /Targets scanned:\s+\d+/i);
  assert.match(stdout, /Candidates extracted:\s+\d+/i);
  assert.match(stdout, /Filtered out:\s+\d+\s+\(title:\s+\d+, location:\s+\d+, exp:\s+\d+\)/i);
  assert.match(stdout, /Duplicates:\s+\d+/i);
  assert.match(stdout, /New jobs:\s+\d+/i);
}

test('scan-playwright dry-run summary format and company counts (integration)', { skip: !runNetworkTests }, () => {
  const result = runReferralDryScan('google');

  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. stderr=${result.stderr || ''}`);

  const stdout = String(result.stdout || '');
  assertSummarySchema(stdout);

  // Per-company count guard.
  assert.match(stdout, /Google:\s+\d+\s+candidate links/i);
});

test('scan-playwright dry-run works for non-Google referral target (integration)', { skip: !runNetworkTests }, () => {
  const result = runReferralDryScan('oracle');

  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. stderr=${result.stderr || ''}`);

  const stdout = String(result.stdout || '');
  assertSummarySchema(stdout);

  // Per-company count guard.
  assert.match(stdout, /Oracle:\s+\d+\s+candidate links/i);
});
