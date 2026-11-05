'use strict';

const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const { createInventoryStore } = require('./inventoryStore');
const { createInventoryRouter } = require('./routes/inventory');

function createApp({ store = createInventoryStore() } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRoutes);
  app.use('/inventory', createInventoryRouter({ store }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };