'use strict';

const express = require('express');
const defaultConfig = require('./config');
const requestLogger = require('./middleware/requestLogger');
const metricsMiddleware = require('./middleware/metrics');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const { createInventoryStore } = require('./inventoryStore');
const { createInventoryRouter } = require('./routes/inventory');

function createApp({
  config = defaultConfig,
  store = createInventoryStore({ stockMultiplier: config.stockMultiplier }),
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(metricsMiddleware);
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRoutes);
  app.use('/inventory', createInventoryRouter({ store }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };