'use strict';

const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const metricsMiddleware = require('./middleware/metrics');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(metricsMiddleware);
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRoutes);
  app.use('/auth', authRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };