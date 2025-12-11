# PRD Agent 快速启动器 (Windows PowerShell)
# 用法:
#   .\quick.ps1          - 启动后端服务
#   .\quick.ps1 admin    - 启动Web管理后台
#   .\quick.ps1 desktop  - 启动桌面客户端
#   .\quick.ps1 all      - 同时启动前后端

param(
    [Parameter(Position=0)]
    [ValidateSet("", "admin", "desktop", "all", "help")]
    [string]$Command = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Blue
}

function Write-Success {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

# 启动后端服务
function Start-Backend {
    Write-Info "Starting backend server..."
    Set-Location "$ScriptDir\PrdAgent.Server\src\PrdAgent.Api"
    dotnet run
}

# 启动Web管理后台
function Start-Admin {
    Write-Info "Starting admin panel..."
    Set-Location "$ScriptDir\prd-agent-admin"
    pnpm dev
}

# 启动桌面客户端
function Start-Desktop {
    Write-Info "Starting desktop client..."
    Set-Location "$ScriptDir\prd-agent-desktop"
    pnpm tauri:dev
}

# 同时启动前后端
function Start-All {
    Write-Info "Starting all services..."
    
    # 后台启动后端
    Write-Info "Starting backend server in background..."
    $backendJob = Start-Job -ScriptBlock {
        param($dir)
        Set-Location "$dir\PrdAgent.Server\src\PrdAgent.Api"
        dotnet run
    } -ArgumentList $ScriptDir
    
    # 等待后端启动
    Start-Sleep -Seconds 3
    
    # 后台启动管理后台
    Write-Info "Starting admin panel in background..."
    $adminJob = Start-Job -ScriptBlock {
        param($dir)
        Set-Location "$dir\prd-agent-admin"
        pnpm dev
    } -ArgumentList $ScriptDir
    
    Write-Success "All services started!"
    Write-Info "Backend Job ID: $($backendJob.Id)"
    Write-Info "Admin Panel Job ID: $($adminJob.Id)"
    Write-Info "Press Ctrl+C to stop all services, or run: Stop-Job $($backendJob.Id),$($adminJob.Id)"
    
    try {
        # 持续输出job的输出
        while ($true) {
            Receive-Job -Job $backendJob -ErrorAction SilentlyContinue
            Receive-Job -Job $adminJob -ErrorAction SilentlyContinue
            
            # 检查job是否仍在运行
            if ($backendJob.State -ne "Running" -and $adminJob.State -ne "Running") {
                break
            }
            
            Start-Sleep -Milliseconds 500
        }
    }
    finally {
        # 清理job
        Write-Info "Stopping services..."
        Stop-Job -Job $backendJob -ErrorAction SilentlyContinue
        Stop-Job -Job $adminJob -ErrorAction SilentlyContinue
        Remove-Job -Job $backendJob -ErrorAction SilentlyContinue
        Remove-Job -Job $adminJob -ErrorAction SilentlyContinue
    }
}

# 显示帮助信息
function Show-Help {
    Write-Host "PRD Agent Quick Launcher (Windows)"
    Write-Host ""
    Write-Host "Usage: .\quick.ps1 [command]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  (default)  Start backend server"
    Write-Host "  admin      Start admin panel (prd-agent-admin)"
    Write-Host "  desktop    Start desktop client (prd-agent-desktop)"
    Write-Host "  all        Start backend and web admin together"
    Write-Host "  help       Show this help message"
    Write-Host ""
}

# 主逻辑
switch ($Command) {
    "" { Start-Backend }
    "admin" { Start-Admin }
    "desktop" { Start-Desktop }
    "all" { Start-All }
    "help" { Show-Help }
    default {
        Write-Error "Unknown command: $Command"
        Show-Help
        exit 1
    }
}

