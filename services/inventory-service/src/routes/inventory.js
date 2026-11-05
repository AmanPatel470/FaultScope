'use strict';

const express = require('express');

function errorBody(code, message, details) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function validReserveBody(body) {
  if (!body || !isId(body.orderId)) return false;
  const { items } = body;
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) return false;
  return items.every(
    (item) =>
      item && isId(item.productId) &&
      Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 100
  );
}

function createInventoryRouter({ store }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.status(200).json({ products: store.list() });
  });

  router.get('/:productId', (req, res) => {
    const product = store.get(req.params.productId);
    if (!product) {
      return res.status(404).json(errorBody('UNKNOWN_PRODUCT', `Unknown product ${req.params.productId}`));
    }
    return res.status(200).json(product);
  });

  router.post('/reserve', (req, res) => {
    if (!validReserveBody(req.body)) {
      return res.status(400).json(
        errorBody(
          'VALIDATION_ERROR',
          'orderId and 1-20 items are required; each item needs productId and an integer quantity of 1-100'
        )
      );
    }
    const result = store.reserve(req.body.orderId, req.body.items);
    if (!result.ok) {
      return res.status(result.status).json(errorBody(result.code, result.message, result.details));
    }
    return res
      .status(result.replay ? 200 : 201)
      .json({ ...result.reservation, idempotentReplay: result.replay });
  });

  router.post('/release', (req, res) => {
    if (!req.body || !isId(req.body.orderId)) {
      return res.status(400).json(errorBody('VALIDATION_ERROR', 'orderId is required'));
    }
    const result = store.release(req.body.orderId);
    if (!result.ok) {
      return res.status(result.status).json(errorBody(result.code, result.message));
    }
    return res.status(200).json({ ...result.reservation, idempotentReplay: result.replay });
  });

  return router;
}

module.exports = { createInventoryRouter };