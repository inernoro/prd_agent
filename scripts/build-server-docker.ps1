# 使用 Docker 编译后台代码（适用于没有 .NET SDK 环境的服务器）
# 产物输出到 prd-api/output 目录

param(
    [switch]$RunTests
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Join-Path $ScriptDir ".."
$ApiDir = Join-Path $RepoRoot "prd-api"
$OutputDir = Join-Path $ApiDir "output"

Set-Location $ApiDir

Write-Host "Building backend code using Docker..." -ForegroundColor Cyan
Write-Host "Output directory: $OutputDir" -ForegroundColor Cyan
Write-Host ""

# 清理旧的输出目录
if (Test-Path $OutputDir) {
    Remove-Item -Recurse -Force $OutputDir
}

# 构建 Docker 镜像并输出产物
$buildArgs = @(
    "build",
    "-f", "Dockerfile.build",
    "-t", "prdagent-build:local",
    "--target", "build",
    "--output", $OutputDir,
    "."
)

docker @buildArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed!"
    exit 1
}

Write-Host ""
Write-Host "Build completed! Artifacts are in: $OutputDir" -ForegroundColor Green
Write-Host ""
Write-Host "To run the compiled app:" -ForegroundColor Yellow
Write-Host "  cd $OutputDir"
Write-Host "  dotnet PrdAgent.Api.dll"
