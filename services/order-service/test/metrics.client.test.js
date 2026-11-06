'use strict';

process.env.LOG_LEVEL = 'silent';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { metrics } = require('@opentelemetry/api');
const { MeterProvider } = require('@opentelemetry/sdk-metrics');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');

const exporter = new PrometheusExporter({
  preventServerStart: true,
});

const provider = new MeterProvider({
  readers: [exporter],
});

metrics.setGlobalMeterProvider(provider);

const { createHttpClient } = require('../src/httpClient');
const { startStub, closedUrl, sleep } = require('../testkit/stubServer');

const CLIENT_COUNT = 'http_client_request_duration_seconds_count';
const RETRIES = 'faultscope_client_retries_total';

const client = createHttpClient({
  timeoutMs: 200,
  maxRetries: 1,
  retryBaseDelayMs: 1,
  sleep: async () => {},
});

let scrapeServer;
let scrapeUrl;

before(async () => {
  scrapeServer = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404);
      res.end();
      return;
    }

    exporter.getMetricsRequestHandler(req, res);
  });

  await new Promise((resolve, reject) => {
    scrapeServer.once('error', reject);
    scrapeServer.listen(0, '127.0.0.1', resolve);
  });

  scrapeUrl = `http://127.0.0.1:${scrapeServer.address().port}`;
});

after(async () => {
  scrapeServer.closeAllConnections();

  await new Promise((resolve) => {
    scrapeServer.close(resolve);
  });

  await provider.shutdown();
});

async function scrape() {
  const response = await fetch(`${scrapeUrl}/metrics`);

  assert.equal(response.status, 200);

  return response.text();
}

function metricValue(text, name, labels = {}) {
  let total = 0;

  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`)) {
      continue;
    }

    const matches = Object.entries(labels).every(
      ([key, value]) => line.includes(`${key}="${value}"`)
    );

    if (!matches) {
      continue;
    }

    const match = line.match(/\}\s+(\S+)/);

    if (match) {
      total += Number(match[1]);
    }
  }

  return total;
}

test('a successful call is recorded with outcome=success and no retries', async (t) => {
  const stub = await startStub((call, reply) => {
    reply(200, { ok: true });
  });

  t.after(() => stub.close());

  await client.request('stub-ok', `${stub.url}/x`);

  const text = await scrape();

  assert.equal(
    metricValue(text, CLIENT_COUNT, {
      peer_service: 'stub-ok',
      outcome: 'success',
    }),
    1
  );

  assert.equal(
    metricValue(text, RETRIES, {
      peer_service: 'stub-ok',
    }),
    0
  );
});

test('persistent 5xx records every attempt and counts the retry', async (t) => {
  const stub = await startStub((call, reply) => {
    reply(500, { error: { code: 'BOOM' } });
  });

  t.after(() => stub.close());

  await assert.rejects(
    client.request('stub-5xx', `${stub.url}/x`),
    {
      kind: 'http',
      status: 500,
    }
  );

  const text = await scrape();

  assert.equal(
    metricValue(text, CLIENT_COUNT, {
      peer_service: 'stub-5xx',
      outcome: 'http_5xx',
    }),
    2
  );

  assert.equal(
    metricValue(text, RETRIES, {
      peer_service: 'stub-5xx',
      reason: 'http_5xx',
    }),
    1
  );
});

test('4xx is recorded and is never retried', async (t) => {
  const stub = await startStub((call, reply) => {
    reply(404, { error: { code: 'NOPE' } });
  });

  t.after(() => stub.close());

  await assert.rejects(
    client.request('stub-4xx', `${stub.url}/x`),
    {
      kind: 'http',
      status: 404,
    }
  );

  const text = await scrape();

  assert.equal(
    metricValue(text, CLIENT_COUNT, {
      peer_service: 'stub-4xx',
      outcome: 'http_4xx',
    }),
    1
  );

  assert.equal(
    metricValue(text, RETRIES, {
      peer_service: 'stub-4xx',
    }),
    0
  );
});

test('timeouts are recorded per attempt with outcome=timeout', async (t) => {
  const stub = await startStub(async (call, reply) => {
    await sleep(400);
    reply(200, {});
  });

  t.after(() => stub.close());

  await assert.rejects(
    client.request('stub-timeout', `${stub.url}/x`, {
      timeoutMs: 50,
    }),
    {
      kind: 'timeout',
    }
  );

  const text = await scrape();

  assert.equal(
    metricValue(text, CLIENT_COUNT, {
      peer_service: 'stub-timeout',
      outcome: 'timeout',
    }),
    2
  );

  assert.equal(
    metricValue(text, RETRIES, {
      peer_service: 'stub-timeout',
      reason: 'timeout',
    }),
    1
  );
});

test('connection failures are recorded with outcome=network', async () => {
  const url = await closedUrl();

  await assert.rejects(
    client.request('stub-down', `${url}/x`),
    {
      kind: 'network',
    }
  );

  const text = await scrape();

  assert.equal(
    metricValue(text, CLIENT_COUNT, {
      peer_service: 'stub-down',
      outcome: 'network',
    }),
    2
  );

  assert.equal(
    metricValue(text, RETRIES, {
      peer_service: 'stub-down',
      reason: 'network',
    }),
    1
  );
});