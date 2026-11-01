'use strict';

const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const client = require('prom-client');
const axios = require('axios');

const SERVICE_NAME = 'order-service';
const PORT = process.env.PORT || 3000;

// Same-namespace Kubernetes Service DNS short names — order-service,
// product-service, and payment-service are all deployed by the same Helm
// release into the same namespace, so no FQDN is needed. axios is built on
// Node's http client, which OpenTelemetry's auto-instrumentation patches:
// every call below both gets its own child span AND has the traceparent
// header injected automatically, which is what stitches order -> product
// and order -> payment into a single end-to-end trace.
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:3000';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3000';

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
  logger.info('order-service is ready to accept traffic');
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

// Places an order: looks up the product (call #1 -> product-service), then
// charges for it (call #2 -> payment-service). This is the three-service
// chain the module's distributed-tracing goal targets — a single incoming
// request to order-service fans out into two downstream spans, all under
// one trace ID.
app.post('/orders', async (req, res) => {
  const { productId, quantity } = req.body || {};

  if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'invalid_order_request' });
  }

  let product;
  try {
    const productResponse = await axios.get(`${PRODUCT_SERVICE_URL}/products/${productId}`);
    product = productResponse.data;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({ error: 'product_not_found' });
    }
    req.log.error({ err }, 'product-service call failed');
    return res.status(502).json({ error: 'product_service_unavailable' });
  }

  const orderId = crypto.randomUUID();
  const amount = Number((product.price * quantity).toFixed(2));

  let payment;
  try {
    const paymentResponse = await axios.post(`${PAYMENT_SERVICE_URL}/payments`, {
      orderId,
      amount,
    });
    payment = paymentResponse.data;
  } catch (err) {
    req.log.error({ err }, 'payment-service call failed');
    return res.status(502).json({ error: 'payment_service_unavailable' });
  }

  if (payment.status !== 'approved') {
    return res.status(402).json({ error: 'payment_declined', payment });
  }

  req.log.info({ orderId, productId, quantity, amount }, 'order placed');

  return res.status(201).json({
    orderId,
    product,
    quantity,
    amount,
    payment,
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'order-service listening');
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
