# syntax=docker/dockerfile:1.4
# 视频 Remotion 渲染已抽到独立 prd-video-renderer 容器，api 镜像不再装 Node + Chromium，
# 也不再嵌入 prd-video 源码 — 渲染通过 HTTP POST 到 video-renderer 容器执行
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 80

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
# publish 会自动 build：避免 build + publish 双编译；二次 restore 防止 BuildKit 复用 restore 层但 NuGet cache mount 缺包
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore "PrdAgent.Api.csproj" && \
    dotnet publish "PrdAgent.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false --no-restore

FROM base AS final
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "PrdAgent.Api.dll"]
