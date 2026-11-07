'use strict';

const SERVICE = 'blast-radius-engine';

// Typed wrapper around the engine's HTTP API. The engine's calls are pure computations,
// so the shared client's retries are safe here.
function createBlastRadiusClient({ client, config }) {
  return {
    health: (requestId) =>
      client.request(SERVICE, `${config.blastRadiusUrl}/health`, {
        requestId,
        timeoutMs: config.healthTimeoutMs,
        retries: 0,
      }),

    getGraph: (requestId) => client.request(SERVICE, `${config.blastRadiusUrl}/graph`, { requestId }),

    analyze: (failedService, requestId) =>
      client.request(SERVICE, `${config.blastRadiusUrl}/analyze`, {
        method: 'POST',
        body: { failed_service: failedService },
        requestId,
      }),
  };
}

module.exports = { createBlastRadiusClient };