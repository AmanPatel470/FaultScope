'use strict';

process.env.LOG_LEVEL = 'silent';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const { createApp } = require('../src/app');
const { startStub, closedUrl, listen, sleep } = require('../testkit/stubServer');

const healthy = (call, reply) => reply(200, { status: 'ok' });

const defaultAuth = (call, reply) => {
  if (call.path === '/health') return reply(200, { status: 'ok' });
  if (call.path === '/auth/login') {
    return call.body && call.body.password === 'good'
      ? reply(200, { token: 'good-token', tokenType: 'Bearer', expiresInSeconds: 3600 })
      : reply(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });
  }
  if (call.path === '/auth/verify') {
    return call.headers.authorization === 'Bearer good-token'
      ? reply(200, { valid: true, user: { id: 'u-1001', username: 'alice', role: 'customer' } })
      : reply(401, { error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired' } });
  }
  return reply(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
};

const defaultOrder = (call, reply) => {
  if (call.path === '/health') return reply(200, { status: 'ok' });
  if (call.method === 'POST' && call.path === '/orders') {
    return reply(201, { orderId: 'ord-1', status: 'CONFIRMED' });
  }
  if (call.method === 'GET' && call.path === '/orders/ord-1') {
    return reply(200, { orderId: 'ord-1', status: 'CONFIRMED' });
  }
  return reply(404, { error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
};

async function startGateway(t, overrides = {}) {
  const auth = await startStub(overrides.auth || defaultAuth);
  const order = await startStub(overrides.order || defaultOrder);
  const payment = await startStub(healthy);
  const inventory = await startStub(healthy);
  const notification = await startStub(healthy);

  const config = {
    ...baseConfig,
    authUrl: overrides.authUrl || auth.url,
    orderUrl: order.url,
    paymentUrl: overrides.paymentUrl || payment.url,
    inventoryUrl: inventory.url,
    notificationUrl: notification.url,
    requestTimeoutMs: 300,
    orderTimeoutMs: 300,
    healthTimeoutMs: 300,
    ...(overrides.config || {}),
  };

  const app = await listen(createApp({ config }));
  t.after(async () => {
    await app.close();
    await Promise.all([auth.close(), order.close(), payment.close(), inventory.close(), notification.close()]);
  });

  return { url: app.url, auth, order };
}

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const GOOD = { authorization: 'Bearer good-token' };

test('GET /health returns ok', async (t) => {
  const gw = await startGateway(t);
  const res = await fetch(`${gw.url}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.service, 'api-gateway');
});

test('GET /health/services reports every service up', async (t) => {
  const gw = await startGateway(t);
  const res = await fetch(`${gw.url}/health/services`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.services.length, 5);
  assert.ok(body.services.every((s) => s.status === 'up'));
});

test('GET /health/services returns 503 and names the down service', async (t) => {
  const gw = await startGateway(t, { paymentUrl: await closedUrl() });
  const res = await fetch(`${gw.url}/health/services`);
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.status, 'degraded');
  const byName = Object.fromEntries(body.services.map((s) => [s.service, s]));
  assert.equal(byName['payment-service'].status, 'down');
  assert.equal(byName['auth-service'].status, 'up');
});

test('POST /api/auth/login proxies a successful login', async (t) => {
  const gw = await startGateway(t);
  const res = await postJson(`${gw.url}/api/auth/login`, { username: 'alice', password: 'good' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.token, 'good-token');
});

test('POST /api/auth/login passes a 401 through unchanged', async (t) => {
  const gw = await startGateway(t);
  const res = await postJson(`${gw.url}/api/auth/login`, { username: 'alice', password: 'bad' });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'INVALID_CREDENTIALS');
});

test('POST /api/orders without a token is rejected and never reaches Order', async (t) => {
  const gw = await startGateway(t);
  const res = await postJson(`${gw.url}/api/orders`, { items: [] });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'MISSING_TOKEN');
  assert.equal(gw.order.calls.length, 0);
});

test('POST /api/orders with an invalid token returns 401 and never reaches Order', async (t) => {
  const gw = await startGateway(t);
  const res = await postJson(`${gw.url}/api/orders`, { items: [] }, { authorization: 'Bearer nope' });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'INVALID_TOKEN');
  assert.equal(gw.order.calls.length, 0);
});

test('a verified request forwards the VERIFIED identity, not a spoofed one', async (t) => {
  const gw = await startGateway(t);
  const payload = { items: [{ productId: 'p-100', quantity: 1 }] };
  const res = await postJson(`${gw.url}/api/orders`, payload, { ...GOOD, 'x-user-id': 'evil-admin' });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.orderId, 'ord-1');

  const forwarded = gw.order.calls.find((c) => c.method === 'POST' && c.path === '/orders');
  assert.equal(forwarded.headers['x-user-id'], 'u-1001');
  assert.equal(forwarded.headers['x-user-name'], 'alice');
  assert.equal(forwarded.headers.authorization, undefined, 'the raw token must not reach Order');
  assert.deepEqual(forwarded.body, payload);
  assert.equal(forwarded.headers['x-request-id'], res.headers.get('x-request-id'));
});

test('an unreachable Auth Service returns 502 naming auth-service', async (t) => {
  const gw = await startGateway(t, { authUrl: await closedUrl() });
  const res = await postJson(`${gw.url}/api/orders`, { items: [] }, GOOD);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(body.error.service, 'auth-service');
});

test('a hung Order Service returns 504', async (t) => {
  const gw = await startGateway(t, {
    config: { orderTimeoutMs: 100 },
    order: async (call, reply) => {
      await sleep(400);
      reply(201, {});
    },
  });
  const res = await postJson(`${gw.url}/api/orders`, { items: [] }, GOOD);
  const body = await res.json();
  assert.equal(res.status, 504);
  assert.equal(body.error.code, 'DEPENDENCY_TIMEOUT');
  assert.equal(body.error.service, 'order-service');
});

test('errors from the Order Service pass through with their status and body', async (t) => {
  const gw = await startGateway(t, {
    order: (call, reply) =>
      reply(422, {
        error: { code: 'ORDER_REJECTED', message: 'Order rejected by payment-service', service: 'payment-service' },
        orderId: 'ord-9',
      }),
  });
  const res = await postJson(`${gw.url}/api/orders`, { items: [] }, GOOD);
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.error.code, 'ORDER_REJECTED');
  assert.equal(body.error.service, 'payment-service');
  assert.equal(body.orderId, 'ord-9');
});

test('GET /api/orders/:id requires auth and forwards the verified identity', async (t) => {
  const gw = await startGateway(t);

  const anonymous = await fetch(`${gw.url}/api/orders/ord-1`);
  assert.equal(anonymous.status, 401);

  const res = await fetch(`${gw.url}/api/orders/ord-1`, { headers: GOOD });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'CONFIRMED');

  const forwarded = gw.order.calls.find((c) => c.method === 'GET' && c.path === '/orders/ord-1');
  assert.equal(forwarded.headers['x-user-id'], 'u-1001');
});