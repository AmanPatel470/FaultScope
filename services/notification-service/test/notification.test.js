'use strict';

process.env.LOG_LEVEL = 'silent';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function setup(t) {
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /health returns ok', async (t) => {
  const base = await setup(t);
  const res = await fetch(`${base}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.service, 'notification-service');
});

test('POST /notifications sends and stores a notification', async (t) => {
  const base = await setup(t);
  const r = await call(base, 'POST', '/notifications', {
    orderId: 'ord-1',
    userId: 'u-1001',
    type: 'ORDER_CONFIRMED',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'SENT');
  assert.match(r.body.notificationId, /^ntf-/);
  assert.match(r.body.message, /ord-1/);
});

test('POST /notifications is idempotent per orderId and type', async (t) => {
  const base = await setup(t);
  const body = { orderId: 'ord-2', userId: 'u-1001', type: 'ORDER_CONFIRMED' };
  const first = await call(base, 'POST', '/notifications', body);
  const second = await call(base, 'POST', '/notifications', body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.notificationId, first.body.notificationId);
  assert.equal(second.body.idempotentReplay, true);
});

test('POST /notifications rejects invalid input with 400', async (t) => {
  const base = await setup(t);
  const badBodies = [
    {},
    { orderId: 'ord-3', userId: 'u-1' },
    { orderId: 'ord-3', userId: 'u-1', type: 'SPAM' },
    { orderId: 'ord-3', userId: 'u-1', type: 'toString' },
  ];
  for (const body of badBodies) {
    const r = await call(base, 'POST', '/notifications', body);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('GET /notifications filters by orderId', async (t) => {
  const base = await setup(t);
  await call(base, 'POST', '/notifications', { orderId: 'ord-a', userId: 'u-1', type: 'ORDER_CONFIRMED' });
  await call(base, 'POST', '/notifications', { orderId: 'ord-b', userId: 'u-1', type: 'ORDER_FAILED' });

  const filtered = await call(base, 'GET', '/notifications?orderId=ord-a');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.notifications.length, 1);
  assert.equal(filtered.body.notifications[0].orderId, 'ord-a');

  const all = await call(base, 'GET', '/notifications');
  assert.equal(all.body.notifications.length, 2);
});

test('GET /notifications/:id returns one notification or 404', async (t) => {
  const base = await setup(t);
  const created = await call(base, 'POST', '/notifications', {
    orderId: 'ord-4',
    userId: 'u-1',
    type: 'ORDER_FAILED',
  });
  const found = await call(base, 'GET', `/notifications/${created.body.notificationId}`);
  assert.equal(found.status, 200);
  assert.equal(found.body.type, 'ORDER_FAILED');

  const missing = await call(base, 'GET', '/notifications/ntf-missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOTIFICATION_NOT_FOUND');
});