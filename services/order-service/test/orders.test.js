'use strict';

process.env.LOG_LEVEL = 'silent';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { startStub, closedUrl, listen, sleep } = require('../testkit/stubServer');

const USER = { 'x-user-id': 'u-1001', 'x-user-name': 'alice' };

// Default fake dependencies: everything succeeds. Each test overrides what it wants to break.
const defaultInventory = (call, reply) => {
  if (call.path === '/inventory/reserve') {
    const items = call.body.items.map((i) => ({
      productId: i.productId,
      name: 'Item',
      quantity: i.quantity,
      unitPriceCents: 1000,
    }));
    const totalCents = items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0);
    return reply(201, { orderId: call.body.orderId, status: 'RESERVED', items, totalCents });
  }
  if (call.path === '/inventory/release') {
    return reply(200, { orderId: call.body.orderId, status: 'RELEASED' });
  }
  return reply(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
};
const defaultPayment = (call, reply) =>
  reply(201, { paymentId: 'pay-test', orderId: call.body.orderId, status: 'APPROVED' });
const defaultNotification = (call, reply) => reply(201, { notificationId: 'ntf-test', status: 'SENT' });

const releaseCalls = (stub) => stub.calls.filter((c) => c.path === '/inventory/release').length;

async function startOrderService(t, overrides = {}) {
  const inventory = await startStub(overrides.inventory || defaultInventory);
  const payment = await startStub(overrides.payment || defaultPayment);
  const notification = await startStub(overrides.notification || defaultNotification);

  const config = {
    inventoryUrl: overrides.inventoryUrl || inventory.url,
    paymentUrl: payment.url,
    notificationUrl: notification.url,
    requestTimeoutMs: 300,
    notificationTimeoutMs: 300,
    maxRetries: 2,
    retryBaseDelayMs: 5,
    ...(overrides.config || {}),
  };

  const app = await listen(createApp({ config }));
  t.after(async () => {
    await app.close();
    await Promise.all([inventory.close(), payment.close(), notification.close()]);
  });

  const post = (body, headers = USER) =>
    fetch(`${app.url}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  return { url: app.url, inventory, payment, notification, post };
}

const ONE_ITEM = { items: [{ productId: 'p-100', quantity: 2 }] };

test('GET /health returns ok', async (t) => {
  const svc = await startOrderService(t);
  const res = await fetch(`${svc.url}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.service, 'order-service');
});

test('happy path: reserves, charges, notifies and propagates the request id', async (t) => {
  const svc = await startOrderService(t);
  const res = await svc.post(ONE_ITEM);
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.status, 'CONFIRMED');
  assert.equal(body.totalCents, 2000);
  assert.equal(body.paymentId, 'pay-test');
  assert.equal(body.notification, 'sent');
  assert.equal(body.userId, 'u-1001');

  // The same orderId is used on every hop, and the payment amount comes from inventory pricing.
  assert.equal(svc.inventory.calls[0].body.orderId, body.orderId);
  assert.equal(svc.payment.calls[0].body.orderId, body.orderId);
  assert.equal(svc.payment.calls[0].body.amountCents, 2000);
  assert.equal(svc.notification.calls[0].body.type, 'ORDER_CONFIRMED');

  // One request id travels through every service.
  assert.equal(svc.payment.calls[0].headers['x-request-id'], res.headers.get('x-request-id'));
});

test('stock rejection (409) becomes 422, is not retried, and never reaches payment', async (t) => {
  const svc = await startOrderService(t, {
    inventory: (call, reply) =>
      reply(409, { error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough stock' } }),
  });
  const res = await svc.post(ONE_ITEM);
  const body = await res.json();

  assert.equal(res.status, 422);
  assert.equal(body.error.code, 'ORDER_REJECTED');
  assert.equal(body.error.service, 'inventory-service');
  assert.equal(body.error.reason.code, 'INSUFFICIENT_STOCK');
  assert.equal(svc.inventory.calls.length, 1, '4xx must not be retried');
  assert.equal(svc.payment.calls.length, 0);
});

test('persistent payment 500s are retried, then fail with 502 and release the stock', async (t) => {
  const svc = await startOrderService(t, {
    payment: (call, reply) => reply(500, { error: { code: 'BOOM', message: 'payment exploded' } }),
  });
  const res = await svc.post(ONE_ITEM);
  const body = await res.json();

  assert.equal(res.status, 502);
  assert.equal(body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(body.error.service, 'payment-service');
  assert.equal(svc.payment.calls.length, 3, '1 attempt + 2 retries');
  assert.equal(releaseCalls(svc.inventory), 1, 'reserved stock must be released');
  assert.equal(svc.notification.calls.length, 0);
});

test('a transient payment failure is recovered by a retry', async (t) => {
  const svc = await startOrderService(t, {
    payment: (call, reply, n) =>
      n === 1
        ? reply(500, { error: { code: 'BLIP', message: 'transient' } })
        : reply(201, { paymentId: 'pay-retry', orderId: call.body.orderId, status: 'APPROVED' }),
  });
  const res = await svc.post(ONE_ITEM);
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.paymentId, 'pay-retry');
  assert.equal(svc.payment.calls.length, 2);
  assert.equal(releaseCalls(svc.inventory), 0);
});

test('a declined card (402) is not retried and releases the stock', async (t) => {
  const svc = await startOrderService(t, {
    payment: (call, reply) => reply(402, { error: { code: 'PAYMENT_DECLINED', message: 'declined' } }),
  });
  const res = await svc.post(ONE_ITEM);
  const body = await res.json();

  assert.equal(res.status, 422);
  assert.equal(body.error.service, 'payment-service');
  assert.equal(body.error.reason.code, 'PAYMENT_DECLINED');
  assert.equal(svc.payment.calls.length, 1, '4xx must not be retried');
  assert.equal(releaseCalls(svc.inventory), 1);
});

test('a hung payment service causes 504 after the configured retries', async (t) => {
  const svc = await startOrderService(t, {
    config: { requestTimeoutMs: 100, maxRetries: 1 },
    payment: async (call, reply) => {
      await sleep(400);
      reply(201, { paymentId: 'too-late' });
    },
  });
  const res = await svc.post(ONE_ITEM);
  const body = await res.json();

  assert.equal(res.status, 504);
  assert.equal(body.error.code, 'DEPENDENCY_TIMEOUT');
  assert.equal(body.error.service, 'payment-service');
  assert.equal(svc.payment.calls.length, 2, '1 attempt + 1 retry');
  assert.equal(releaseCalls(svc.inventory), 1);
});

test('notification failure degrades gracefully: the order still succeeds', async (t) => {
  const svc = await startOrderService(t, {
    notification: (call, reply) => reply(500, { error: { code: 'DOWN', message: 'smtp down' } }),
  });
  const res = await svc.post(ONE_ITEM);
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.status, 'CONFIRMED');
  assert.equal(body.notification, 'degraded');
  assert.equal(svc.notification.calls.length, 1, 'notifications are best-effort, no retries');
});

test('an unreachable inventory service returns 502 naming the service', async (t) => {
  const svc = await startOrderService(t, { inventoryUrl: await closedUrl() });
  const res = await svc.post(ONE_ITEM);
  const body = await res.json();

  assert.equal(res.status, 502);
  assert.equal(body.error.code, 'DEPENDENCY_FAILURE');
  assert.equal(body.error.service, 'inventory-service');
  assert.equal(svc.payment.calls.length, 0);
});

test('requests without user context are rejected with 401', async (t) => {
  const svc = await startOrderService(t);
  const res = await svc.post(ONE_ITEM, {});
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'MISSING_USER_CONTEXT');
});

test('invalid order bodies are rejected with 400', async (t) => {
  const svc = await startOrderService(t);
  const badBodies = [
    {},
    { items: [] },
    { items: [{ productId: 'p-100', quantity: 0 }] },
    { items: [{ productId: 'p-100', quantity: 'two' }] },
    { items: 'p-100' },
  ];
  for (const body of badBodies) {
    const res = await svc.post(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(svc.inventory.calls.length, 0);
});

test('GET /orders/:id returns own orders only', async (t) => {
  const svc = await startOrderService(t);
  const created = await (await svc.post(ONE_ITEM)).json();

  const own = await fetch(`${svc.url}/orders/${created.orderId}`, { headers: USER });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).status, 'CONFIRMED');

  const other = await fetch(`${svc.url}/orders/${created.orderId}`, { headers: { 'x-user-id': 'u-9999' } });
  assert.equal(other.status, 404);

  const unknown = await fetch(`${svc.url}/orders/ord-missing`, { headers: USER });
  assert.equal(unknown.status, 404);
});