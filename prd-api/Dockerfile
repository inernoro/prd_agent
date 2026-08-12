# syntax=docker/dockerfile:1.4
# 视频 Remotion 渲染已抽到独立 prd-video-renderer 容器，api 镜像不再装 Node + Chromium，
# 也不再嵌入 prd-video 源码 — 渲染通过 HTTP POST 到 video-renderer 容器执行
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 80

# OpenRouter 返回的 MP4 常将 moov 索引放在文件尾。API 入库前用 ffmpeg
# 执行无损 fast-start 重排，保证预览端无需下载完整文件即可显示首帧。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["src/PrdAgent.Api/PrdAgent.Api.csproj", "src/PrdAgent.Api/"]
COPY ["src/PrdAgent.Core/PrdAgent.Core.csproj", "src/PrdAgent.Core/"]
COPY ["src/PrdAgent.Infrastructure/PrdAgent.Infrastructure.csproj", "src/PrdAgent.Infrastructure/"]
# 仅 restore API 项目：测试项目被 .dockerignore 排除，不进入生产镜像
# BuildKit cache mount：NuGet 包跨 build 复用，避免换服务器 / 清 docker layer 后重新下载全量包
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore "src/PrdAgent.Api/PrdAgent.Api.csproj"
COPY . .
WORKDIR "/src/src/PrdAgent.Api"
# commit 必须烤进程序集（SourceRevisionId → AssemblyInformationalVersion 的 "+sha" 后缀），
# 而不是只写进 ENV：容器启动时平台会注入同名 env 覆盖掉镜像里的值，那个值只能代表
# 「部署希望跑哪版」，不能代表「实际跑的是哪版」。两者由 /api/v 分列并对账。
ARG GIT_COMMIT=""
# publish 会自动 build：避免 build + publish 双编译；二次 restore 防止 BuildKit 复用 restore 层但 NuGet cache mount 缺包
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore "PrdAgent.Api.csproj" && \
    dotnet publish "PrdAgent.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false --no-restore \
      ${GIT_COMMIT:+-p:SourceRevisionId=$GIT_COMMIT}

FROM base AS final
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG GIT_COMMIT=""
ARG BUILD_TIME_UTC=""
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME_UTC=$BUILD_TIME_UTC
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "PrdAgent.Api.dll"]
