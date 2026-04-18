# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# Install pnpm via corepack (matches the packageManager field in package.json)
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Copy lockfile and manifest first for better layer caching
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies needed for the build)
RUN pnpm install --frozen-lockfile

# Copy the rest of the source
COPY . .

# Build the app — increase heap to handle the large dependency tree
RUN NODE_OPTIONS='--max-old-space-size=2048' pnpm run build

# ── Stage 2: serve ────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

# Install `serve` globally — lightweight static file server
RUN npm install -g serve@14

WORKDIR /app

# Copy only the compiled output from the build stage
COPY --from=builder /app/dist ./dist

EXPOSE 8080

# Serve the dist folder on port 8080 with SPA fallback (-s)
CMD ["serve", "-s", "dist", "-l", "8080"]
