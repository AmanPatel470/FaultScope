'use strict';

const { createHttpClient } = require('./httpClient');

function createDependencies(config) {
  const client = createHttpClient({
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    retryBaseDelayMs: config.retryBaseDelayMs,
  });

  return {
    inventory: {
      reserve: (orderId, items, requestId) =>
        client.request('inventory-service', `${config.inventoryUrl}/inventory/reserve`, {
          method: 'POST',
          body: { orderId, items },
          requestId,
        }),
      // Compensation call: one retry is enough, we are already on a failure path.
      release: (orderId, requestId) =>
        client.request('inventory-service', `${config.inventoryUrl}/inventory/release`, {
          method: 'POST',
          body: { orderId },
          requestId,
          retries: 1,
        }),
    },

    payment: {
      charge: (orderId, amountCents, requestId) =>
        client.request('payment-service', `${config.paymentUrl}/payments`, {
          method: 'POST',
          body: { orderId, amountCents, currency: 'USD' },
          requestId,
        }),
    },

    notification: {
      // Best-effort: shorter timeout, no retries. A slow notification must not slow the order.
      send: (payload, requestId) =>
        client.request('notification-service', `${config.notificationUrl}/notifications`, {
          method: 'POST',
          body: payload,
          requestId,
          timeoutMs: config.notificationTimeoutMs,
          retries: 0,
        }),
    },
  };
}

module.exports = { createDependencies };