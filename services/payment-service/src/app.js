'use strict';

const express = require('express');
const defaultConfig = require('./config');
const requestLogger = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const { createPaymentStore } = require('./paymentStore');
const { createPaymentsRouter } = require('./routes/payments');

function createApp({ config = defaultConfig, store = createPaymentStore() } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRoutes);
  app.use('/payments', createPaymentsRouter({ store, config }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };