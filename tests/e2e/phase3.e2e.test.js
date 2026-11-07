'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const IS_WINDOWS = process.platform === 'win32';
const PORTS = {
  gateway: 5300,
  auth: 5301,
  order: 5302,
  payment: 5303,
  inventory: 5304,
  notification: 5305,
  engine: 5310,
  backend: 5311,
};
const base = (name) => `http://127.0.0.1:${PORTS[name]}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PYTHON = path.join(
  ROOT,
  'blast-radius-engine',
  '.venv',
  IS_WINDOWS ? 'Scripts' : 'bin',
  IS_WINDOWS ? 'python.exe' : 'python'
);

const nodeService = (name, dir, env = {}) => ({
  name,
  command: process.execPath,
  args: ['src/server.js'],
  cwd: path.join(ROOT, dir),
  env: { PORT: String(PORTS[name]), ...env },
});

const PROCESSES = [
  nodeService('auth', 'services/auth-service'),
  nodeService('payment', 'services/payment-service'),
  nodeService('inventory', 'services/inventory-service'),
  nodeService('notification', 'services/notification-service'),
  nodeService('order', 'services/order-service', {
    INVENTORY_URL: base('inventory'),
    PAYMENT_URL: base('payment'),
    NOTIFICATION_URL: base('notification'),
    REQUEST_TIMEOUT_MS: '1000',
    MAX_RETRIES: '1',
    RETRY_BASE_DELAY_MS: '20',
  }),
  nodeService('gateway', 'services/api-gateway', {
    AUTH_URL: base('auth'),
    ORDER_URL: base('order'),
    PAYMENT_URL: base('payment'),
    INVENTORY_URL: base('inventory'),
    NOTIFICATION_URL: base('notification'),
  }),
  {
    name: 'engine',
    command: PYTHON,
    args: ['-m', 'uvicorn', 'blast_radius.api:app', '--host', '127.0.0.1', '--port', String(PORTS.engine), '--no-access-log'],
    cwd: path.join(ROOT, 'blast-radius-engine'),
    env: {},
  },
  nodeService('backend', 'backend', {
    HOST: '127.0.0.1',
    BLAST_RADIUS_URL: base('engine'),
  }),
];

const running = new Map();

function start(spec) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, NODE_ENV: 'development', LOG_LEVEL: 'error', ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  running.set(spec.name, { child, logs, exited });
}

// A venv's python.exe on Windows is a launcher that spawns the real interpreter as a child,
// so kill the whole process tree or uvicorn would be orphaned and keep holding its port.
function killTree(child) {
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

async function stop(name) {
  const entry = running.get(name);
  if (!entry) return;
  running.delete(name);
  killTree(entry.child);
  await entry.exited;
}

async function waitUntilHealthy(name, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base(name)}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  const logs = running.get(name) ? running.get(name).logs.join('') : '';
  throw new Error(`${name} did not become healthy within ${timeoutMs}ms. Output:\n${logs}`);
}

async function call(service, pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${base(service)}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function predict(failedService) {
  const r = await call('backend', '/api/blast-radius/analyze', { method: 'POST', body: { failedService } });
  assert.equal(r.status, 200, `prediction for ${failedService} failed`);
  return r.body;
}

const login = async () =>
  (await call('gateway', '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice-pass' } }));

const placeOrder = (token) =>
  call('gateway', '/api/orders', {
    method: 'POST',
    token,
    body: { items: [{ productId: 'p-200', quantity: 1 }] },
  });

const exposures = (prediction) => prediction.affected.map((a) => [a.service, a.exposure]);

let token;

before(
  async () => {
    if (!fs.existsSync(PYTHON)) {
      throw new Error(`Python venv not found at ${PYTHON}. Complete Phase 3 Part 1, Step 2 first.`);
    }
    try {
      PROCESSES.forEach(start);
      await Promise.all(PROCESSES.map((spec) => waitUntilHealthy(spec.name)));
    } catch (err) {
      await Promise.all([...running.keys()].map(stop));
      throw err;
    }
  },
  { timeout: 90000 }
);

after(async () => {
  await Promise.all([...running.keys()].map(stop));
});

test('the control plane is connected to the engine', async () => {
  const r = await call('backend', '/health/dependencies');
  assert.equal(r.status, 200);
  assert.equal(r.body.dependencies[0].service, 'blast-radius-engine');
  assert.equal(r.body.dependencies[0].status, 'up');
});

test('the graph served through the control plane matches the real topology', async () => {
  const r = await call('backend', '/api/blast-radius/graph');
  assert.equal(r.status, 200);
  assert.equal(r.body.nodes.length, 6);
  assert.equal(r.body.edges.length, 5);
  const edge = r.body.edges.find((e) => e.service === 'order-service' && e.dependsOn === 'notification-service');
  assert.equal(edge.dependency, 'soft');
});

test('Gateway failure is predicted CRITICAL with every service behind it stranded', async () => {
  const p = await predict('api-gateway');
  assert.equal(p.impact.severity, 'CRITICAL');
  assert.deepEqual(p.affected, []);
  const stranded = p.impact.contributions.filter((c) => c.role === 'stranded').map((c) => c.service).sort();
  assert.deepEqual(stranded, [
    'auth-service',
    'inventory-service',
    'notification-service',
    'order-service',
    'payment-service',
  ]);
});

test('Notification outage: predicted soft/LOW matches observed degraded-but-successful orders', async () => {
  const p = await predict('notification-service');
  assert.equal(p.impact.severity, 'LOW');
  assert.deepEqual(exposures(p), [
    ['order-service', 'soft'],
    ['api-gateway', 'soft'],
  ]);

  const session = await login();
  assert.equal(session.status, 200);
  token = session.body.token;

  await stop('notification');
  const order = await placeOrder(token);
  assert.equal(order.status, 201, 'soft exposure means the order must still succeed');
  assert.equal(order.body.status, 'CONFIRMED');
  assert.equal(order.body.notification, 'degraded');
});

test('Payment outage: predicted hard/HIGH matches observed order failures, and unaffected services keep working', async () => {
  const p = await predict('payment-service');
  assert.equal(p.impact.severity, 'HIGH');
  assert.deepEqual(exposures(p), [
    ['order-service', 'hard'],
    ['api-gateway', 'hard'],
  ]);
  assert.ok(p.unaffected.includes('auth-service'));
  assert.ok(p.unaffected.includes('inventory-service'));

  await stop('payment');
  const order = await placeOrder(token);
  assert.equal(order.status, 502, 'hard exposure means the order must fail');
  assert.equal(order.body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(order.body.error.service, 'payment-service');

  // Predicted unaffected: they must still serve requests.
  assert.equal((await login()).status, 200, 'auth-service is predicted unaffected');
  assert.equal((await call('inventory', '/inventory/p-200')).status, 200, 'inventory-service is predicted unaffected');
});

test('Auth outage: predicted gateway-only hard exposure matches observed gateway failures', async () => {
  const p = await predict('auth-service');
  assert.deepEqual(exposures(p), [['api-gateway', 'hard']]);
  assert.equal(p.affected[0].relationship, 'direct');
  assert.ok(p.unaffected.includes('order-service'));

  await stop('auth');
  const protectedCall = await placeOrder(token);
  assert.equal(protectedCall.status, 502);
  assert.equal(protectedCall.body.error.service, 'auth-service');
  assert.equal((await login()).status, 502, 'login is proxied to Auth, so it fails too');

  assert.equal((await call('order', '/health')).status, 200, 'order-service itself is predicted unaffected');
});

test('if the engine itself is down, the control plane reports a clean 502', async () => {
  await stop('engine');

  const r = await call('backend', '/api/blast-radius/analyze', { method: 'POST', body: { failedService: 'payment-service' } });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(r.body.error.service, 'blast-radius-engine');

  const health = await call('backend', '/health/dependencies');
  assert.equal(health.status, 503);
});