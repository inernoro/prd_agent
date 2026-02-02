# prd-executor Dockerfile
FROM node:20-alpine

# Install common build tools for scripts
RUN apk add --no-cache git bash curl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY src/ ./src/

# Create logs directory
RUN mkdir -p /app/logs

# Non-root user for security
RUN addgroup -g 1001 -S executor && \
    adduser -u 1001 -S executor -G executor && \
    chown -R executor:executor /app

USER executor

# Default port
EXPOSE 3940

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3940/health || exit 1

CMD ["node", "src/index.js"]
