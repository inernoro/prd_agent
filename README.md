## PRD Agent

PRD Agent is a purpose-built assistant for **understanding Product Requirement Documents (PRDs)**. It acts as the PM’s “voice”, aiming to make **“the document itself the shared consensus”** through guided explanations, role-aware Q&A, and collaborative sessions.

### Core features
- **Markdown PRD upload & parsing**: structure extraction (headings/lists/tables), token estimation, fast load.
- **Role-based perspectives**: PM / DEV / QA viewpoints that change priorities and output style.
- **Two interaction modes**:
  - Q&A (SSE streaming)
  - Guided walkthrough (step-by-step explanation)
- **Group collaboration**: PM creates groups bound to a PRD; others join via invite; shared session timeline.
- **Content-gap detection**: flags questions not covered by the PRD and records actionable "missing spec" items.
- **Attachments**: images (clipboard paste/drag-drop) and documents as message context.
- **Admin console**: user management, LLM configuration, request logs, token usage statistics.
- **Open Platform API**: OpenAI-compatible API for external integrations (PRD Q&A + LLM proxy modes).

### Architecture (high level)
- **Desktop app**: Tauri (Rust core) + React UI
- **Backend API**: .NET 8 (REST + SSE) with `/api/v1/`
- **Admin Web**: React (Vite)
- **Infra**: MongoDB + Redis; optional object storage (Tencent COS / S3-compatible)
- **Gateway**: Nginx routes `/api/*` to the backend and serves the admin static site

---

## Repository layout

```text
prd_agent/
  doc/                    # product & engineering docs
  prd-api/                 # .NET backend (API)
  prd-desktop/             # Tauri desktop app (React + Rust)
  prd-admin/               # Admin web console (React)
  deploy/nginx/            # Nginx gateway config
  deploy/web/dist/         # Admin static output expected by docker-compose.yml
  scripts/                 # build/dev scripts
  docker-compose.yml       # gateway + production-like stack (pulls api image)
  docker-compose.dev.yml   # dev stack (builds api + gateway; publishes Mongo/Redis ports)
  quick.ps1 / quick.sh     # convenience launchers
```

---

## User guide

### Run with Docker (recommended)

#### Development stack (build everything locally)

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

- Web (gateway + admin static): `http://localhost:5500`
- API (exposed from container): `http://localhost:5000`
- MongoDB: `mongodb://localhost:18081`
- Redis: `localhost:18082`

#### Production-like stack (pull API image)

`docker-compose.yml` uses a gateway container (`:5500`) and pulls the API image by default: `ghcr.io/inernoro/prd_agent/prdagent-server:latest`.

You **must** provide a strong JWT secret:

```bash
JWT_SECRET="change-me-in-prod" docker compose up -d
```

Notes:
- The gateway serves static files from `deploy/web/dist/`.
- This repo does **not** include a one-click `deploy.sh`; use `docker compose` directly.

### Build the admin static site for the gateway

The gateway expects the admin build output in `deploy/web/dist/`.

```bash
pnpm -C prd-admin install
pnpm -C prd-admin build
```

Then copy `prd-admin/dist/` into `deploy/web/dist/` (any method is fine). Example (PowerShell):

```powershell
Remove-Item -Recurse -Force .\deploy\web\dist\* -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force .\prd-admin\dist\* .\deploy\web\dist\
```

---

## Developer guide

### Prerequisites
- Node.js 18+
- pnpm 8+
- .NET 8 SDK
- Rust 1.70+
- Docker + Docker Compose

### Local development (scripts)

#### Windows (PowerShell)

```powershell
.\quick.ps1 all
```

Or start individual components:

```powershell
.\quick.ps1          # API only
.\quick.ps1 admin    # Admin only
.\quick.ps1 desktop  # Desktop only
```

#### Alternative dev script (spawns multiple terminals)

```powershell
.\scripts\dev.ps1 -Component all
```

Expected dev ports:
- API: `http://localhost:5000`
- Admin (Vite): `http://localhost:8000`
- Desktop dev server (Tauri): `http://localhost:1420`

### Run components manually

#### Backend API

**Manual build (requires .NET 8 SDK):**

```powershell
cd prd-api/src/PrdAgent.Api
dotnet watch run
```

**Build using Docker (no .NET SDK required):**

适用于没有安装 .NET SDK 的服务器环境：

```powershell
# Windows
.\scripts\build-server-docker.ps1

# Linux/macOS
./scripts/build-server-docker.sh
```

产物输出到 `prd-api/output/` 目录。可直接运行：

```powershell
cd prd-api/output
dotnet PrdAgent.Api.dll
```

#### Admin console

```powershell
cd prd-admin
pnpm install
pnpm dev
```

The dev server proxies `/api/*` to `http://localhost:5000` (see `prd-admin/vite.config.ts`).

#### Desktop app

```powershell
cd prd-desktop
pnpm install
pnpm tauri:dev
```

The desktop app includes a **Settings** dialog to configure the API base URL. In developer mode, the default is `http://localhost:5000`.

---

## Configuration

### LLM configuration (admin-first)

Recommended: configure the active platform/model in the **Admin console** (stored in MongoDB).

Fallback for local development only:
- `LLM__ClaudeApiKey` (required for fallback)
- `LLM__Model` (optional; defaults to `claude-3-5-sonnet-20241022`)

Never commit secrets. Use environment variables or your secret manager.

### Backend environment variables (high signal)
- `MongoDB__ConnectionString`, `MongoDB__DatabaseName`
- `Redis__ConnectionString`
- `Jwt__Secret` (required in production)
- `Session__TimeoutMinutes` (defaults to 30)
- `ASSETS_PROVIDER` (`tencentCos` / `local` / `auto`)
- Tencent COS (if enabled): `TENCENT_COS_BUCKET`, `TENCENT_COS_REGION`, `TENCENT_COS_SECRET_ID`, `TENCENT_COS_SECRET_KEY`, `TENCENT_COS_PUBLIC_BASE_URL`, `TENCENT_COS_PREFIX`

### Admin environment variables
- `VITE_API_BASE_URL` (optional). If empty, the admin uses same-origin `/api` and relies on gateway/proxy.

---

## Versioning (desktop packaging)

The desktop bundle version is synced across:
- `prd-desktop/src-tauri/tauri.conf.json`
- `prd-desktop/src-tauri/Cargo.toml`
- `prd-desktop/package.json`

Sync helper:
- `./quick.sh version vX.Y.Z`
- `bash scripts/sync-desktop-version.sh vX.Y.Z`

---

## Docs
- `doc/1.why.md`: background and design principles
- `doc/2.srs.md`: system spec (API contracts, SSE, data model)
- `doc/3.prd.md`: product requirements and acceptance criteria
- `doc/4.dev.md`: developer guide (deeper details)
- `doc/rule.data-dictionary.md`: persistent storage dictionary (must keep updated)
- `doc/design.open-platform.md`: Open Platform API feature overview
- `doc/open-platform-complete-test.md`: comprehensive testing guide for Open Platform

---

## License

MIT

