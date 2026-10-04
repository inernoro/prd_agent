# PRD Agent Quick Launcher (Windows PowerShell)
# Usage:
#   .\quick.ps1          - Start backend server
#   .\quick.ps1 admin    - Start admin panel
#   .\quick.ps1 desktop  - Start desktop client
#   .\quick.ps1 bt       - Start CDS
#   .\quick.ps1 all      - Start all services together
#   .\quick.ps1 check    - Run desktop CI checks
#   .\quick.ps1 ci       - Run full CI checks
#   .\quick.ps1 version  - Show recent 10 versions
#   .\quick.ps1 version v1.2.3 - Sync version + git tag + git push origin tag

param(
    [Parameter(Position=0)]
    [ValidateSet("", "admin", "desktop", "bt", "all", "check", "ci", "version", "help")]
    [string]$Command = "",
    [Parameter(Position=1)]
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Set console encoding to UTF-8
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

function Write-Err {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Get-NormalizedVersion {
    param([string]$RawVersion)
    if ([string]::IsNullOrWhiteSpace($RawVersion)) {
        throw "Version is required."
    }

    $v = $RawVersion.Trim()
    if ($v.StartsWith("v")) {
        $v = $v.Substring(1)
    }

    if ($v -notmatch '^\d+\.\d+\.\d+([\-+][0-9A-Za-z\.\-]+)?$') {
        throw "Invalid version: '$RawVersion' (expected like v1.2.3 / 1.2.3)"
    }

    return $v
}

function Sync-DesktopVersion {
    param([Parameter(Mandatory=$true)][string]$Version)

    $tauriConf = Join-Path $ScriptDir "prd-desktop\src-tauri\tauri.conf.json"
    $cargoToml = Join-Path $ScriptDir "prd-desktop\src-tauri\Cargo.toml"
    $pkgJson = Join-Path $ScriptDir "prd-desktop\package.json"

    foreach ($p in @($tauriConf, $cargoToml, $pkgJson)) {
        if (-not (Test-Path $p)) {
            throw "Missing file: $p"
        }
    }

    Write-Info "Syncing desktop version to $Version..."

    $tauriData = Get-Content -Path $tauriConf -Raw | ConvertFrom-Json
    $tauriData.version = $Version
    $tauriData | ConvertTo-Json -Depth 100 | Set-Content -Path $tauriConf -Encoding utf8

    $pkgData = Get-Content -Path $pkgJson -Raw | ConvertFrom-Json
    $pkgData.version = $Version
    $pkgData | ConvertTo-Json -Depth 100 | Set-Content -Path $pkgJson -Encoding utf8

    $lines = Get-Content -Path $cargoToml
    $inPackage = $false
    $done = $false
    $out = New-Object System.Collections.Generic.List[string]

    foreach ($line in $lines) {
        $trim = $line.Trim()
        if ($trim.StartsWith("[") -and $trim.EndsWith("]")) {
            $inPackage = ($trim -eq "[package]")
        }

        if ($inPackage -and -not $done -and $line -match '^\s*version\s*=\s*".*"\s*$') {
            $out.Add("version = `"$Version`"")
            $done = $true
            continue
        }

        $out.Add($line)
    }

    if (-not $done) {
        throw "Failed to update Cargo.toml: could not find [package].version"
    }

    Set-Content -Path $cargoToml -Value $out -Encoding utf8
    Write-Success "Desktop version synced!"
}

function Show-RecentVersions {
    Write-Info "Recent 10 versions:"

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Err "git is not available"
        exit 1
    }

    Push-Location $ScriptDir
    try {
        & git rev-parse --git-dir *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Not a git repository: $ScriptDir"
            exit 1
        }

        $tags = & git tag --sort=-creatordate --list "v*" 2>$null | Select-Object -First 10
        if (-not $tags) {
            $tags = & git tag --sort=-creatordate 2>$null | Select-Object -First 10
        }

        if (-not $tags) {
            Write-Warn "No tags found."
            return
        }

        $tags | ForEach-Object { Write-Host $_ }
    }
    finally {
        Pop-Location
    }
}

function Publish-VersionTag {
    param([Parameter(Mandatory=$true)][string]$RawVersion)

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Err "git is not available"
        exit 1
    }

    $version = Get-NormalizedVersion -RawVersion $RawVersion
    $tagName = "v$version"

    Push-Location $ScriptDir
    try {
        & git rev-parse --git-dir *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Not a git repository: $ScriptDir"
            exit 1
        }

        & git rev-parse $tagName *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Err "Tag '$tagName' already exists!"
            Write-Info "To delete it: git tag -d $tagName && git push origin :refs/tags/$tagName"
            exit 1
        }

        Sync-DesktopVersion -Version $version

        & git diff --quiet *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Working tree has uncommitted changes; tag will point to current HEAD."
        }

        Write-Info "Creating tag $tagName..."
        & git tag $tagName

        Write-Info "Pushing tag $tagName..."
        & git push origin $tagName

        Write-Success "Version published: $tagName"
    }
    finally {
        Pop-Location
    }
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
        Write-Warn "$Label node_modules incomplete, running: pnpm install --frozen-lockfile"
        pnpm -C $Dir install --frozen-lockfile
    }
}

# Start CDS
function Start-BranchTester {
    Write-Info "Starting CDS..."
    $btDir = "$ScriptDir\cds"
    if (-not (Test-Path (Join-Path $btDir "node_modules"))) {
        Write-Warn "node_modules not found, running: npm install"
        npm -C "$btDir" install
    }
    npm -C "$btDir" run dev
}

# Start backend server
# MAP calls models only through the standalone LLM gateway serving, so the backend starts it too.
# Explicitly set values win; otherwise serving listens on localhost:5091 (same host port as
# docker-compose.dev.yml), both sides share the repo dev key, and serving reuses the API dev
# Jwt:Secret so it can decrypt platform keys stored in the local database.
$LlmgwLocalUrl = if ($env:LLMGW_LOCAL_URL) { $env:LLMGW_LOCAL_URL } else { "http://localhost:5091" }
if (-not $env:LlmGateway__ServeBaseUrl) { $env:LlmGateway__ServeBaseUrl = $LlmgwLocalUrl }
if (-not $env:LlmGwServe__ApiKey) { $env:LlmGwServe__ApiKey = "dev-llmgw-serve-key" }

function Start-LlmgwServingJob {
    $jwtSecret = $env:Jwt__Secret
    if (-not $jwtSecret) {
        try {
            $devSettings = Get-Content "$ScriptDir\prd-api\src\PrdAgent.Api\appsettings.Development.json" -Raw | ConvertFrom-Json
            $jwtSecret = $devSettings.Jwt.Secret
        } catch {}
    }
    return Start-Job -ScriptBlock {
        param($projectPath, $url, $jwtSecret)
        try {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [Console]::InputEncoding = $utf8NoBom
            [Console]::OutputEncoding = $utf8NoBom
            $OutputEncoding = $utf8NoBom
        } catch {}

        if (-not $env:ASPNETCORE_ENVIRONMENT) { $env:ASPNETCORE_ENVIRONMENT = "Development" }
        $env:ASPNETCORE_URLS = $url
        if ($jwtSecret) { $env:Jwt__Secret = $jwtSecret }
        dotnet run --no-launch-profile --project $projectPath 2>&1 | ForEach-Object { "[llmgw] $_" }
    } -ArgumentList "$ScriptDir\llmgw\serving\PrdAgent.LlmGateway.csproj", $LlmgwLocalUrl, $jwtSecret
}

# Report the gateway as started only after /gw/v1/healthz answers. If the serving job exits early
# (compile error, port in use) or never becomes healthy, fail instead of leaving an API whose
# every model call errors out while the launcher claims success.
function Wait-LlmgwReady {
    param($Job)
    $timeoutSec = if ($env:LLMGW_LOCAL_READY_TIMEOUT) { [int]$env:LLMGW_LOCAL_READY_TIMEOUT } else { 300 }
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    Write-Info "Waiting for LLM gateway serving: $LlmgwLocalUrl/gw/v1/healthz ..."
    while ($true) {
        # Send job output to the host, not the pipeline: anything left in the pipeline becomes part of the return value.
        Receive-Job -Job $Job -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
        if ($Job.State -ne "Running") {
            Write-Err "LLM gateway serving failed to start (job $($Job.State)); see the [llmgw] output above"
            return $false
        }
        try {
            $resp = Invoke-WebRequest -Uri "$LlmgwLocalUrl/gw/v1/healthz" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                Wait-LlmgwDependencies
                return $true
            }
        } catch {}
        if ((Get-Date) -gt $deadline) {
            Write-Err "LLM gateway serving not ready within ${timeoutSec}s ($LlmgwLocalUrl/gw/v1/healthz); see the [llmgw] output above"
            return $false
        }
        Start-Sleep -Seconds 2
    }
}

# After the process is up, check dependency readiness (gateway Mongo, key decryption, routing,
# scenario capability). A fresh local database fails this until the gateway is configured, and the
# developer needs the app running to configure it, so not-ready does not abort -- but it is reported
# loudly with the failing components instead of being announced as ready.
$script:LlmgwReadyState = "unknown"
function Wait-LlmgwDependencies {
    $graceSec = if ($env:LLMGW_LOCAL_READY_GRACE) { [int]$env:LLMGW_LOCAL_READY_GRACE } else { 60 }
    $deadline = (Get-Date).AddSeconds($graceSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $ready = Invoke-WebRequest -Uri "$LlmgwLocalUrl/gw/v1/healthz/ready" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($ready.StatusCode -eq 200) {
                $script:LlmgwReadyState = "ready"
                Write-Success "LLM gateway serving ready at $LlmgwLocalUrl"
                return
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    $script:LlmgwReadyState = "not-ready"
    Write-Warn "LLM gateway serving is up but its dependencies are NOT ready ($LlmgwLocalUrl/gw/v1/healthz/ready is not 200); model calls will fail. Failing components:"
    try {
        $detail = Invoke-WebRequest -Uri "$LlmgwLocalUrl/gw/v1/readyz" -Headers @{ "X-Gateway-Key" = $env:LlmGwServe__ApiKey } -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
        Write-Host $detail.Content
    } catch {
        if ($_.Exception.Response) {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            Write-Host $reader.ReadToEnd()
        }
    }
    Write-Warn "A fresh local database usually just lacks gateway platforms/models; once configured, readiness turns green without a restart."
}

function Start-Backend {
    Write-Info "Starting LLM gateway serving at $LlmgwLocalUrl in background..."
    $llmgwJob = Start-LlmgwServingJob
    try {
        if (-not (Wait-LlmgwReady -Job $llmgwJob)) {
            exit 1
        }
        Write-Info "Starting backend server..."
        dotnet watch run --project "$ScriptDir\prd-api\src\PrdAgent.Api\PrdAgent.Api.csproj"
    }
    finally {
        Receive-Job -Job $llmgwJob -ErrorAction SilentlyContinue
        Stop-Job -Job $llmgwJob -ErrorAction SilentlyContinue
        Remove-Job -Job $llmgwJob -ErrorAction SilentlyContinue
    }
}

# Start admin panel
function Start-Admin {
    Write-Info "Starting admin panel..."
    Ensure-PnpmInstalled -Dir "$ScriptDir\prd-admin" -Label "admin" -MustExistRelativePaths @("node_modules")
    pnpm -C "$ScriptDir\prd-admin" dev
}

# Start desktop client
function Start-Desktop {
    Write-Info "Starting desktop client..."
    Ensure-PnpmInstalled -Dir "$ScriptDir\prd-desktop" -Label "desktop" -MustExistRelativePaths @(
        "node_modules",
        "node_modules\@tauri-apps\plugin-shell\package.json"
    )
    pnpm -C "$ScriptDir\prd-desktop" tauri:dev
}

# Desktop CI-equivalent checks
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
    pnpm -C "$desktopDir" exec tsc --noEmit

    Write-Info "Build frontend..."
    pnpm -C "$desktopDir" run build

    Write-Info "Generate Tauri icons..."
    pnpm -C "$desktopDir" run tauri:icons

    Write-Info "Cargo check..."
    cargo check --manifest-path "$tauriManifest"

    Write-Info "Rust format check (cargo fmt --check)..."
    cargo fmt --manifest-path "$tauriManifest" --check

    Write-Info "Clippy (deny warnings)..."
    cargo clippy --manifest-path "$tauriManifest" -- -D warnings

    Write-Success "Desktop check passed!"
}

# Local CI checks (server + admin + desktop)
function Check-CI {
    Write-Info "Running local CI checks (server + admin + desktop)..."

    # server checks
    Write-Info "Server: dotnet restore/build/test..."
    $slnPath = Join-Path $ScriptDir "prd-api\PrdAgent.sln"
    dotnet restore "$slnPath"
    dotnet build "$slnPath" -c Release --no-restore
    dotnet test "$slnPath" -c Release --no-build --verbosity normal --filter "Category!=Integration"

    # admin checks
    Write-Info "Admin: install/typecheck/build..."
    $adminDir = Join-Path $ScriptDir "prd-admin"
    if (-not (Test-Path (Join-Path $adminDir "node_modules"))) {
        Write-Warn "node_modules not found, running pnpm install..."
        pnpm -C "$adminDir" install
    }
    pnpm -C "$adminDir" exec tsc --noEmit
    pnpm -C "$adminDir" run build

    # desktop checks
    Check-Desktop

    Write-Success "Local CI checks passed!"
}

# Start all services together
function Start-All {
    Write-Info "Starting all services..."
    
    # Start backend in background
    Write-Info "Starting backend server in background..."
    $backendJob = Start-Job -ScriptBlock {
        param($projectPath)
        try {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [Console]::InputEncoding = $utf8NoBom
            [Console]::OutputEncoding = $utf8NoBom
            $OutputEncoding = $utf8NoBom
        } catch {}

        dotnet watch run --project $projectPath 2>&1 | ForEach-Object { "[api] $_" }
    } -ArgumentList "$ScriptDir\prd-api\src\PrdAgent.Api\PrdAgent.Api.csproj"

    # Start local LLM gateway serving in background (MAP model calls only go through it)
    Write-Info "Starting LLM gateway serving at $LlmgwLocalUrl in background..."
    $llmgwJob = Start-LlmgwServingJob

    # Start admin in background
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

    # Start desktop in background
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
    
    if (-not (Wait-LlmgwReady -Job $llmgwJob)) {
        foreach ($job in @($backendJob, $llmgwJob, $adminJob, $desktopJob)) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -ErrorAction SilentlyContinue
        }
        exit 1
    }

    if ($script:LlmgwReadyState -eq "ready") {
        Write-Success "All services started!"
    } else {
        Write-Warn "All services started, but LLM gateway serving is NOT ready (model calls will fail until it is)."
    }
    Write-Info "Backend Job ID: $($backendJob.Id)"
    Write-Info "LLM Gateway Serving Job ID: $($llmgwJob.Id)"
    Write-Info "Admin Panel Job ID: $($adminJob.Id)"
    Write-Info "Desktop Job ID: $($desktopJob.Id)"
    Write-Info "Press Ctrl+C to stop all services, or run: Stop-Job $($backendJob.Id),$($llmgwJob.Id),$($adminJob.Id),$($desktopJob.Id)"
    
    try {
        # Output job results continuously
        while ($true) {
            Receive-Job -Job $backendJob -ErrorAction SilentlyContinue
            Receive-Job -Job $llmgwJob -ErrorAction SilentlyContinue
            Receive-Job -Job $adminJob -ErrorAction SilentlyContinue
            Receive-Job -Job $desktopJob -ErrorAction SilentlyContinue
            
            # Check if jobs are still running
            if ($backendJob.State -ne "Running" -and $llmgwJob.State -ne "Running" -and $adminJob.State -ne "Running" -and $desktopJob.State -ne "Running") {
                break
            }
            
            Start-Sleep -Milliseconds 500
        }
    }
    finally {
        # Cleanup jobs
        Write-Info "Stopping services..."
        Stop-Job -Job $backendJob -ErrorAction SilentlyContinue
        Stop-Job -Job $llmgwJob -ErrorAction SilentlyContinue
        Stop-Job -Job $adminJob -ErrorAction SilentlyContinue
        Stop-Job -Job $desktopJob -ErrorAction SilentlyContinue
        Remove-Job -Job $backendJob -ErrorAction SilentlyContinue
        Remove-Job -Job $llmgwJob -ErrorAction SilentlyContinue
        Remove-Job -Job $adminJob -ErrorAction SilentlyContinue
        Remove-Job -Job $desktopJob -ErrorAction SilentlyContinue
    }
}

# Show help message
function Show-Help {
    Write-Host "PRD Agent Quick Launcher (Windows)"
    Write-Host ""
    Write-Host "Usage: .\quick.ps1 [command]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  (default)  Start backend server"
    Write-Host "  admin      Start admin panel (prd-admin)"
    Write-Host "  desktop    Start desktop client (prd-desktop)"
    Write-Host "  bt         Start CDS (cds)"
    Write-Host "  all        Start backend (API + LLM gateway serving) + admin + desktop together (single console output)"
    Write-Host "  check      Run desktop CI-equivalent checks"
    Write-Host "  ci         Run local CI checks (server + admin + desktop)"
    Write-Host "  version    Show recent 10 versions; pass a version to sync+tag+push"
    Write-Host "  help       Show this help message"
    Write-Host ""
}

# Main logic
switch ($Command) {
    "" { Start-Backend }
    "admin" { Start-Admin }
    "desktop" { Start-Desktop }
    "bt" { Start-BranchTester }
    "all" { Start-All }
    "check" { Check-Desktop }
    "ci" { Check-CI }
    "version" {
        if ([string]::IsNullOrWhiteSpace($Version)) {
            Show-RecentVersions
        } else {
            Publish-VersionTag -RawVersion $Version
        }
    }
    "help" { Show-Help }
    default {
        Write-Err "Unknown command: $Command"
        Show-Help
        exit 1
    }
}
