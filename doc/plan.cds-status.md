# CDS 当前状态看板 · 计划

> **类型**:plan(总览看板) · **更新**:2026-05-03 · **状态**:活的 — 每次 handoff 必须更新本文件
>
> 这是 **CDS 唯一的"我在哪"入口**。任何 AI / 人类接手 CDS 改动前先读本页 30 秒,然后按需深入子文档。
>
> **不要**给 CDS 新建额外的 handoff/进度文档 — 全部归口本文件 + `plan.cds-backlog-matrix.md`(碎片项 SSOT)。

---

## 一、30 秒了解 CDS 现状

| 维度 | 状态 |
|---|---|
| 主分支 | `main` @ `f2c48716`(2026-05-02 PR #522 合) |
| 进行中分支 | `claude/cds-loose-ends-wrap-up`(2026-05-03,F11/F12/Bug A/B/C) |
| 远端实例 | `https://cds.miduo.org`(已 self-update 到 main) |
| 后端栈 | Node 20 + Express + MongoDB(`mongo-split` 默认),3000+ 测试 |
| 前端栈 | React + Vite + Tailwind + shadcn/ui(`cds/web/`),legacy `cds/web-legacy/` 逐页迁移中 |
| 测试 | vitest 1098 / 64 文件,pytest 90,tsc backend + web 全绿 |

---

## 二、大期路线图

```
2026-Q1                    2026-Q2(now)               2026-Q3+
─────────────────────────────────────────────────────────────────

✅ 基础设施服务         ✅ 多项目隔离              📋 项目模板库
✅ 基础设施发现         ✅ MySQL/Postgres 接入       📋 发布代理(Release Agent)
✅ 一键配置导入         ✅ Onboarding UAT 收尾      🔮 集群部署 + 远程 executor
✅ Stack 自动检测       🔨 React 迁移(60%+)
                         🔨 Onboarding 真人验收
```

### 已完成里程碑

| 里程碑 | 完成日期 | 关键 PR / commit |
|---|---|---|
| Phase 0 基础设施管理 | 2026-03-13 | 早期 |
| Phase 1 一键配置导入(`/cds-scan` + stack-detector) | 2026-04 | FU-03 nixpacks 推断 |
| Phase 2 多项目支持(P4 多项目隔离) | 2026-04-19 | PR #450 GitHub webhook |
| **MySQL/Postgres 接入(7 phase)** | 2026-04-30 | `cds-mysql-phase-1..7` |
| **Onboarding UAT 收尾(13 friction)** | 2026-05-02 | PR #522 |
| **mongo-split storage** | 2026-05 | 默认 `CDS_STORAGE_MODE=mongo-split` |
| **per-branch DB 隔离机制(代码层)** | 2026-05 | `applyPerBranchDbIsolation` + `dbScope='per-branch'` |
| **Onboarding 收尾第二波(F11/F12 + 3 UI bug)** | 2026-05-03 | `claude/cds-loose-ends-wrap-up` |

### 进行中

| 项 | 进度 | 阻塞 |
|---|---|---|
| **Onboarding UAT 真人验收剩余 22%** | 待真人浏览器跑 | 需用户跑[剩余清单](report.cds-onboarding-uat.md#真人-uat-剩余清单) |
| **React 迁移**(`cds/web-legacy/` → `cds/web/`) | ~60% | 见 [plan.cds-web-migration](plan.cds-web-migration.md) |
| **F16-UI**(BuildProfile 暴露 dbScope toggle) | 后端能力齐 / React 编辑器缺 | 等 React 迁移更进一步 |

### 未启动

| 项 | 触发条件 |
|---|---|
| 项目模板库(community) | 多项目跑稳定 + 用户主动需要 |
| Release Agent + 子节点注册 | 团队需要"测试→生产"全链路 |
| 远程 executor 集群 | 单机性能瓶颈 |

---

## 三、当前已知问题状态(F1-F18 + LIM-01..07)

### F 系列(onboarding UAT 暴露的 friction)

| ID | 等级 | 描述 | 状态 |
|---|---|---|---|
| F1 | P2 | mongo 单文档写放大 | ✅ 已解(默认 `mongo-split`) |
| F2 | P2 | 无 mongo→mongo-split 升级 API | ✅ 已解(同上,新装直接 mongo-split) |
| F3 | P1 | cdscli 缺 project create/clone/delete + branch create | ✅ 已修(Phase 16) |
| F4 | P1 | clone 后 autoConfigure 静默失败 | ✅ 已修 |
| F5 | P1 | cds.miduo.org 落后 main | ✅ 已修(self-update) |
| F6 | P1 | yml 没 x-cds-env-meta envMeta 全空 | ✅ 已修(`env-classifier.ts`) |
| F7 | P1 | POST /api/branches 字段名歧义 | ✅ 已修(cdscli 抹平) |
| F8 | P1 | deploy 不 block TODO 占位符 | ✅ 已修(F6 修后既有 412 路径生效) |
| F9 | P1 | GET /api/branches/:id 端点缺 | ✅ 已修 |
| F10 | P1 | in-progress logs 空 | ✅ 已修(`liveStreamHint`) |
| F11 | P3 | demo 必须 push GitHub 才能跑 | ✅ 已修 2026-05-03(`POST /api/projects` 沙盒模式) |
| F12 | P3 | init.sql 没 UI 上传入口 | ✅ 已修 2026-05-03(`POST /api/projects/:id/files` + EnvSetupDialog 卡片) |
| F13 | P4 | cdscli scan 不识别 init.sql | ✅ 已修 2026-05-03(verify INFO `infra-init-script-detected`) |
| F14 | P4 | `schemaful-db-no-migration` 误报 | ✅ 已修 2026-05-03(挂 init.sql 时不再 WARN) |
| F15 | HIGH | container-exec 输出回显 secret | ✅ 已修(`secret-masker.ts`) |
| F16 | P2 | per-branch DB 后缀未实施 | 🔨 后端能力齐(`dbScope='per-branch'`),UI 入口缺(F16-UI) |
| F17 | 契约违反 | 预览过渡页是纯文本 | ✅ 已修(SVG 双圈+CDS 字样) |
| F18 | P4 | repo picker 命名歧义(Tab vs Dialog) | ✅ 已修 2026-05-03(dropdown 直接弹 picker) |

**F 系列状态**:18 项中 **17 项已修**,剩 F16-UI(后端齐 / 前端 React 端没 BuildProfile 编辑器,等迁移)。

### Bug 系列(2026-05-03 用户反馈的 UI bug)

| ID | 描述 | 状态 |
|---|---|---|
| Bug A | BranchListPage 加载分支与远程引用 太慢 | ✅ 已修(取消远程 force-fetch 兜底) |
| Bug B | 运行中 vs 未运行 状态色区分弱 | ✅ 已修(font-semibold + dot + opacity) |
| Bug C | 服务详情左右分栏 → 顶部 tab | ✅ 已修(grid → flex-col) |

### LIM 系列(设计权衡,不是 bug)

| ID | 限制 | 处理 |
|---|---|---|
| LIM-01 | Mongo 16MB 单 doc 限制 | ✅ 已解(`mongo-split`) |
| LIM-02 | GitHub Device Flow 单租户 | deferred(等 P5 user model) |
| LIM-03 | Repo Picker 只取前 100 | ✅ 已解(FU-01 分页) |
| LIM-04 | Executor 不复用 multi-repo | deferred(等 P3 集群) |
| LIM-05 | Proxy auto-discovery 不跨项目 | wontfix(显式部署不受影响) |
| LIM-06 | 多 tab 并发 Device Flow race | wontfix(已知低概率) |
| LIM-07 | Volume / 持久化卷 UI 入口被砍 | ✅ 已解(2026-04-16) |

---

## 四、活的子文档(按读取顺序)

### 第一层:开始干活前必读
1. **本文件** — 当前状态
2. [plan.cds-backlog-matrix.md](plan.cds-backlog-matrix.md) — 碎片项 SSOT(UF/GAP/L10N/LIM/FU/TEST 系列)
3. [report.cds-onboarding-uat.md](report.cds-onboarding-uat.md) — Onboarding UAT 完整报告(合并自 5 个子文件)

### 第二层:架构 / 规格(改设计前读)
- [design.cds.md](design.cds.md) — CDS 主架构
- [spec.cds.md](spec.cds.md) — CDS 主规格
- [spec.cds-compose-contract.md](spec.cds-compose-contract.md) — compose 契约(verify 规则源)
- [spec.cds-project-model.md](spec.cds-project-model.md) — Project / Branch / InfraService 模型
- [design.cds-multi-project.md](design.cds-multi-project.md) — 多项目隔离设计
- [design.cds-resilience.md](design.cds-resilience.md) — 容错设计
- [design.cds-cluster-bootstrap.md](design.cds-cluster-bootstrap.md) — 集群启动(未启动)
- [design.cds-data-migration.md](design.cds-data-migration.md) — 数据迁移
- [design.cds-fu-02-auth-store-mongo.md](design.cds-fu-02-auth-store-mongo.md) — Auth store
- [design.cds-onboarding.md](design.cds-onboarding.md) — Onboarding 设计

### 第三层:操作指南(部署/调试/集成时读)
- [guide.cds-env.md](guide.cds-env.md) — 环境变量配置(必读)
- [guide.cds-ai-auth.md](guide.cds-ai-auth.md) — Agent 鉴权(三 Tab 接入)
- [guide.cds-multi-project-upgrade.md](guide.cds-multi-project-upgrade.md) — 多项目升级流程
- [guide.cds-multi-branch-db.md](guide.cds-multi-branch-db.md) — per-branch DB 用法
- [guide.cds-orm-support.md](guide.cds-orm-support.md) — ORM 接入
- [guide.cds-mysql-validation-runbook.md](guide.cds-mysql-validation-runbook.md) — MySQL 接入实战
- [guide.cds-mongo-migration.md](guide.cds-mongo-migration.md) — JSON → Mongo 迁移
- [guide.cds-cluster-setup.md](guide.cds-cluster-setup.md) — 集群部署
- [guide.cds-github-webhook-events.md](guide.cds-github-webhook-events.md) — webhook 事件
- [guide.cds-view-parity.md](guide.cds-view-parity.md) — legacy 视图迁移对照
- [guide.cds-web-migration-runbook.md](guide.cds-web-migration-runbook.md) — React 迁移 runbook

### 第四层:规则(改代码前必查)
- [rule.cds-mongo-migration.md](rule.cds-mongo-migration.md) — mongo migration 规则
- [rule.cds-project-isolation-audit.md](rule.cds-project-isolation-audit.md) — 跨项目隔离审计
- `.claude/rules/cds-theme-tokens.md` — 主题 token(白天禁暗色)
- `.claude/rules/scope-naming.md` — 系统级 vs 项目级命名
- `.claude/rules/cds-auto-deploy.md` — push 即部署(2026-04-19 起)

### 第五层:大期计划(架构决策时读)
- [plan.cds-roadmap.md](plan.cds-roadmap.md) — Phase 0-3 长期路线
- [plan.cds-multi-project-phases.md](plan.cds-multi-project-phases.md) — P0-P6 多项目大期
- [plan.cds-web-migration.md](plan.cds-web-migration.md) — React 迁移大期(~60%)
- [plan.cds-resilience-rollout.md](plan.cds-resilience-rollout.md) — 容错 rollout
- [plan.cds-deployment.md](plan.cds-deployment.md) — 部署策略

### 第六层:周报(历史)
- `doc/report.2026-W*.md` — 周报系列(`/weekly` skill 生成)

---

## 五、改动 CDS 的标准流程

```
开始干活
    ↓
读本文件 30 秒(知道在哪)
    ↓
读 plan.cds-backlog-matrix 看是否已有 ID(避免重复)
    ↓
按规则(`.claude/rules/`)动手改代码
    ↓
跑 `pnpm tsc --noEmit` + `pnpm vitest run` + `python3 -m pytest .claude/skills/cds/tests/`
    ↓
push → cds.miduo.org auto-deploy(等 2-5 分钟)
    ↓
真人验收 → 合 PR
    ↓
回到本文件 + plan.cds-backlog-matrix 把状态打勾 / 加新发现
```

---

## 六、维护本文件的规则

1. **每次 handoff 必更新**:大期里程碑 / F-Bug-LIM 状态 / 进行中分支
2. **不要新建独立 handoff 文档**:有内容直接进本文件 §二/§三,要详细推演进 `plan.cds-backlog-matrix`
3. **历史快照**:由 `doc/report.2026-W*.md` 周报承担,本文件只装 *现在*
4. **更新顺序**:本文件 → `MEMORY.md` → `doc/index.yml` + `doc/guide.list.directory.md`
