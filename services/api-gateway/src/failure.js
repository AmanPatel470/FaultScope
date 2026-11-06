'use strict';

const { DownstreamError } = require('./httpClient');

function errorBody(code, message, extra = {}) {
  return { error: { code, message, ...extra } };
}

/**
 * - Service answered with its own error body (4xx or 5xx): pass it through unchanged.
 * - Timeout: 504.  Network error or unparseable answer: 502.
 * Re-throws anything that isn't a DownstreamError (a real bug) so the error handler logs it.
 */
function sendDownstreamFailure(res, err) {
  if (!(err instanceof DownstreamError)) throw err;

  if (err.kind === 'http' && err.body && err.body.error) {
    return res.status(err.status).json(err.body);
  }
  if (err.kind === 'timeout') {
    return res
      .status(504)
      .json(errorBody('DEPENDENCY_TIMEOUT', `${err.service} did not respond in time`, { service: err.service }));
  }
  return res
    .status(502)
    .json(errorBody('DEPENDENCY_FAILURE', `${err.service} is unavailable or failing`, { service: err.service }));
}

module.exports = { sendDownstreamFailure, errorBody };