# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:20-alpine
WORKDIR /app

# Run as non-root user — reduces blast radius if the app is compromised
RUN addgroup -S synapse && adduser -S synapse -G synapse

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Hand ownership to the non-root user before switching
RUN chown -R synapse:synapse /app
USER synapse

EXPOSE 3000
CMD ["node", "dist/server.js"]
