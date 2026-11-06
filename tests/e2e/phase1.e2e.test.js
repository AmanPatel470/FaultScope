
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const PORTS = {
  gateway: 5100,
  auth: 5101,
  order: 5102,
  payment: 5103,
  inventory: 5104,
  notification: 5105,
};

const METRICS_PORTS = {
  gateway: 5200,
  auth: 5201,
  order: 5202,
  payment: 5203,
  inventory: 5204,
  notification: 5205,
};

const base = (name) => `http://127.0.0.1:${PORTS[name]}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SERVICES = [
  { name: 'auth', dir: 'auth-service', env: {} },
  { name: 'payment', dir: 'payment-service', env: {} },
  { name: 'inventory', dir: 'inventory-service', env: {} },
  { name: 'notification', dir: 'notification-service', env: {} },
  {
    name: 'order',
    dir: 'order-service',
    env: {
      INVENTORY_URL: base('inventory'),
      PAYMENT_URL: base('payment'),
      NOTIFICATION_URL: base('notification'),
      REQUEST_TIMEOUT_MS: '1000',
      MAX_RETRIES: '1',
      RETRY_BASE_DELAY_MS: '20',
    },
  },
  {
    name: 'gateway',
    dir: 'api-gateway',
    env: {
      AUTH_URL: base('auth'),
      ORDER_URL: base('order'),
      PAYMENT_URL: base('payment'),
      INVENTORY_URL: base('inventory'),
      NOTIFICATION_URL: base('notification'),
    },
  },
];

const running = new Map();

function start(service) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(ROOT, 'services', service.dir),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'error',
      PORT: String(PORTS[service.name]),
      METRICS_HOST: '127.0.0.1',
      METRICS_PORT: String(METRICS_PORTS[service.name]),
      ...service.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];

  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  const exited = new Promise((resolve) => child.once('exit', resolve));

  running.set(service.name, { child, logs, exited });
}

async function stop(name) {
  const entry = running.get(name);

  if (!entry) return;

  running.delete(name);
  entry.child.kill();

  await entry.exited;
}

async function waitUntilHealthy(name, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base(name)}/health`);

      if (res.ok) return;
    } catch {
      // Service is not listening yet.
    }

    await sleep(200);
  }

  const logs = running.get(name)
    ? running.get(name).logs.join('')
    : '';

  throw new Error(
    `${name} did not become healthy within ${timeoutMs}ms. Output:\n${logs}`
  );
}

async function get(service, pathname) {
  const res = await fetch(`${base(service)}${pathname}`);

  return {
    status: res.status,
    body: await res.json(),
  };
}

async function gateway(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};

  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';

  const res = await fetch(`${base('gateway')}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => null);

  return {
    status: res.status,
    body: json,
    headers: res.headers,
  };
}

const stockOf = async (productId) =>
  (await get('inventory', `/inventory/${productId}`)).body.stock;

let token;

before(
  async () => {
    try {
      SERVICES.forEach(start);

      await Promise.all(
        SERVICES.map((service) => waitUntilHealthy(service.name))
      );
    } catch (err) {
      await Promise.all([...running.keys()].map(stop));
      throw err;
    }
  },
  { timeout: 60000 }
);

after(async () => {
  await Promise.all([...running.keys()].map(stop));
});

test('all five backend services are reported healthy by the gateway', async () => {
  const r = await gateway('/health/services');

  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.services.length, 5);
  assert.ok(r.body.services.every((s) => s.status === 'up'));
});

test('login through the gateway returns a JWT', async () => {
  const r = await gateway('/api/auth/login', {
    method: 'POST',
    body: {
      username: 'alice',
      password: 'alice-pass',
    },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.tokenType, 'Bearer');

  token = r.body.token;

  assert.ok(token);

  const bad = await gateway('/api/auth/login', {
    method: 'POST',
    body: {
      username: 'alice',
      password: 'wrong',
    },
  });

  assert.equal(bad.status, 401);
});

test('protected routes reject missing and invalid tokens', async () => {
  const body = {
    items: [{ productId: 'p-100', quantity: 1 }],
  };

  const missing = await gateway('/api/orders', {
    method: 'POST',
    body,
  });

  assert.equal(missing.status, 401);

  const invalid = await gateway('/api/orders', {
    method: 'POST',
    body,
    token: 'garbage',
  });

  assert.equal(invalid.status, 401);
  assert.equal(await stockOf('p-100'), 50);
});

test('a successful order flows through every service and leaves the right side effects', async () => {
  const r = await gateway('/api/orders', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: 'p-100', quantity: 2 }],
    },
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'CONFIRMED');
  assert.equal(r.body.totalCents, 9998);
  assert.equal(r.body.notification, 'sent');
  assert.ok(r.body.paymentId);
  assert.ok(r.headers.get('x-request-id'));

  assert.equal(await stockOf('p-100'), 48);

  const payment = await get(
    'payment',
    `/payments/${r.body.paymentId}`
  );

  assert.equal(payment.body.status, 'APPROVED');
  assert.equal(payment.body.amountCents, 9998);
  assert.equal(payment.body.orderId, r.body.orderId);

  const notifications = await get(
    'notification',
    `/notifications?orderId=${r.body.orderId}`
  );

  assert.equal(notifications.body.notifications.length, 1);

  const fetched = await gateway(
    `/api/orders/${r.body.orderId}`,
    { token }
  );

  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.status, 'CONFIRMED');
});

test('insufficient stock is rejected with 422 and stock is unchanged', async () => {
  const r = await gateway('/api/orders', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: 'p-300', quantity: 6 }],
    },
  });

  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'ORDER_REJECTED');
  assert.equal(r.body.error.service, 'inventory-service');
  assert.equal(r.body.error.reason.code, 'INSUFFICIENT_STOCK');
  assert.equal(await stockOf('p-300'), 5);
});

test('a declined payment rolls the reserved stock back', async () => {
  const r = await gateway('/api/orders', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: 'p-300', quantity: 5 }],
    },
  });

  assert.equal(r.status, 422);
  assert.equal(r.body.error.service, 'payment-service');
  assert.equal(r.body.error.reason.code, 'PAYMENT_DECLINED');
  assert.equal(await stockOf('p-300'), 5);
});

test('a Notification outage degrades gracefully: the order still succeeds', async () => {
  await stop('notification');

  const r = await gateway('/api/orders', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: 'p-200', quantity: 1 }],
    },
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'CONFIRMED');
  assert.equal(r.body.notification, 'degraded');
});

test('a Payment outage fails the order with 502 and rolls back stock', async () => {
  await stop('payment');

  const stockBefore = await stockOf('p-200');

  const r = await gateway('/api/orders', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: 'p-200', quantity: 1 }],
    },
  });

  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(r.body.error.service, 'payment-service');

  assert.equal(
    await stockOf('p-200'),
    stockBefore,
    'reservation must have been released'
  );

  const failed = await gateway(
    `/api/orders/${r.body.orderId}`,
    { token }
  );

  assert.equal(failed.body.status, 'FAILED');
  assert.equal(failed.body.failure.service, 'payment-service');
});

test('the gateway health view reflects the outages', async () => {
  const r = await gateway('/health/services');

  assert.equal(r.status, 503);
  assert.equal(r.body.status, 'degraded');

  const byName = Object.fromEntries(
    r.body.services.map((s) => [s.service, s.status])
  );

  assert.equal(byName['payment-service'], 'down');
  assert.equal(byName['notification-service'], 'down');
  assert.equal(byName['auth-service'], 'up');
  assert.equal(byName['order-service'], 'up');
  assert.equal(byName['inventory-service'], 'up');
});

// ---------------------------------------------------------------------------
// Phase 2: telemetry
// ---------------------------------------------------------------------------

async function scrape(name) {
  const res = await fetch(
    `http://127.0.0.1:${METRICS_PORTS[name]}/metrics`
  );

  assert.equal(res.status, 200);

  return res.text();
}

function metricValue(text, metric, labels = {}) {
  let total = 0;

  for (const line of text.split('\n')) {
    if (!line.startsWith(`${metric}{`)) continue;

    if (
      !Object.entries(labels).every(
        ([key, value]) => line.includes(`${key}="${value}"`)
      )
    ) {
      continue;
    }

    const match = line.match(/\}\s+(\S+)/);

    if (match) {
      total += Number(match[1]);
    }
  }

  return total;
}

const SERVER_COUNT =
  'http_server_request_duration_seconds_count';

const CLIENT_COUNT =
  'http_client_request_duration_seconds_count';

test('running services expose HTTP, process and runtime metrics', async () => {
  const required = [
    SERVER_COUNT,
    'process_uptime_seconds',
    'process_cpu_time_seconds_total',
    'process_memory_usage_bytes',
    'nodejs_eventloop_delay_p99_seconds',
  ];

  for (const name of ['gateway', 'auth', 'order', 'inventory']) {
    const text = await scrape(name);

    for (const metric of required) {
      assert.match(
        text,
        new RegExp(`^${metric}\\{`, 'm'),
        `${name} is missing ${metric}`
      );
    }
  }
});

test('order-service metrics reflect the outcomes of this run', async () => {
  const text = await scrape('order');

  const orders = (code) =>
    metricValue(text, SERVER_COUNT, {
      http_request_method: 'POST',
      http_route: '/orders',
      http_response_status_code: code,
    });

  assert.equal(
    orders('201'),
    2,
    'confirmed orders (including the degraded-notification one)'
  );

  assert.equal(
    orders('422'),
    2,
    'insufficient stock + declined card'
  );

  assert.equal(
    orders('502'),
    1,
    'payment outage'
  );

  const calls = (peer, outcome) =>
    metricValue(text, CLIENT_COUNT, {
      peer_service: peer,
      outcome,
    });

  assert.equal(
    calls('inventory-service', 'http_4xx'),
    1
  );

  assert.equal(
    calls('payment-service', 'http_4xx'),
    1
  );

  assert.equal(
    calls('payment-service', 'network') +
      calls('payment-service', 'timeout'),
    2,
    'one attempt plus one retry while payment was down'
  );

  assert.equal(
    metricValue(text, 'faultscope_client_retries_total', {
      peer_service: 'payment-service',
    }),
    1
  );

  assert.equal(
    metricValue(text, 'faultscope_client_retries_total', {
      peer_service: 'inventory-service',
    }),
    0
  );
});

test('gateway metrics show edge traffic, auth failures and passed-through errors', async () => {
  const text = await scrape('gateway');

  const at = (method, route, code) =>
    metricValue(text, SERVER_COUNT, {
      http_request_method: method,
      http_route: route,
      http_response_status_code: code,
    });

  assert.equal(at('POST', '/api/orders', '201'), 2);
  assert.equal(at('POST', '/api/orders', '422'), 2);
  assert.equal(at('POST', '/api/orders', '502'), 1);

  assert.equal(
    at('POST', '/api/orders', '401'),
    2,
    'missing token + invalid token'
  );

  assert.equal(at('POST', '/api/auth/login', '200'), 1);
  assert.equal(at('POST', '/api/auth/login', '401'), 1);

  assert.ok(
    !text.includes('ord-'),
    'order IDs must never appear in metric labels'
  );
});
