# 多阶段构建：sdk 编译 → aspnet 运行。构建上下文为仓库根目录，共享出站传输库独立于 MAP 服务
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# 先 COPY csproj 单独 restore，最大化层缓存
COPY llmgw/console-api/prd-llmgw.csproj llmgw/console-api/
COPY prd-api/src/LlmGateway.Transport/LlmGateway.Transport.csproj prd-api/src/LlmGateway.Transport/
RUN dotnet restore llmgw/console-api/prd-llmgw.csproj

# 再 COPY 全部源码并发布
COPY llmgw/console-api/ llmgw/console-api/
COPY prd-api/src/LlmGateway.Transport/ prd-api/src/LlmGateway.Transport/
RUN dotnet publish llmgw/console-api/prd-llmgw.csproj -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app

# 构建元信息（由 CI 注入），健康检查端点会回显 GIT_COMMIT
ARG GIT_COMMIT=""
ARG BUILD_TIME_UTC=""
ENV GIT_COMMIT=${GIT_COMMIT}
ENV BUILD_TIME_UTC=${BUILD_TIME_UTC}

ENV ASPNETCORE_URLS=http://0.0.0.0:8090
EXPOSE 8090

COPY --from=build /app/publish ./
ENTRYPOINT ["dotnet", "prd-llmgw.dll"]
