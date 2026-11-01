'use strict';

// Loaded via `node --require ./src/tracing.js` (see package.json's `start`
// script and the Dockerfile CMD) rather than a top-of-file require() in
// index.js. OpenTelemetry's auto-instrumentation patches modules (express,
// http) at require() time, so it must run before index.js requires them —
// --require guarantees that ordering; a plain require('./tracing') inside
// index.js would race its own requires at the top of the same file.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'payment-service';
const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://tempo.monitoring.svc.cluster.local:4317';

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
  }),
  traceExporter: new OTLPTraceExporter({
    url: OTLP_ENDPOINT,
  }),
  // Bundles express + http instrumentation (traceparent propagation on
  // every inbound/outbound request) plus pino instrumentation, which
  // injects trace_id/span_id into every Pino log line — that's what
  // the Loki derivedFields regex in configmap-datasource.yaml matches on
  // to jump from a log line straight to its trace.
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    sdk
      .shutdown()
      .catch((err) => console.error('Error shutting down OpenTelemetry SDK', err));
  });
}
