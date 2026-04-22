FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
# 安装 Node.js 20 + pnpm，供 Remotion 分镜预览渲染（VideoGenRunWorker 调用 npx）
RUN apt-get update && apt-get install -y curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
EXPOSE 80

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["src/PrdAgent.Api/PrdAgent.Api.csproj", "src/PrdAgent.Api/"]
COPY ["src/PrdAgent.Core/PrdAgent.Core.csproj", "src/PrdAgent.Core/"]
COPY ["src/PrdAgent.Infrastructure/PrdAgent.Infrastructure.csproj", "src/PrdAgent.Infrastructure/"]
RUN dotnet restore "src/PrdAgent.Api/PrdAgent.Api.csproj"
COPY . .
WORKDIR "/src/src/PrdAgent.Api"
# publish 会自动 build：避免 build + publish 双编译；并复用上一步 restore 的缓存
RUN dotnet publish "PrdAgent.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false --no-restore

# 安装 prd-video 依赖（独立 stage；通过 --build-context video=./prd-video 注入，不污染 dotnet 缓存）
FROM node:20-slim AS video-deps
WORKDIR /prd-video
# "video" 是构建时通过 --build-context video=./prd-video 传入的命名上下文
COPY --from=video package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

FROM base AS final
WORKDIR /app
COPY --from=build /app/publish .
# 嵌入 prd-video 源码 + 预装依赖，供 Remotion 渲染使用
COPY --from=video . /prd-video
COPY --from=video-deps /prd-video/node_modules /prd-video/node_modules
ENTRYPOINT ["dotnet", "PrdAgent.Api.dll"]
