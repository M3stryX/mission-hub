# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile
COPY . .
# Stamp the revision while `.git` is still present in the build context: Dokploy
# passes no build argument, so without this the image cannot say what it is.
RUN node scripts/build-commit.cjs
RUN pnpm build

# Production stage
FROM node:22-alpine AS runner
WORKDIR /app
# Build identity: the commit this image was built from. `--build-arg
# MISSION_HUB_COMMIT=<sha>` wins when CI passes it; otherwise the `commit.txt`
# stamped by `scripts/build-commit.cjs` from the checkout answers, so a Dokploy
# build that passes nothing still reports a real revision. Only a build with
# neither source reports `unknown` — never an invented one.
ARG MISSION_HUB_COMMIT=
ENV MISSION_HUB_COMMIT=${MISSION_HUB_COMMIT}
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/commit.txt ./commit.txt
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
RUN corepack enable pnpm && pnpm install --prod --frozen-lockfile
EXPOSE 3000

# Container health probe: GET /health over loopback, on the port the app listens on.
# Uses the Node runtime already present (global fetch) — no added runtime dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'const port = process.env.PORT || 3000; fetch(`http://127.0.0.1:${port}/health`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));'

CMD ["node", "dist/index.js"]
