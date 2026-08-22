# 1. Builder Stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# 2. Production Runner Stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

# Copy package files and production dependencies with non-root ownership
COPY package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy source code with non-root ownership
COPY --chown=node:node . .

USER node

EXPOSE 4000

# Run Node.js directly as PID 1 (best practice)
CMD ["node", "src/server.js"]
