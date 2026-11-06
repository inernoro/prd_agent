# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:0.8.15 AS uv
FROM python:3.12-slim AS builder
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --from=uv /uv /usr/local/bin/uv
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev libffi-dev && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    uv sync --frozen --no-dev

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 curl git openssh-client libpango-1.0-0 libpangoft2-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libglib2.0-0 shared-mime-info fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/.venv /app/.venv
COPY --chown=10001:10001 . .
RUN groupadd --gid 10001 deepaudit && useradd --uid 10001 --gid 10001 --no-create-home deepaudit \
    && mkdir -p /app/uploads/zip_files /app/data /app/.cache \
    && chown -R 10001:10001 /app/uploads /app/data /app/.cache \
    && chmod 755 /app/cds-entrypoint.sh
ENV HOME=/app/.cache PATH="/app/.venv/bin:${PATH}"
USER 10001:10001
EXPOSE 8000
CMD ["/app/cds-entrypoint.sh"]
