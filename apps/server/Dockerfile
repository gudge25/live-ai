# syntax=docker/dockerfile:1

# ---- build: install workspace deps for the server only and bundle it ----
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @live-ai/server...
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @live-ai/server build

# ---- runtime: a single bundled file, no node_modules ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
USER node
EXPOSE 8765 9092
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${UI_PORT:-8765}/healthz" >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
