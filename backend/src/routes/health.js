'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const config = require('../config');

function createHealthRouter({ engine }) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.status(200).json({
      service: config.serviceName,
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  router.get(
    '/health/dependencies',
    asyncHandler(async (req, res) => {
      const startedAt = process.hrtime.bigint();
      const latency = () => Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1));

      let dependency;
      try {
        await engine.health(req.requestId);
        dependency = { service: 'blast-radius-engine', status: 'up', latencyMs: latency() };
      } catch (err) {
        dependency = {
          service: 'blast-radius-engine',
          status: 'down',
          latencyMs: latency(),
          reason: err.kind || 'error',
        };
      }

      const up = dependency.status === 'up';
      res.status(up ? 200 : 503).json({
        status: up ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        dependencies: [dependency],
      });
    })
  );

  return router;
}

module.exports = { createHealthRouter };