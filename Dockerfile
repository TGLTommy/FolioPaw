# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim
ARG OLLAMA_IMAGE=ollama/ollama:0.32.15

FROM ${NODE_IMAGE} AS dependencies
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm config set registry "${NPM_REGISTRY}" \
    && npm ci

FROM dependencies AS builder
COPY backend backend
COPY frontend frontend
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS foliopaw
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/backend/node_modules ./backend/node_modules
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY package.json ./package.json
COPY backend/package.json ./backend/package.json
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
RUN mkdir -p /app/backend/data/backups /app/backend/uploads \
    && chown -R node:node /app/backend/data /app/backend/uploads
USER node
EXPOSE 17891
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:17891/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "backend/dist/index.js"]

FROM ${OLLAMA_IMAGE} AS ollama-source

FROM ${NODE_IMAGE} AS model-bootstrap
ENV NODE_ENV=production \
    HOME=/tmp/bootstrap-home \
    NODE_USE_ENV_PROXY=1
WORKDIR /app
COPY --from=builder /app/backend/dist/bootstrap ./backend/dist/bootstrap
COPY --from=ollama-source /bin/ollama /usr/local/bin/ollama
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
RUN mkdir -p /cache /models /tmp/bootstrap-home \
    && chown -R node:node /cache /models /tmp/bootstrap-home
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "backend/dist/bootstrap/index.js"]
