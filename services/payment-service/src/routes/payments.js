'use strict';

const express = require('express');

function errorBody(code, message, details) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function createPaymentsRouter({ store, config }) {
  const router = express.Router();

  router.post('/', (req, res) => {
    const { orderId, amountCents, currency = 'USD' } = req.body || {};

    const valid =
      typeof orderId === 'string' && orderId.length > 0 && orderId.length <= 64 &&
      Number.isInteger(amountCents) && amountCents > 0 && amountCents <= 100_000_000 &&
      typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);

    if (!valid) {
      return res.status(400).json(
        errorBody(
          'VALIDATION_ERROR',
          'orderId (string), amountCents (positive integer) and an optional 3-letter currency are required'
        )
      );
    }

    // Idempotency: the Order Service may retry after a timeout. Same orderId => same payment.
    const existing = store.findByOrderId(orderId);
    if (existing) {
      return res.status(200).json({ ...existing, idempotentReplay: true });
    }

    if (amountCents > config.declineAboveCents) {
      return res.status(402).json(
        errorBody('PAYMENT_DECLINED', 'Amount exceeds the simulated card limit', {
          limitCents: config.declineAboveCents,
        })
      );
    }

    return res.status(201).json(store.create({ orderId, amountCents, currency }));
  });

  router.get('/:paymentId', (req, res) => {
    const payment = store.findById(req.params.paymentId);
    if (!payment) {
      return res.status(404).json(errorBody('PAYMENT_NOT_FOUND', 'Payment not found'));
    }
    return res.status(200).json(payment);
  });

  return router;
}

module.exports = { createPaymentsRouter };