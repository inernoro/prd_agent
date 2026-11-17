# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS artifacts
WORKDIR /runtime
COPY artifacts.json download.mjs ./
RUN node download.mjs

FROM node:22-bookworm-slim
ARG SOURCE_REVISION=unknown
ARG SOURCE_URL=https://github.com/inernoro/prd_agent
LABEL org.opencontainers.image.revision=$SOURCE_REVISION org.opencontainers.image.source=$SOURCE_URL
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless bash gosu ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=artifacts /artifacts /artifacts
RUN mkdir -p /opt/seatunnel /opt/redis-shake /data \
 && tar -xzf /artifacts/seatunnel.tar.gz -C /opt/seatunnel --strip-components=1 \
 && tar -xzf /artifacts/redis-shake.tar.gz -C /opt/redis-shake --strip-components=1 \
 && cp /artifacts/connector-*.jar /opt/seatunnel/connectors/ \
 && cp /artifacts/postgresql-*.jar /artifacts/mysql-connector-j-*.jar /opt/seatunnel/lib/ \
 && rm -rf /artifacts \
 && chown -R node:node /opt/seatunnel /opt/redis-shake /data
WORKDIR /runtime
COPY *.mjs artifacts.json entrypoint.sh RedisShake.LICENSE ./
RUN cp /runtime/RedisShake.LICENSE /opt/redis-shake/LICENSE && chmod 755 /runtime/entrypoint.sh
ENV DTS_RUNTIME_HOST=0.0.0.0 DTS_RUNTIME_PORT=18085 DTS_RUNTIME_DATA=/data/jobs DTS_REDIS_SHAKE_BINARY=/opt/redis-shake/redis-shake
EXPOSE 18085
HEALTHCHECK --interval=15s --timeout=8s --start-period=90s --retries=3 CMD node -e "fetch('http://127.0.0.1:18085/overview',{headers:{authorization:'Basic '+Buffer.from(process.env.DTS_ENGINE_USER+':'+process.env.DTS_ENGINE_PASSWORD).toString('base64')}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/runtime/entrypoint.sh"]
