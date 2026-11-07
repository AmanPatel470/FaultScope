'use strict';

process.env.LOG_LEVEL = 'silent';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const { createApp } = require('../src/app');
const { startStub, closedUrl, listen, sleep } = require('../testkit/stubServer');

const ENGINE_GRAPH = {
  semantics: 'An edge A -> B means A depends on B.',
  nodes: [{ name: 'order-service', criticality: 0.9, description: 'Orders' }],
  edges: [{ service: 'order-service', depends_on: 'payment-service', dependency: 'hard', strength: 1.0 }],
};

const ENGINE_ANALYSIS = {
  failed_service: 'payment-service',
  direct_dependents: ['order-service'],
  indirect_dependents: ['api-gateway'],
  affected: [
    {
      service: 'order-service',
      relationship: 'direct',
      distance: 1,
      exposure: 'hard',
      paths: [['order-service', 'payment-service']],
      paths_truncated: false,
    },
  ],
  unaffected: ['auth-service'],
  impact: {
    raw_impact: 2.8,
    max_raw_impact: 4.7,
    score: 59.6,
    severity: 'HIGH',
    contributions: [
      {
        service: 'payment-service',
        role: 'failed',
        criticality: 1.0,
        dependency_strength: 1.0,
        propagation_factor: 1.0,
        contribution: 1.0,
      },
    ],
    scoring_model: 'heuristic-v1',
    interpretation: 'Heuristic estimate.',
  },
};

const defaultEngine = (call, reply) => {
  if (call.path === '/health') return reply(200, { status: 'ok' });
  if (call.path === '/graph') return reply(200, ENGINE_GRAPH);
  if (call.path === '/analyze') {
    return call.body && call.body.failed_service === 'payment-service'
      ? reply(200, ENGINE_ANALYSIS)
      : reply(404, { error: { code: 'UNKNOWN_SERVICE', message: "Unknown service 'x'" } });
  }
  return reply(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
};

async function startBackend(t, overrides = {}) {
  const engine = await startStub(overrides.engine || defaultEngine);
  const config = {
    ...baseConfig,
    blastRadiusUrl: overrides.engineUrl || engine.url,
    requestTimeoutMs: 300,
    healthTimeoutMs: 300,
    maxRetries: 1,
    retryBaseDelayMs: 5,
    ...(overrides.config || {}),
  };
  const app = await listen(createApp({ config }));
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const analyze = (body) =>
    fetch(`${app.url}/api/blast-radius/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return { url: app.url, engine, analyze };
}

test('GET /health returns ok', async (t) => {
  const svc = await startBackend(t);
  const res = await fetch(`${svc.url}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.service, 'control-plane');
});

test('GET /api/blast-radius/graph returns camelCase and forwards the request id', async (t) => {
  const svc = await startBackend(t);
  const res = await fetch(`${svc.url}/api/blast-radius/graph`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.edges[0].dependsOn, 'payment-service');
  assert.equal('depends_on' in body.edges[0], false);
  assert.equal(svc.engine.calls[0].headers['x-request-id'], res.headers.get('x-request-id'));
});

test('analyze sends snake_case to the engine and returns camelCase', async (t) => {
  const svc = await startBackend(t);
  const res = await svc.analyze({ failedService: 'payment-service' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(svc.engine.calls[0].body, { failed_service: 'payment-service' });
  assert.equal(body.failedService, 'payment-service');
  assert.deepEqual(body.directDependents, ['order-service']);
  assert.equal(body.affected[0].pathsTruncated, false);
  assert.deepEqual(body.affected[0].paths, [['order-service', 'payment-service']]);
  assert.equal(body.impact.rawImpact, 2.8);
  assert.equal(body.impact.severity, 'HIGH');
  assert.equal(body.impact.scoringModel, 'heuristic-v1');
  assert.equal(body.impact.contributions[0].dependencyStrength, 1);
});

test('invalid bodies are rejected with 400 and never reach the engine', async (t) => {
  const svc = await startBackend(t);
  const badBodies = [
    {},
    [],
    { failedService: '' },
    { failedService: 42 },
    { failed_service: 'payment-service' }, // wrong key: the public API is camelCase
    { failedService: 'x'.repeat(65) },
  ];
  for (const body of badBodies) {
    const res = await svc.analyze(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  }
  assert.equal(svc.engine.calls.length, 0);
});

test('an engine 404 (unknown service) passes through unchanged', async (t) => {
  const svc = await startBackend(t);
  const res = await svc.analyze({ failedService: 'nope' });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'UNKNOWN_SERVICE');
  assert.equal(svc.engine.calls.length, 1, '4xx must not be retried');
});

test('persistent engine 500s are retried, then reported as 502 naming the engine', async (t) => {
  const svc = await startBackend(t, {
    engine: (call, reply) => reply(500, { error: { code: 'BOOM', message: 'engine exploded' } }),
  });
  const res = await svc.analyze({ failedService: 'payment-service' });
  const body = await res.json();
  assert.equal(res.status, 500, 'an engine error body is passed through with its own status');
  assert.equal(body.error.code, 'BOOM');
  assert.equal(svc.engine.calls.length, 2, '1 attempt + 1 retry');
});

test('an unreachable engine returns 502 DEPENDENCY_FAILURE', async (t) => {
  const svc = await startBackend(t, { engineUrl: await closedUrl() });
  const res = await svc.analyze({ failedService: 'payment-service' });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(body.error.service, 'blast-radius-engine');
});

test('a hung engine returns 504 DEPENDENCY_TIMEOUT', async (t) => {
  const svc = await startBackend(t, {
    config: { requestTimeoutMs: 100, maxRetries: 0 },
    engine: async (call, reply) => {
      await sleep(400);
      reply(200, ENGINE_ANALYSIS);
    },
  });
  const res = await svc.analyze({ failedService: 'payment-service' });
  const body = await res.json();
  assert.equal(res.status, 504);
  assert.equal(body.error.code, 'DEPENDENCY_TIMEOUT');
  assert.equal(body.error.service, 'blast-radius-engine');
});

test('GET /health/dependencies is 200 when the engine is up', async (t) => {
  const svc = await startBackend(t);
  const res = await fetch(`${svc.url}/health/dependencies`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.dependencies[0].status, 'up');
});

test('GET /health/dependencies is 503 when the engine is down', async (t) => {
  const svc = await startBackend(t, { engineUrl: await closedUrl() });
  const res = await fetch(`${svc.url}/health/dependencies`);
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.status, 'degraded');
  assert.equal(body.dependencies[0].status, 'down');
});

test('unknown routes return a JSON 404', async (t) => {
  const svc = await startBackend(t);
  const res = await fetch(`${svc.url}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});

test('malformed JSON bodies return 400 INVALID_JSON', async (t) => {
  const svc = await startBackend(t);
  const res = await fetch(`${svc.url}/api/blast-radius/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_JSON');
});