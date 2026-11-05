'use strict';

// Set env BEFORE loading the app, because config reads it at require time.
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'test-secret-for-automated-tests';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function postJson(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function loginAsAlice() {
  const res = await postJson('/auth/login', { username: 'alice', password: 'alice-pass' });
  return (await res.json()).token;
}

test('GET /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.service, 'auth-service');
  assert.equal(body.status, 'ok');
  assert.ok(res.headers.get('x-request-id'));
});

test('POST /auth/login succeeds with valid credentials', async () => {
  const res = await postJson('/auth/login', { username: 'alice', password: 'alice-pass' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.tokenType, 'Bearer');
  assert.ok(body.token.split('.').length === 3, 'token should be a JWT');
});

test('POST /auth/login rejects a wrong password with 401', async () => {
  const res = await postJson('/auth/login', { username: 'alice', password: 'wrong' });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'INVALID_CREDENTIALS');
});

test('POST /auth/login rejects a missing password with 400', async () => {
  const res = await postJson('/auth/login', { username: 'alice' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('POST /auth/login rejects malformed JSON with 400', async () => {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'INVALID_JSON');
});

test('GET /auth/verify accepts a valid token', async () => {
  const token = await loginAsAlice();
  const res = await fetch(`${baseUrl}/auth/verify`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.user.username, 'alice');
});

test('GET /auth/verify rejects a missing token', async () => {
  const res = await fetch(`${baseUrl}/auth/verify`);
  assert.equal(res.status, 401);
});

test('GET /auth/verify rejects a tampered token', async () => {
  const token = await loginAsAlice();
  const res = await fetch(`${baseUrl}/auth/verify`, {
    headers: { authorization: `Bearer ${token}x` },
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'INVALID_TOKEN');
});

test('unknown routes return a JSON 404', async () => {
  const res = await fetch(`${baseUrl}/nope`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});