'use strict';

const { errorBody } = require('./failure');

// The five Phase 2 telemetry features for ONE service over ONE 30-second window.
// These PromQL expressions mirror anomaly-engine/anomaly_engine/features.py; the metric names are the
// Prometheus names of the OpenTelemetry instruments created in Phase 2.
const WINDOW_SECONDS = 30;
const FEATURE_NAMES = ['requestRate', 'errorRate', 'avgLatency', 'p95Latency', 'timeoutCount'];

const SERVER = 'http_server_request_duration_seconds';
const CLIENT = 'http_client_request_duration_seconds';

// The service name is interpolated into PromQL, so only a strict allow-list pattern is accepted.
const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function isValidServiceName(name) {
  return typeof name === 'string' && SERVICE_NAME_PATTERN.test(name);
}

function buildQueries(service, windowSeconds = WINDOW_SECONDS) {
  if (!isValidServiceName(service)) throw new Error(`invalid service name "${service}"`);
  const range = `${windowSeconds}s`;
  const selector = `job="${service}",http_route!~"/health.*"`; // health probes are not user traffic
  const requests = `sum(rate(${SERVER}_count{${selector}}[${range}]))`;
  return {
    requestRate: requests,
    errorRate: `(sum(rate(${SERVER}_count{${selector},http_response_status_code=~"5.."}[${range}])) / ${requests}) or vector(0)`,
    avgLatency: `sum(rate(${SERVER}_sum{${selector}}[${range}])) / ${requests}`,
    p95Latency: `histogram_quantile(0.95, sum by (le) (rate(${SERVER}_bucket{${selector}}[${range}])))`,
    // timeouts are attributed to the CALLEE (peer_service): the service that was slow
    timeoutCount: `sum(increase(${CLIENT}_count{peer_service="${service}",outcome="timeout"}[${range}])) or vector(0)`,
  };
}

// Prometheus instant-vector result -> number, or null when the vector is empty (no such series).
// Prometheus encodes values as strings, including "NaN", "+Inf" and "-Inf".
function parseVectorValue(data) {
  if (!data || data.resultType !== 'vector' || !Array.isArray(data.result)) {
    throw new Error('unexpected Prometheus result shape');
  }
  if (data.result.length === 0) return null;
  const sample = data.result[0].value;
  if (!Array.isArray(sample) || sample.length < 2) throw new Error('unexpected Prometheus sample shape');
  const text = String(sample[1]);
  // JavaScript's Number() does not understand Prometheus' "+Inf" / "-Inf" spellings.
  if (text === '+Inf' || text === 'Inf') return Infinity;
  if (text === '-Inf') return -Infinity;
  return Number(text);
}

const finiteOrZero = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

// Returns the cleaned five-feature window, or null when Prometheus has no request series for the service
// (service down or never scraped). NaN (0/0 on an idle service) becomes 0, like the training data.
async function fetchWindow({ prometheus, service, requestId }) {
  const queries = buildQueries(service);
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, promql]) => [name, parseVectorValue(await prometheus.query(promql, { requestId }))])
  );
  const raw = Object.fromEntries(entries);
  if (raw.requestRate === null) return null;
  return {
    requestRate: finiteOrZero(raw.requestRate),
    errorRate: Math.min(1, finiteOrZero(raw.errorRate)),
    avgLatency: finiteOrZero(raw.avgLatency),
    p95Latency: finiteOrZero(raw.p95Latency),
    timeoutCount: finiteOrZero(raw.timeoutCount),
  };
}

// Validates a client-supplied window. Returns { window } or { error } (a ready-made error body).
function validateWindow(window) {
  const isObject = window !== null && typeof window === 'object' && !Array.isArray(window);
  const keys = isObject ? Object.keys(window) : [];
  const exact = isObject && keys.length === FEATURE_NAMES.length && FEATURE_NAMES.every((name) => name in window);
  const numeric = exact && FEATURE_NAMES.every((name) => typeof window[name] === 'number' && Number.isFinite(window[name]) && window[name] >= 0);
  if (!numeric || window.errorRate > 1) {
    return {
      error: errorBody(
        'VALIDATION_ERROR',
        `window must contain exactly ${FEATURE_NAMES.join(', ')} as finite non-negative numbers (errorRate at most 1)`
      ),
    };
  }
  return { window: Object.fromEntries(FEATURE_NAMES.map((name) => [name, window[name]])) };
}

module.exports = { WINDOW_SECONDS, FEATURE_NAMES, isValidServiceName, buildQueries, parseVectorValue, fetchWindow, validateWindow };
