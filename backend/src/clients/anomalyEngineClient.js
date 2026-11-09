'use strict';

const SERVICE = 'anomaly-engine';

// The public API is camelCase; the engine speaks snake_case. The mapping is explicit so that an
// unexpected key can never be forwarded by accident.
function toEngineWindow(window) {
  return {
    request_rate: window.requestRate,
    error_rate: window.errorRate,
    avg_latency: window.avgLatency,
    p95_latency: window.p95Latency,
    timeout_count: window.timeoutCount,
  };
}

// Scoring is a pure computation, so the shared client's retries are safe here.
function createAnomalyEngineClient({ client, config }) {
  return {
    health: (requestId) =>
      client.request(SERVICE, `${config.anomalyEngineUrl}/health`, { requestId, timeoutMs: config.healthTimeoutMs, retries: 0 }),

    model: (requestId) => client.request(SERVICE, `${config.anomalyEngineUrl}/model`, { requestId }),

    predict: (service, window, explain, requestId) =>
      client.request(SERVICE, `${config.anomalyEngineUrl}/predict`, {
        method: 'POST',
        body: { service, window: toEngineWindow(window), explain },
        requestId,
      }),
  };
}

module.exports = { createAnomalyEngineClient, toEngineWindow };
