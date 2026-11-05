'use strict';

const { randomUUID } = require('node:crypto');
const logger = require('../logger');

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || randomUUID();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('request_completed', {
      requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    });
  });

  next();
}

module.exports = requestLogger;