'use strict';

const http = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { metrics } = require('@opentelemetry/api');
const { MeterProvider } = require('@opentelemetry/sdk-metrics');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const logger = require('./logger');

const LOOP_RESOLUTION_MS = 10;

function readMetricsConfig(env = process.env) {
  const raw = env.METRICS_PORT;

  if (raw === undefined || raw === '') {
    return { port: null, host: '127.0.0.1' };
  }

  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`METRICS_PORT must be a port number between 1 and 65535, got "${raw}"`);
  }

  return { port, host: env.METRICS_HOST || '127.0.0.1' };
}

function registerProcessMetrics(meter) {
  meter
    .createObservableGauge('process.uptime.seconds', {
      description: 'Seconds since the process started',
      unit: 's',
    })
    .addCallback((result) => {
      result.observe(process.uptime());
    });

  meter
    .createObservableCounter('process.cpu.time.seconds', {
      description: 'Cumulative CPU time used by this process',
      unit: 's',
    })
    .addCallback((result) => {
      const usage = process.cpuUsage();

      result.observe(usage.user / 1e6, { 'cpu.mode': 'user' });
      result.observe(usage.system / 1e6, { 'cpu.mode': 'system' });
    });

  meter
    .createObservableGauge('process.memory.usage.bytes', {
      description: 'Process memory usage',
      unit: 'By',
    })
    .addCallback((result) => {
      const memory = process.memoryUsage();

      result.observe(memory.rss, { 'memory.type': 'rss' });
      result.observe(memory.heapUsed, { 'memory.type': 'heap_used' });
    });

  const loopDelay = monitorEventLoopDelay({
    resolution: LOOP_RESOLUTION_MS,
  });

  loopDelay.enable();

  meter
    .createObservableGauge('nodejs.eventloop.delay.p99.seconds', {
      description: 'Approximate event-loop delay at p99',
      unit: 's',
    })
    .addCallback((result) => {
      const lag =
        loopDelay.count > 0
          ? loopDelay.percentile(99) / 1e9 - LOOP_RESOLUTION_MS / 1e3
          : 0;

      result.observe(Math.max(0, lag));
      loopDelay.reset();
    });

  return () => loopDelay.disable();
}

function createMetricsServer(exporter) {
  return http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];

    if (req.method === 'GET' && pathname === '/metrics') {
      exporter.getMetricsRequestHandler(req, res);
      return;
    }

    res.writeHead(404, {
      'content-type': 'text/plain',
    });

    res.end('Not found\n');
  });
}

async function startTelemetry({ serviceName, port, host = '127.0.0.1' }) {
  if (!port) {
    logger.info('telemetry_disabled', {
      reason: 'METRICS_PORT is not set',
    });

    return {
      enabled: false,
      shutdown: async () => {},
    };
  }

  const exporter = new PrometheusExporter({
    preventServerStart: true,
  });

  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': serviceName,
    }),
    readers: [exporter],
  });

  metrics.setGlobalMeterProvider(provider);

  const stopLoopMonitor = registerProcessMetrics(
    provider.getMeter('faultscope.process')
  );

  const server = createMetricsServer(exporter);

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    stopLoopMonitor();
    await provider.shutdown();
    throw error;
  }

  logger.info('telemetry_started', {
    metricsUrl: `http://${host}:${port}/metrics`,
  });

  return {
    enabled: true,

    shutdown: async () => {
      stopLoopMonitor();
      server.closeAllConnections();

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      await provider.shutdown();
    },
  };
}

module.exports = {
  startTelemetry,
  readMetricsConfig,
};