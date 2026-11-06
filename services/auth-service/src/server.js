'use strict';

const config = require('./config');
const logger = require('./logger');
const { startTelemetry, readMetricsConfig } = require('./telemetry');

async function main() {
  // Register the MeterProvider first; ./app (and what it requires) creates instruments on load.
  const telemetry = await startTelemetry({ serviceName: config.serviceName, ...readMetricsConfig() });

  const { createApp } = require('./app');
  const app = createApp();

  const server = app.listen(config.port, () => {
    logger.info('service_started', { port: config.port, nodeEnv: config.nodeEnv });
  });

  function shutdown(signal) {
    logger.info('service_stopping', { signal });
    server.close(() => {
      telemetry.shutdown().finally(() => process.exit(0));
    });
    // Force exit if connections refuse to close.
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('startup_failed', { message: err.message });
  process.exit(1);
});