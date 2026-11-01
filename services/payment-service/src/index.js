'use strict';

const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const client = require('prom-client');

const SERVICE_NAME = 'payment-service';
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
  logger.info('payment-service is ready to accept traffic');
}, 2000);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(express.json());
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

// Simulated payment processing: validates the amount and "charges" it with
// a fixed artificial delay, standing in for a call to a real payment
// processor. This is the span order-service's trace waterfall will show as
// the final leg of a checkout.
app.post('/payments', (req, res) => {
  const { orderId, amount } = req.body || {};

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'invalid_amount' });
  }

  setTimeout(() => {
    const paymentId = crypto.randomUUID();
    logger.info({ orderId, amount, paymentId }, 'payment approved');
    res.status(201).json({
      paymentId,
      orderId: orderId || null,
      amount,
      status: 'approved',
    });
  }, 150);
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'payment-service listening');
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
