# PRD Agent Desktop Build Script
# 使用方法: .\scripts\build-desktop.ps1 [-Platform <windows|macos|linux>]

param(
    [string]$Platform = "windows"
)

$ErrorActionPreference = "Stop"

Write-Host "PRD Agent Desktop Build Script" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

# 切换到桌面客户端目录
Set-Location "$PSScriptRoot\..\prd-desktop"

# 所有受支持的发布入口共用同一动态 API 地址门禁，避免生成无法连接服务端的安装包。
node scripts/require-default-api-url.mjs

# 安装依赖
Write-Host "`n[1/3] Installing dependencies..." -ForegroundColor Yellow
pnpm install

# 构建前端
Write-Host "`n[2/3] Building frontend..." -ForegroundColor Yellow
pnpm build

# 构建Tauri应用
Write-Host "`n[3/3] Building Tauri application..." -ForegroundColor Yellow

switch ($Platform) {
    "windows" {
        pnpm tauri build --target x86_64-pc-windows-msvc
    }
    "macos" {
        pnpm tauri build --target x86_64-apple-darwin
    }
    "linux" {
        pnpm tauri build --target x86_64-unknown-linux-gnu
    }
    default {
        pnpm tauri build
    }
}

Write-Host "`nBuild completed!" -ForegroundColor Green
Write-Host "Output: prd-desktop/src-tauri/target/release/bundle/" -ForegroundColor Cyan
