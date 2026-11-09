'use strict';

const express = require('express');
const defaultConfig = require('./config');
const { createHttpClient } = require('./httpClient');
const requestLogger = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { createBlastRadiusClient } = require('./clients/blastRadiusClient');
const { createAnomalyEngineClient } = require('./clients/anomalyEngineClient');
const { createPrometheusClient } = require('./clients/prometheusClient');
const { createHealthRouter } = require('./routes/health');
const { createBlastRadiusRouter } = require('./routes/blastRadius');
const { createAnomalyRouter } = require('./routes/anomaly');

function createApp({ config = defaultConfig } = {}) {
  const app = express();

  const client = createHttpClient({
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    retryBaseDelayMs: config.retryBaseDelayMs,
  });
  const engine = createBlastRadiusClient({ client, config });
  const anomalyEngine = createAnomalyEngineClient({ client, config });
  const prometheus = createPrometheusClient({ client, config });

  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(createHealthRouter({ engine }));
  app.use('/api/blast-radius', createBlastRadiusRouter({ engine }));
  app.use('/api/anomaly', createAnomalyRouter({ anomalyEngine, prometheus }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
