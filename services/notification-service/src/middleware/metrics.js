'use strict';

const { metrics } = require('@opentelemetry/api');

const BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
  0.5, 1, 2.5, 5, 10, 15,
];

let instruments;

function getInstruments() {
  if (instruments) return instruments;

  const meter = metrics.getMeter('faultscope');

  const requestDuration = meter.createHistogram(
    'http.server.request.duration.seconds',
    {
      description: 'Duration of inbound HTTP requests',
      unit: 's',
      advice: {
        explicitBucketBoundaries: BUCKETS_SECONDS,
      },
    }
  );

  const activeRequests = meter.createUpDownCounter(
    'http.server.active.requests',
    {
      description: 'Inbound HTTP requests currently being processed',
      unit: '{request}',
    }
  );

  instruments = { requestDuration, activeRequests };

  return instruments;
}

function routeLabel(req) {
  if (!req.route) return 'UNMATCHED';

  const routePath =
    req.route.path === '/' ? '' : String(req.route.path);

  return `${req.baseUrl || ''}${routePath}` || '/';
}

function metricsMiddleware(req, res, next) {
  const { requestDuration, activeRequests } = getInstruments();

  const startedAt = process.hrtime.bigint();
  const method = req.method;

  const attributes = {
    'http.request.method': method,
  };

  activeRequests.add(1, attributes);

  let completed = false;

  function finishRequest(recordDuration) {
    if (completed) return;

    completed = true;

    if (recordDuration) {
      const duration =
        Number(process.hrtime.bigint() - startedAt) / 1e9;

      requestDuration.record(duration, {
        'http.request.method': method,
        'http.route': routeLabel(req),
        'http.response.status_code': res.statusCode,
      });
    }

    activeRequests.add(-1, attributes);
  }

  res.once('finish', () => finishRequest(true));
  res.once('close', () => finishRequest(false));

  next();
}

module.exports = metricsMiddleware;