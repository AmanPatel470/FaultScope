'use strict';

process.env.LOG_LEVEL = 'silent';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const { createApp } = require('../src/app');
const { startStub, closedUrl, listen, sleep } = require('../testkit/stubServer');

const FEATURES = { requestRate: 6.2, errorRate: 0.01, avgLatency: 0.007, p95Latency: 0.02, timeoutCount: 1 };

// Fake Prometheus: answers each of the five feature queries from `values` (null = empty vector).
function prometheusStub(values = FEATURES) {
  return (call, reply) => {
    if (call.path === '/-/healthy') return reply(200, {});
    const query = new URL(call.path, 'http://x').searchParams.get('query') || '';
    let value = values.requestRate;
    if (query.includes('histogram_quantile')) value = values.p95Latency;
    else if (query.includes('increase(')) value = values.timeoutCount;
    else if (query.includes('_sum{')) value = values.avgLatency;
    else if (query.includes('5..')) value = values.errorRate;
    return reply(200, {
      status: 'success',
      data: { resultType: 'vector', result: value === null ? [] : [{ metric: {}, value: [1700000000, String(value)] }] },
    });
  };
}

const ENGINE_RESULT = {
  service: 'payment-service',
  status: 'anomalous',
  is_anomalous: true,
  anomaly_score: 0.71,
  threshold: 0.64,
  margin: 0.07,
  window_seconds: 30,
  top_features: [{ feature: 'error_rate', value: 0.5, baseline: 0, direction: 'above', contribution: 0.12 }],
  interpretation: 'Isolation Forest anomaly score.',
};

const engineStub = (call, reply) => {
  if (call.path === '/health') return reply(200, { status: 'ok' });
  if (call.path === '/model') return reply(200, { feature_names: ['request_rate'], train_median_raw: { 'payment-service': [6] } });
  if (call.path === '/predict') {
    return call.body.service === 'payment-service'
      ? reply(200, ENGINE_RESULT)
      : reply(404, { error: { code: 'UNKNOWN_SERVICE', message: `Unknown service '${call.body.service}'` } });
  }
  return reply(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
};

async function startBackend(t, overrides = {}) {
  const prometheus = await startStub(overrides.prometheus || prometheusStub());
  const engine = await startStub(overrides.engine || engineStub);
  const blast = await startStub(overrides.blast || ((call, reply) => reply(200, { status: 'ok', failed_service: 'x', direct_dependents: [] })));
  const config = {
    ...baseConfig,
    prometheusUrl: overrides.prometheusUrl || prometheus.url,
    anomalyEngineUrl: overrides.engineUrl || engine.url,
    blastRadiusUrl: blast.url,
    requestTimeoutMs: 300,
    healthTimeoutMs: 300,
    prometheusTimeoutMs: 300,
    maxRetries: 1,
    retryBaseDelayMs: 5,
    ...(overrides.config || {}),
  };
  const app = await listen(createApp({ config }));
  t.after(async () => {
    await app.close();
    await Promise.all([prometheus.close(), engine.close(), blast.close()]);
  });
  const post = (path, body) =>
    fetch(`${app.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { url: app.url, prometheus, engine, post };
}

test('GET /api/anomaly/services/:service scores the Prometheus window and returns camelCase', async (t) => {
  const svc = await startBackend(t);
  const res = await fetch(`${svc.url}/api/anomaly/services/payment-service`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'anomalous');
  assert.equal(body.isAnomalous, true);
  assert.equal(body.anomalyScore, 0.71);
  assert.equal(body.windowSeconds, 30);
  assert.equal(body.source, 'prometheus');
  assert.deepEqual(body.window, FEATURES);
  assert.equal(body.topFeatures[0].feature, 'error_rate');
  assert.equal('anomaly_score' in body, false);

  // five PromQL queries, then one prediction with the window in the engine's snake_case
  assert.equal(svc.prometheus.calls.length, 5);
  assert.equal(svc.engine.calls.length, 1);
  assert.deepEqual(svc.engine.calls[0].body, {
    service: 'payment-service',
    window: { request_rate: 6.2, error_rate: 0.01, avg_latency: 0.007, p95_latency: 0.02, timeout_count: 1 },
    explain: true,
  });
  assert.equal(svc.engine.calls[0].headers['x-request-id'], res.headers.get('x-request-id'));
});

test('no Prometheus series means status no_data and the engine is not called', async (t) => {
  const svc = await startBackend(t, { prometheus: prometheusStub({ ...FEATURES, requestRate: null }) });
  const res = await fetch(`${svc.url}/api/anomaly/services/payment-service`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'no_data');
  assert.equal(body.isAnomalous, null);
  assert.equal(body.window, null);
  assert.equal(svc.engine.calls.length, 0);
});

test('invalid service names are rejected before any query is built', async (t) => {
  const svc = await startBackend(t);
  for (const bad of ['Payment', 'a%22b', 'x%7D%7B', '-x']) {
    const res = await fetch(`${svc.url}/api/anomaly/services/${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  }
  assert.equal(svc.prometheus.calls.length, 0);
  assert.equal(svc.engine.calls.length, 0);
});

test('an unreachable Prometheus returns 502 naming prometheus and never reaches the engine', async (t) => {
  const svc = await startBackend(t, { prometheusUrl: await closedUrl() });
  const res = await fetch(`${svc.url}/api/anomaly/services/payment-service`);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(body.error.service, 'prometheus');
  assert.equal(svc.engine.calls.length, 0);
});

test('a hung Prometheus returns 504', async (t) => {
  const svc = await startBackend(t, {
    config: { prometheusTimeoutMs: 100, maxRetries: 0 },
    prometheus: async (call, reply) => {
      await sleep(400);
      reply(200, {});
    },
  });
  const res = await fetch(`${svc.url}/api/anomaly/services/payment-service`);
  const body = await res.json();
  assert.equal(res.status, 504);
  assert.equal(body.error.code, 'DEPENDENCY_TIMEOUT');
  assert.equal(body.error.service, 'prometheus');
});

test("Prometheus's own error body is mapped to 502, not passed through", async (t) => {
  const svc = await startBackend(t, {
    prometheus: (call, reply) => reply(400, { status: 'error', errorType: 'bad_data', error: 'parse error' }),
  });
  const res = await fetch(`${svc.url}/api/anomaly/services/payment-service`);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.service, 'prometheus');
  assert.equal(JSON.stringify(body).includes('parse error'), false);
});

test('a malformed successful Prometheus response is a 502', async (t) => {
  const svc = await startBackend(t, { prometheus: (call, reply) => reply(200, { status: 'success' }) });
  const res = await fetch(`${svc.url}/api/anomaly/services/payment-service`);
  assert.equal(res.status, 502);
});

test('an unreachable anomaly engine returns 502 naming anomaly-engine', async (t) => {
  const svc = await startBackend(t, { engineUrl: await closedUrl() });
  const res = await fetch(`${svc.url}/api/anomaly/services/payment-service`);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(body.error.service, 'anomaly-engine');
});

test('POST /api/anomaly/score maps camelCase to the engine format and returns camelCase', async (t) => {
  const svc = await startBackend(t);
  const res = await svc.post('/api/anomaly/score', { service: 'payment-service', window: FEATURES, explain: false });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.source, 'request');
  assert.equal(body.anomalyScore, 0.71);
  assert.equal(svc.prometheus.calls.length, 0);
  assert.deepEqual(svc.engine.calls[0].body.window, {
    request_rate: 6.2, error_rate: 0.01, avg_latency: 0.007, p95_latency: 0.02, timeout_count: 1,
  });
  assert.equal(svc.engine.calls[0].body.explain, false);
});

test('POST /api/anomaly/score rejects invalid bodies without calling the engine', async (t) => {
  const svc = await startBackend(t);
  const bad = [
    {},
    { service: 'payment-service' },
    { service: 'Payment', window: FEATURES },
    { service: 'payment-service', window: { ...FEATURES, extra: 1 } },
    { service: 'payment-service', window: { ...FEATURES, errorRate: 2 } },
    { service: 'payment-service', window: { ...FEATURES, requestRate: -1 } },
    { service: 'payment-service', window: { ...FEATURES, avgLatency: 'fast' } },
    { service: 'payment-service', window: FEATURES, explain: 'yes' },
    { service: 'payment_service', window: { request_rate: 1, error_rate: 0, avg_latency: 0, p95_latency: 0, timeout_count: 0 } },
  ];
  for (const body of bad) {
    const res = await svc.post('/api/anomaly/score', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  }
  assert.equal(svc.engine.calls.length, 0);
});

test('an engine 404 for an unknown service passes through and is not retried', async (t) => {
  const svc = await startBackend(t);
  const res = await svc.post('/api/anomaly/score', { service: 'ghost-service', window: FEATURES });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'UNKNOWN_SERVICE');
  assert.equal(svc.engine.calls.length, 1);
});

test('GET /api/anomaly/model returns the engine metadata in camelCase', async (t) => {
  const svc = await startBackend(t);
  const body = await (await fetch(`${svc.url}/api/anomaly/model`)).json();
  assert.deepEqual(body.featureNames, ['request_rate']);
  assert.deepEqual(body.trainMedianRaw['payment-service'], [6]);
});

test('GET /api/anomaly/health reports both dependencies', async (t) => {
  const up = await startBackend(t);
  const ok = await fetch(`${up.url}/api/anomaly/health`);
  const okBody = await ok.json();
  assert.equal(ok.status, 200);
  assert.deepEqual(okBody.dependencies.map((d) => [d.service, d.status]), [['prometheus', 'up'], ['anomaly-engine', 'up']]);

  const noProm = await startBackend(t, { prometheusUrl: await closedUrl() });
  const degraded = await fetch(`${noProm.url}/api/anomaly/health`);
  assert.equal(degraded.status, 503);
  const down = (await degraded.json()).dependencies.find((d) => d.service === 'prometheus');
  assert.equal(down.status, 'down');

  const noEngine = await startBackend(t, { engineUrl: await closedUrl() });
  assert.equal((await fetch(`${noEngine.url}/api/anomaly/health`)).status, 503);
});

test('existing routes are unchanged: blast radius and /health/dependencies still work', async (t) => {
  const blast = (call, reply) => {
    if (call.path === '/health') return reply(200, { status: 'ok' });
    return reply(200, { failed_service: 'payment-service', direct_dependents: ['order-service'], impact: { raw_impact: 2.8 } });
  };
  const svc = await startBackend(t, { blast });
  assert.equal((await fetch(`${svc.url}/health`)).status, 200);
  const deps = await fetch(`${svc.url}/health/dependencies`);
  assert.equal(deps.status, 200);
  assert.equal((await deps.json()).dependencies[0].service, 'blast-radius-engine');
  const analysis = await (await svc.post('/api/blast-radius/analyze', { failedService: 'payment-service' })).json();
  assert.deepEqual(analysis.directDependents, ['order-service']);
  assert.equal(analysis.impact.rawImpact, 2.8);
  assert.equal((await svc.post('/api/blast-radius/analyze', {})).status, 400);
});
