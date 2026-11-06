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

const config = {
  serviceName: 'notification-service',
  nodeEnv: process.env.NODE_ENV || 'development',
  port: readInt('PORT', 3005),
};

module.exports = config;