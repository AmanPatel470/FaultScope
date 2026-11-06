'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');
const asyncHandler = require('../middleware/asyncHandler');
const { DownstreamError } = require('../httpClient');
const logger = require('../logger');

function errorBody(code, message, extra = {}) {
  return { error: { code, message, ...extra } };
}

// Identity is set by the API Gateway after it verified the token with the Auth Service.
function readUser(req) {
  const id = req.get('x-user-id');
  if (!id || id.length > 64) return null;
  return { id, username: req.get('x-user-name') || null };
}

function validateItems(body) {
  const items = body && body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) return null;
  const valid = items.every(
    (item) =>
      item &&
      typeof item.productId === 'string' && item.productId.length > 0 && item.productId.length <= 64 &&
      Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 100
  );
  return valid ? items.map((i) => ({ productId: i.productId, quantity: i.quantity })) : null;
}

function sendDependencyFailure(res, err, orderId) {
  if (err.kind === 'http' && err.status < 500) {
    // The dependency understood the request and said no (stock, declined card...).
    return res.status(422).json({
      ...errorBody('ORDER_REJECTED', `Order rejected by ${err.service}`, {
        service: err.service,
        reason: err.body && err.body.error ? err.body.error : null,
      }),
      orderId,
    });
  }
  if (err.kind === 'timeout') {
    return res.status(504).json({
      ...errorBody('DEPENDENCY_TIMEOUT', `${err.service} did not respond in time`, {
        service: err.service,
        attempts: err.attempts,
      }),
      orderId,
    });
  }
  return res.status(502).json({
    ...errorBody('DEPENDENCY_FAILURE', `${err.service} is unavailable or failing`, {
      service: err.service,
      attempts: err.attempts,
    }),
    orderId,
  });
}

async function releaseQuietly(deps, orderId, requestId) {
  try {
    await deps.inventory.release(orderId, requestId);
    logger.info('inventory_released', { requestId, orderId });
  } catch (err) {
    // Needs manual reconciliation in a real system.
    logger.error('inventory_release_failed', { requestId, orderId, reason: err.message });
  }
}

async function notifyQuietly(deps, order, requestId) {
  try {
    await deps.notification.send(
      { orderId: order.orderId, userId: order.userId, type: 'ORDER_CONFIRMED' },
      requestId
    );
    return 'sent';
  } catch (err) {
    if (!(err instanceof DownstreamError)) throw err;
    logger.warn('notification_failed', { requestId, orderId: order.orderId, reason: err.kind });
    return 'degraded';
  }
}

function createOrdersRouter({ deps, store }) {
  const router = express.Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const user = readUser(req);
      if (!user) {
        return res
          .status(401)
          .json(errorBody('MISSING_USER_CONTEXT', 'x-user-id header is required (set by the API Gateway)'));
      }

      const items = validateItems(req.body);
      if (!items) {
        return res.status(400).json(
          errorBody(
            'VALIDATION_ERROR',
            'items must contain 1-20 entries; each needs a productId and an integer quantity of 1-100'
          )
        );
      }

      const requestId = req.requestId;
      const order = {
        orderId: `ord-${randomUUID().slice(0, 12)}`,
        userId: user.id,
        status: 'PENDING',
        items: [],
        totalCents: 0,
        paymentId: null,
        notification: null,
        failure: null,
        createdAt: new Date().toISOString(),
      };

      let reserved = false;

      try {
        const reservation = await deps.inventory.reserve(order.orderId, items, requestId);
        reserved = true;
        order.items = reservation.body.items;
        order.totalCents = reservation.body.totalCents;

        const payment = await deps.payment.charge(order.orderId, order.totalCents, requestId);
        order.paymentId = payment.body.paymentId;
      } catch (err) {
        if (!(err instanceof DownstreamError)) throw err;

        // Compensation: give the stock back if we had already reserved it.
        if (reserved) await releaseQuietly(deps, order.orderId, requestId);

        order.status = 'FAILED';
        order.failure = {
          service: err.service,
          kind: err.kind,
          status: err.status,
          code: err.body && err.body.error ? err.body.error.code : null,
        };
        store.save(order);
        logger.warn('order_failed', { requestId, orderId: order.orderId, ...order.failure });
        return sendDependencyFailure(res, err, order.orderId);
      }

      order.status = 'CONFIRMED';
      order.notification = await notifyQuietly(deps, order, requestId);
      store.save(order);
      logger.info('order_confirmed', {
        requestId,
        orderId: order.orderId,
        totalCents: order.totalCents,
        notification: order.notification,
      });
      return res.status(201).json(order);
    })
  );

  router.get('/:orderId', (req, res) => {
    const user = readUser(req);
    if (!user) {
      return res
        .status(401)
        .json(errorBody('MISSING_USER_CONTEXT', 'x-user-id header is required (set by the API Gateway)'));
    }
    const order = store.get(req.params.orderId);
    // Return 404 (not 403) for other people's orders so we don't reveal which IDs exist.
    if (!order || order.userId !== user.id) {
      return res.status(404).json(errorBody('ORDER_NOT_FOUND', 'Order not found'));
    }
    return res.status(200).json(order);
  });

  return router;
}

module.exports = { createOrdersRouter };