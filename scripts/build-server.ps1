# PRD Agent Server Build Script
# 使用方法: .\scripts\build-server.ps1 [-Configuration <Debug|Release>]

param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

Write-Host "PRD Agent Server Build Script" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan

# 切换到后端目录
Set-Location "$PSScriptRoot\..\PrdAgent.Server"

# 还原依赖
Write-Host "`n[1/4] Restoring dependencies..." -ForegroundColor Yellow
dotnet restore

# 构建
Write-Host "`n[2/4] Building solution..." -ForegroundColor Yellow
dotnet build -c $Configuration --no-restore

# 运行测试
Write-Host "`n[3/4] Running tests..." -ForegroundColor Yellow
dotnet test -c $Configuration --no-build --verbosity normal

# 发布
Write-Host "`n[4/4] Publishing..." -ForegroundColor Yellow
dotnet publish src/PrdAgent.Api/PrdAgent.Api.csproj -c $Configuration -o ./publish

Write-Host "`nBuild completed!" -ForegroundColor Green
Write-Host "Output: PrdAgent.Server/publish/" -ForegroundColor Cyan
