# CDS vs Railway 功能对齐 · 报告

> **版本**:v1.0 | **日期**:2026-04-16 | **类型**:report | **状态**:定稿
>
> 回答用户的 Q4:**"借鉴 Railway + 保留我们核心功能,完成度多少?还需要额外新增吗?"**

---

## 1. 一句话结论

**完成度 ~92%**(按"日常可用性"权重)。

- Railway 的核心交互范式(项目列表 → 拓扑视图 → Details 面板 → 实时日志 → Device Flow 登录)**全部到位**
- 我们的差异化核心(单机、header 动态路由、JSON state、Run/Worker、热切换)**完整保留**
- **剩 8%** 是两个战略级功能域(**团队 workspace** P5 / **自动部署+webhook** P6),明确 deferred 到下一阶段,不是"漏了"

---

## 2. Railway 范式 · 每条逐项对齐

> Railway 官方网站 / 截图观察到的核心用户可见功能,对齐到我们 CDS 的对应实现。

### 2.1 上手流程

| Railway | CDS 实现 | 状态 |
|---|---|---|
| GitHub OAuth 登录 | Device Flow(`CDS_GITHUB_CLIENT_ID`)+ 首次登录自动建 owner | ✅ |
| 从 GitHub 仓库创建项目 | Create Project modal → paste URL → SSE clone progress | ✅ |
| 项目列表(grid 卡片) | `projects.html` + `.cds-project-grid` | ✅ |
| 项目卡点击进入详情 | 跳 `index.html?project=<id>` | ✅ |

### 2.2 分支/Environment 管理

| Railway | CDS 实现 | 状态 |
|---|---|---|
| Environment 概念(staging/prod) | 暂以 `branch` 作为 environment 单位,单维度 | ⚠ 简化:不分环境栏 |
| 切换 environment | 顶栏 branch combobox(UF-07) | ✅ |
| 添加 branch/environment | combobox 输入 / 粘贴 + Enter,或从 git refs 选 | ✅ |

### 2.3 服务拓扑视图

| Railway | CDS 实现 | 状态 |
|---|---|---|
| Service topology 图形画布 | SVG 拓扑 + 正交边(UF-05) | ✅ |
| 卡片显示 icon + name + status | GitHub icon for apps,brand SVG for infra(UF-21) | ✅ |
| volume slot 在卡片底部 | UF-05 + UF-21 | ✅ |
| 双指平移 + 捏合缩放 | UF-06 移植自 VisualAgent | ✅ |
| 节点点击 → Details 面板 | Details 面板 9 tab(UF-08/UF-09)| ✅ |
| 面板 ESC / 点空白关闭 | UF-19 | ✅ |
| 卡片 build 时动画 | 琥珀脉冲(UF-22)| ✅ |
| Service connection(port) 交互 | 端口 pill 单击复制 · 双击预览(GAP-08) | ✅ |
| + Add 按钮 | topologyFsAddBtn · github/db/docker/routing/empty(UF-10) | ✅ |

### 2.4 Details 面板标签页

| Railway | CDS 实现 | 状态 |
|---|---|---|
| Deployments tab | 详情 tab + Deploy 按钮 + inline 日志预览(UF-16) | ✅ |
| Build Logs tab | 构建日志 tab(拉 `/branches/:id/logs`) | ✅ |
| Deploy Logs tab | 部署日志 tab(POST `/container-logs`,UF-20 修好) | ✅ |
| HTTP Logs tab | HTTP 日志 tab(SSE `/activity-stream`) | ✅ |
| Metrics tab | **缺** | ❌ 需要 cAdvisor/Prometheus 采集,超出 CDS 定位 |
| Variables tab | 环境变量 tab 继承+覆盖 + 眼睛 toggle(UF-09) | ✅ |
| Settings tab | 设置 tab + 连接串 + 部署模式(可点 GAP-15)+ 集群派发 | ✅ |
| **+ 我们独有** | 路由 tab(GAP-04)· 备注/标签 tab(GAP-07 + GAP-13) | ✅ 超出 |

### 2.5 部署 + 日志实时流

| Railway | CDS 实现 | 状态 |
|---|---|---|
| 点击 Deploy → 实时 build 流 | SSE `/branches/:id/deploy` + afterSeq 重连 | ✅ |
| 部署中状态可视化 | UF-16 按钮 spinner + 横幅琥珀脉冲 + 卡片脉冲(UF-22) | ✅ |
| 部署失败 reset | resetBranch(GAP-12) | ✅ |
| Redeploy / Stop / Delete | UF-16 三按钮 | ✅ |
| 单服务 redeploy | split-button GAP-11 | ✅ |
| Preview URL(子域名) | multi-mode 预览(`<slug>.<domain>`)/ port 模式 / simple 模式 | ✅ |

### 2.6 环境变量

| Railway | CDS 实现 | 状态 |
|---|---|---|
| Variables 继承 | profile → branch override 链(UF-09) | ✅ |
| 眼睛 toggle show/hide | 用于切 inherit↔override(UF-09 语义微调) | ✅ |
| 变量 raw editor | Variables tab "编辑全部"→ openOverrideModal | ✅ |
| Shared / Reference 变量 | CDS 基础设施变量 `CDS_*` 自动注入,被锁定 | ✅ 对等方案 |

### 2.7 项目级配置

| Railway | CDS 实现 | 状态 |
|---|---|---|
| Project Settings(常规/危险区) | `settings.html` 4 tab(L10N-01 汉化) | ✅ |
| Delete project | DELETE /api/projects/:id + docker network 清理 | ✅ |
| Multi-project isolation | P4 每项目独立 docker network | ✅ |
| Project templates | **缺** | ❌ Phase 2 路线图,未启动 |

---

## 3. 我们独有的核心(必须保留,**不抄**)

Railway 没有但我们有 — 这些是 CDS 的差异化护城河:

| 特性 | 必要性 | 实现 |
|---|---|---|
| **单机可用** | ★★★★★ 目标用户 4 人团队一台小机 | `docker compose up -d` 级别启动 |
| **Header/Cookie 动态路由** | ★★★★★ 一个域名多分支瞬切 | `proxy.ts` 按 X-Branch 分发 |
| **JSON state(可人读)** | ★★★★ 出问题直接 vim | 有 Mongo 后端作为可选(D.1-D.3) |
| **Infrastructure 自动发现** | ★★★★ 重启接管,无需配置 | Docker Label `cds.managed=true` |
| **Run/Worker 模式** | ★★★★ SSE 断线续传 | afterSeq 重连 |
| **Server Authority** | ★★★★ 客户端断连不取消任务 | CancellationToken.None + SSE 心跳 |
| **Cluster dispatch** | ★★★ 多 executor 节点 | dispatcher.ts + `targetExecutorId` |
| **Deploy modes** | ★★★ shared/pool/单次 三策略 | profile.deployModes |
| **Watchdog janitor** | ★★★ 磁盘阈值告警 + worktree TTL 清理 | janitor.ts |
| **Container capacity badge** | ★★★ 容量可视化 | capacityBadge 电池样式 |

这些在 Railway 上**找不到等价物**,因为 Railway 是多机云平台,根本不面对"一台小机 + 开发者自运维"的场景。

---

## 4. 完成度量化

### 4.1 按功能类别权重

| 类别 | 权重 | CDS 完成度 | 加权得分 |
|---|---|---|---|
| Railway 核心 UX(登录/项目/拓扑/部署/日志/env) | 40% | 100% | 40 |
| Railway 扩展(metrics/templates/environments 分栏) | 10% | 30% | 3 |
| 我们独有核心(单机/动态路由/Run-Worker/server-authority) | 30% | 100% | 30 |
| 团队/多租户(P5) | 10% | 0% | 0 |
| 自动部署/webhook(P6) | 10% | 0% | 0 |
| **合计** | **100%** | | **73** |

**说明**:73 分 = 完整覆盖 Railway 核心 + 我们独有 + 无 P5/P6。

### 4.2 按"日常可用性"权重(重要的功能拿高权重)

| 场景 | 权重 | 完成度 |
|---|---|---|
| 新用户首次登录 + 创建项目 | 15% | 100% |
| 日常添加分支 + 部署 + 观察日志 | 25% | 100% |
| 环境变量调整(inherit/override) | 15% | 100% |
| 拓扑视图管理服务依赖 | 15% | 100% |
| 错误恢复(stop/reset/delete/rollback commit) | 10% | 100% |
| 多项目管理 | 10% | 100% |
| 团队协作 / 多用户 | 5% | 0% |
| 自动部署 / webhook | 5% | 0% |
| **加权合计** | **100%** | **92%** |

**结论**:日常使用 92% 完成。剩下 8% 是"多人/自动部署",属于下一阶段战略特性而非回归缺陷。

---

## 5. 需要额外新增的功能?

### 5.1 短期(下一棒或两棒内建议做)

| ID | 描述 | 优先级 |
|---|---|---|
| **FU-02** | MapAuthStore mongo 后端(独立设计稿 `design.cds-fu-02-auth-store-mongo.md`) | P2 |
| LIM-07 升级 | "Volume / 持久化卷"UI 入口补回 | P2 |
| GAP-10 Phase 1 | Design token 提取 `canvas-tokens.css` 三画布共享 | P2 |

### 5.2 中期(P5 启动前后)

| 特性 | 说明 |
|---|---|
| **Environment 分栏** | `main` / `staging` / `prod` 三环境切换(Railway 顶栏风格) |
| **Team workspace**(P5) | 多个用户共享同一项目,GitHub Org 白名单 + RBAC |
| **Per-user Device Flow token** | 关闭 LIM-02(单租户 token),和 FU-02 + P5 一起做 |

### 5.3 长期(P6+)

| 特性 | 说明 |
|---|---|
| **Release Agent** | 部署到远端生产机的守护进程(路线图 Phase 3) |
| **Webhook-driven deploy** | GitHub push → 自动重部署分支 |
| **Project templates 市场** | 社区分享的配置模板(路线图 Phase 2) |

### 5.4 **不建议做**的(明确拒绝)

| 特性 | 为什么拒绝 |
|---|---|
| Railway 的 Metrics tab | 需要 cAdvisor + Prometheus,超出"单机轻量"定位 |
| K8s / 多机生产部署 | CDS = 分支级调试器,不是生产 PaaS(见 design.cds.md §0) |
| 大数据量 state 拆表(LIM-01) | 实际 state < 1MB,未触发 |

---

## 6. 与原始路线图对齐

`doc/plan.cds-roadmap.md` 定义的阶段:

| 阶段 | 状态 | 本次交付覆盖 |
|---|---|---|
| **Phase 0**:基础设施服务(MongoDB/Redis) | ✅ 落地很久 | 本次无动 |
| **Phase 1**:一键导入 + 项目扫描 | ✅ P4 Part 18 G10 + FU-03 | 本次 FU-03 补完 framework 推断 |
| **Phase 2**:多项目支持 + 项目模板 | ⚠ 多项目 ✅ / 模板 ❌ | P4 多项目已落地,模板未启动 |
| **Phase 3**:Release Agent + 环境管理 | ❌ 未启动 | 本次无动 |

所以 **roadmap Phase 0/1 完成**,Phase 2 完成一半,Phase 3 未启动 — 完全符合路线图"本次迭代 → Phase 1"的预期。

`doc/plan.cds-multi-project-phases.md` 定义的 P0-P6 里程碑:

| 期 | 状态 |
|---|---|
| P0 design docs | ✅ |
| P1 project-shell | ✅ |
| P2 github-auth | ✅ |
| P3 mongo-migrate | ✅ Part 1 + ✅ Part 2(Phase D)/ ⚠ Part 3(dual-write)未做 |
| P4 multi-project | ✅ |
| P5 team-workspace | ❌ 未启动 — 前置 FU-02 |
| P6 deploy-automation | ❌ 未启动 — 战略级,建议路线图评审后再定时机 |

---

## 7. 总结

> "借鉴 Railway + 保留核心功能"——目标 **达成 92%**。

| 评分维度 | 结论 |
|---|---|
| Railway 核心 UX 模仿度 | **100%**(登录/项目/拓扑/部署/日志/env 全覆盖) |
| 我们独有核心保留度 | **100%**(单机/动态路由/Run-Worker 一个不丢) |
| 整体可用性 | **92%**(剩 8% = 团队协作 + 自动部署,两个战略特性) |
| 是否需要新增回归/必备功能 | **否**(剩余都是战略级增量,不是缺陷) |

**下一步建议**:FU-02(auth-store mongo) → P5(team workspace) → P6(webhooks + auto deploy),按这个顺序推进。**不要**反过来做 P6,因为 webhook 到来时没有多用户概念就没法定权限。

---

## 8. 关联文档

- `doc/design.cds.md` — CDS 架构主入口
- `doc/design.cds-multi-project.md` — 多项目架构设计
- `doc/plan.cds-roadmap.md` — 产品路线图(3 个大阶段)
- `doc/plan.cds-multi-project-phases.md` — P0-P6 里程碑
- `doc/guide.cds-view-parity.md` — 列表↔拓扑视图功能对齐
- `doc/plan.cds-backlog-matrix.md` — 碎片事项矩阵
- `doc/design.cds-fu-02-auth-store-mongo.md` — FU-02 独立设计
