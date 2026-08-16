FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS dependencies
WORKDIR /app
RUN npm install --global npm@11.6.2
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
WORKDIR /app
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    COOKIE_SECURE=true \
    MIGRATIONS_PATH=/app/migrations
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system trevra \
    && useradd --system --gid trevra --home-dir /app --shell /usr/sbin/nologin trevra \
    && chown -R trevra:trevra /app
COPY --from=build --chown=trevra:trevra /app/package.json ./package.json
COPY --from=build --chown=trevra:trevra /app/node_modules ./node_modules
COPY --from=build --chown=trevra:trevra /app/dist ./dist
COPY --from=build --chown=trevra:trevra /app/dist-server ./dist-server
COPY --from=build --chown=trevra:trevra /app/migrations ./migrations
USER trevra
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1
CMD ["node", "dist-server/server/index.js"]
