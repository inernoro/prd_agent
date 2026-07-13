# syntax=docker/dockerfile:1.4
# 独立 LLM 网关承载服务（PrdAgent.LlmGateway）。
# build context = 仓库根目录。通过 DI HOST 既有 LlmGateway + ModelResolver 实现，HTTP 暴露 /gw/v1/*。
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 8091
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["llmgw/serving/PrdAgent.LlmGateway.csproj", "llmgw/serving/"]
COPY ["prd-api/src/PrdAgent.Core/PrdAgent.Core.csproj", "prd-api/src/PrdAgent.Core/"]
COPY ["prd-api/src/PrdAgent.Infrastructure/PrdAgent.Infrastructure.csproj", "prd-api/src/PrdAgent.Infrastructure/"]
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore "llmgw/serving/PrdAgent.LlmGateway.csproj"
COPY . .
WORKDIR "/src/llmgw/serving"
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore "PrdAgent.LlmGateway.csproj" && \
    dotnet publish "PrdAgent.LlmGateway.csproj" -c Release -o /app/publish /p:UseAppHost=false --no-restore

FROM base AS final
WORKDIR /app
ARG GIT_COMMIT=""
ARG BUILD_TIME_UTC=""
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME_UTC=$BUILD_TIME_UTC
ENV ASPNETCORE_URLS=http://0.0.0.0:8091
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "PrdAgent.LlmGateway.dll"]
