import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFixes,
  findInconsistencies,
} from '../check-score-decision-consistency.mjs';

test('findInconsistencies reads score/status from correct columns', () => {
  const lines = [
    '| 41 | 2026-05-18 | ACME | Backend Engineer | 2.8/5 | Scored | ⏳ | [Report](reports/r-41.md) | note |',
  ];

  const issues = findInconsistencies(lines);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].num, '41');
  assert.equal(issues[0].status, 'Scored');
});

test('findInconsistencies uses latest status in chain', () => {
  const lines = [
    '| 42 | 2026-05-18 | ACME | Platform Engineer | 3.9/5 | Scored > SKIP | ⏳ | [Report](reports/r-42.md) | note |',
  ];

  const issues = findInconsistencies(lines);
  assert.equal(issues.length, 1);
  assert.match(issues[0].issue, /should end in Scored/);
});

test('findInconsistencies ignores entries already in motion', () => {
  const lines = [
    '| 43 | 2026-05-18 | ACME | Infra Engineer | 2.1/5 | Scored > Applied | ✅ | [Report](reports/r-43.md) | note |',
  ];

  const issues = findInconsistencies(lines);
  assert.equal(issues.length, 0);
});

test('applyFixes updates latest status segment only', () => {
  const lines = [
    '| 44 | 2026-05-18 | ACME | Data Engineer | 3.6/5 | Evaluated > SKIP | ⏳ | [Report](reports/r-44.md) | note |',
  ];
  const inconsistencies = [
    { num: '44', score: 3.6, line: 0, status: 'Evaluated > SKIP' },
  ];

  const fixed = applyFixes(lines, inconsistencies);
  assert.equal(fixed, 1);
  assert.match(lines[0], /\| Evaluated > Scored \|/);
});

test('fixture-style markdown rows detect low-score Scored mismatch', () => {
  const lines = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 51 | 2026-05-18 | ElevenLabs | SWE | 2.2/5 | Scored | ❌ | [51](reports/51.md) | note |',
  ];

  const issues = findInconsistencies(lines);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].num, '51');
  assert.match(issues[0].issue, /should end in SKIP/);
});

test('applyFixes can set status when chain is blank', () => {
  const lines = [
    '| 52 | 2026-05-18 | ACME | SWE | 2.5/5 |  | ❌ | [52](reports/52.md) | note |',
  ];
  const inconsistencies = [
    { num: '52', score: 2.5, line: 0, status: '' },
  ];

  const fixed = applyFixes(lines, inconsistencies);
  assert.equal(fixed, 1);
  assert.match(lines[0], /\| SKIP \|/);
});
