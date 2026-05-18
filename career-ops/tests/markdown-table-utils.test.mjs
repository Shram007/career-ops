import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTrackerRow, parseTrackerRow } from '../scripts/markdown-table-utils.mjs';

test('parseTrackerRow handles notes containing extra pipes', () => {
  const row = parseTrackerRow('| 41 | 2026-05-18 | ACME | SWE | 4.2/5 | Scored | ❌ | [41](reports/41.md) | tag:a | note with | pipe |');
  assert.ok(row);
  assert.equal(row.id, 41);
  assert.equal(row.notes, 'tag:a | note with | pipe');
});

test('buildTrackerRow round-trips parsed tracker row fields', () => {
  const source = parseTrackerRow('| 42 | 2026-05-18 | ACME | SWE | 4.0/5 | Scored | ❌ | - | notes | with | separators |');
  const rebuilt = buildTrackerRow(source);
  assert.match(rebuilt, /^\| 42 \| 2026-05-18 \| ACME \| SWE \| 4\.0\/5 \| Scored \| ❌ \| - \| notes \| with \| separators \|$/);
});
