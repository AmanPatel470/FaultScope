'use strict';

process.env.LOG_LEVEL = 'silent';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// Each test gets its own app instance (and therefore its own empty store).
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
  assert.equal(body.service, 'payment-service');
  assert.ok(res.headers.get('x-request-id'));
});

test('POST /payments approves a valid payment', async (t) => {
  const base = await setup(t);
  const r = await call(base, 'POST', '/payments', { orderId: 'ord-1', amountCents: 4999 });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'APPROVED');
  assert.equal(r.body.currency, 'USD');
  assert.match(r.body.paymentId, /^pay-/);
});

test('POST /payments is idempotent per orderId', async (t) => {
  const base = await setup(t);
  const first = await call(base, 'POST', '/payments', { orderId: 'ord-2', amountCents: 1000 });
  const second = await call(base, 'POST', '/payments', { orderId: 'ord-2', amountCents: 1000 });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.paymentId, first.body.paymentId);
  assert.equal(second.body.idempotentReplay, true);
});

test('POST /payments declines amounts above the limit with 402', async (t) => {
  const base = await setup(t);
  const r = await call(base, 'POST', '/payments', { orderId: 'ord-3', amountCents: 500001 });
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'PAYMENT_DECLINED');
});

test('POST /payments rejects invalid bodies with 400', async (t) => {
  const base = await setup(t);
  const badBodies = [
    {},
    { orderId: 'ord-4' },
    { orderId: 'ord-4', amountCents: -5 },
    { orderId: 'ord-4', amountCents: 10.5 },
    { orderId: 'ord-4', amountCents: '100' },
    { orderId: 'ord-4', amountCents: 100, currency: 'usd' },
  ];
  for (const body of badBodies) {
    const r = await call(base, 'POST', '/payments', body);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  }
});

test('GET /payments/:id returns a stored payment', async (t) => {
  const base = await setup(t);
  const created = await call(base, 'POST', '/payments', { orderId: 'ord-5', amountCents: 2500 });
  const fetched = await call(base, 'GET', `/payments/${created.body.paymentId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.orderId, 'ord-5');
  assert.equal(fetched.body.amountCents, 2500);
});

test('GET /payments/:id returns 404 for an unknown payment', async (t) => {
  const base = await setup(t);
  const r = await call(base, 'GET', '/payments/pay-missing');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'PAYMENT_NOT_FOUND');
});