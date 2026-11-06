'use strict';

const express = require('express');
const defaultConfig = require('./config');
const requestLogger = require('./middleware/requestLogger');
const metricsMiddleware = require('./middleware/metrics');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const { createDependencies } = require('./dependencies');
const { createOrderStore } = require('./orderStore');
const { createOrdersRouter } = require('./routes/orders');

function createApp({ config = defaultConfig, deps, store = createOrderStore() } = {}) {
  const app = express();
  const dependencies = deps || createDependencies(config);

  app.disable('x-powered-by');
  app.use(metricsMiddleware);
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRoutes);
  app.use('/orders', createOrdersRouter({ deps: dependencies, store }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };