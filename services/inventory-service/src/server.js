'use strict';

const config = require('./config');
const logger = require('./logger');
const { createApp } = require('./app');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info('service_started', { port: config.port, nodeEnv: config.nodeEnv });
});

function shutdown(signal) {
  logger.info('service_stopping', { signal });
  server.close(() => process.exit(0));
  // Force exit if connections refuse to close.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));