# 1. Builder Stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy shared module and install its dependencies
COPY shared /app/shared
WORKDIR /app/shared
RUN npm install

# Copy the shared network manifests (lib/stellar.ts imports @greenpay/config)
WORKDIR /app
COPY config /app/config

# Copy frontend and install dependencies
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci

# Create a symlink to the shared module in node_modules
RUN mkdir -p node_modules/@greenpay && \
    ln -sf /app/shared node_modules/@greenpay/i18n && \
    ln -sf /app/config node_modules/@greenpay/config

# Copy the rest of the frontend
COPY frontend/. .

# Build the app
RUN mkdir -p public
RUN npm run build

# 2. Production Runner Stage
#
# Installs NO dependencies: everything the server needs comes from the
# builder's `.next/standalone` output (the app plus its traced runtime
# dependencies), so the runner image contains no package manager and no
# reinstall step. The Node server runs directly as PID 1, so `docker stop`
# sends SIGTERM straight to it and the shutdown completes within the grace
# period.
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Standalone server (server.js) and its traced dependencies
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Next.js copies project-root .env* files into the standalone output; strip
# them so no env file can ever reach a published layer (the root
# .dockerignore keeps them out of the build context in the first place, and
# CI asserts their absence in the final image).
RUN find /app -maxdepth 1 -name '.env*' -type f -delete
# Hashed static assets referenced by the standalone server
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# Public assets (icons, robots.txt, manifest, etc.)
COPY --from=builder --chown=node:node /app/public ./public

USER node

EXPOSE 3000

CMD ["node", "server.js"]
