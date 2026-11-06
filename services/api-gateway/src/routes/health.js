'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');

function createHealthRouter({ client, config }) {
  const router = express.Router();

  const targets = [
    { name: 'auth-service', url: config.authUrl },
    { name: 'order-service', url: config.orderUrl },
    { name: 'payment-service', url: config.paymentUrl },
    { name: 'inventory-service', url: config.inventoryUrl },
    { name: 'notification-service', url: config.notificationUrl },
  ];

  router.get('/health', (req, res) => {
    res.status(200).json({
      service: config.serviceName,
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Aggregated availability view. Phase 6's dashboard will build on this.
  router.get(
    '/health/services',
    asyncHandler(async (req, res) => {
      const services = await Promise.all(
        targets.map(async ({ name, url }) => {
          const startedAt = process.hrtime.bigint();
          const latency = () => Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1));
          try {
            await client.request(name, `${url}/health`, {
              timeoutMs: config.healthTimeoutMs,
              retries: 0,
              requestId: req.requestId,
            });
            return { service: name, status: 'up', latencyMs: latency() };
          } catch (err) {
            return { service: name, status: 'down', latencyMs: latency(), reason: err.kind || 'error' };
          }
        })
      );

      const allUp = services.every((s) => s.status === 'up');
      res.status(allUp ? 200 : 503).json({
        status: allUp ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        services,
      });
    })
  );

  return router;
}

module.exports = { createHealthRouter };