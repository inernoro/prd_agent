## Cursor Cloud specific instructions

### Services overview

| Service | Port | Tech | How to start |
|---------|------|------|-------------|
| prd-api | 5000 | .NET 8 (C# 12) | `cd prd-api && dotnet run --project src/PrdAgent.Api` |
| prd-admin | 8000 | React 18 + Vite | `cd prd-admin && pnpm dev` |
| MongoDB | 18081 | mongo:8.0 | `sudo docker start prdagent-mongodb` (or create with `sudo docker run -d --name prdagent-mongodb -p 18081:27017 -e MONGO_INITDB_DATABASE=prdagent mongo:8.0`) |
| Redis | 18082 | redis:7-alpine | `sudo docker start prdagent-redis` (or create with `sudo docker run -d --name prdagent-redis -p 18082:6379 redis:7-alpine`) |

prd-desktop (Tauri) and prd-video (Remotion) are optional for core development.

### Environment variables required to start prd-api

The API requires these env vars (set before `dotnet run`):

```bash
export MongoDB__ConnectionString="mongodb://localhost:18081"
export MongoDB__DatabaseName="prdagent"
export Redis__ConnectionString="localhost:18082"
export Jwt__Secret="YourSuperSecretKeyForJwtTokenGeneration2024!"
export ASPNETCORE_ENVIRONMENT="Development"
# Asset storage -- tencentCos or cloudflareR2; both need real credentials for upload features.
# Provide placeholder values to allow startup without cloud credentials:
export ASSETS_PROVIDER="tencentCos"
export TENCENT_COS_BUCKET="dev-placeholder"
export TENCENT_COS_REGION="ap-guangzhou"
export TENCENT_COS_SECRET_ID="dev-placeholder-id"
export TENCENT_COS_SECRET_KEY="dev-placeholder-key"
```

With placeholder COS credentials the API starts normally; file upload features will fail at runtime but all other functionality works (auth, agents, CRUD, LLM gateway, etc.).

### Default admin credentials

On first startup with a fresh MongoDB, the API auto-creates:
- Username: `admin` / Password: `admin`
- Invite code: `PRD-INIT-2024` (expires in 30 days)

### Docker daemon

The VM runs inside a Firecracker VM. Docker requires `fuse-overlayfs` storage driver and `iptables-legacy`. The update script handles Docker installation; to start the daemon manually: `sudo dockerd &>/tmp/dockerd.log &`.

### Gotchas

- `.NET SDK path`: Must export `DOTNET_ROOT=$HOME/.dotnet` and add to PATH (persisted in `~/.bashrc` by setup).
- `ASSETS_PROVIDER` has no "local" or "mock" mode; the only supported values are `tencentCos` and `cloudflareR2`. Use placeholder credentials for local dev.
- The frontend dev server (Vite) proxies `/api` requests to `localhost:5000`, so both backend and frontend must be running for the app to work.
- Package manager is **pnpm only** -- see `CLAUDE.md` rule #1.

### Standard commands reference

- **Build/test/lint**: See `README.md` "Testing" section and each sub-project's `CLAUDE.md`.
- **Full-stack Docker dev**: `docker compose -f docker-compose.dev.yml up -d --build` (needs real COS/R2 credentials in `.env`).
- **Quick launcher**: `./quick.sh` (backend), `./quick.sh all` (all services).
