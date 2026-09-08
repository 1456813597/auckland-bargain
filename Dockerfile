# syntax=docker/dockerfile:1
ARG NODE_VERSION=22.20.0

# Dependencies are installed once and reused by the build, so a code-only change
# reuses this layer.
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PRODUCT_IMAGE_DIR=/data/product-images
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/public ./public
# `output: 'standalone'` writes a server plus only the traced dependencies.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Migrations ship with the image so the same tag can migrate the database it is
# about to serve, with no repository checkout on the server.
COPY --from=builder /app/supabase/migrations ./supabase/migrations
COPY --from=builder /app/scripts/migrate.mjs ./scripts/migrate.mjs

RUN mkdir -p /data/product-images && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health/live || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
