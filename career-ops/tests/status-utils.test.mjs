import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendStatusHistory,
  isBlockedStatus,
  latestStatusToken,
  normalizeStatusHistory,
  normalizeStatusToken,
} from '../scripts/status-utils.mjs';

test('normalizeStatusToken supports canonical aliases', () => {
  assert.equal(normalizeStatusToken("PDF'd").id, 'pdf');
  assert.equal(normalizeStatusToken('pdfd').id, 'pdf');
  assert.equal(normalizeStatusToken('expired').id, 'inactive');
  assert.equal(normalizeStatusToken('monitor').id, 'skip');
});

test('normalizeStatusHistory normalizes chain to canonical display labels', () => {
  const normalized = normalizeStatusHistory("score > pdfd > aplicado");
  assert.equal(normalized.unknown, false);
  assert.equal(normalized.status, "Scored > PDF'd > Applied");
});

test('latestStatusToken returns latest canonical token id', () => {
  assert.equal(latestStatusToken("Scored > PDF'd > Applied"), 'applied');
  assert.equal(latestStatusToken('Scored > expired'), 'inactive');
});

test('appendStatusHistory appends without duplicating latest state', () => {
  assert.equal(appendStatusHistory("Scored > PDF'd", "Applied"), "Scored > PDF'd > Applied");
  assert.equal(appendStatusHistory("Scored > Applied", "Applied"), "Scored > Applied");
});

test('isBlockedStatus blocks closed and already-pdf statuses', () => {
  assert.equal(isBlockedStatus('Rejected'), true);
  assert.equal(isBlockedStatus('Scored > PDF\'d'), true);
  assert.equal(isBlockedStatus('Scored'), false);
});
