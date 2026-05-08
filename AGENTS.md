## Cursor Cloud specific instructions

### Services Overview

| Service | Port | Purpose |
|---------|------|---------|
| prd-api (.NET 8) | 5000 | Backend API (C# 12, ASP.NET Core) |
| prd-admin (Vite) | 8000 | React admin frontend (proxies `/api` to localhost:5000) |
| MongoDB 8.0 | 18081 | Primary datastore (115+ collections) |
| Redis 7 | 18082 | Session/cache management |

### Starting the development environment

Infrastructure (MongoDB + Redis) must run first:

```bash
sudo dockerd &>/tmp/dockerd.log &
sleep 3
sudo docker compose -f docker-compose.dev.yml up -d mongodb redis
```

Backend API (requires env overrides for Docker-mapped ports):

```bash
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
export MongoDB__ConnectionString="mongodb://localhost:18081"
export Redis__ConnectionString="localhost:18082"
export ASPNETCORE_ENVIRONMENT=Development
export TENCENT_COS_BUCKET="dev-placeholder"
export TENCENT_COS_REGION="ap-guangzhou"
export TENCENT_COS_SECRET_ID="dev-placeholder-id"
export TENCENT_COS_SECRET_KEY="dev-placeholder-key"
cd prd-api && dotnet run --project src/PrdAgent.Api --urls "http://0.0.0.0:5000"
```

Frontend admin:

```bash
cd prd-admin && pnpm dev
```

### Non-obvious gotchas

1. **Port mismatch**: `docker-compose.dev.yml` maps MongoDB to 18081 and Redis to 18082 (not default 27017/6379). When running API outside Docker, you must override `MongoDB__ConnectionString` and `Redis__ConnectionString`.

2. **Asset storage required**: The API requires `TENCENT_COS_BUCKET`, `TENCENT_COS_REGION`, `TENCENT_COS_SECRET_ID`, `TENCENT_COS_SECRET_KEY` env vars even in dev mode (there is no local fallback). Use placeholder values for startup; asset upload features will fail but the API itself will run.

3. **Default admin account**: On first startup, the API creates `admin / admin` (password: admin). Login endpoint is `POST /api/v1/auth/login` with `{"username":"admin","password":"admin","clientType":"admin"}`.

4. **Invite code**: First startup also creates invite code `PRD-INIT-2024` (expires in 30 days).

5. **ESLint pre-existing errors**: `pnpm lint` in prd-admin reports 18 pre-existing errors (mostly `no-explicit-any`). These are not regressions.

6. **Auth endpoint path**: Auth routes are under `/api/v1/auth/...`, not `/api/auth/...`. Group routes are `/api/v1/groups/...`.

### Build/lint/test commands

See `prd-api/CLAUDE.md` and `prd-admin/CLAUDE.md` for canonical commands. Quick reference:

- **Backend build**: `cd prd-api && dotnet build`
- **Backend test**: `cd prd-api && dotnet test PrdAgent.sln --filter "Category!=Integration&Category!=Manual"`
- **Frontend typecheck**: `cd prd-admin && pnpm tsc --noEmit`
- **Frontend lint**: `cd prd-admin && pnpm lint`
- **Frontend test**: `cd prd-admin && pnpm test`
