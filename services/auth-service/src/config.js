'use strict';

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV || 'development';

// Never fall back to a default secret in production.
if (nodeEnv === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}

const config = {
  serviceName: 'auth-service',
  nodeEnv,
  port: readInt('PORT', 3001),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-not-for-production',
  tokenTtlSeconds: readInt('TOKEN_TTL_SECONDS', 3600),
};

module.exports = config;