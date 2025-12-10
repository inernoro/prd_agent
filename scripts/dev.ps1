# PRD Agent Development Script
# 使用方法: .\scripts\dev.ps1 [-Component <all|server|desktop|admin>]

param(
    [string]$Component = "all"
)

Write-Host "PRD Agent Development Script" -ForegroundColor Cyan
Write-Host "=============================" -ForegroundColor Cyan

$RootPath = "$PSScriptRoot\.."

function Start-Server {
    Write-Host "`nStarting Backend Server..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$RootPath\PrdAgent.Server\src\PrdAgent.Api'; dotnet watch run"
}

function Start-Desktop {
    Write-Host "`nStarting Desktop Client..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$RootPath\prd-agent-desktop'; pnpm tauri dev"
}

function Start-Admin {
    Write-Host "`nStarting Admin Frontend..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$RootPath\prd-agent-admin'; pnpm dev"
}

function Start-Docker {
    Write-Host "`nStarting Docker services (MongoDB + Redis)..." -ForegroundColor Yellow
    docker-compose -f "$RootPath\docker-compose.yml" up mongodb redis -d
}

# 启动Docker服务
Start-Docker
Start-Sleep -Seconds 3

switch ($Component) {
    "server" {
        Start-Server
    }
    "desktop" {
        Start-Desktop
    }
    "admin" {
        Start-Admin
    }
    "all" {
        Start-Server
        Start-Sleep -Seconds 5
        Start-Desktop
        Start-Admin
    }
}

Write-Host "`nDevelopment environment started!" -ForegroundColor Green
Write-Host @"

Services:
- Backend API:    http://localhost:5000
- Desktop Client: http://localhost:1420 (Tauri dev)
- Admin Panel:    http://localhost:5173
- MongoDB:        mongodb://localhost:27017
- Redis:          localhost:6379

"@ -ForegroundColor Cyan

