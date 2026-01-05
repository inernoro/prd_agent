# PRD Agent 快速启动器 (Windows PowerShell)
# 用法:
#   .\quick.ps1          - 启动后端服务
#   .\quick.ps1 admin    - 启动Web管理后台
#   .\quick.ps1 desktop  - 启动桌面客户端
#   .\quick.ps1 all      - 同时启动后端 + Web管理后台 + 桌面端（统一输出到同一控制台）
#   .\quick.ps1 check    - 桌面端本地CI等价检查（fmt/clippy/icons等）

param(
    [Parameter(Position=0)]
    [ValidateSet("", "admin", "desktop", "all", "check", "ci", "help")]
    [string]$Command = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 统一控制台编码：尽量避免 Start-Job / Receive-Job + Node/Vite 输出中文乱码
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch {
    # ignore
}

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

function Ensure-PnpmInstalled {
    param(
        [Parameter(Mandatory=$true)][string]$Dir,
        [Parameter(Mandatory=$true)][string]$Label,
        [Parameter(Mandatory=$true)][string[]]$MustExistRelativePaths
    )

    $needInstall = $false
    foreach ($rel in $MustExistRelativePaths) {
        $p = Join-Path $Dir $rel
        if (-not (Test-Path $p)) {
            $needInstall = $true
            break
        }
    }

    if ($needInstall) {
        Write-Warn "$Label node_modules 不完整，正在执行: pnpm install --frozen-lockfile"
        pnpm -C $Dir install --frozen-lockfile
    }
}

# 启动后端服务
function Start-Backend {
    Write-Info "Starting backend server..."
    dotnet run --project "$ScriptDir\prd-api\src\PrdAgent.Api\PrdAgent.Api.csproj"
}

# 启动Web管理后台
function Start-Admin {
    Write-Info "Starting admin panel..."
    Ensure-PnpmInstalled -Dir "$ScriptDir\prd-admin" -Label "admin" -MustExistRelativePaths @("node_modules")
    pnpm -C "$ScriptDir\prd-admin" dev
}

# 启动桌面客户端
function Start-Desktop {
    Write-Info "Starting desktop client..."
    Ensure-PnpmInstalled -Dir "$ScriptDir\prd-desktop" -Label "desktop" -MustExistRelativePaths @(
        "node_modules",
        "node_modules\@tauri-apps\plugin-shell\package.json"
    )
    pnpm -C "$ScriptDir\prd-desktop" tauri:dev
}

# 桌面端本地CI等价检查（避免 CI desktop 才爆）
function Check-Desktop {
    Write-Info "Running desktop check (CI-equivalent)..."
    $desktopDir = "$ScriptDir\prd-desktop"
    $tauriDir = "$ScriptDir\prd-desktop\src-tauri"
    $tauriManifest = "$tauriDir\Cargo.toml"

    if (-not (Test-Path "$desktopDir\node_modules")) {
        Write-Warn "node_modules not found, running pnpm install..."
        pnpm -C "$desktopDir" install
    }

    Write-Info "Type check frontend (tsc --noEmit)..."
    pnpm -C "$desktopDir" tsc --noEmit

    Write-Info "Build frontend..."
    pnpm -C "$desktopDir" build

    Write-Info "Generate Tauri icons..."
    pnpm -C "$desktopDir" tauri:icons

    Write-Info "Cargo check..."
    cargo check --manifest-path "$tauriManifest"

    Write-Info "Rust format check (cargo fmt --check)..."
    cargo fmt --manifest-path "$tauriManifest" --check

    Write-Info "Clippy (deny warnings)..."
    cargo clippy --manifest-path "$tauriManifest" -- -D warnings

    Write-Success "Desktop check passed!"
}

# 本地跑一遍 CI（server + admin + desktop）
function Check-CI {
    Write-Info "Running local CI checks (server + admin + desktop)..."

    # server checks (align with .github/workflows/ci.yml server-build)
    Write-Info "Server: dotnet restore/build/test..."
    $slnPath = Join-Path $ScriptDir "prd-api\PrdAgent.sln"
    dotnet restore "$slnPath"
    dotnet build "$slnPath" -c Release --no-restore
    dotnet test "$slnPath" -c Release --no-build --verbosity normal

    # admin checks (align with .github/workflows/ci.yml admin-build)
    Write-Info "Admin: install/typecheck/build..."
    $adminDir = Join-Path $ScriptDir "prd-admin"
    if (-not (Test-Path (Join-Path $adminDir "node_modules"))) {
        Write-Warn "node_modules not found, running pnpm install..."
        pnpm -C "$adminDir" install
    }
    pnpm -C "$adminDir" tsc --noEmit
    pnpm -C "$adminDir" build

    # desktop checks (reuse existing)
    Check-Desktop

    Write-Success "Local CI checks passed!"
}

# 同时启动前后端
function Start-All {
    Write-Info "Starting all services..."
    
    # 后台启动后端
    Write-Info "Starting backend server in background..."
    $backendJob = Start-Job -ScriptBlock {
        param($projectPath)
        try {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [Console]::InputEncoding = $utf8NoBom
            [Console]::OutputEncoding = $utf8NoBom
            $OutputEncoding = $utf8NoBom
        } catch {}

        dotnet run --project $projectPath 2>&1 | ForEach-Object { "[api] $_" }
    } -ArgumentList "$ScriptDir\prd-api\src\PrdAgent.Api\PrdAgent.Api.csproj"

    # 后台启动管理后台
    Write-Info "Starting admin panel in background..."
    $adminJob = Start-Job -ScriptBlock {
        param($dir)
        try {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [Console]::InputEncoding = $utf8NoBom
            [Console]::OutputEncoding = $utf8NoBom
            $OutputEncoding = $utf8NoBom
        } catch {}

        if (-not (Test-Path (Join-Path $dir "node_modules"))) {
            pnpm -C $dir install --frozen-lockfile 2>&1 | ForEach-Object { "[admin][install] $_" }
        }
        pnpm -C $dir dev 2>&1 | ForEach-Object { "[admin] $_" }
    } -ArgumentList "$ScriptDir\prd-admin"

    # 后台启动桌面端
    Write-Info "Starting desktop client in background..."
    $desktopJob = Start-Job -ScriptBlock {
        param($dir)
        try {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [Console]::InputEncoding = $utf8NoBom
            [Console]::OutputEncoding = $utf8NoBom
            $OutputEncoding = $utf8NoBom
        } catch {}

        $must = @(
            (Join-Path $dir "node_modules"),
            (Join-Path $dir "node_modules\@tauri-apps\plugin-shell\package.json")
        )
        $needInstall = $false
        foreach ($p in $must) {
            if (-not (Test-Path $p)) { $needInstall = $true; break }
        }
        if ($needInstall) {
            pnpm -C $dir install --frozen-lockfile 2>&1 | ForEach-Object { "[desktop][install] $_" }
        }
        pnpm -C $dir tauri:dev 2>&1 | ForEach-Object { "[desktop] $_" }
    } -ArgumentList "$ScriptDir\prd-desktop"
    
    Write-Success "All services started!"
    Write-Info "Backend Job ID: $($backendJob.Id)"
    Write-Info "Admin Panel Job ID: $($adminJob.Id)"
    Write-Info "Desktop Job ID: $($desktopJob.Id)"
    Write-Info "Press Ctrl+C to stop all services, or run: Stop-Job $($backendJob.Id),$($adminJob.Id),$($desktopJob.Id)"
    
    try {
        # 持续输出job的输出
        while ($true) {
            Receive-Job -Job $backendJob -ErrorAction SilentlyContinue
            Receive-Job -Job $adminJob -ErrorAction SilentlyContinue
            Receive-Job -Job $desktopJob -ErrorAction SilentlyContinue
            
            # 检查job是否仍在运行
            if ($backendJob.State -ne "Running" -and $adminJob.State -ne "Running" -and $desktopJob.State -ne "Running") {
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
        Stop-Job -Job $desktopJob -ErrorAction SilentlyContinue
        Remove-Job -Job $backendJob -ErrorAction SilentlyContinue
        Remove-Job -Job $adminJob -ErrorAction SilentlyContinue
        Remove-Job -Job $desktopJob -ErrorAction SilentlyContinue
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
    Write-Host "  admin      Start admin panel (prd-admin)"
    Write-Host "  desktop    Start desktop client (prd-desktop)"
    Write-Host "  all        Start backend + admin + desktop together (single console output)"
    Write-Host "  check      Run desktop CI-equivalent checks"
    Write-Host "  ci         Run local CI checks (server + admin + desktop)"
    Write-Host "  help       Show this help message"
    Write-Host ""
}

# 主逻辑
switch ($Command) {
    "" { Start-Backend }
    "admin" { Start-Admin }
    "desktop" { Start-Desktop }
    "all" { Start-All }
    "check" { Check-Desktop }
    "ci" { Check-CI }
    "help" { Show-Help }
    default {
        Write-Error "Unknown command: $Command"
        Show-Help
        exit 1
    }
}

