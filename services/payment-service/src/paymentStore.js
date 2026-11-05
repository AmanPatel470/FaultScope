'use strict';

const { randomUUID } = require('node:crypto');

const MAX_PAYMENTS = 5000;

function createPaymentStore() {
  const byId = new Map();
  const byOrderId = new Map();

  return {
    findById: (paymentId) => byId.get(paymentId) || null,
    findByOrderId: (orderId) => byOrderId.get(orderId) || null,

    create({ orderId, amountCents, currency }) {
      const payment = {
        paymentId: `pay-${randomUUID().slice(0, 8)}`,
        orderId,
        amountCents,
        currency,
        status: 'APPROVED',
        processedAt: new Date().toISOString(),
      };
      byId.set(payment.paymentId, payment);
      byOrderId.set(orderId, payment);

      if (byId.size > MAX_PAYMENTS) {
        const oldestId = byId.keys().next().value;
        byOrderId.delete(byId.get(oldestId).orderId);
        byId.delete(oldestId);
      }
      return payment;
    },
  };
}

module.exports = { createPaymentStore };