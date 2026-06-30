# 多阶段构建：sdk 编译 → aspnet 运行。构建上下文为 ./prd-llmgw
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# 先 COPY csproj 单独 restore，最大化层缓存
COPY prd-llmgw.csproj ./
RUN dotnet restore prd-llmgw.csproj

# 再 COPY 全部源码并发布
COPY . ./
RUN dotnet publish prd-llmgw.csproj -c Release -o /app/publish /p:UseAppHost=false

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
