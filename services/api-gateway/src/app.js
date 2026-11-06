'use strict';

const express = require('express');
const defaultConfig = require('./config');
const { createHttpClient } = require('./httpClient');
const requestLogger = require('./middleware/requestLogger');
const metricsMiddleware = require('./middleware/metrics');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { createAuthenticate } = require('./middleware/authenticate');
const { createHealthRouter } = require('./routes/health');
const { createApiRouter } = require('./routes/api');

function createApp({ config = defaultConfig } = {}) {
  const app = express();

  // The Gateway never retries; each request gets one attempt per downstream call.
  const client = createHttpClient({
    timeoutMs: config.requestTimeoutMs,
    maxRetries: 0,
    retryBaseDelayMs: 100,
  });
  const authenticate = createAuthenticate({ client, config });

  app.disable('x-powered-by');
  app.use(metricsMiddleware);
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(createHealthRouter({ client, config }));
  app.use('/api', createApiRouter({ client, config, authenticate }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };