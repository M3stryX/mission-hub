# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Production stage
FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
RUN corepack enable pnpm && pnpm install --prod --frozen-lockfile
EXPOSE 3000

# Container health probe: GET /health over loopback, on the port the app listens on.
# Uses the Node runtime already present (global fetch) — no added runtime dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'const port = process.env.PORT || 3000; fetch(`http://127.0.0.1:${port}/health`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));'

CMD ["node", "dist/index.js"]
