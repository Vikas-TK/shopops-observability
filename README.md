# ShopOps — Observability-Driven Kubernetes Microservices Platform

A production-style e-commerce backend (`product-service`, `order-service`, `payment-service`) built as an end-to-end demonstration of SRE and DevOps practice on Kubernetes: instrumented services, a full observability stack, alerting, chaos-tested resilience, and a security-hardened CI/CD pipeline.

## Architecture Overview

- **Services**: Node.js/Express microservices, each emitting Prometheus metrics (`/metrics`), structured JSON logs (Pino), and distributed traces (OpenTelemetry → OTLP/gRPC). `product-service` is implemented in this repo (`services/product-service`); `order-service` and `payment-service` follow the same pattern and image contract.
- **Packaging & deployment**: a single Helm chart (`infrastructure/helm/shopops`) drives every service from one `templates/deployment.yaml`, templated over the `services` map in `values.yaml` — adding a service means adding a map entry, not a new template. Each entry renders one `Deployment` + one `ClusterIP Service`, annotated for Prometheus scraping (`prometheus.io/scrape`, `prometheus.io/port`, `prometheus.io/path`).
- **Cluster**: validated end-to-end on a local `kind` cluster (`shopops`), with the same manifests intended for any standard Kubernetes cluster.
- **Security posture**: every pod runs as a dedicated non-root user (`runAsUser: 10001`), with all Linux capabilities dropped, privilege escalation disabled, and a read-only root filesystem (writable scratch space provided via an `emptyDir` mounted at `/tmp`). Container images are built with a matching unprivileged `appuser`/`appgroup` (uid/gid 10001) rather than relying on the base image's default user. See [Security Hardening](#security-hardening) below.

## Observability Stack

Everything lives under `infrastructure/monitoring`, deployed into a dedicated `monitoring` namespace:

| Signal | Stack | Notes |
|---|---|---|
| Metrics | **Prometheus** (`infrastructure/monitoring/prometheus`) | Kubernetes service discovery (`role: pod`) auto-discovers any pod in `default` annotated `prometheus.io/scrape: "true"` — new services are picked up with zero config changes. |
| Dashboards | **Grafana** (`infrastructure/monitoring/grafana`) | Provisioned on boot (datasources + dashboards as ConfigMaps, no manual UI setup). Ships the **ShopOps RED Metrics** dashboard: Service Up, Request Rate, 5xx Error Rate, and p95 Request Duration per service. |
| Logs | **Loki** + **Fluent Bit** (`infrastructure/monitoring/loki`, `infrastructure/monitoring/fluent-bit`) | Fluent Bit runs as a DaemonSet, shipping container logs from every node into Loki. |
| Traces | **Tempo** (`infrastructure/monitoring/tempo`) | Services export OTLP traces directly via `OTEL_EXPORTER_OTLP_ENDPOINT`. |

**Correlated signals, not siloed ones** — the Grafana datasource provisioning wires logs and traces together both directions:
- *Logs → traces*: Loki's `derivedFields` regex-matches the `trace_id` that OpenTelemetry's auto-instrumentation injects into every Pino log line, turning it into a one-click jump to that trace's waterfall in Tempo.
- *Traces → logs*: Tempo's `tracesToLogsV2` does the reverse — from any span, jump to the matching Loki logs, filtered by the `app` label mapped from the span's `service.name`.

Example RED-method PromQL used by the dashboard:
```promql
# Request rate
sum by (job) (rate(http_requests_total[1m]))

# Error rate (%)
100 * sum by (job) (rate(http_requests_total{status=~"5.."}[1m]))
    / sum by (job) (rate(http_requests_total[1m]))

# p95 latency
histogram_quantile(0.95, sum by (le, job) (rate(http_request_duration_seconds_bucket[1m])))
```

## SRE & Operations

### Alerting
A Prometheus alerting rule, `ShopOpsHighLatency`, fires on sustained p95 latency regression (`histogram_quantile(0.95, ...)` over the request-duration histogram, per `job`). It was validated live during chaos testing (below) via the Prometheus rules/query API — confirmed `inactive` at baseline and monitored through two independent fault injections.

### Chaos Engineering
Resilience was validated with real fault injection against the running cluster, not simulated:

1. **CPU exhaustion** — busy-loop processes driven inside `product-service`, confirmed via `/sys/fs/cgroup/cpu.stat` CFS throttling counters (throttled time rose by ~493s over the test window). Service recovered cleanly once the load was removed, with no alert breach.
2. **Network latency injection** — an ephemeral `nicolaka/netshoot` debug container (`kubectl debug --custom`, granted `NET_ADMIN`) attached to `order-service`'s network namespace, injecting delay via `tc qdisc add ... netem delay 300ms 50ms`. Client-perceived latency (measured from a real in-cluster caller) rose to 500ms+, while the service's own histogram-based p95 stayed near baseline — a deliberate finding, not a bug: server-side instrumentation times the response hand-off to the OS socket, *before* `tc netem` delays the packet at the NIC/qdisc layer. This is a documented blind spot of purely server-side latency metrics and the reason client-side/synthetic probes matter alongside them.

Both scenarios were rolled back cleanly and recovery was confirmed against live metrics before being signed off.

### Security Hardening
Defined once in `infrastructure/helm/shopops/values.yaml` and applied uniformly to every service by the shared deployment template:

```yaml
securityContext:
  pod:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile:
      type: RuntimeDefault
  container:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop: ["ALL"]
```

Paired with a writable `emptyDir` at `/tmp` (required once the root filesystem is read-only) and a matching unprivileged `appuser`/`appgroup` (uid/gid 10001) baked into each service's Dockerfile, so file ownership lines up with the pod's `runAsUser` instead of relying on world-readable permissions.

### CI/CD Pipeline
`.github/workflows/ci.yaml` — three stages, `test-and-lint` → `build-scan-push`:

1. **Lint & Test** — per service (matrix over `product-service`, `order-service`, `payment-service`), skipping any service not yet implemented.
2. **Build, Scan & Push** — builds the image *locally only* (`push: false, load: true`); runs **Trivy** against that local image in two passes:
   - an informational scan (`CRITICAL,HIGH`, non-blocking) for visibility into the full vulnerability surface;
   - a gating scan (`CRITICAL` only, `exit-code: 1`) that **fails the job** on any critical CVE.
   Only if both scans pass does the final step `docker push` the image to `ghcr.io/<repo>/<service>`. A critical vulnerability never reaches the registry.

## Repository Layout

```
infrastructure/
  helm/shopops/           # Single chart, templated over values.yaml's services map
  monitoring/             # Prometheus, Grafana, Loki, Fluent Bit, Tempo manifests
services/
  product-service/        # Express app, OTel tracing, Dockerfile (non-root, uid 10001)
.github/workflows/ci.yaml # Lint/test → build → scan → push
```
