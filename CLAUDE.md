# CLAUDE.md

> PRD Agent 全栈项目。子目录 CLAUDE.md 含各模块构建命令，`.claude/rules/` 含按需加载的架构规则。

---

## 项目结构

```
prd_agent/
├── prd-api/          # .NET 8 后端 (C# 12)        → prd-api/CLAUDE.md
├── prd-admin/        # React 18 管理后台 (Vite)    → prd-admin/CLAUDE.md
├── prd-desktop/      # Tauri 2.0 桌面客户端        → prd-desktop/CLAUDE.md
├── prd-video/        # Remotion 视频合成
├── doc/              # 编号文档 (spec/design/plan/rule/guide/report)
└── scripts/          # 构建/部署脚本
```

## 快速启动

```bash
# Docker Compose (推荐)
docker compose -f docker-compose.dev.yml up -d --build
# Web: localhost:5500, API: localhost:5000, Mongo: localhost:18081, Redis: localhost:18082

# Windows
.\quick.ps1           # Backend only
.\quick.ps1 all       # Server + desktop + admin
```

各模块构建命令见子目录 CLAUDE.md（`prd-api/`、`prd-admin/`、`prd-desktop/`）。

### Video (prd-video/) — Remotion 4.0

```bash
cd prd-video && pnpm install && pnpm start
```

---

## 强制规则

### 1. 前端包管理器：pnpm Only

所有前端项目（`prd-admin`、`prd-desktop`、`prd-video`）统一使用 **pnpm**，禁止 npm / yarn。
Lockfile 仅保留 `pnpm-lock.yaml`，禁止提交 `package-lock.json` 或 `yarn.lock`。

### 2. C# 静态分析

任何 `.cs` 改动完成后必须执行（详见 `prd-api/CLAUDE.md`）：

```bash
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

- `error CS*`：必须修复
- `warning CS*`：评估是否为本次改动引入

### 3. 任务完成交接

完成开发任务后，**必须主动**使用 `task-handoff-checklist` 技能生成交接清单（涉及 3+ 文件变更、API 端点变更、或 UI 页面变更时）。1-2 个文件小修改无需生成。

### 4. 更新记录维护

对 `prd-api/`、`prd-admin/`、`prd-desktop/`、`prd-video/` 的任何代码变更（feat/fix/refactor/perf），**提交前必须**在 `CHANGELOG.md` 的 `[未发布]` 区域追加记录。

规则：
- 按日期分组，当日已有同类型同模块条目时**合并**而非新增行
- 纯文档变更（`doc/`）、纯 CLAUDE.md 规则调整可选记录
- 版本发布时将 `[未发布]` 条目包裹进 `## [x.y.z] - YYYY-MM-DD` 并补写 `用户更新项` 摘要
- 格式详见 `CHANGELOG.md` 底部维护规则

---

## 架构规则索引

以下规则按需加载（仅当编辑匹配 glob 的文件时），详见 `.claude/rules/`：

| 规则文件 | 触发范围 | 核心要点 |
|----------|----------|----------|
| `app-identity.md` | `prd-api/src/**/*.cs` | Controller 硬编码 appKey，6 个应用标识 |
| `data-audit.md` | `Models/**/*.cs`, `Controllers/**/*.cs` | 新增实体引用时审计所有消费端点 |
| `llm-gateway.md` | `prd-api/src/**/*.cs` | 所有 LLM 调用必须通过 ILlmGateway |
| `frontend-architecture.md` | `**/*.{ts,tsx}` | 前端无业务状态 + SSOT + 组件复用 + 默认可编辑 |
| `server-authority.md` | `prd-api/src/**/*.cs` | CancellationToken.None + Run/Worker + SSE 心跳 |
| `doc-types.md` | `doc/**/*.md` | 6 种文档前缀（spec/design/plan/rule/guide/report） |
| `marketplace.md` | 市场相关文件 | CONFIG_TYPE_REGISTRY + IForkable 白名单复制 |
| `codebase-snapshot.md` | 无 glob (手动维护) | 项目快照：架构模式、功能注册表、98 个 MongoDB 集合 |

---

## 质量保障技能链

```
需求 → /validate → 设计 → /risk → /trace → 实现 → /verify → /smoke → /preview → /handoff → /weekly
```

| 技能 | 触发词 | 用途 |
|------|--------|------|
| **skill-validation** | `/validate` | 需求气味检测 + 雷同排查 + 七维度打分 |
| **risk-matrix** | `/risk` | MECE 六维度风险评估 |
| **flow-trace** | `/trace` | 全链路数据流追踪 |
| **human-verify** | `/verify` | 多角度模拟验证 |
| **smoke-test** | `/smoke` | 链式 curl 端到端测试 |
| **task-handoff-checklist** | `/handoff` | 8 维度交接清单 |
| **preview-url** | `/preview` | 分支名生成预览验收地址 |
| **conflict-resolution** | `/resolve` | PR 前预合并 main |
| **weekly-update-summary** | `/weekly` | git 历史生成周报 |
| **doc-writer** | `/doc` | doc/ 文档类型守护 |
| **doc-sync** | `/doc-sync` | 文档索引同步 |
| **code-hygiene** | `/hygiene` | 9 维度代码卫生审计 |
| **create-skill-file** | `/create-skill` | 技能创建 & 质量评分 |
| **cds-project-scan** | `/cds-scan` | CDS compose YAML 生成 |
| **theme-transition** | `/theme-transition` | 主题切换圆形过渡动效 (View Transition API) |

### 使用指引

1. **新需求提出时** → `/validate` 验证需求质量和价值（中大型功能必跑）
3. **方案评审时** → 先 `/risk` 评估风险，再 `/trace` 追踪关键链路
4. **开发完成后** → 先 `/verify` 交叉验证，再 `/smoke-test` 跑端到端
5. **需人工验收时** → `/preview` 生成预览地址，用户直接打开验收
6. **提 PR 前** → `/resolve` 预合并主分支，AI 代替人类解决冲突
7. **准备上线时** → `/handoff` 生成交接清单（涉及 3+ 文件时自动触发）
8. **周五收尾时** → `/weekly` 生成本周总结（完成后自动触发 `/doc-sync`）
9. **写文档时** → `/doc` 查看类型速查，或直接创建文档时自动套用模板
10. **迁移/重构后** → `/hygiene`
