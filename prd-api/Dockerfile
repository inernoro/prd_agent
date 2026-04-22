# syntax=docker/dockerfile:1.4
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
# 安装 Node.js 20 + pnpm + 系统 Chromium（供 Remotion 分镜预览渲染用）
# 系统 Chromium 可避免 Remotion 在 read-only 容器内自行下载 Chromium 时因写不进
# node_modules/.remotion 而崩溃；wrapper 脚本注入 Docker headless 必需的 Chrome 标志
RUN apt-get update && apt-get install -y curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs chromium fonts-noto && \
    npm install -g pnpm && \
    printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage "$@"\n' \
        > /usr/local/bin/chromium-docker && \
    chmod +x /usr/local/bin/chromium-docker && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
EXPOSE 80

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["PrdAgent.sln", "./"]
COPY ["src/PrdAgent.Api/PrdAgent.Api.csproj", "src/PrdAgent.Api/"]
COPY ["src/PrdAgent.Core/PrdAgent.Core.csproj", "src/PrdAgent.Core/"]
COPY ["src/PrdAgent.Infrastructure/PrdAgent.Infrastructure.csproj", "src/PrdAgent.Infrastructure/"]
COPY ["tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj", "tests/PrdAgent.Api.Tests/"]
# BuildKit cache mount：NuGet 包跨 build 复用，避免换服务器 / 清 docker layer 后重新下载全量包
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore PrdAgent.sln
COPY . .
WORKDIR "/src/src/PrdAgent.Api"
# publish 会自动 build：避免 build + publish 双编译；并复用上一步 restore 的缓存
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet publish "PrdAgent.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false --no-restore

# 安装 prd-video 依赖（独立 stage；通过 --build-context video=./prd-video 注入，不污染 dotnet 缓存）
FROM node:20-slim AS video-deps
WORKDIR /prd-video
# "video" 是构建时通过 --build-context video=./prd-video 传入的命名上下文
COPY --from=video package.json pnpm-lock.yaml ./
# BuildKit cache mount：pnpm store 跨 build 复用
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    npm install -g pnpm && pnpm install --frozen-lockfile

FROM base AS final
WORKDIR /app
COPY --from=build /app/publish .
# 嵌入 prd-video 源码 + 预装依赖，供 Remotion 渲染使用
COPY --from=video . /prd-video
COPY --from=video-deps /prd-video/node_modules /prd-video/node_modules
ENTRYPOINT ["dotnet", "PrdAgent.Api.dll"]
