import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { writeRunReceipt } from '../scripts/run-receipt.mjs';

test('writeRunReceipt creates json receipt with stage and payload', () => {
  const base = mkdtempSync(join(tmpdir(), 'career-ops-receipt-'));
  const filePath = writeRunReceipt(base, 'smoke', {
    durationMs: 123,
    ok: true,
  });

  const content = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(content.stage, 'smoke');
  assert.equal(content.durationMs, 123);
  assert.equal(content.ok, true);
  assert.ok(content.timestamp);
});
