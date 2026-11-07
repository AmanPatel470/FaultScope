'use strict';

function readInt(name, fallback, { min = 1 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < min) {
    throw new Error(`Environment variable ${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function readUrl(name, fallback) {
  const raw = process.env[name] || fallback;
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`Environment variable ${name} must be a valid URL, got "${raw}"`);
  }
}

const config = {
  serviceName: 'control-plane',
  nodeEnv: process.env.NODE_ENV || 'development',
  // Safe local default: only this machine can reach the control plane.
  host: process.env.HOST || '127.0.0.1',
  port: readInt('PORT', 4000),
  blastRadiusUrl: readUrl('BLAST_RADIUS_URL', 'http://127.0.0.1:8002'),
  requestTimeoutMs: readInt('REQUEST_TIMEOUT_MS', 3000),
  healthTimeoutMs: readInt('HEALTH_TIMEOUT_MS', 1000),
  maxRetries: readInt('MAX_RETRIES', 1, { min: 0 }),
  retryBaseDelayMs: readInt('RETRY_BASE_DELAY_MS', 100),
};

module.exports = config;