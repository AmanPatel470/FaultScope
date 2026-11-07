'use strict';

const http = require('node:http');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a fake HTTP service on a random port.
 * handler(call, reply, callNumber) where call = { method, path, body, headers }
 * and reply(status, jsonBody) sends the response.
 * Every request is recorded in `calls`.
 */
async function startStub(handler) {
  const calls = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const call = { method: req.method, path: req.url, body, headers: req.headers };
      calls.push(call);

      const reply = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      try {
        await handler(call, reply, calls.length);
      } catch (err) {
        reply(500, { error: { code: 'STUB_ERROR', message: err.message } });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

// A URL that nothing is listening on, to simulate a crashed service (connection refused).
async function closedUrl() {
  const stub = await startStub((call, reply) => reply(200, {}));
  const { url } = stub;
  await stub.close();
  return url;
}

// Starts an Express app on a random port.
async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

module.exports = { startStub, closedUrl, listen, sleep };