# Deploy Script Template (Windows PowerShell)
# Copy this file and customize for your project
#
# Usage: .\deploy-myproject.ps1 <commit_hash> <short_hash> <branch> <project_id>
#
# Arguments:
#   $args[0] - Full commit hash (40 chars)
#   $args[1] - Short commit hash (7 chars)
#   $args[2] - Branch name
#   $args[3] - Project ID
#
# Environment Variables:
#   $env:PROJECT_ID   - Project identifier
#   $env:PROJECT_NAME - Project display name
#   $env:REPO_PATH    - Repository path

$ErrorActionPreference = "Stop"

Write-Host "========================================="
Write-Host "  Deploy Script"
Write-Host "========================================="
Write-Host "Project:  $env:PROJECT_NAME ($env:PROJECT_ID)"
Write-Host "Version:  $($args[1])"
Write-Host "Branch:   $($args[2])"
Write-Host "Repo:     $env:REPO_PATH"
Write-Host "========================================="

Set-Location $env:REPO_PATH

# ============================================
# Add your deployment logic below
# ============================================

# Example: Node.js project
# pnpm install --frozen-lockfile
# pnpm build
# pm2 restart $env:PROJECT_ID

# Example: .NET project
# dotnet restore
# dotnet publish -c Release -o ./publish
# Restart-Service MyService

Write-Host "========================================="
Write-Host "  Deploy completed successfully!"
Write-Host "========================================="
