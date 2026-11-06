'use strict';

const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const { createNotificationStore } = require('./notificationStore');
const { createNotificationsRouter } = require('./routes/notifications');

function createApp({ store = createNotificationStore() } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRoutes);
  app.use('/notifications', createNotificationsRouter({ store }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };