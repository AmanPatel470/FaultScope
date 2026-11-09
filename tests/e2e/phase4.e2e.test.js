'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const IS_WINDOWS = process.platform === 'win32';
const PORTS = { engine: 5410, backend: 5411, prometheus: 5412, blast: 5413, badEngine: 5414 };
const base = (name) => `http://127.0.0.1:${PORTS[name]}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const venvPython = (dir) => path.join(ROOT, dir, '.venv', IS_WINDOWS ? 'Scripts' : 'bin', IS_WINDOWS ? 'python.exe' : 'python');
const ANOMALY_PYTHON = venvPython('anomaly-engine');
const BLAST_PYTHON = venvPython('blast-radius-engine');
const ANOMALY_DIR = path.join(ROOT, 'anomaly-engine');
const MODEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'faultscope-model-'));

const SERVICES = ['api-gateway', 'auth-service', 'order-service', 'payment-service', 'inventory-service', 'notification-service'];
const FEATURES = ['requestRate', 'errorRate', 'avgLatency', 'p95Latency', 'timeoutCount'];

// ---------------------------------------------------------------- fake Prometheus
// Answers the five feature queries from `prom.byService`, or fails on demand.
const prom = { mode: 'normal', byService: {}, calls: 0 };

function valueFor(query) {
  const service = (query.match(/(?:job|peer_service)="([^"]+)"/) || [])[1];
  const values = prom.byService[service];
  if (!values) return null;
  if (query.includes('histogram_quantile')) return values.p95Latency;
  if (query.includes('increase(')) return values.timeoutCount;
  if (query.includes('_sum{')) return values.avgLatency;
  if (query.includes('5..')) return values.errorRate;
  return values.requestRate;
}

const promServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/-/healthy') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Prometheus Server is Healthy.\n');
  }
  prom.calls += 1;
  if (prom.mode === 'error') {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'error', error: 'boom' }));
  }
  if (prom.mode === 'hang') await sleep(3000);
  const value = valueFor(url.searchParams.get('query') || '');
  const result = prom.mode === 'empty' || value === null ? [] : [{ metric: {}, value: [1700000000, String(value)] }];
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }));
});

// ---------------------------------------------------------------- process management
const running = new Map();

function start(name, command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'development', LOG_LEVEL: 'error', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  running.set(name, { child, logs, exited });
}

// A venv's python.exe on Windows is a launcher that spawns the real interpreter, so kill the whole tree.
function killTree(child) {
  if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
}

async function stop(name) {
  const entry = running.get(name);
  if (!entry) return;
  running.delete(name);
  killTree(entry.child);
  await entry.exited;
}

async function waitUntilHealthy(name, port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  const logs = running.get(name) ? running.get(name).logs.join('') : '';
  throw new Error(`${name} did not become healthy within ${timeoutMs}ms. Output:\n${logs}`);
}

async function call(port, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const backend = (pathname, options) => call(PORTS.backend, pathname, options);

let medians; // training medians per service, raw units, in feature order (from the trained artifact)

const windowFromMedian = (service, overrides = {}) => ({
  ...Object.fromEntries(FEATURES.map((name, i) => [name, medians[service][i]])),
  ...overrides,
});

before(
  async () => {
    for (const python of [ANOMALY_PYTHON, BLAST_PYTHON]) {
      if (!fs.existsSync(python)) throw new Error(`Python venv not found at ${python}. Complete the Phase 3 / Phase 4 setup first.`);
    }
    // 1. Train a model artifact for this run (small configuration: this test checks plumbing, not quality).
    const trained = spawnSync(
      ANOMALY_PYTHON,
      ['-m', 'anomaly_engine.train', '--seed', '7', '--small', '--out', MODEL_DIR],
      { cwd: ANOMALY_DIR, encoding: 'utf8', timeout: 180000 }
    );
    if (trained.status !== 0) throw new Error(`training failed:\n${trained.stdout}\n${trained.stderr}`);

    await new Promise((resolve) => promServer.listen(PORTS.prometheus, '127.0.0.1', resolve));

    try {
      start('engine', ANOMALY_PYTHON,
        ['-m', 'uvicorn', 'anomaly_engine.api:create_app', '--factory', '--host', '127.0.0.1', '--port', String(PORTS.engine), '--no-access-log'],
        ANOMALY_DIR, { MODEL_DIR });
      start('blast', BLAST_PYTHON,
        ['-m', 'uvicorn', 'blast_radius.api:app', '--host', '127.0.0.1', '--port', String(PORTS.blast), '--no-access-log'],
        path.join(ROOT, 'blast-radius-engine'), {});
      start('backend', process.execPath, ['src/server.js'], path.join(ROOT, 'backend'), {
        PORT: String(PORTS.backend),
        HOST: '127.0.0.1',
        BLAST_RADIUS_URL: base('blast'),
        ANOMALY_ENGINE_URL: base('engine'),
        PROMETHEUS_URL: base('prometheus'),
        REQUEST_TIMEOUT_MS: '2000',
        PROMETHEUS_TIMEOUT_MS: '1000',
        MAX_RETRIES: '1',
        RETRY_BASE_DELAY_MS: '20',
      });
      await Promise.all([
        waitUntilHealthy('engine', PORTS.engine),
        waitUntilHealthy('blast', PORTS.blast),
        waitUntilHealthy('backend', PORTS.backend),
      ]);
    } catch (err) {
      await Promise.all([...running.keys()].map(stop));
      promServer.close();
      throw err;
    }

    const model = await call(PORTS.engine, '/model');
    medians = model.body.train_median_raw;
    for (const service of SERVICES) prom.byService[service] = windowFromMedian(service);
  },
  { timeout: 240000 }
);

after(async () => {
  await Promise.all([...running.keys()].map(stop));
  promServer.closeAllConnections();
  await new Promise((resolve) => promServer.close(resolve));
  fs.rmSync(MODEL_DIR, { recursive: true, force: true });
});

test('the model artifact trained for this run is loaded and exposed through the control plane', async () => {
  const health = await call(PORTS.engine, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.model_loaded, true);
  assert.deepEqual(health.body.services, SERVICES);

  const model = await backend('/api/anomaly/model');
  assert.equal(model.status, 200);
  assert.deepEqual(model.body.featureNames, ['request_rate', 'error_rate', 'avg_latency', 'p95_latency', 'timeout_count']);
  assert.deepEqual(Object.keys(model.body.thresholds).sort(), [...SERVICES].sort());
  assert.equal(model.body.targetFpr, 0.01);
  assert.ok(model.body.trainedWith.scikitLearn);
  assert.equal(model.body.training.dataSource, 'synthetic');
});

test('normal telemetry from Prometheus is scored normal for every service', async () => {
  for (const service of SERVICES) {
    const r = await backend(`/api/anomaly/services/${service}`);
    assert.equal(r.status, 200, service);
    assert.equal(r.body.status, 'normal', `${service}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.isAnomalous, false);
    assert.equal(r.body.source, 'prometheus');
    assert.ok(r.body.anomalyScore <= r.body.threshold);
    for (const name of FEATURES) assert.ok(Math.abs(r.body.window[name] - medians[service][FEATURES.indexOf(name)]) < 1e-9, `${service}.${name}`);
  }
});

test('an injected multi-feature anomaly is flagged and explained', async () => {
  prom.byService['payment-service'] = windowFromMedian('payment-service', {
    errorRate: 0.5, avgLatency: 1.5, p95Latency: 5, timeoutCount: 60,
    requestRate: medians['payment-service'][0] * 3,
  });
  const r = await backend('/api/anomaly/services/payment-service');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'anomalous');
  assert.equal(r.body.isAnomalous, true);
  assert.ok(r.body.margin > 0 && r.body.anomalyScore > r.body.threshold);
  assert.ok(r.body.topFeatures.length > 0 && r.body.topFeatures[0].contribution > 0);
  prom.byService['payment-service'] = windowFromMedian('payment-service');
});

test('a single changed feature raises the score and is named as the main contributor', async () => {
  // Whether one lone feature crosses the 1%-FPR threshold is a property of the model, measured by the
  // evaluation (recall by fault type), so this test asserts only what the system guarantees.
  const typical = await backend('/api/anomaly/services/payment-service');
  prom.byService['payment-service'] = windowFromMedian('payment-service', { errorRate: 0.6 });
  const changed = await backend('/api/anomaly/services/payment-service');
  prom.byService['payment-service'] = windowFromMedian('payment-service');

  assert.ok(changed.body.anomalyScore > typical.body.anomalyScore);
  assert.equal(changed.body.topFeatures[0].feature, 'error_rate');
  assert.equal(changed.body.topFeatures[0].direction, 'above');
});

test('scoring through the control plane equals scoring the engine directly', async () => {
  const window = windowFromMedian('order-service', { p95Latency: 4, timeoutCount: 25 });
  const viaBackend = await backend('/api/anomaly/score', { method: 'POST', body: { service: 'order-service', window } });
  const direct = await call(PORTS.engine, '/predict', {
    method: 'POST',
    body: {
      service: 'order-service',
      window: {
        request_rate: window.requestRate, error_rate: window.errorRate, avg_latency: window.avgLatency,
        p95_latency: window.p95Latency, timeout_count: window.timeoutCount,
      },
    },
  });
  assert.equal(viaBackend.status, 200);
  assert.equal(viaBackend.body.anomalyScore, direct.body.anomaly_score);
  assert.equal(viaBackend.body.threshold, direct.body.threshold);
  assert.equal(viaBackend.body.status, direct.body.status);
});

test('invalid input and unknown services get clear errors', async () => {
  const bad = await backend('/api/anomaly/score', {
    method: 'POST', body: { service: 'payment-service', window: { requestRate: 1 } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

  const unknown = await backend('/api/anomaly/score', {
    method: 'POST', body: { service: 'ghost-service', window: windowFromMedian('order-service') },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'UNKNOWN_SERVICE');

  assert.equal((await backend('/api/anomaly/services/Bad_Name')).status, 400);
});

test('a service with no Prometheus series is reported as no_data, not scored', async () => {
  prom.mode = 'empty';
  const r = await backend('/api/anomaly/services/payment-service');
  prom.mode = 'normal';
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'no_data');
  assert.equal(r.body.isAnomalous, null);
});

test('Prometheus failures become clean 502 and 504 responses naming prometheus', async () => {
  prom.mode = 'error';
  const failing = await backend('/api/anomaly/services/payment-service');
  assert.equal(failing.status, 502);
  assert.equal(failing.body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(failing.body.error.service, 'prometheus');

  prom.mode = 'hang';
  const hung = await backend('/api/anomaly/services/payment-service');
  assert.equal(hung.status, 504);
  assert.equal(hung.body.error.code, 'DEPENDENCY_TIMEOUT');
  prom.mode = 'normal';
});

test('the blast-radius functionality of the control plane is unchanged', async () => {
  const analysis = await backend('/api/blast-radius/analyze', { method: 'POST', body: { failedService: 'payment-service' } });
  assert.equal(analysis.status, 200);
  assert.deepEqual(analysis.body.directDependents, ['order-service']);
  assert.equal(analysis.body.impact.severity, 'HIGH');
  assert.equal((await backend('/api/blast-radius/graph')).status, 200);
  const deps = await backend('/health/dependencies');
  assert.equal(deps.status, 200);
  assert.equal(deps.body.dependencies[0].service, 'blast-radius-engine');
});

test('the anomaly health endpoint reports Prometheus and the engine as up', async () => {
  const r = await backend('/api/anomaly/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.dependencies.map((d) => [d.service, d.status]), [['prometheus', 'up'], ['anomaly-engine', 'up']]);
});

test('the engine refuses to start without a valid model artifact', () => {
  const result = spawnSync(
    ANOMALY_PYTHON,
    ['-m', 'uvicorn', 'anomaly_engine.api:create_app', '--factory', '--host', '127.0.0.1', '--port', String(PORTS.badEngine)],
    { cwd: ANOMALY_DIR, encoding: 'utf8', timeout: 60000, env: { ...process.env, MODEL_DIR: path.join(MODEL_DIR, 'does-not-exist'), LOG_LEVEL: 'info' } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /model_load_failed/);
});

test('if the anomaly engine goes down the control plane reports it cleanly and blast radius keeps working', async () => {
  await stop('engine');

  const scored = await backend('/api/anomaly/services/payment-service');
  assert.equal(scored.status, 502);
  assert.equal(scored.body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(scored.body.error.service, 'anomaly-engine');

  const health = await backend('/api/anomaly/health');
  assert.equal(health.status, 503);
  assert.equal(health.body.dependencies.find((d) => d.service === 'anomaly-engine').status, 'down');

  const blast = await backend('/api/blast-radius/analyze', { method: 'POST', body: { failedService: 'payment-service' } });
  assert.equal(blast.status, 200);
});
