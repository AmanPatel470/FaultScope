
'use strict';

// Local-only load generator for FaultScope.
// Usage (repo root): npm run load -- --rps 5 --duration 60

const { parseArgs } = require('node:util');

const { values } = parseArgs({
  options: {
    gateway: { type: 'string', default: 'http://localhost:3000' },
    rps: { type: 'string', default: '5' },
    duration: { type: 'string', default: '60' },
    username: { type: 'string', default: 'alice' },
    password: { type: 'string', default: 'alice-pass' },
  },
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function positive(name, raw) {
  const n = Number(raw);

  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive number, got "${raw}"`);
    process.exit(1);
  }

  return n;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;

  const index = Math.min(
    sortedAsc.length - 1,
    Math.ceil((p / 100) * sortedAsc.length) - 1
  );

  return sortedAsc[index];
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function main() {
  const rps = positive('rps', values.rps);
  const durationS = positive('duration', values.duration);
  const base = new URL(values.gateway);

  // Safety rail: this tool only ever targets a local environment.
  if (!LOCAL_HOSTS.has(base.hostname)) {
    console.error(
      `Refusing to generate load against "${base.hostname}". Only localhost is allowed.`
    );
    process.exit(1);
  }

  const login = await fetch(`${base.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: values.username,
      password: values.password,
    }),
  }).catch((err) => {
    console.error(`Cannot reach the gateway at ${base.origin}: ${err.message}`);
    process.exit(1);
  });

  if (!login.ok) {
    console.error(`Login failed with HTTP ${login.status}`);
    process.exit(1);
  }

  const { token } = await login.json();

  if (!token) {
    console.error('Login response did not contain an authentication token.');
    process.exit(1);
  }

  const auth = { authorization: `Bearer ${token}` };

  const statusCounts = new Map();
  const latenciesMs = [];
  const failureSamples = [];

  let inFlight = 0;
  let sent = 0;
  let lastOrderId = null;

  // Only p-100 / p-200 (never the 4K monitor).
  const randomOrder = () => ({
    items: [
      {
        productId: pick(['p-100', 'p-200']),
        quantity: 1 + Math.floor(Math.random() * 2),
      },
    ],
  });

  async function fireOne() {
    const roll = Math.random();

    let url;
    let init;

    if (roll < 0.8) {
      url = `${base.origin}/api/orders`;

      init = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...auth,
        },
        body: JSON.stringify(randomOrder()),
      };
    } else if (roll < 0.9 && lastOrderId) {
      url = `${base.origin}/api/orders/${lastOrderId}`;
      init = { headers: auth };
    } else {
      url = `${base.origin}/health/services`;
      init = {};
    }

    inFlight += 1;
    sent += 1;

    const startedAt = performance.now();
    let key;

    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20000),
      });

      key = String(res.status);

      const responseText = await res.text();

      // Capture response bodies for rejected or failed requests.
      if (
        [422, 502, 503].includes(res.status) &&
        failureSamples.length < 10
      ) {
        failureSamples.push(
          `HTTP ${res.status}: ${responseText}`
        );
      }

      // Remember successful order IDs for subsequent GET requests.
      if (init.method === 'POST' && res.status === 201) {
        try {
          const responseBody = JSON.parse(responseText);

          if (responseBody.orderId) {
            lastOrderId = responseBody.orderId;
          }
        } catch {
          // Ignore invalid JSON; this ID is only used for request variation.
        }
      }
    } catch (err) {
      key =
        err.name === 'TimeoutError'
          ? 'client-timeout'
          : 'network-error';

      if (failureSamples.length < 10) {
        failureSamples.push(`${key}: ${err.message}`);
      }
    } finally {
      latenciesMs.push(performance.now() - startedAt);
      statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
      inFlight -= 1;
    }
  }

  console.log(
    `Load test: ~${rps} req/s for ${durationS}s against ${base.origin}`
  );

  const startedAt = Date.now();

  const timer = setInterval(fireOne, 1000 / rps);

  const progress = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    console.log(
      `  t=${elapsed}s sent=${sent} in-flight=${inFlight}`
    );
  }, 5000);

  await sleep(durationS * 1000);

  clearInterval(timer);
  clearInterval(progress);

  // Wait for outstanding requests to complete.
  const settleDeadline = Date.now() + 20000;

  while (inFlight > 0 && Date.now() < settleDeadline) {
    await sleep(100);
  }

  const elapsedS = (Date.now() - startedAt) / 1000;

  const sorted = [...latenciesMs].sort((a, b) => a - b);

  const avg =
    sorted.reduce((sum, value) => sum + value, 0) /
    (sorted.length || 1);

  console.log(
    '\n--- Summary (latency is measured by this client, in ms) ---'
  );

  console.log(
    `requests sent : ${sent} (${(sent / elapsedS).toFixed(1)} req/s achieved)`
  );

  console.log(
    `responses received : ${latenciesMs.length}`
  );

  console.log(
    `status counts : ${JSON.stringify(
      Object.fromEntries([...statusCounts].sort())
    )}`
  );

  if (failureSamples.length > 0) {
    console.log('\n--- Sample failure responses ---');

    failureSamples.forEach((sample, index) => {
      console.log(`${index + 1}. ${sample}`);
    });
  }

  console.log(
    `latency ms    : avg=${avg.toFixed(1)} ` +
    `p50=${percentile(sorted, 50).toFixed(1)} ` +
    `p95=${percentile(sorted, 95).toFixed(1)} ` +
    `p99=${percentile(sorted, 99).toFixed(1)}`
  );

  if (inFlight > 0) {
    console.log(
      `WARNING: ${inFlight} request(s) were still in flight at the 20-second settlement deadline.`
    );
  }
}

main().catch((err) => {
  console.error('Load generator failed:', err);
  process.exitCode = 1;
});
