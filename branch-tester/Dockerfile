FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript
RUN pnpm build

# Branch Tester needs access to Docker socket for container management
# Mount /var/run/docker.sock when running
EXPOSE 9900

CMD ["node", "dist/index.js"]
