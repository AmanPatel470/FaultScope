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

function readUrl(name, fallback) {
  const raw = process.env[name] || fallback;
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`Environment variable ${name} must be a valid URL, got "${raw}"`);
  }
}

const config = {
  serviceName: 'api-gateway',
  nodeEnv: process.env.NODE_ENV || 'development',
  port: readInt('PORT', 3000),
  authUrl: readUrl('AUTH_URL', 'http://127.0.0.1:3001'),
  orderUrl: readUrl('ORDER_URL', 'http://127.0.0.1:3002'),
  paymentUrl: readUrl('PAYMENT_URL', 'http://127.0.0.1:3003'),
  inventoryUrl: readUrl('INVENTORY_URL', 'http://127.0.0.1:3004'),
  notificationUrl: readUrl('NOTIFICATION_URL', 'http://127.0.0.1:3005'),
  requestTimeoutMs: readInt('REQUEST_TIMEOUT_MS', 2000),
  // Must exceed the Order Service's worst-case (retries across several dependencies).
  orderTimeoutMs: readInt('ORDER_TIMEOUT_MS', 15000),
  healthTimeoutMs: readInt('HEALTH_TIMEOUT_MS', 1000),
};

module.exports = config;