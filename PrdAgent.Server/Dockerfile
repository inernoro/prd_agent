FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
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
RUN dotnet build "PrdAgent.Api.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "PrdAgent.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "PrdAgent.Api.dll"]


