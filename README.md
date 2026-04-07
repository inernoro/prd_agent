# PRD Agent

> Full-stack AI workspace with six specialized agents, an LLM gateway, and a configuration marketplace.

---

## Project Structure

```
prd_agent/
├── prd-api/          # .NET 8 backend (C# 12)        → prd-api/CLAUDE.md
├── prd-admin/        # React 18 admin console (Vite)  → prd-admin/CLAUDE.md
├── prd-desktop/      # Tauri 2.0 desktop client       → prd-desktop/CLAUDE.md
├── prd-video/        # Remotion 4.0 video engine
├── cds/              # Cloud Dev Suite (branch deployment dashboard)
├── changelogs/       # Changelog fragments (one file per PR, merged on release)
├── doc/              # Structured docs (spec/design/plan/rule/guide/report)
└── scripts/          # Build & deployment scripts
```

## Quick Start

### Docker Compose (recommended)

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

| Service | URL |
|---------|-----|
| Web (Gateway + Admin) | http://localhost:5500 |
| API | http://localhost:5000 |
| MongoDB | mongodb://localhost:18081 |
| Redis | localhost:18082 |

### Local Development

```powershell
# Windows
.\quick.ps1           # Backend only
.\quick.ps1 all       # API + Admin + Desktop
```

```bash
# Linux / macOS
./quick.sh            # Backend only
./quick.sh all        # All services
```

### Start Components Individually

```bash
# Backend API
cd prd-api && dotnet watch run --project src/PrdAgent.Api    # http://localhost:5000

# Admin console
cd prd-admin && pnpm install && pnpm dev                     # http://localhost:8000

# Desktop app
cd prd-desktop && pnpm install && pnpm tauri:dev             # http://localhost:1420

# Video engine
cd prd-video && pnpm install && pnpm start
```

See each sub-directory's `CLAUDE.md` for module-specific build commands.

---

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

#### Workflow Agent Template Update: TAPD Defect Collection & Analysis

To support monthly governance requirements, the **TAPD Defect Collection & Analysis** template now includes a mandatory committee reporting block:

- **Purpose**: Ensure `AI technical service fee` is included in the technical committee monthly briefing with month-by-month analysis.
- **Automatic extraction fields** (if present in source data):
  - `AI技术服务费`
  - `AI 技术服务费`
  - `AI服务费`
- **Generated output fields**:
  - `monthlyBriefingRequirements`: fixed policy item, code `1p`
  - `aiServiceFeeMonthlyStats`: monthly amount, previous month amount, month-over-month rate, analysis text
- **HTML report rendering**:
  - Adds a dedicated section in the summary area showing the `1p` policy requirement
  - Adds a month-by-month fee table for direct use in the technical committee monthly briefing

### LLM Gateway

All LLM calls flow through a unified **LLM Gateway** (`ILlmGateway`):

- **Three-tier model scheduling** — Dedicated pool → Default pool → Legacy config fallback
- **AppCallerCode routing** — Each feature registers a caller code (e.g. `visual-agent.image.vision::generation`)
- **Health management** — Automatic health scoring with failure demotion and recovery promotion
- **Unified logging** — Every request logs expected vs. actual model, tokens, latency, and resolution source

### Model Pool Engine

Six scheduling strategies in `Infrastructure/ModelPool/`:

| Strategy | Behavior |
|----------|----------|
| FailFast | Try one model, fail immediately on error |
| Sequential | Ordered fallback chain |
| RoundRobin | Even load distribution |
| WeightedRandom | Probability-based selection |
| LeastLatency | Route to fastest model |
| Race | Parallel requests, return first success |

### Configuration Marketplace

A built-in marketplace for sharing and forking configurations:

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
- **Run/Worker pattern** — Long tasks decoupled from HTTP; SSE streaming with `afterSeq` reconnection
- **Server authority** — Client disconnect never cancels server-side work
- **Watermark system** — Per-app watermark configs with font management and ImageSharp rendering
- **Web hosting** — Publish HTML pages to COS with shareable links
- **Skill system** — 37 Claude Code skills for the full development lifecycle (see below)
- **Desktop auto-update** — Tauri 2.0 built-in updater
- **Rate limiting** — Redis-based sliding window (Lua script)

### Cloud Dev Suite (CDS)

Branch preview and testing platform for parallel development:

- **On-demand branch builds** — Visit an unbuilt branch → CDS auto-creates worktree, builds containers, streams progress via SSE
- **Smart routing** — `X-Branch` header, `cds_branch` cookie, subdomain pattern (`<slug>.preview.example.com`)
- **Build profiles** — Docker image, commands, ports, shared cache mounts
- **Dashboard UI** (`:9900`) — Branch CRUD, build profiles, routing rules, deployment logs

---

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

### Core Architecture Patterns

| Pattern | Description |
|---------|-------------|
| **Run/Worker** | Conversation creates Run → Worker executes in background → SSE with `afterSeq` reconnection |
| **Platform + Model** | `(platformId, modelId)` replaces legacy Provider concept |
| **App Identity** | Controllers hardcode `appKey` — never passed from frontend |
| **RBAC** | `SystemRole` + `AdminPermissionCatalog` (60+) + Middleware |
| **LLM Gateway** | `ILlmGateway` + `ModelResolver` + three-tier scheduling + health management |
| **Marketplace** | `CONFIG_TYPE_REGISTRY` + `IForkable` whitelist copy |

---

## Mandatory Rules

### 1. Frontend Package Manager: pnpm Only

All frontend projects (`prd-admin`, `prd-desktop`, `prd-video`) use **pnpm**. No npm/yarn. Only `pnpm-lock.yaml` is committed.

### 2. C# Static Analysis

After any `.cs` change:

```bash
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

- `error CS*` — must fix
- `warning CS*` — evaluate if introduced by current change

### 3. Changelog Fragments

Code changes to `prd-api/`, `prd-admin/`, `prd-desktop/`, `prd-video/` require a fragment file in `changelogs/` before commit. Never edit `CHANGELOG.md` directly.

- Filename: `changelogs/YYYY-MM-DD_<short-desc>.md`
- Content: table rows (no header), one record per line:
  ```
  | feat | prd-admin | Added XX feature |
  | fix | prd-api | Fixed XX issue |
  ```
- On release: `bash scripts/assemble-changelog.sh` merges fragments into `CHANGELOG.md`

### 4. LLM Interaction Visibility

Any LLM-calling feature must show interaction progress — no blank waiting:

- **Streaming** — SSE push, frontend renders character-by-character
- **Progress** — Batch tasks push progress events (e.g. "Analyzing defect 3/45…")
- **Stage indicators** — Long tasks show phase transitions (Preparing → Analyzing → Generating → Done)

### 5. Server Authority

Client disconnection never cancels server-side work. Only an explicit cancel API stops a task.

- LLM calls and DB writes use `CancellationToken.None`
- SSE writes catch `OperationCanceledException` — skip write but continue processing
- Long tasks decouple via Run/Worker pattern

---

## Architecture Rules (`.claude/rules/`)

Rules are loaded on-demand when editing matching files:

| Rule | Trigger Scope | Summary |
|------|---------------|---------|
| `app-identity.md` | `prd-api/src/**/*.cs` | Controllers hardcode `appKey`, 6 app identities |
| `data-audit.md` | `Models/**/*.cs`, `Controllers/**/*.cs` | New entity references must audit all consuming endpoints |
| `llm-gateway.md` | `prd-api/src/**/*.cs` | All LLM calls go through `ILlmGateway` |
| `frontend-architecture.md` | `**/*.{ts,tsx}` | No business state in frontend + SSOT + component reuse |
| `server-authority.md` | `prd-api/src/**/*.cs` | `CancellationToken.None` + Run/Worker + SSE heartbeat |
| `doc-types.md` | `doc/**/*.md` | 6 document prefixes (spec/design/plan/rule/guide/report) |
| `marketplace.md` | Marketplace files | `CONFIG_TYPE_REGISTRY` + `IForkable` whitelist copy |
| `snapshot-fallback.md` | `Controllers/**/*.cs`, `Services/**/*.cs` | Snapshot denormalization must have equivalent fallback query path |
| `enum-ripple-audit.md` | `Enums/**/*.cs`, `types/**/*.ts` | Full-stack 6-layer ripple audit on enum/constant changes |
| `codebase-snapshot.md` | Manual | Project snapshot: architecture patterns, feature registry, 101 MongoDB collections |

---

## Quality Assurance Skill Chain

37 Claude Code skills cover the full development lifecycle:

```
Requirement → /validate → Design → /plan-first → /risk → /trace → Implement → /verify → /scope-check → /cds-deploy → /smoke → /preview → /handoff → /weekly
```

### Lifecycle Skills

| Skill | Trigger | Input → Output |
|-------|---------|----------------|
| **skill-validation** | `/validate` | Requirement description → 8-smell detection + deduplication + 7-dimension score report |
| **plan-first** | `/plan-first` | Task description → Implementation plan + impact analysis, waits for user approval |
| **risk-matrix** | `/risk` | Change scope → MECE 6-dimension risk matrix (correctness/compat/perf/security/ops/UX) |
| **flow-trace** | `/trace` | Feature name → End-to-end data flow + control flow path diagram |
| **human-verify** | `/verify` | Code changes → Devil's advocate + reverse verification + boundary + scenario review |
| **scope-check** | `/scope-check` | Current branch → File classification (owned/shared/foreign) + boundary violation report |
| **cds-deploy-pipeline** | `/cds-deploy` | Code commit → Push to staging, wait for containers, run smoke tests |
| **smoke-test** | `/smoke` | Module name → Chained curl script scanning all Controller endpoints |
| **preview-url** | `/preview` | Current branch → Preview URL (`branch-name.miduo.org`) |
| **task-handoff-checklist** | `/handoff` | Current changes → 8-dimension handoff checklist |
| **weekly-update-summary** | `/weekly` | Time range → Categorized weekly report from git history |

### Workflow

```
0. First time?     → /help       (guided onboarding)
1. New requirement → /validate   (quality gate)
2. Design phase    → /plan-first (plan before code)
3. Review phase    → /risk + /trace
4. After coding    → /verify + /scope-check
5. Deploy & test   → /cds-deploy + /smoke
6. Acceptance      → /preview
7. Before PR       → /resolve    (merge main, resolve conflicts)
8. Ship            → /handoff
9. Friday wrap-up  → /weekly     (auto-triggers /doc-sync)
10. Writing docs   → /doc
11. Post-refactor  → /hygiene
```

Full skill catalog with consolidation recommendations: `doc/guide.skill-catalog.md`

---

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

### LLM Configuration

Models are configured through the **Admin console** and stored in MongoDB. The LLM Gateway handles all routing automatically.

For quick local development: `LLM__ClaudeApiKey` and `LLM__Model`.

## Testing

```bash
# Backend
cd prd-api && dotnet test PrdAgent.sln
dotnet test PrdAgent.sln --filter "Category!=Integration"    # Skip integration tests

# Frontend
cd prd-admin && pnpm lint && pnpm tsc && pnpm test
```

## Deployment

```bash
# Docker build (no SDK required)
./scripts/build-server-docker.sh

# Production deploy
./exec_dep.sh

# Desktop version sync
./quick.sh version vX.Y.Z
```

## Documentation

Structured docs in `doc/` with six standardized types:

| Prefix | Purpose | Examples |
|--------|---------|---------|
| `spec.*` | What to build | Product specs, agent docs, user stories |
| `design.*` | How to build it | Architecture designs, technical analysis |
| `plan.*` | When to build it | Implementation plans |
| `rule.*` | Constraints | Coding standards, audit reports |
| `guide.*` | How to operate | Dev guides, runbooks, skill catalog |
| `report.*` | What happened | Weekly reports |

## License

MIT
