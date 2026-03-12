# PRD Agent

PRD Agent is a multi-platform intelligent assistant for **product requirement documents and team collaboration**. Starting as a PRD reader, it has evolved into a full-featured AI workspace with six specialized agents, an LLM gateway with advanced model scheduling, a configuration marketplace, and a desktop client — all backed by a unified .NET 8 API.

## Key Features

### Specialized Agents

| Agent | Description |
|-------|-------------|
| **PRD Agent** | Upload Markdown PRDs, get role-aware Q&A (PM / DEV / QA perspectives), guided walkthroughs, content-gap detection, and collaborative sessions with comments |
| **Visual Agent** | Advanced visual creation workspace — text-to-image generation, multi-image vision analysis, canvas editing, and watermark management |
| **Literary Agent** | Article illustration and literary creation — prompt templates, reference image configs, and image generation tailored for written content |
| **Defect Agent** | Issue tracking and defect management — project-scoped templates, escalation workflows, webhook notifications, timeout reminders, and statistics dashboard |
| **Video Agent** | Article-to-video tutorial generation powered by Remotion 4.0 — scene composition, animated text, particle effects, SVG path drawing, and transitions |
| **Report Agent** | Weekly report management — team structure, daily logs, data source integration, AI-assisted summaries, and review workflows |
| **Workflow Agent** | Visual workflow builder — drag-and-drop capsules, scheduled execution, secret management, and video generation integration |

### LLM Gateway

All LLM calls flow through a unified **LLM Gateway** (`ILlmGateway`) that provides:

- **Three-tier model scheduling** — Dedicated pool → Default pool → Legacy config fallback
- **AppCallerCode routing** — Each feature registers a caller code (e.g. `visual-agent.image.vision::generation`) for automatic model matching
- **Health management** — Automatic health scoring with failure demotion and recovery promotion
- **Unified logging** — Every request logs expected vs. actual model, tokens, latency, and resolution source

### Model Pool Engine

The **Model Pool** (`Infrastructure/ModelPool/`) is a standalone strategy engine with six scheduling strategies:

| Strategy | Behavior |
|----------|----------|
| **FailFast** | Try one model, fail immediately on error |
| **Sequential** | Ordered fallback chain |
| **RoundRobin** | Even load distribution across models |
| **WeightedRandom** | Probability-based selection |
| **LeastLatency** | Route to the fastest responding model |
| **Race** | Parallel requests, return first success |

Includes `PoolHealthTracker` for automatic model health monitoring and `HttpPoolDispatcher` for external endpoint pooling.

### Configuration Marketplace

A built-in marketplace ("Seafood Market") for sharing and forking configurations across teams:

- **Type registry** — Prompt templates, reference images, watermark configs (extensible via `CONFIG_TYPE_REGISTRY`)
- **Fork with whitelist** — `IForkable` interface ensures only safe fields are copied
- **Publishing** — Any config can be published/unpublished with fork counts tracked

### Open Platform API

OpenAI-compatible API for external integrations:

- PRD Q&A mode — query documents via API
- LLM proxy mode — use the gateway's model scheduling externally
- API key authentication with rate limiting

### Additional Capabilities

- **RBAC** — 60+ granular permissions with `AdminPermissionMiddleware`
- **Run/Worker pattern** — Long tasks (chat, image gen, video render) decoupled from HTTP; SSE streaming with `afterSeq` reconnection
- **Server authority** — Client disconnect never cancels server-side work; only explicit cancel API stops a task
- **Watermark system** — Per-app watermark configs with font management and ImageSharp rendering
- **Web hosting** — Publish HTML pages to COS with shareable links
- **Skill system** — Server-side public skills + client-side custom skills
- **Desktop auto-update** — Tauri 2.0 built-in updater
- **Rate limiting** — Redis-based sliding window (Lua script)
- **Attachments** — Image paste/drag-drop/upload as message context

### Cloud Dev Suite (CDS)

A built-in **branch preview and testing platform** that lets teams run and test multiple git branches in parallel without touching the production environment.

- **On-demand branch builds** — Visit an unbuilt branch and CDS automatically creates a git worktree, builds Docker containers, and streams live progress via SSE
- **Smart routing** — Requests are routed to the correct branch container via `X-Branch` header, `cds_branch` cookie, subdomain pattern (`<slug>.preview.example.com`), or configurable routing rules
- **Build profiles** — Define how each service is built and run (Docker image, commands, ports, shared cache mounts). Multiple profiles can coexist for API, frontend, etc.
- **Dashboard UI** (`:9900`) — Branch CRUD, build profile management, routing rules, per-branch environment variables, real-time deployment logs, and container status
- **Container orchestration** — Auto port allocation, Docker network isolation, health tracking, and environment file injection without shell escaping issues
- **Git worktree management** — Safe creation/removal, branch suffix matching, remote sync, and cleanup

```
CDS Architecture:

  :9900 — Dashboard (Express.js)
  :5500 — Worker (HTTP reverse proxy)

  Docker Network (cds-network)
  ├── mongodb (shared)
  ├── redis (shared)
  ├── prd-api-feature-a  :9001
  ├── prd-api-feature-b  :9002
  └── prd-api-hotfix-c   :9003
```

Launch with `./exec_bt.sh` (production) or `./exec_bt.sh --dev` (hot reload). See `doc/design.cds.md` for full design documentation.

## Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ prd-desktop  │  │  prd-admin   │  │  prd-video   │
│ Tauri 2.0    │  │ React + Vite │  │ Remotion 4.0 │
│ (Rust+React) │  │  (TypeScript)│  │ (TypeScript) │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                  │
       └────────┬────────┘                  │
                ▼                           ▼
        ┌───────────────┐          ┌───────────────┐
        │  Nginx Gateway│          │  Video Render  │
        │  (:5500)      │          │  (CLI/Worker)  │
        └───────┬───────┘          └───────────────┘
                ▼
        ┌───────────────┐
        │   prd-api     │
        │  .NET 8 API   │
        │  (:5000)      │
        └───┬───────┬───┘
            │       │
     ┌──────▼─┐  ┌──▼──────┐
     │MongoDB │  │  Redis   │
     │  8.0   │  │    7     │
     └────────┘  └─────────┘
```

## Repository Layout

```
prd_agent/
├── prd-api/               # .NET 8 backend (C# 12)
│   └── src/
│       ├── PrdAgent.Api/           # Controllers, Middleware, Workers
│       ├── PrdAgent.Core/          # Models, Interfaces, Security
│       └── PrdAgent.Infrastructure/# LLM clients, DB, Services, ModelPool/
├── prd-admin/             # React 18 admin console (Vite, Zustand, Radix UI)
├── prd-desktop/           # Tauri 2.0 desktop app (Rust + React)
├── prd-video/             # Remotion 4.0 video engine
├── cds/                   # Cloud Dev Suite (branch deployment dashboard)
├── doc/                   # Structured documentation (spec/design/plan/rule/guide/report)
├── deploy/                # Nginx config + static assets
├── scripts/               # Build & deployment scripts
├── docker-compose.yml     # Production stack (pulls API image)
├── docker-compose.dev.yml # Dev stack (builds from source)
└── quick.ps1 / quick.sh   # Convenience launchers
```

## Quick Start

### Prerequisites

- Docker + Docker Compose
- Node.js 18+ and pnpm 8+
- .NET 8 SDK (for local backend development)
- Rust 1.70+ (for desktop app development only)

### 1. Docker Compose (recommended)

**Development stack** — builds everything from source:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

| Service | URL |
|---------|-----|
| Web (Gateway + Admin) | http://localhost:5500 |
| API | http://localhost:5000 |
| MongoDB | mongodb://localhost:18081 |
| Redis | localhost:18082 |

**Production-like stack** — pulls pre-built API image:

```bash
JWT_SECRET="your-strong-secret" docker compose up -d
```

### 2. Local Development

**Start all services (Windows):**

```powershell
.\quick.ps1 all     # API + Admin + Desktop
.\quick.ps1          # API only
.\quick.ps1 admin    # Admin only
.\quick.ps1 desktop  # Desktop only
```

**Start all services (Linux/macOS):**

```bash
./quick.sh all
./quick.sh           # API only
```

**Start components individually:**

```bash
# Backend API
cd prd-api
dotnet watch run --project src/PrdAgent.Api    # http://localhost:5000

# Admin console
cd prd-admin
pnpm install && pnpm dev                       # http://localhost:8000

# Desktop app
cd prd-desktop
pnpm install && pnpm tauri:dev                 # http://localhost:1420
```

### 3. Build Admin for Gateway

The Nginx gateway serves the admin build from `deploy/web/dist/`:

```bash
pnpm -C prd-admin install
pnpm -C prd-admin build
cp -r prd-admin/dist/* deploy/web/dist/
```

## Configuration

### Environment Variables

Copy `.env.template` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| `MongoDB__ConnectionString` | Yes | MongoDB connection string |
| `MongoDB__DatabaseName` | Yes | Database name |
| `Redis__ConnectionString` | Yes | Redis connection string |
| `Jwt__Secret` | Production | JWT signing secret |
| `ASSETS_PROVIDER` | No | `tencentCos`, `local`, or `auto` |
| `Session__TimeoutMinutes` | No | Session timeout (default: 30) |

For Tencent COS storage: `TENCENT_COS_BUCKET`, `TENCENT_COS_REGION`, `TENCENT_COS_SECRET_ID`, `TENCENT_COS_SECRET_KEY`, `TENCENT_COS_PUBLIC_BASE_URL`, `TENCENT_COS_PREFIX`.

### LLM Configuration

Models are configured through the **Admin console** (recommended) and stored in MongoDB. The LLM Gateway handles all routing automatically.

For quick local development without the admin UI:

- `LLM__ClaudeApiKey` — API key for Claude
- `LLM__Model` — Model name (defaults to `claude-3-5-sonnet-20241022`)

Never commit secrets. Use environment variables or a secret manager.

## Testing

```bash
# Backend unit tests
cd prd-api && dotnet test PrdAgent.sln

# Unit tests only (skip integration)
dotnet test PrdAgent.sln --filter "Category!=Integration"

# Admin lint + type check
cd prd-admin && pnpm lint && pnpm tsc

# Admin unit tests
cd prd-admin && pnpm test

# Full CI check (Windows)
.\quick.ps1 ci
```

## Deployment

### Docker Build (no SDK required)

```bash
./scripts/build-server-docker.sh
```

Output goes to `prd-api/output/`. Run directly:

```bash
dotnet prd-api/output/PrdAgent.Api.dll
```

### Production Deployment

```bash
# One-line deploy (downloads release, validates checksums, starts containers)
./exec_dep.sh
```

### Desktop Versioning

Desktop version must stay in sync across `package.json`, `tauri.conf.json`, and `Cargo.toml`:

```bash
./quick.sh version vX.Y.Z
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend API | .NET 8, C# 12, ASP.NET Core |
| Admin Frontend | React 18, Vite, TypeScript, Zustand, Radix UI, Tailwind CSS |
| Desktop | Tauri 2.0, Rust, React |
| Video Engine | Remotion 4.0, React |
| Database | MongoDB 8.0 |
| Cache | Redis 7 |
| Gateway | Nginx |
| Package Manager | pnpm |

## Documentation

Structured docs live in `doc/` with six standardized types:

| Prefix | Purpose | Examples |
|--------|---------|---------|
| `spec.*` | What to build | Product specs, agent docs, user stories |
| `design.*` | How to build it | Architecture designs, technical analysis |
| `plan.*` | When to build it | Implementation plans |
| `rule.*` | Constraints | Coding standards, audit reports |
| `guide.*` | How to operate | Dev guides, runbooks |
| `report.*` | What happened | Weekly reports |

## License

MIT
