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
  serviceName: 'order-service',
  nodeEnv: process.env.NODE_ENV || 'development',
  port: readInt('PORT', 3002),
  inventoryUrl: readUrl('INVENTORY_URL', 'http://127.0.0.1:3004'),
  paymentUrl: readUrl('PAYMENT_URL', 'http://127.0.0.1:3003'),
  notificationUrl: readUrl('NOTIFICATION_URL', 'http://127.0.0.1:3005'),
  requestTimeoutMs: readInt('REQUEST_TIMEOUT_MS', 1500),
  notificationTimeoutMs: readInt('NOTIFICATION_TIMEOUT_MS', 1000),
  maxRetries: readInt('MAX_RETRIES', 2, { min: 0 }),
  retryBaseDelayMs: readInt('RETRY_BASE_DELAY_MS', 100),
};

module.exports = config;