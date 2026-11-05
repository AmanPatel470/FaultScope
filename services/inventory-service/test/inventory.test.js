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
  assert.equal(body.service, 'inventory-service');
});

test('GET /inventory lists the seeded catalogue', async (t) => {
  const base = await setup(t);
  const r = await call(base, 'GET', '/inventory');
  assert.equal(r.status, 200);
  assert.equal(r.body.products.length, 3);
});

test('reserve deducts stock and prices the order from the catalogue', async (t) => {
  const base = await setup(t);
  const r = await call(base, 'POST', '/inventory/reserve', {
    orderId: 'o-1',
    items: [{ productId: 'p-100', quantity: 2 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'RESERVED');
  assert.equal(r.body.totalCents, 9998);
  const stock = await call(base, 'GET', '/inventory/p-100');
  assert.equal(stock.body.stock, 48);
});

test('reserving the same orderId twice is idempotent', async (t) => {
  const base = await setup(t);
  const body = { orderId: 'o-2', items: [{ productId: 'p-100', quantity: 2 }] };
  const first = await call(base, 'POST', '/inventory/reserve', body);
  const second = await call(base, 'POST', '/inventory/reserve', body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.idempotentReplay, true);
  const stock = await call(base, 'GET', '/inventory/p-100');
  assert.equal(stock.body.stock, 48, 'stock must be deducted only once');
});

test('insufficient stock returns 409 and reserves nothing (atomic)', async (t) => {
  const base = await setup(t);
  const r = await call(base, 'POST', '/inventory/reserve', {
    orderId: 'o-3',
    items: [
      { productId: 'p-100', quantity: 1 },
      { productId: 'p-300', quantity: 6 },
    ],
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(r.body.error.details.available, 5);
  const keyboard = await call(base, 'GET', '/inventory/p-100');
  assert.equal(keyboard.body.stock, 50, 'the valid line must not have been deducted');
});

test('unknown product returns 404', async (t) => {
  const base = await setup(t);
  const r = await call(base, 'POST', '/inventory/reserve', {
    orderId: 'o-4',
    items: [{ productId: 'p-999', quantity: 1 }],
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'UNKNOWN_PRODUCT');
});

test('release restores stock and is idempotent', async (t) => {
  const base = await setup(t);
  await call(base, 'POST', '/inventory/reserve', {
    orderId: 'o-5',
    items: [{ productId: 'p-100', quantity: 3 }],
  });
  assert.equal((await call(base, 'GET', '/inventory/p-100')).body.stock, 47);

  const released = await call(base, 'POST', '/inventory/release', { orderId: 'o-5' });
  assert.equal(released.status, 200);
  assert.equal(released.body.status, 'RELEASED');
  assert.equal((await call(base, 'GET', '/inventory/p-100')).body.stock, 50);

  const again = await call(base, 'POST', '/inventory/release', { orderId: 'o-5' });
  assert.equal(again.status, 200);
  assert.equal((await call(base, 'GET', '/inventory/p-100')).body.stock, 50, 'no double restore');

  const missing = await call(base, 'POST', '/inventory/release', { orderId: 'o-none' });
  assert.equal(missing.status, 404);

  const reuse = await call(base, 'POST', '/inventory/reserve', {
    orderId: 'o-5',
    items: [{ productId: 'p-100', quantity: 1 }],
  });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.code, 'RESERVATION_RELEASED');
});

test('validation rejects malformed reserve bodies', async (t) => {
  const base = await setup(t);
  const badBodies = [
    {},
    { orderId: 'o-6', items: [] },
    { orderId: 'o-6', items: [{ productId: 'p-100', quantity: 0 }] },
    { orderId: 'o-6', items: [{ productId: 'p-100', quantity: 1.5 }] },
    { items: [{ productId: 'p-100', quantity: 1 }] },
  ];
  for (const body of badBodies) {
    const r = await call(base, 'POST', '/inventory/reserve', body);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});