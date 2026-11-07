<p align="center">
  <img src="assets/readme/map-hero.svg?v=light-1" width="100%" alt="MAP — Midoo Agentic Platform. Create, freely. One desk for specialist agents, with model execution and branch delivery underneath." />
</p>

<p align="center">
  <a href="https://map.ebcone.net/home"><strong>Explore MAP</strong></a> &nbsp; / &nbsp;
  <a href="https://github.com/inernoro/prd_agent/releases/latest">Download desktop</a> &nbsp; / &nbsp;
  <a href="#product-tour">Product tour</a> &nbsp; / &nbsp;
  <a href="#project-status">Project status</a> &nbsp; / &nbsp;
  <a href="#get-started">Start here</a>
</p>

<p align="center">
  <a href="https://github.com/inernoro/prd_agent/releases/latest"><img src="https://img.shields.io/github/v/release/inernoro/prd_agent?style=flat-square&amp;label=release&amp;color=A94F36&amp;labelColor=26322B" alt="Latest published release" /></a>
  <a href="https://github.com/inernoro/prd_agent/releases"><img src="https://img.shields.io/github/downloads/inernoro/prd_agent/total?style=flat-square&amp;label=downloads&amp;color=A94F36&amp;labelColor=26322B" alt="Total GitHub release asset downloads" /></a>
  <a href="https://github.com/inernoro/prd_agent/commits/main/"><img src="https://img.shields.io/github/last-commit/inernoro/prd_agent/main?style=flat-square&amp;label=last+commit&amp;color=A94F36&amp;labelColor=26322B" alt="Latest commit on main" /></a>
</p>

**MAP brings specialist agents into one shared workspace.** Create and refine images on an infinite canvas. Write an article and illustrate it by paragraph. Read, rewrite, and connect knowledge in place. Turn repeatable work into a workflow, with model execution and branch delivery handled by dedicated layers underneath.

This repository, `prd_agent`, contains three products: **MAP**, the Midoo Agentic Platform; **LLMGW**, the model gateway; and **CDS**, Cloud Dev Suite.

## Product tour

### 01 / Create on a canvas

Generate, select, refine, and combine images in the same workspace. The infinite canvas keeps the variations in view; the assistant stays beside them. Image actions include upscaling, background removal, expansion, inpainting, and AI layers.

<picture>
  <source media="(max-width: 640px)" srcset="assets/readme/visual-workspace-mobile.svg?v=light-1" />
  <img src="assets/readme/visual-workspace.svg?v=light-1" width="100%" alt="Visual creation interface study: an infinite canvas with image variations, a floating toolbar and an AI designer on the right." />
</picture>

<sub>Interface studies use the shared visual theme of this README and example content based on the admin homepage. [Visual scene source](prd-admin/src/pages/home/scenes/VisualCanvasScene.tsx).</sub>

<br />

### 02 / Write and retain

The writing workspace keeps the article on the left and its illustration bench on the right. Generate illustrations by paragraph meaning; change their style while keeping the text intact.

The knowledge reader keeps files, document, and outline together. Select a passage to comment, rewrite, or illustrate it. Review the suggested edit before confirming it; explore relationships between documents in the knowledge galaxy.

<picture>
  <source media="(max-width: 640px)" srcset="assets/readme/writing-knowledge-mobile.svg?v=light-1" />
  <img src="assets/readme/writing-knowledge.svg?v=light-1" width="100%" alt="Writing and knowledge interface studies: an article with a separate illustration bench, and a three-pane reader with in-place editing and a document relationship graph." />
</picture>

<sub>[Writing scene](prd-admin/src/pages/home/scenes/LiteraryScene.tsx) &nbsp; / &nbsp; [Knowledge scene](prd-admin/src/pages/home/scenes/KnowledgeScene.tsx)</sub>

<br />

### 03 / Connect the work

Connect trigger, process, control, and output capsules on a canvas. Start from a template, inspect one capsule's input and output, then connect the next. Workflows can run on a timer or respond to a webhook.

<picture>
  <source media="(max-width: 640px)" srcset="assets/readme/workflow-strip-mobile.svg?v=light-1" />
  <img src="assets/readme/workflow-strip.svg?v=light-1" width="100%" alt="Example workflow from the admin homepage: manual trigger, TAPD collector, defect statistics, HTML rendering, export HTML and completion notice." />
</picture>

<sub>The illustrated chain comes from the [homepage's TAPD template](prd-admin/src/pages/home/i18n/landing.ts). [Workflow scene source](prd-admin/src/pages/home/scenes/WorkflowScene.tsx).</sub>

## Product architecture

Work in **MAP**, route model calls through **LLMGW**, and review a working branch through **CDS**.

<picture>
  <source media="(max-width: 640px)" srcset="assets/readme/platform-layers-mobile.svg?v=light-1" />
  <img src="assets/readme/platform-layers.svg?v=light-1" width="100%" alt="MAP takes work from a prompt through agents to an artifact. LLMGW routes a caller through its model pool and provider members. CDS turns a code branch into services and a preview address." />
</picture>

<p align="center"><sub><a href="doc/design.platform.llm-gateway.md">Model routing</a> &nbsp; / &nbsp; <a href="cds/README.md">Branch delivery</a> &nbsp; / &nbsp; <a href="#developer-reference">Source map</a></sub></p>

## Project status

<p align="center">
<a href="https://github.com/inernoro/prd_agent/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/inernoro/prd_agent/ci.yml?branch=main&amp;style=flat-square&amp;label=CI&amp;labelColor=26322B" alt="CI — latest main-branch workflow result" /></a>
  <a href="https://github.com/inernoro/prd_agent/actions/workflows/cds.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/inernoro/prd_agent/cds.yml?branch=main&amp;style=flat-square&amp;label=CDS+tests&amp;labelColor=26322B" alt="CDS tests — latest main-branch workflow result" /></a>
  <a href="https://github.com/inernoro/prd_agent/actions/workflows/server-deploy.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/inernoro/prd_agent/server-deploy.yml?branch=main&amp;style=flat-square&amp;label=server+image&amp;labelColor=26322B" alt="server image — latest main-branch workflow result" /></a>
  <a href="https://github.com/inernoro/prd_agent/actions/workflows/branch-image.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/inernoro/prd_agent/branch-image.yml?branch=main&amp;style=flat-square&amp;label=branch+image&amp;labelColor=26322B" alt="branch image — latest main-branch workflow result" /></a>
</p>
<p align="center">
<a href="https://map.ebcone.net"><img src="https://img.shields.io/website?url=https%3A%2F%2Fmap.ebcone.net&amp;style=flat-square&amp;label=web+HTTP&amp;up_message=reachable&amp;down_message=unreachable&amp;labelColor=26322B" alt="Public web entry — external HTTP reachability" /></a>
  <a href="https://github.com/inernoro/cds-independent-status/actions/workflows/watchdog.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/inernoro/cds-independent-status/watchdog.yml?branch=main&amp;style=flat-square&amp;label=watchdog&amp;labelColor=26322B" alt="watchdog — latest main-branch workflow result" /></a>
  <a href="https://github.com/inernoro/prd_agent/actions/workflows/cds-external-port-audit.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/inernoro/prd_agent/cds-external-port-audit.yml?branch=main&amp;style=flat-square&amp;label=port+audit&amp;labelColor=26322B" alt="port audit — latest main-branch workflow result" /></a>
</p>

<p align="center"><sub>Latest matching <code>main</code> runs. Web: HTTP reachability. Watchdog: heartbeat-check execution. Audit: scheduled port checks.<br />Open any badge for its source; run times and badge refreshes can vary.</sub></p>

## Get started

**Use the workspace** · [Open MAP](https://map.ebcone.net/home), sign in, choose an agent, and describe one task.

**Take it to the desktop** · [Download the latest release](https://github.com/inernoro/prd_agent/releases/latest) for macOS, Windows, or Linux.

**Develop or self-host** · Follow the [developer reference](#developer-reference) below for local setup, module checks, and deployment entrypoints.

## Documentation

[Product workflows](doc/design.product-agent.md) &nbsp; / &nbsp; [Model gateway](doc/design.platform.llm-gateway.md) &nbsp; / &nbsp; [Cloud Dev Suite](cds/README.md) &nbsp; / &nbsp; [Contributor rules](AGENTS.md) &nbsp; / &nbsp; [Changelog](CHANGELOG.md)

<a id="developer-reference"></a>
<details>
<summary><strong>Developer reference</strong> — setup, commands, agents, and source map</summary>

### Develop locally

Use the development Compose stack from a checkout of this repository with Docker and Compose available. On a fresh database, supply `MAP_INITIAL_ADMIN_USERNAME` and `MAP_INITIAL_ADMIN_PASSWORD` through your environment or a local `.env` file; the initializer validates this credential pair before creating the first administrator. See the [environment template](.env.template) for the broader configuration reference.

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Open **[http://localhost:5500](http://localhost:5500)** for the web console and sign in with that administrator account. Model-backed features also require configured providers and credentials through the gateway.

| Service | Development address |
| :--- | :--- |
| Web gateway and admin console | `http://localhost:5500` |
| API | `http://localhost:5000` |
| MongoDB | `mongodb://localhost:18081` |
| Redis | `localhost:18082` |

### Local development shortcuts

Use the existing launchers when developing with the local toolchains and configured infrastructure:

```bash
./quick.sh          # API + local LLM gateway serving
./quick.sh admin    # web console
./quick.sh all      # API + gateway + web console + desktop
```

Windows:

```powershell
.\quick.ps1
.\quick.ps1 all
```

The full desktop workflow uses the .NET, Node/pnpm, Rust, and Tauri development toolchains. Frontend packages use **pnpm**.

### Build and check individual modules

Backend, from `prd-api/`:

```bash
dotnet build --no-restore
dotnet test tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore --filter "Category!=Integration&Category!=Manual"
```

Web console, from `prd-admin/`:

```bash
pnpm install
pnpm dev
pnpm tsc --noEmit
pnpm lint
```

Desktop, from `prd-desktop/`:

```bash
pnpm install
pnpm tauri:dev
```

The test command above selects the non-integration, non-manual suite. See [AGENTS.md](AGENTS.md) for scope-specific checks, CI requirements, and integration test rules.

### Start Cloud Dev Suite and manage deployments

From the repository root:

```bash
./exec_cds.sh init
./exec_cds.sh start
./exec_cds.sh status
```

The CDS initialization flow prepares its configuration. See the [CDS guide](cds/README.md) for Agent onboarding, managed delivery, previews, and recovery.

List the CDS acceptance scenarios:

```bash
./scripts/cds-acceptance-test.sh --list
```

Project deployment entrypoint:

```bash
./exec_dep.sh
```

Local production-like builds:

```bash
./local_exec_dep.sh up
```

Use the deployment entrypoint with the environment configuration for your intended target. The development Compose stack is the local development path.

### Agent directory

The registry contains **30+ agents and tools**, grouped here by the work they help with. Preview entries retain their product labels.

| Create | Deliver | Retain | Coordinate |
| :--- | :--- | :--- | :--- |
| Visual agent | PR review agent | My shares | AI arena |
| Writing agent | Frontend partner **(Preview)** | Weekly report agent | Project management **(Preview)** |
| Video agent | CDS agent **(Preview)** | Markdown to slides | Product management **(Preview)** |
| Storyboard bench **(Preview)** | Defect reporting | Transcription bench | Blunt secretary **(Preview)** |

Search the Toolbox by the task you need to finish. The [tool registry](prd-admin/src/stores/toolboxStore.ts) and [homepage catalog](prd-admin/src/pages/home/i18n/landing.ts) define the entries and their availability.

### Implementation map

| Component | Responsibility | Source |
| :--- | :--- | :--- |
| MAP backend | .NET API, product operations, and background workers | [prd-api](prd-api/) |
| Web console | React interface for the workspace and administration | [prd-admin](prd-admin/) |
| Desktop client | Tauri desktop application | [prd-desktop](prd-desktop/) |
| LLM gateway | Model execution and request governance | [llmgw](llmgw/) |
| Cloud Dev Suite | Branch builds, previews, and delivery records | [cds](cds/) |
| Agent SDK sidecar | Supporting Agent SDK service | [claude-sdk-sidecar](claude-sdk-sidecar/) |

### Further reading and repository conventions

| For | Start here |
| :--- | :--- |
| The product and its story | [Admin homepage](prd-admin/src/pages/home/LandingPage.tsx) · [English and Chinese product copy](prd-admin/src/pages/home/i18n/landing.ts) |
| Product workflows | [Product Agent design](doc/design.product-agent.md) |
| Model pools and responsibility boundaries | [LLM gateway design](doc/design.platform.llm-gateway.md) |
| Branch previews and managed delivery | [CDS guide](cds/README.md) · [CDS architecture](doc/design.cds.md) |
| Knowledge shared across systems | [Peer sync design](doc/design.platform.peer-sync.md) |
| Contributor rules and checks | [AGENTS.md](AGENTS.md) |
| Changes across releases | [Changelog](CHANGELOG.md) |

### Repository and documentation conventions

The root keeps project entrypoints and top-level documentation. Supporting material lives with its owning module:

| Path | Contents |
| :--- | :--- |
| `doc/` | Specifications, designs, plans, rules, guides, reports, and debt notes |
| `scripts/` | Build, smoke, migration, acceptance, and maintenance tooling |
| `e2e/` | Automated tests, manual probes, and test fixtures |
| `assets/` | Static artwork, reference assets, and archived prototypes |
| `.design/` | Editable design sources |
| `changelogs/` | One changelog fragment per change set |
| `deploy/` | Deployment support files |

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

See the [decision governance guide](doc/guide.platform.decision-records.md) for project gaps and product methods, and [decision practice](doc/guide.platform.decision-practice.md) for two real change replays, an independent-reader exercise, and a portable starting method. Full naming, directory, change-record, and quality requirements are in [AGENTS.md](AGENTS.md).

README illustrations follow a shared [visual specification](assets/readme/design-system.json) for color, typography, geometry, and badge treatment.

### Model execution boundaries

The gateway selects members, records health, and retries within the selected model pool. Cross-pool substitution requires explicit authorization. CDS manages branch builds, preview routing, reusable versions, deployment records, and rollback.

### Build and operational evidence

[All workflow runs](https://github.com/inernoro/prd_agent/actions) · [Preview acceptance](https://github.com/inernoro/prd_agent/actions/workflows/preview-acceptance.yml) · [Heartbeat check history](https://github.com/inernoro/cds-independent-status/actions/workflows/watchdog.yml)

The architecture illustration follows the [homepage layer view](prd-admin/src/pages/home/scenes/LayersScene.tsx).

### License

MIT

</details>

<br />

<a href="https://map.ebcone.net/home">
  <picture>
    <source media="(max-width: 640px)" srcset="assets/readme/map-close-mobile.svg?v=light-1" />
    <img src="assets/readme/map-close.svg?v=light-1" width="100%" alt="Open MAP. Pick one agent. Finish one useful thing. MAP — Create, freely." />
  </picture>
</a>
