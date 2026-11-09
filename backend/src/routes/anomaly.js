'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { DownstreamError } = require('../httpClient');
const { sendDownstreamFailure, errorBody } = require('../failure');
const { toCamel } = require('../caseConverter');
const { WINDOW_SECONDS, isValidServiceName, fetchWindow, validateWindow } = require('../telemetryFeatures');

// Prometheus answers with its own error shape ({status, errorType, error: "<string>"}), which must not
// be passed through like a FaultScope service's error body, so Prometheus failures are mapped here.
function sendFailure(res, err) {
  if (err instanceof DownstreamError && err.service === 'prometheus') {
    if (err.kind === 'timeout') {
      return res.status(504).json(errorBody('DEPENDENCY_TIMEOUT', 'prometheus did not respond in time', { service: 'prometheus' }));
    }
    return res.status(502).json(errorBody('DEPENDENCY_FAILURE', 'prometheus is unavailable or failing', { service: 'prometheus' }));
  }
  return sendDownstreamFailure(res, err);
}

const badService = (res) =>
  res.status(400).json(errorBody('VALIDATION_ERROR', 'service must be a lowercase service name such as payment-service'));

function createAnomalyRouter({ anomalyEngine, prometheus }) {
  const router = express.Router();

  // Health of the two dependencies this feature needs. (/health/dependencies is unchanged: blast radius only.)
  router.get(
    '/health',
    asyncHandler(async (req, res) => {
      const check = async (service, fn) => {
        const startedAt = process.hrtime.bigint();
        const latency = () => Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1));
        try {
          await fn(req.requestId);
          return { service, status: 'up', latencyMs: latency() };
        } catch (err) {
          return { service, status: 'down', latencyMs: latency(), reason: err.kind || 'error' };
        }
      };
      const dependencies = await Promise.all([
        check('prometheus', prometheus.health),
        check('anomaly-engine', anomalyEngine.health),
      ]);
      const allUp = dependencies.every((d) => d.status === 'up');
      res.status(allUp ? 200 : 503).json({
        status: allUp ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        dependencies,
      });
    })
  );

  router.get(
    '/model',
    asyncHandler(async (req, res) => {
      try {
        const result = await anomalyEngine.model(req.requestId);
        return res.status(200).json(toCamel(result.body));
      } catch (err) {
        return sendFailure(res, err);
      }
    })
  );

  // Score a window supplied by the caller (no Prometheus involved).
  router.post(
    '/score',
    asyncHandler(async (req, res) => {
      const { service, window, explain = true } = req.body || {};
      if (!isValidServiceName(service)) return badService(res);
      if (typeof explain !== 'boolean') {
        return res.status(400).json(errorBody('VALIDATION_ERROR', 'explain must be a boolean'));
      }
      const checked = validateWindow(window);
      if (checked.error) return res.status(400).json(checked.error);

      try {
        const result = await anomalyEngine.predict(service, checked.window, explain, req.requestId);
        return res.status(200).json(toCamel({ ...result.body, window: checked.window, source: 'request' }));
      } catch (err) {
        return sendFailure(res, err); // an engine 404 (unknown service) passes through unchanged
      }
    })
  );

  // Build the current 30 s window from Prometheus, then score it.
  router.get(
    '/services/:service',
    asyncHandler(async (req, res) => {
      const { service } = req.params;
      if (!isValidServiceName(service)) return badService(res);

      try {
        const window = await fetchWindow({ prometheus, service, requestId: req.requestId });
        if (window === null) {
          return res.status(200).json({
            service,
            status: 'no_data',
            isAnomalous: null,
            window: null,
            windowSeconds: WINDOW_SECONDS,
            source: 'prometheus',
            message: 'Prometheus has no recent request metrics for this service (is it running and being scraped?)',
          });
        }
        const result = await anomalyEngine.predict(service, window, true, req.requestId);
        return res.status(200).json(toCamel({ ...result.body, window, source: 'prometheus' }));
      } catch (err) {
        return sendFailure(res, err);
      }
    })
  );

  return router;
}

module.exports = { createAnomalyRouter };
