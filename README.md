# PRD Agent

PRD Agent is a full-stack AI product workspace for turning product knowledge, defects, reports, reviews, workflows, and branch previews into auditable team operations.

The repository contains the production app, the admin console, the desktop client, CDS branch-preview infrastructure, and the supporting automation scripts.

## Start Here

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

| Service | URL |
| --- | --- |
| Web gateway and admin console | http://localhost:5500 |
| API | http://localhost:5000 |
| MongoDB | mongodb://localhost:18081 |
| Redis | localhost:18082 |

Local shortcuts:

```bash
./quick.sh          # backend only
./quick.sh admin    # admin console
./quick.sh all      # api + admin + desktop
```

Windows:

```powershell
.\quick.ps1
.\quick.ps1 all
```

## Repository Layout

```text
prd_agent/
├── prd-api/        # .NET 8 API and background workers
├── prd-admin/      # React admin console
├── prd-desktop/    # Tauri desktop client
├── cds/            # Cloud Dev Suite branch preview platform
├── llmgw/          # Centralized LLM gateway
├── claude-sdk-sidecar/ # Agent SDK sidecar service
├── e2e/            # Automated tests, manual probes, and test fixtures
├── scripts/        # Build, smoke, migration, and maintenance scripts
├── doc/            # Structured specs, designs, plans, guides, reports, debt notes
├── assets/         # Static design/reference assets and archived prototypes
├── .design/        # Editable design-canvas source files
├── changelogs/     # One changelog fragment per PR
└── deploy/         # Deployment support files
```

Root directory policy:

- Keep only project entrypoints, compose files, top-level documentation, and repository metadata in the root.
- Put exploratory HTML prototypes under `assets/prototypes/`.
- Put automated tests under `e2e/`, manual probes under `e2e/manual/`, and test fixtures under `e2e/fixtures/`.
- Put editable design-canvas sources under `.design/`; do not create parallel root-level design workspaces.
- Put operational scripts under `scripts/` unless they are intentionally kept as root entrypoints.
- Keep top-level path names ASCII-only; `scripts/tests/test_root_layout_contract.py` enforces the contract in CI.

## Main Capabilities

| Area | What it does |
| --- | --- |
| PRD and knowledge workspace | Markdown PRDs, document stores, Q&A, citations, comments, sharing, and cross-system peer sync |
| Product and defect operations | Product workflows, requirement/feature/defect lifecycle management, statistics, and review loops |
| TAPD bug reporting | Natural language defect descriptions become editable four-part TAPD bug drafts, then create-only submission after confirmation |
| Report and review agents | Weekly reports, review workflows, webhook feedback, and team reporting |
| Visual and literary workflows | Image generation, visual analysis, article illustration, and watermark support |
| Workflow automation | Visual workflow builder, scheduled execution, secrets, and run history |
| CDS branch previews | Branch builds, preview routing, resumable deployment records, reusable versions, rollback, and failure guidance |
| LLM gateway | Centralized model routing, model pools, logging, health scoring, and fallback strategy |

## Development Commands

Backend:

```bash
cd prd-api
dotnet build --no-restore
dotnet test tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore
```

Admin console:

```bash
cd prd-admin
pnpm install
pnpm dev
pnpm tsc --noEmit
pnpm lint
```

Desktop:

```bash
cd prd-desktop
pnpm install
pnpm tauri:dev
```

CDS:

```bash
./exec_cds.sh init
./exec_cds.sh start
./exec_cds.sh status
```

CDS acceptance test:

```bash
./scripts/cds-acceptance-test.sh --list
```

## Quality Gates

Before pushing code:

- Frontend projects use `pnpm` only.
- C# changes must compile with `dotnet build --no-restore`.
- TypeScript changes must pass `pnpm tsc --noEmit`.
- UI changes need browser or visual verification.
- Code changes require a changelog fragment in `changelogs/`.
- Do not commit generated screenshots, local acceptance artifacts, build outputs, or dependency directories.

Full contributor rules are in [AGENTS.md](AGENTS.md).

## Documentation

Docs in `doc/` use strict prefixes:

`pri` abbreviates Principles. Root-level `pri.<type>.md` files explain each document type; individual documents live in `doc/`. Current specifications and designs evolve, while accepted or rejected decisions preserve their rationale and use successor records for substantive changes.

| Prefix | Purpose | Principles |
| --- | --- | --- |
| `spec.*` | Current product behavior and acceptance criteria | [pri.spec.md](pri.spec.md) |
| `design.*` | Current structure, responsibilities, and data flow | [pri.design.md](pri.design.md) |
| `plan.*` | Delivery sequence, ownership, and completion criteria | [pri.plan.md](pri.plan.md) |
| `rule.*` | Current business and engineering constraints | [pri.rule.md](pri.rule.md) |
| `guide.*` | Task-oriented operating instructions | [pri.guide.md](pri.guide.md) |
| `report.*` | Time-bounded evidence; new repository reports are weekly reports | [pri.report.md](pri.report.md) |
| `debt.*` | Known gaps, impact, and closure conditions | [pri.debt.md](pri.debt.md) |
| `adr.*` | Important architecture and engineering decisions | [pri.adr.md](pri.adr.md) |
| `pdr.*` | Important product choices and business commitments | [pri.pdr.md](pri.pdr.md) |

Good entry points:

- [pri.adr.md](pri.adr.md) for ADR principles and the eight core principles for future maintainers.
- [pri.pdr.md](pri.pdr.md) for product foundations, structural commitments, and product decision records.
- [Decision governance guide](doc/guide.platform.decision-records.md) for project gaps, product methods, and cross-project adoption.
- [Decision practice](doc/guide.platform.decision-practice.md) for two real change replays, an independent-reader exercise, and a portable starting method.
- [AGENTS.md](AGENTS.md) for repository rules.
- [cds/README.md](cds/README.md) for the CDS managed-delivery quick start and user acceptance checklist.
- [doc/design.platform.peer-sync.md](doc/design.platform.peer-sync.md) for system interconnection.
- [doc/design.cds.md](doc/design.cds.md) for branch previews.
- [doc/design.platform.llm-gateway.md](doc/design.platform.llm-gateway.md) for model routing.
- [doc/design.product-agent.md](doc/design.product-agent.md) for product workflows.

## Deployment

```bash
./exec_dep.sh
```

For local production-like builds:

```bash
./local_exec_dep.sh up
```

For branch preview deployment, use CDS through `./exec_cds.sh` or the CDS dashboard.

## License

MIT
