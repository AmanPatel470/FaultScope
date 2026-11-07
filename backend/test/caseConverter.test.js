'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toCamel } = require('../src/caseConverter');

test('converts nested keys and arrays but never values', () => {
  const input = {
    failed_service: 'payment-service',
    impact: { raw_impact: 2.8, contributions: [{ dependency_strength: 0.9 }] },
    paths: [['order-service', 'payment-service']],
    paths_truncated: false,
  };
  assert.deepEqual(toCamel(input), {
    failedService: 'payment-service',
    impact: { rawImpact: 2.8, contributions: [{ dependencyStrength: 0.9 }] },
    paths: [['order-service', 'payment-service']],
    pathsTruncated: false,
  });
});

test('leaves null, primitives and already-camelCase keys alone', () => {
  assert.equal(toCamel(null), null);
  assert.equal(toCamel(5), 5);
  assert.equal(toCamel('a_b'), 'a_b');
  assert.deepEqual(toCamel({ alreadyCamel: 1, plain: 2 }), { alreadyCamel: 1, plain: 2 });
});