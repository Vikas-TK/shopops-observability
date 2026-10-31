'use strict';

const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const client = require('prom-client');

const SERVICE_NAME = 'product-service';
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: SERVICE_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const httpLogger = pinoHttp({ logger });

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const registry = new client.Registry();
registry.setDefaultLabels({ service: SERVICE_NAME });
client.collectDefaultMetrics({ register: registry });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests received',
  labelNames: ['service', 'method', 'route', 'status'],
  registers: [registry],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['service', 'method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Resolves a low-cardinality route label. Falls back to "unmatched" instead
// of the raw path so unknown/garbage URLs never create new label series.
function resolveRouteLabel(req) {
  if (req.route && req.route.path) {
    return req.route.path;
  }
  return 'unmatched';
}

function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = {
      service: SERVICE_NAME,
      method: req.method,
      route: resolveRouteLabel(req),
      status: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });

  next();
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let isReady = false;

// Simulate a brief warm-up period before accepting traffic, mirroring a real
// service that needs to establish DB pools / cache connections on boot.
setTimeout(() => {
  isReady = true;
  logger.info('product-service is ready to accept traffic');
}, 2000);

const PRODUCTS = [
  { id: 1, name: 'Wireless Mouse', price: 24.99, stock: 150 },
  { id: 2, name: 'Mechanical Keyboard', price: 89.99, stock: 75 },
  { id: 3, name: '27" 4K Monitor', price: 349.0, stock: 32 },
  { id: 4, name: 'USB-C Dock', price: 59.5, stock: 120 },
  { id: 5, name: 'Noise Cancelling Headphones', price: 199.99, stock: 48 },
];

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(httpLogger);
app.use(metricsMiddleware);

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/readyz', (req, res) => {
  if (isReady) {
    return res.status(200).json({ status: 'ready' });
  }
  return res.status(503).json({ status: 'not_ready' });
});

app.get('/products', (req, res) => {
  res.status(200).json(PRODUCTS);
});

app.get('/products/:id', (req, res) => {
  const product = PRODUCTS.find((p) => p.id === Number(req.params.id));
  if (!product) {
    return res.status(404).json({ error: 'product_not_found' });
  }
  return res.status(200).json(product);
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'product-service listening');
});

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then exit. Needed because Kubernetes sends SIGTERM on pod
// termination and expects the process to drain before the grace period
// (terminationGracePeriodSeconds) elapses.
function shutdown(signal) {
  logger.info({ signal }, 'received shutdown signal, draining connections');
  isReady = false;

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'error during server close');
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });

  // Safety net in case connections never drain.
  setTimeout(() => {
    logger.warn('forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
