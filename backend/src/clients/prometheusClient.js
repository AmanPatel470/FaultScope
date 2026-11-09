'use strict';

const { DownstreamError } = require('../httpClient');

const SERVICE = 'prometheus';

// Thin wrapper around the Prometheus HTTP API (instant queries only).
function createPrometheusClient({ client, config }) {
  return {
    health: (requestId) =>
      client.request(SERVICE, `${config.prometheusUrl}/-/healthy`, { requestId, timeoutMs: config.healthTimeoutMs, retries: 0 }),

    // Resolves the `data` object of a successful response: { resultType, result }.
    async query(promql, { requestId } = {}) {
      const url = new URL('/api/v1/query', config.prometheusUrl);
      url.searchParams.set('query', promql);
      const response = await client.request(SERVICE, url.toString(), { requestId, timeoutMs: config.prometheusTimeoutMs });
      const body = response.body;
      if (!body || body.status !== 'success' || !body.data) {
        throw new DownstreamError({ service: SERVICE, kind: 'http', status: 502, body: null });
      }
      return body.data;
    },
  };
}

module.exports = { createPrometheusClient };
