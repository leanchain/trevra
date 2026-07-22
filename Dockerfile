FROM node:24-alpine AS dependencies
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
    && npm install --global npm@11.6.2
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
WORKDIR /app
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/app/data/trevra.db \
    COOKIE_SECURE=true
RUN apk add --no-cache libstdc++ wget \
    && addgroup -S trevra \
    && adduser -S -G trevra -h /app trevra \
    && mkdir -p /app/data \
    && chown -R trevra:trevra /app
COPY --from=build --chown=trevra:trevra /app/package.json ./package.json
COPY --from=build --chown=trevra:trevra /app/node_modules ./node_modules
COPY --from=build --chown=trevra:trevra /app/dist ./dist
COPY --from=build --chown=trevra:trevra /app/dist-server ./dist-server
USER trevra
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "dist-server/server/index.js"]
