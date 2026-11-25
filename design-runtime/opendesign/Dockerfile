# MAP 设计执行服务（OpenDesign 引擎）镜像。
#
# 一个容器里跑两个进程：
#   - 本服务（Node，/opt/map-design-runtime），以 root 运行，实现 map-design-executor-v1 协议，
#     负责拉起 / 停止 / 重启引擎、铺工作区、质量闸门、结果打包、模型出口转发口；
#   - OpenDesign daemon（镜像自带的 apps/daemon/dist/cli.js），由本服务以 open-design 用户拉起，
#     Codex 由 daemon 以 agentId 'codex' 拉起，同样以 open-design 用户运行。
# 两个 uid 分开是隔离边界的一部分：引擎（及它执行的模型命令）读不到本服务进程的环境变量与内存里的票据。
# 进程管理：tini 作为 PID 1 收养孤儿进程；daemon 由本服务监管，意外退出会在 /v1/capabilities 如实报告
# 并自动清空工作目录后重新拉起（见 src/engine/lifecycle.ts、src/tasks.ts）。
#
# 构建上下文：design-runtime/opendesign（见 .github/workflows/branch-image.yml 的 design-opendesign-image）。

FROM ghcr.io/nexu-io/od:0.21.1 AS build
USER root
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM ghcr.io/nexu-io/od:0.21.1

LABEL org.opencontainers.image.source="https://github.com/inernoro/prd_agent" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="MAP design runtime service (map-design-executor-v1) on OpenDesign 0.21.1 with Codex CLI 0.143.0"

USER root

ARG DESIGN_RUNTIME_CHROMIUM_VERSION=156.0.8078.79
ARG DESIGN_RUNTIME_CHROMIUM_RELEASE=0

ENV DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    DESIGN_RUNTIME_BROWSER_VERSION=${DESIGN_RUNTIME_CHROMIUM_VERSION}

WORKDIR /opt/map-design-runtime
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile \
    && apk add --no-cache chromium="${DESIGN_RUNTIME_CHROMIUM_VERSION}-r${DESIGN_RUNTIME_CHROMIUM_RELEASE}" \
    && test -x "$DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH"

# 与 cds/open-design-runtime/Dockerfile 同一个钉住版本，并在构建时核对。
RUN npm install --global --ignore-scripts=false @openai/codex@0.143.0 \
    && test "$(codex --version)" = "codex-cli 0.143.0" \
    && npm cache clean --force

# CDS code-film validation: install the original skill, pinned by revision and byte digest.
# Keep it outside the task sandbox and register it only when a film run is requested.
# FFmpeg and Git already ship in the underlying OpenDesign image.
RUN apk add --no-cache curl python3 py3-pip libsndfile \
    && mkdir -p /opt/map-design-runtime/lemo-opuscar/scripts \
    && cd /opt/map-design-runtime/lemo-opuscar \
    && upstream=https://raw.githubusercontent.com/lemomo-ai/lemo-opuscar/8ca0dd805e214bcc1d30714cd5b9d21cc02a454b/plugin/skills/lemo-opuscar \
    && curl --retry 3 --fail --silent --show-error "$upstream/SKILL.md" -o SKILL.md \
    && curl --retry 3 --fail --silent --show-error "$upstream/scripts/setup.sh" -o scripts/setup.sh \
    && printf '%s\n' \
        '17c2f1c2a337becf28ec1e23eec46b42a6f0ffa2691b40d8b97b35d043b79f65  SKILL.md' \
        '6b5e39efe99e42d671edb365e11b89d065ccda7188a45e81fe5757f5f46661be  scripts/setup.sh' \
        | sha256sum -c - \
    && git --version >/dev/null \
    && ffmpeg -version >/dev/null \
    && python3 -m venv /tmp/map-code-film-venv \
    && rm -rf /tmp/map-code-film-venv

COPY THIRD_PARTY_NOTICES.md /usr/share/doc/map-design-runtime/THIRD_PARTY_NOTICES.md
COPY --from=build /build/dist /opt/map-design-runtime/dist
COPY scripts/image-browser-smoke.mjs /opt/map-design-runtime/scripts/image-browser-smoke.mjs

# 工作目录与引擎数据目录归引擎用户；浏览器质量证据由同一个降权用户写入专用目录。
# 产物导出目录仍只归本服务（root），引擎与浏览器子进程读不到也写不进。
RUN mkdir -p /home/open-design /workspace /app/design-templates /app/.od \
        /var/lib/map-design-runtime/output /var/lib/map-design-runtime/browser-quality \
    && chown open-design:open-design /home/open-design /workspace /app/design-templates /app/.od \
        /var/lib/map-design-runtime/browser-quality \
    && chmod 0711 /var/lib/map-design-runtime \
    && chmod 0700 /home/open-design /var/lib/map-design-runtime/output /var/lib/map-design-runtime/browser-quality

# 构建产物只有在降权用户能真实拉起固定版本 Chromium，并分别创建桌面与移动视口时才可发布。
# 这条零模型自检会在 Alpine 包、Playwright 协议或沙箱权限漂移时直接让镜像构建失败。
RUN su open-design -s /bin/sh -c \
    "HOME=/home/open-design \
     DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH='$DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH' \
     DESIGN_RUNTIME_BROWSER_VERSION='$DESIGN_RUNTIME_BROWSER_VERSION' \
     node /opt/map-design-runtime/scripts/image-browser-smoke.mjs"

# 基础镜像的 NODE_OPTIONS（192 MB 堆上限）是给 daemon 的，daemon 的环境由本服务显式传入；
# 本服务自己要处理最大 64 MB 的任务包与 128 MB 的产物，堆上限在启动命令里单独给。
ENV NODE_OPTIONS= \
    DESIGN_RUNTIME_PORT=8093

EXPOSE 8093
WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--max-old-space-size=1024", "/opt/map-design-runtime/dist/index.js"]
