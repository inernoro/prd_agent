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
├── changelogs/       # 更新记录碎片（每 PR 一个文件，发版时合并）
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

### 4. 更新记录维护（Changelog Fragments）

对 `prd-api/`、`prd-admin/`、`prd-desktop/`、`prd-video/` 的任何代码变更（feat/fix/refactor/perf），**提交前必须**在 `changelogs/` 目录创建碎片文件，**禁止直接编辑 `CHANGELOG.md`**。

#### 碎片文件规则

- 文件名：`changelogs/YYYY-MM-DD_<短描述>.md`（如 `2026-03-19_safari-fix.md`）
- 内容为纯表格行（无表头），每行一条记录：
  ```
  | feat | prd-admin | 新增XX功能 |
  | fix | prd-api | 修复XX问题 |
  ```
- 同一 PR 的所有变更放在**一个碎片文件**中
- 纯文档变更（`doc/`）、纯 CLAUDE.md 规则调整可选记录

#### 发版合并

版本发布时执行 `bash scripts/assemble-changelog.sh`，自动将碎片文件按日期合并进 `CHANGELOG.md` 的 `[未发布]` 区域并删除碎片文件。

#### 为什么这样做

多分支并行开发时，直接编辑 `CHANGELOG.md` 会在同一位置插入内容导致 **必然冲突**。碎片文件各自独立，彻底消除合并冲突。

### 5. 禁止自动提交 PR

除非用户明确要求"提交 PR"/"创建 PR"/"提 PR"，否则**禁止自动创建 Pull Request**。
任务完成后只做 commit + push，不得擅自调用 PR 创建工具。
遇到阻塞无法完成的任务，向用户说明阻塞原因并等待指示，禁止提交半成品。

### 6. LLM 交互过程可视化

任何涉及大模型调用的功能，**必须**向用户展示交互过程，禁止让用户面对空白等待：

- **流式输出**：LLM 响应必须使用 SSE 流式推送，前端逐字/逐块渲染（打字效果）
- **进度反馈**：批量 LLM 任务必须推送进度事件（如"正在分析第 3/45 个缺陷…"）
- **思考过程**：如果 LLM 支持 thinking，应展示思考过程
- **阶段提示**：长任务拆分阶段，每个阶段开始时推送状态（准备中 → 分析中 → 生成中 → 完成）
- **兜底方案**：如无法流式输出，至少显示动画加载状态 + 预估耗时提示

原则：用户在等待 AI 响应时，屏幕上必须有持续变化的内容。静止的"加载中…"超过 2 秒即为体验缺陷。

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
| `snapshot-fallback.md` | `Controllers/**/*.cs`, `Services/**/*.cs` | 快照反规范化必须有等价覆盖的兜底查询路径 |
| `enum-ripple-audit.md` | `Enums/**/*.cs`, `types/**/*.ts` | 枚举/常量扩展时全栈 6 层涟漪审计 |
| `codebase-snapshot.md` | 无 glob (手动维护) | 项目快照：架构模式、功能注册表、98 个 MongoDB 集合 |

---

## 质量保障技能链

```
需求 → /validate → 设计 → /risk → /trace → 实现 → /verify → /cds-deploy → /preview → /handoff → /weekly
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
| **cn-brief-summary** | `200字总结` | 最终回复末尾追加200字内通俗总结 |
| **cds-project-scan** | `/cds-scan` | CDS compose YAML 生成 |
| **cds-deploy-pipeline** | `/cds-deploy` | 跨服务器灰度环境生命周期：部署/观测/诊断/操作/验证/清理 |
| **llm-visibility** | `/visibility` | LLM 交互可视化审计 + 组件指南 |
| **theme-transition** | `/theme-transition` | 主题切换圆形过渡动效 (View Transition API) |
| **create-executor** | `/create-executor` | CLI Agent 执行器全自动接入（读代码→生成→注册→自测） |

### 使用指引

1. **新需求提出时** → `/validate` 验证需求质量和价值（中大型功能必跑）
3. **方案评审时** → 先 `/risk` 评估风险，再 `/trace` 追踪关键链路
4. **开发完成后** → 先 `/verify` 交叉验证，再 `/cds-deploy` 一键部署+冒烟测试
5. **需人工验收时** → `/preview` 生成预览地址，用户直接打开验收
6. **提 PR 前** → `/resolve` 预合并主分支，AI 代替人类解决冲突
7. **准备上线时** → `/handoff` 生成交接清单（涉及 3+ 文件时自动触发）
8. **周五收尾时** → `/weekly` 生成本周总结（完成后自动触发 `/doc-sync`）
9. **写文档时** → `/doc` 查看类型速查，或直接创建文档时自动套用模板
10. **迁移/重构后** → `/hygiene`
