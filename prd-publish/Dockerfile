FROM node:20-alpine

LABEL maintainer="PRD-Publish"
LABEL description="Lightweight release management system"

# Install git for deployment operations
RUN apk add --no-cache git bash

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY public/ ./public/
COPY exec.sh ./

# Make exec script executable
RUN chmod +x exec.sh

# Create data directory for history
RUN mkdir -p /data

# Environment variables
ENV NODE_ENV=production
ENV PUBLISH_PORT=3939
ENV PUBLISH_HOST=0.0.0.0

EXPOSE 3939

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3939/api/health || exit 1

CMD ["node", "src/server.js"]
