'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  WINDOW_SECONDS,
  FEATURE_NAMES,
  isValidServiceName,
  buildQueries,
  parseVectorValue,
  fetchWindow,
  validateWindow,
} = require('../src/telemetryFeatures');

const SERVICES = [
  'api-gateway',
  'auth-service',
  'order-service',
  'payment-service',
  'inventory-service',
  'notification-service',
];

test('the window and the five features match the anomaly engine', () => {
  assert.equal(WINDOW_SECONDS, 30);
  assert.deepEqual(FEATURE_NAMES, ['requestRate', 'errorRate', 'avgLatency', 'p95Latency', 'timeoutCount']);
});

test('queries use the Phase 2 metric names, the 30 s window and the right labels', () => {
  const q = buildQueries('payment-service');
  assert.deepEqual(Object.keys(q), FEATURE_NAMES);
  for (const name of ['requestRate', 'errorRate', 'avgLatency', 'p95Latency']) {
    assert.match(q[name], /job="payment-service"/);
    assert.match(q[name], /http_route!~"\/health\.\*"/);
    assert.match(q[name], /\[30s\]/);
  }
  assert.match(q.requestRate, /^sum\(rate\(http_server_request_duration_seconds_count\{/);
  assert.match(q.errorRate, /http_response_status_code=~"5\.\."/);
  assert.match(q.avgLatency, /http_server_request_duration_seconds_sum/);
  assert.match(q.p95Latency, /^histogram_quantile\(0\.95, sum by \(le\) \(rate\(http_server_request_duration_seconds_bucket/);
  assert.match(q.timeoutCount, /http_client_request_duration_seconds_count\{peer_service="payment-service",outcome="timeout"\}/);
  assert.doesNotMatch(q.timeoutCount, /job=/, 'timeouts are attributed to the callee, not the caller');
});

test('only plain service names can reach PromQL', () => {
  for (const name of SERVICES) assert.equal(isValidServiceName(name), true, name);
  for (const bad of ['', 'Payment', 'a"b', 'a b', 'x}{', '-x', '9x', 'a'.repeat(64), 'a;b', 'a\nb', null, 5, undefined]) {
    assert.equal(isValidServiceName(bad), false, JSON.stringify(bad));
  }
  assert.throws(() => buildQueries('x"} or vector(1) #'), /invalid service name/);
});

test('parseVectorValue handles empty vectors, strings, NaN and Inf', () => {
  const vector = (value) => ({ resultType: 'vector', result: [{ metric: {}, value: [1700000000, value] }] });
  assert.equal(parseVectorValue({ resultType: 'vector', result: [] }), null);
  assert.equal(parseVectorValue(vector('0.25')), 0.25);
  assert.ok(Number.isNaN(parseVectorValue(vector('NaN'))));
  assert.equal(parseVectorValue(vector('+Inf')), Infinity);
  assert.equal(parseVectorValue(vector('-Inf')), -Infinity);
  assert.throws(() => parseVectorValue({ resultType: 'matrix', result: [] }), /unexpected/);
  assert.throws(() => parseVectorValue(null), /unexpected/);
});

function fakePrometheus(values) {
  const calls = [];
  return {
    calls,
    async query(promql) {
      calls.push(promql);
      let value = values.requestRate;
      if (promql.includes('histogram_quantile')) value = values.p95Latency;
      else if (promql.includes('increase(')) value = values.timeoutCount;
      else if (promql.includes('_sum{')) value = values.avgLatency;
      else if (promql.includes('5..')) value = values.errorRate;
      return { resultType: 'vector', result: value === null ? [] : [{ metric: {}, value: [1, String(value)] }] };
    },
  };
}

test('fetchWindow returns the five cleaned features', async () => {
  const prometheus = fakePrometheus({ requestRate: 6.2, errorRate: 0.01, avgLatency: 0.007, p95Latency: 0.02, timeoutCount: 1.4 });
  const window = await fetchWindow({ prometheus, service: 'payment-service' });
  assert.deepEqual(window, { requestRate: 6.2, errorRate: 0.01, avgLatency: 0.007, p95Latency: 0.02, timeoutCount: 1.4 });
  assert.equal(prometheus.calls.length, 5);
});

test('fetchWindow turns NaN, negatives and out-of-range ratios into safe values', async () => {
  const prometheus = fakePrometheus({ requestRate: 0, errorRate: 'NaN', avgLatency: 'NaN', p95Latency: 'NaN', timeoutCount: -0.0001 });
  assert.deepEqual(await fetchWindow({ prometheus, service: 'auth-service' }), {
    requestRate: 0, errorRate: 0, avgLatency: 0, p95Latency: 0, timeoutCount: 0,
  });
  const over = fakePrometheus({ requestRate: 5, errorRate: 3, avgLatency: 0.01, p95Latency: 0.02, timeoutCount: 0 });
  assert.equal((await fetchWindow({ prometheus: over, service: 'auth-service' })).errorRate, 1);
});

test('fetchWindow returns null when Prometheus has no request series for the service', async () => {
  const prometheus = fakePrometheus({ requestRate: null, errorRate: 0, avgLatency: 0, p95Latency: 0, timeoutCount: 0 });
  assert.equal(await fetchWindow({ prometheus, service: 'payment-service' }), null);
});

test('validateWindow accepts exactly the five features and rejects everything else', () => {
  const ok = { requestRate: 5, errorRate: 0.1, avgLatency: 0.01, p95Latency: 0.03, timeoutCount: 0 };
  assert.deepEqual(validateWindow(ok), { window: ok });
  const bad = [
    null, [], 'x', {}, { ...ok, extra: 1 },
    { ...ok, errorRate: 1.5 }, { ...ok, requestRate: -1 }, { ...ok, avgLatency: '0.01' },
    { ...ok, p95Latency: NaN }, { ...ok, timeoutCount: Infinity },
    Object.fromEntries(Object.entries(ok).filter(([k]) => k !== 'errorRate')),
  ];
  for (const candidate of bad) {
    assert.equal(validateWindow(candidate).error.error.code, 'VALIDATION_ERROR', JSON.stringify(candidate));
  }
});
