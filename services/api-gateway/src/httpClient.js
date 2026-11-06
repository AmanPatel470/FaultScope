'use strict';

const logger = require('./logger');

/**
 * Thrown for any failed call to another service.
 *   kind = 'timeout' : no response within the time limit
 *   kind = 'network' : connection refused, DNS failure, connection reset...
 *   kind = 'http'    : the service answered with a non-2xx status (status/body are set)
 */
class DownstreamError extends Error {
  constructor({ service, kind, status = null, body = null, cause }) {
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

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry only failures that might succeed next time. A 4xx never will.
function isRetryable(err) {
  if (err.kind === 'timeout' || err.kind === 'network') return true;
  return err.kind === 'http' && err.status >= 500;
}

function createHttpClient({ timeoutMs, maxRetries, retryBaseDelayMs, sleep = defaultSleep }) {
  async function attemptOnce(service, url, { method, headers, payload, timeout }) {
    let res;
    let text;
    try {
      // The timeout signal covers connecting, waiting for headers AND reading the body.
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeout) });
      text = await res.text();
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new DownstreamError({ service, kind: 'timeout', cause: err });
      }
      throw new DownstreamError({ service, kind: 'network', cause: err });
    }

    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!res.ok) {
      throw new DownstreamError({ service, kind: 'http', status: res.status, body });
    }
    return { status: res.status, body };
  }

  /**
   * options: method, body, headers, requestId,
   *          timeoutMs (per-attempt override), retries (override of maxRetries)
   * Resolves { status, body, attempts } or throws DownstreamError.
   */
  async function request(service, url, options = {}) {
    const {
      method = 'GET',
      body,
      headers = {},
      requestId,
      timeoutMs: timeout = timeoutMs,
      retries = maxRetries,
    } = options;

    const finalHeaders = { accept: 'application/json', ...headers };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      finalHeaders['content-type'] = 'application/json';
    }
    if (requestId) finalHeaders['x-request-id'] = requestId;

    const totalAttempts = retries + 1;

    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await attemptOnce(service, url, { method, headers: finalHeaders, payload, timeout });
        return { ...result, attempts: attempt };
      } catch (err) {
        err.attempts = attempt;
        if (!isRetryable(err) || attempt >= totalAttempts) throw err;

        // Exponential backoff (base, 2x base, 4x base...) plus jitter.
        const delay = retryBaseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * retryBaseDelayMs);
        logger.warn('downstream_retry', {
          requestId,
          service,
          method,
          url,
          attempt,
          reason: err.kind,
          status: err.status,
          retryInMs: delay,
        });
        await sleep(delay);
      }
    }
  }

  return { request };
}

module.exports = { createHttpClient, DownstreamError };