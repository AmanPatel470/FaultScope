
'use strict';

const { metrics } = require('@opentelemetry/api');
const logger = require('./logger');

const BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
  0.5, 1, 2.5, 5, 10, 15,
];

let instruments;

function getInstruments() {
  if (instruments) return instruments;

  const meter = metrics.getMeter('faultscope');

  const clientDuration = meter.createHistogram(
    'http.client.request.duration.seconds',
    {
      description: 'Duration of each outbound HTTP request attempt',
      unit: 's',
      advice: {
        explicitBucketBoundaries: BUCKETS_SECONDS,
      },
    }
  );

  const clientRetries = meter.createCounter(
    'faultscope.client.retries',
    {
      description: 'Retry attempts made after a failed outbound call',
    }
  );

  instruments = { clientDuration, clientRetries };

  return instruments;
}

class DownstreamError extends Error {
  constructor({
    service,
    kind,
    status = null,
    body = null,
    cause,
  }) {
    super(`${service} ${kind}${status ? ` (${status})` : ''}`);

    this.name = 'DownstreamError';
    this.service = service;
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.attempts = 1;

    if (cause) this.cause = cause;
  }
}

const defaultSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err) {
  if (err.kind === 'timeout' || err.kind === 'network') {
    return true;
  }

  return err.kind === 'http' && err.status >= 500;
}

function outcomeOf(err) {
  if (err.kind === 'timeout') return 'timeout';
  if (err.kind === 'network') return 'network';

  return err.status >= 500 ? 'http_5xx' : 'http_4xx';
}

function recordAttempt(service, method, outcome, startedAt) {
  const { clientDuration } = getInstruments();

  const duration =
    Number(process.hrtime.bigint() - startedAt) / 1e9;

  clientDuration.record(duration, {
    'peer.service': service,
    'http.request.method': method,
    outcome,
  });
}

function createHttpClient({
  timeoutMs,
  maxRetries,
  retryBaseDelayMs,
  sleep = defaultSleep,
}) {
  async function attemptOnce(
    service,
    url,
    { method, headers, payload, timeout }
  ) {
    let response;
    let responseText;

    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeout),
      });

      responseText = await response.text();
    } catch (err) {
      if (
        err.name === 'TimeoutError' ||
        err.name === 'AbortError'
      ) {
        throw new DownstreamError({
          service,
          kind: 'timeout',
          cause: err,
        });
      }

      throw new DownstreamError({
        service,
        kind: 'network',
        cause: err,
      });
    }

    let responseBody = null;

    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = null;
      }
    }

    if (!response.ok) {
      throw new DownstreamError({
        service,
        kind: 'http',
        status: response.status,
        body: responseBody,
      });
    }

    return {
      status: response.status,
      body: responseBody,
    };
  }

  async function request(service, url, options = {}) {
    const {
      method = 'GET',
      body,
      headers = {},
      requestId,
      timeoutMs: timeout = timeoutMs,
      retries = maxRetries,
    } = options;

    const finalHeaders = {
      accept: 'application/json',
      ...headers,
    };

    let payload;

    if (body !== undefined) {
      payload = JSON.stringify(body);
      finalHeaders['content-type'] = 'application/json';
    }

    if (requestId) {
      finalHeaders['x-request-id'] = requestId;
    }

    const totalAttempts = retries + 1;

    for (let attempt = 1; ; attempt += 1) {
      const startedAt = process.hrtime.bigint();

      try {
        const result = await attemptOnce(service, url, {
          method,
          headers: finalHeaders,
          payload,
          timeout,
        });

        recordAttempt(service, method, 'success', startedAt);

        return {
          ...result,
          attempts: attempt,
        };
      } catch (err) {
        // Only handle errors created by this HTTP client.
        if (!(err instanceof DownstreamError)) {
          throw err;
        }

        const outcome = outcomeOf(err);

        recordAttempt(service, method, outcome, startedAt);

        err.attempts = attempt;

        if (!isRetryable(err) || attempt >= totalAttempts) {
          throw err;
        }

        const { clientRetries } = getInstruments();

        const delay =
          retryBaseDelayMs * 2 ** (attempt - 1) +
          Math.floor(Math.random() * retryBaseDelayMs);

        clientRetries.add(1, {
          'peer.service': service,
          reason: outcome,
        });

        // Include the underlying network error for diagnosis.
        logger.warn('downstream_retry', {
          requestId,
          service,
          method,
          url,
          attempt,
          reason: err.kind,
          status: err.status,
          errorCode: err.cause?.code || null,
          errorMessage: err.cause?.message || null,
          retryInMs: delay,
        });

        await sleep(delay);
      }
    }
  }

  return { request };
}

module.exports = {
  createHttpClient,
  DownstreamError,
};
