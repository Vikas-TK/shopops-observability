# =============================================================================
# Builder stage: full dependency install (incl. devDeps) for linting/testing
# and to produce a reliable npm-ci cache layer for the runner stage.
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY src ./src

# =============================================================================
# Runner stage: minimal production image.
# - Fresh `npm ci --only=production` keeps devDependencies out of the final
#   image instead of copying node_modules across stages.
# - Runs as uid/gid 10001, a dedicated unprivileged user matching the
#   Helm chart's pod securityContext (runAsUser: 10001), rather than root
#   or the image's built-in `node` user (uid 1000).
# - dumb-init is PID 1 so SIGTERM/SIGINT are forwarded to the Node process
#   (and any zombie children reaped) instead of being swallowed by a shell,
#   giving the app a real chance to drain connections before exiting.
# =============================================================================
FROM node:20-alpine AS runner

RUN apk add --no-cache dumb-init \
    && addgroup -g 10001 appgroup \
    && adduser -D -u 10001 -G appgroup appuser

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production && npm cache clean --force

COPY --chown=appuser:appgroup --from=builder /app/src ./src

USER 10001:10001

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
