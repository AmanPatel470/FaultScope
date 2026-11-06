'use strict';

process.env.LOG_LEVEL = 'silent';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { metrics } = require('@opentelemetry/api');
const { MeterProvider } = require('@opentelemetry/sdk-metrics');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');

// Register the provider before loading the middleware.
const exporter = new PrometheusExporter({
  preventServerStart: true,
});

const provider = new MeterProvider({
  readers: [exporter],
});

metrics.setGlobalMeterProvider(provider);

const metricsMiddleware = require('../src/middleware/metrics');

const COUNT = 'http_server_request_duration_seconds_count';

let scrapeServer;
let scrapeUrl;
let appServer;
let appUrl;

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

  const app = express();

  app.use(metricsMiddleware);

  app.get('/items/:id', (req, res) => {
    res.json({ id: req.params.id });
  });

  app.get('/boom', (req, res) => {
    res.status(500).json({ error: 'boom' });
  });

  const api = express.Router();

  api.get('/orders/:orderId', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', api);

  appServer = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve(server);
    });

    server.once('error', reject);
  });

  appUrl = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  appServer.closeAllConnections();
  scrapeServer.closeAllConnections();

  await Promise.all([
    new Promise((resolve) => appServer.close(resolve)),
    new Promise((resolve) => scrapeServer.close(resolve)),
  ]);

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

async function eventually(check, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function hit(path) {
  const response = await fetch(`${appUrl}${path}`);
  await response.text();

  return response.status;
}

test('records duration by method, route template and status code', async () => {
  const labels = {
    http_request_method: 'GET',
    http_route: '/items/:id',
    http_response_status_code: '200',
  };

  const baseline = metricValue(await scrape(), COUNT, labels);

  await hit('/items/1');
  await hit('/items/2');

  await eventually(async () => {
    const current = metricValue(await scrape(), COUNT, labels);

    assert.equal(current - baseline, 2);
  });
});

test('records 5xx responses under their own status code', async () => {
  const labels = {
    http_route: '/boom',
    http_response_status_code: '500',
  };

  const baseline = metricValue(await scrape(), COUNT, labels);

  await hit('/boom');

  await eventually(async () => {
    const current = metricValue(await scrape(), COUNT, labels);

    assert.equal(current - baseline, 1);
  });
});

test('mounted routers keep their prefix and never leak raw ids into labels', async () => {
  const labels = {
    http_route: '/api/orders/:orderId',
    http_response_status_code: '200',
  };

  const baseline = metricValue(await scrape(), COUNT, labels);

  await hit('/api/orders/abc-12345');

  await eventually(async () => {
    const text = await scrape();
    const current = metricValue(text, COUNT, labels);

    assert.equal(current - baseline, 1);
    assert.ok(!text.includes('abc-12345'), 'raw ID must not appear in metric labels');
  });
});

test('unmatched routes collapse into one UNMATCHED series', async () => {
  const labels = {
    http_route: 'UNMATCHED',
    http_response_status_code: '404',
  };

  const baseline = metricValue(await scrape(), COUNT, labels);

  await hit('/definitely/not/a/route-xyz');

  await eventually(async () => {
    const text = await scrape();
    const current = metricValue(text, COUNT, labels);

    assert.equal(current - baseline, 1);
    assert.ok(!text.includes('route-xyz'), 'unknown URLs must not become labels');
  });
});

test('latency histogram uses the custom second-based buckets', async () => {
  const text = await scrape();

  assert.match(
    text,
    /http_server_request_duration_seconds_bucket\{[^}]*le="0\.025"/
  );
});