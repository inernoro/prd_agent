# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@9.15.9 --registry=https://registry.npmjs.org
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
ENV VITE_API_BASE_URL=/api/v1 VITE_CDS_STATIC_REVIEW=true
RUN pnpm exec vitest run src/shared/config/__tests__/cdsStaticReview.test.tsx --maxWorkers=1 --minWorkers=1 \
    && pnpm type-check && pnpm build
FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.cds.conf.template /etc/nginx/templates/default.conf.template
COPY cds-auth.sh /docker-entrypoint.d/15-cds-auth.sh
RUN chmod 755 /docker-entrypoint.d/15-cds-auth.sh
EXPOSE 80
