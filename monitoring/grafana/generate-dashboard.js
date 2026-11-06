'use strict';

// Generates the Grafana dashboard JSON ("dashboards as code").
// Usage (repo root):  npm run dashboard:build

const fs = require('node:fs');
const path = require('node:path');

const DS = { type: 'prometheus', uid: 'prometheus' };

const COUNT = 'http_server_request_duration_seconds_count';
const BUCKET = 'http_server_request_duration_seconds_bucket';
const CLIENT_COUNT = 'http_client_request_duration_seconds_count';
const CLIENT_BUCKET = 'http_client_request_duration_seconds_bucket';

const API = 'http_route!~"/health.*"'; // health probes would drown out real traffic
const GW = 'job="api-gateway"';
const FIVE_XX = 'http_response_status_code=~"5.."';

let nextId = 1;

const toTargets = (queries) =>
  queries.map(([expr, legend], i) => ({
    datasource: DS,
    expr,
    legendFormat: legend,
    refId: String.fromCharCode(65 + i),
  }));

function timeseries({ title, queries, unit, x, y, w = 12, description }) {
  return {
    id: nextId++,
    type: 'timeseries',
    title,
    description,
    datasource: DS,
    gridPos: { x, y, w, h: 8 },
    fieldConfig: {
      defaults: { unit, custom: { lineWidth: 2, fillOpacity: 10, spanNulls: false } },
      overrides: [],
    },
    options: {
      legend: { displayMode: 'table', placement: 'bottom', calcs: ['mean', 'max'] },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
    targets: toTargets(queries),
  };
}

function stat({ title, expr, unit, x, steps, decimals }) {
  return {
    id: nextId++,
    type: 'stat',
    title,
    datasource: DS,
    gridPos: { x, y: 0, w: 4, h: 4 },
    fieldConfig: {
      defaults: { unit, decimals, thresholds: { mode: 'absolute', steps } },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      colorMode: 'background',
      graphMode: 'none',
      textMode: 'auto',
    },
    targets: toTargets([[expr, '']]),
  };
}

const green = { color: 'green', value: null };

const panels = [
  // ---- headline stats -------------------------------------------------------
  stat({
    title: 'Services up (of 6)',
    expr: 'sum(up{job!="prometheus"})',
    unit: 'none',
    decimals: 0,
    x: 0,
    steps: [{ color: 'red', value: null }, { color: 'green', value: 6 }],
  }),
  stat({
    title: 'Gateway req/s',
    expr: `sum(rate(${COUNT}{${GW},${API}}[1m]))`,
    unit: 'reqps',
    x: 4,
    steps: [{ color: 'blue', value: null }],
  }),
  stat({
    title: 'Gateway 5xx ratio',
    expr: `(sum(rate(${COUNT}{${GW},${API},${FIVE_XX}}[1m])) / sum(rate(${COUNT}{${GW},${API}}[1m]))) or vector(0)`,
    unit: 'percentunit',
    x: 8,
    steps: [green, { color: 'orange', value: 0.01 }, { color: 'red', value: 0.05 }],
  }),
  stat({
    title: 'Gateway latency p95',
    expr: `histogram_quantile(0.95, sum by (le) (rate(${BUCKET}{${GW},${API}}[1m])))`,
    unit: 's',
    x: 12,
    steps: [green, { color: 'orange', value: 0.5 }, { color: 'red', value: 1 }],
  }),
  stat({
    title: 'Timeouts (5m)',
    expr: `sum(increase(${CLIENT_COUNT}{outcome="timeout"}[5m])) or vector(0)`,
    unit: 'none',
    decimals: 0,
    x: 16,
    steps: [green, { color: 'red', value: 1 }],
  }),
  stat({
    title: 'Retries (5m)',
    expr: 'sum(increase(faultscope_client_retries_total[5m])) or vector(0)',
    unit: 'none',
    decimals: 0,
    x: 20,
    steps: [green, { color: 'orange', value: 1 }, { color: 'red', value: 10 }],
  }),

  // ---- inbound traffic ------------------------------------------------------
  timeseries({
    title: 'Request rate by service',
    queries: [[`sum by (job) (rate(${COUNT}{${API}}[1m]))`, '{{job}}']],
    unit: 'reqps', x: 0, y: 4,
  }),
  timeseries({
    title: 'Error ratio (5xx) by service',
    queries: [[
      `sum by (job) (rate(${COUNT}{${API},${FIVE_XX}}[1m])) / sum by (job) (rate(${COUNT}{${API}}[1m]))`,
      '{{job}}',
    ]],
    unit: 'percentunit', x: 12, y: 4,
    description: '5xx responses / all responses. Gaps mean no traffic in the window.',
  }),
  timeseries({
    title: 'Latency p95 by service',
    queries: [[`histogram_quantile(0.95, sum by (job, le) (rate(${BUCKET}{${API}}[1m])))`, '{{job}}']],
    unit: 's', x: 0, y: 12,
    description: 'Estimated from histogram buckets, so precision is limited by bucket boundaries.',
  }),
  timeseries({
    title: 'Latency p99 by service',
    queries: [[`histogram_quantile(0.99, sum by (job, le) (rate(${BUCKET}{${API}}[1m])))`, '{{job}}']],
    unit: 's', x: 12, y: 12,
  }),
  timeseries({
    title: 'Responses by status code',
    queries: [[
      `sum by (job, http_response_status_code) (rate(${COUNT}{${API}}[1m]))`,
      '{{job}} {{http_response_status_code}}',
    ]],
    unit: 'reqps', x: 0, y: 20,
  }),
  timeseries({
    title: 'In-flight requests',
    queries: [['sum by (job) (http_server_active_requests)', '{{job}}']],
    unit: 'none', x: 12, y: 20,
    description: 'A rising value with flat throughput means requests are piling up behind a slow dependency.',
  }),

  // ---- dependencies (client side) ------------------------------------------
  timeseries({
    title: 'Outbound calls by outcome',
    queries: [[
      `sum by (job, peer_service, outcome) (rate(${CLIENT_COUNT}[1m]))`,
      '{{job}} -> {{peer_service}} ({{outcome}})',
    ]],
    unit: 'reqps', x: 0, y: 28,
    description: 'Every attempt, including retries. outcome = success | http_4xx | http_5xx | timeout | network.',
  }),
  timeseries({
    title: 'Outbound latency p95 by dependency',
    queries: [[
      `histogram_quantile(0.95, sum by (job, peer_service, le) (rate(${CLIENT_BUCKET}[1m])))`,
      '{{job}} -> {{peer_service}}',
    ]],
    unit: 's', x: 12, y: 28,
  }),
  timeseries({
    title: 'Timeouts and retries per second',
    queries: [
      [`sum by (job, peer_service) (rate(${CLIENT_COUNT}{outcome="timeout"}[1m]))`, 'timeouts {{job}} -> {{peer_service}}'],
      ['sum by (job, peer_service) (rate(faultscope_client_retries_total[1m]))', 'retries {{job}} -> {{peer_service}}'],
    ],
    unit: 'ops', x: 0, y: 36,
  }),
  timeseries({
    title: 'Event loop lag p99',
    queries: [['nodejs_eventloop_delay_p99_seconds', '{{job}}']],
    unit: 's', x: 12, y: 36,
    description: 'Approximate. Rises when a service is CPU-bound or blocked.',
  }),

  // ---- resources -----------------------------------------------------------
  timeseries({
    title: 'CPU (100% = one full core)',
    queries: [['sum by (job) (rate(process_cpu_time_seconds_total[1m]))', '{{job}}']],
    unit: 'percentunit', x: 0, y: 44,
  }),
  timeseries({
    title: 'Memory (RSS)',
    queries: [['process_memory_usage_bytes{memory_type="rss"}', '{{job}}']],
    unit: 'bytes', x: 12, y: 44,
  }),
  timeseries({
    title: 'Process uptime',
    queries: [['process_uptime_seconds', '{{job}}']],
    unit: 's', x: 0, y: 52,
    description: 'A drop back to zero is a restart.',
  }),
];

const dashboard = {
  uid: 'faultscope-overview',
  title: 'FaultScope - Service Overview',
  tags: ['faultscope'],
  timezone: 'browser',
  editable: true,
  graphTooltip: 1,
  schemaVersion: 39,
  version: 1,
  refresh: '5s',
  time: { from: 'now-15m', to: 'now' },
  panels,
};

const outFile = path.join(__dirname, 'dashboards', 'faultscope-overview.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(dashboard, null, 2)}\n`);
console.log(`Wrote ${outFile} (${panels.length} panels)`);