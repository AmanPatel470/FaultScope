'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { sendDownstreamFailure } = require('../failure');

// Identity headers are built from the VERIFIED token, never copied from the client.
function identityHeaders(user) {
  return {
    'x-user-id': user.id,
    'x-user-name': user.username,
    'x-user-role': user.role,
  };
}

function createApiRouter({ client, config, authenticate }) {
  const router = express.Router();

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      try {
        const result = await client.request('auth-service', `${config.authUrl}/auth/login`, {
          method: 'POST',
          body: req.body || {},
          requestId: req.requestId,
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return sendDownstreamFailure(res, err);
      }
    })
  );

  router.post(
    '/orders',
    authenticate,
    asyncHandler(async (req, res) => {
      try {
        const result = await client.request('order-service', `${config.orderUrl}/orders`, {
          method: 'POST',
          body: req.body || {},
          headers: identityHeaders(req.user),
          requestId: req.requestId,
          timeoutMs: config.orderTimeoutMs,
          retries: 0, // never retry order creation here: the Gateway has no idempotency key
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return sendDownstreamFailure(res, err);
      }
    })
  );

  router.get(
    '/orders/:orderId',
    authenticate,
    asyncHandler(async (req, res) => {
      try {
        const result = await client.request(
          'order-service',
          `${config.orderUrl}/orders/${encodeURIComponent(req.params.orderId)}`,
          {
            headers: identityHeaders(req.user),
            requestId: req.requestId,
            timeoutMs: config.orderTimeoutMs,
            retries: 0,
          }
        );
        return res.status(result.status).json(result.body);
      } catch (err) {
        return sendDownstreamFailure(res, err);
      }
    })
  );

  return router;
}

module.exports = { createApiRouter };