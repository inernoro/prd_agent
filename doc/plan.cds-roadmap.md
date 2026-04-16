# CDS 产品路线图

> **版本**:v1.2 | **日期**:2026-04-16 | **状态**:Phase 0/1 全部落地 · Phase 2 多项目已完成(模板库未启动)· Phase 3 未启动

## 全景视图

```
2026-Q1 (已完成)                   2026-Q2 (进行中)               2026-Q3+ (未启动)
───────────────────────────────────────────────────────────────────────

  ┌─────────────────┐
  │ ✅ 基础设施服务   │  MongoDB/Redis 一键管理
  │ ✅ 基础设施发现   │  Docker Label 标记+重启接管
  └─────────────────┘

  ┌─────────────────┐
  │ ✅ 一键导入配置   │  /cds-scan + stack-detector + FU-03 框架推断
  │ ✅ 项目扫描技能   │  Next/Nest/Django/FastAPI/Flask/Rails 等 9 种
  └─────────────────┘
                          ┌─────────────────┐
                          │ ✅ 多项目支持     │  P4 多项目隔离(docker network + API scope)
                          │ 📋 项目模板库     │  社区分享配置(未启动)
                          └─────────────────┘
                                                ┌─────────────────┐
                                                │ 🔮 发布代理       │  Release Agent(未启动)
                                                │ 🔮 环境管理       │  staging/prod(未启动)
                                                └─────────────────┘
```

**2026-04-16 更新**:Phase 0 和 Phase 1 全部落地;Phase 2 多项目 ✅;模板库 📋 未启动;Phase 3 未启动。详见 `doc/report.cds-railway-alignment.md` 对 Railway 范式的完整对齐评估(~92% 完成度)。

---

## Phase 0：基础设施管理 ✅ 已完成

**日期**：2026-03-13

### 交付物

- [x] `InfraService` 类型定义 + Docker Named Volume 持久化
- [x] Docker Label 标记 (`cds.managed=true`) 实现容器发现
- [x] 启动时自动发现和接管已有基础设施容器
- [x] MongoDB / Redis 预设模板 + 一键初始化
- [x] 基础设施环境变量自动注入到分支容器
- [x] Dashboard UI: 启停/重启/日志/删除

### 关键文件

| 文件 | 变更 |
|------|------|
| `cds/src/types.ts` | `InfraService`, `InfraVolume`, `InfraHealthCheck`, `InfraPreset` |
| `cds/src/services/state.ts` | Infra CRUD + `getInfraInjectEnv()` |
| `cds/src/services/container.ts` | `startInfraService()`, `discoverInfraContainers()` |
| `cds/src/routes/branches.ts` | `/api/infra/*` 路由组 |
| `cds/src/index.ts` | 启动时容器发现 + env 注入 |
| `cds/web/app.js` | 基础设施设置 UI |

---

## Phase 1：一键配置导入 🔨 进行中

**目标**：非程序员 5 分钟完成配置。

### 改进 1：一键配置粘贴

| 任务 | 说明 | 状态 |
|------|------|------|
| Config JSON 格式定义 | `$schema: "cds-config-v1"` | 🔨 |
| `POST /api/import-config` | 验证 + 差异计算 + 应用 | 🔨 |
| `GET /api/export-config` | 当前配置导出为 JSON | 🔨 |
| Dashboard 导入 UI | 粘贴框 + 验证反馈 + 预览差异 | 🔨 |
| 导出按钮 | 设置菜单中一键导出 | 🔨 |

### 改进 2：项目扫描技能

| 任务 | 说明 | 状态 |
|------|------|------|
| `/cds-scan` 技能定义 | `.claude/skills/cds-project-scan/SKILL.md` | 🔨 |
| 项目结构识别 | `.csproj`/`package.json`/`go.mod`/`Cargo.toml` | 🔨 |
| Docker Compose 解析 | 提取 services → infraServices | 🔨 |
| 环境变量提取 | `.env.example` / `appsettings.json` | 🔨 |
| Monorepo 支持 | 扫描子目录识别多个可部署单元 | 🔨 |
| 排错信息 | 缺失字段用 `TODO:` 标注 | 🔨 |

### 验收标准

- [ ] 用户执行 `/cds-scan` → 获得完整 CDS Config JSON
- [ ] 用户粘贴 JSON 到 Dashboard → 看到验证结果和差异预览
- [ ] 用户确认 → 配置自动应用（构建配置 + 环境变量 + 基础设施）
- [ ] 导出当前配置 → JSON 文件可直接再次导入

---

## Phase 2：多项目支持 📋 规划中

**目标**：一个 CDS 实例管理多个 Git 仓库。

### 核心变更

| 组件 | 变更 |
|------|------|
| **数据模型** | 新增 `ProjectConfig`，每个项目独立 `CdsState` |
| **UI** | 左上角 ☰ 汉堡菜单，项目列表 + 切换 |
| **端口分配** | 每个项目独立端口段（如 10000-10999, 11000-11999） |
| **工作树** | 每个项目独立 worktreeBase 目录 |
| **路由** | 路由规则支持项目级别隔离 |
| **Docker 网络** | 可选：每个项目独立网络 or 共享网络 |

### 触发条件

当 CDS 在多个团队/项目中使用时启动此阶段。

---

## Phase 3：发布代理 🔮 远期

**目标**：从测试到生产的无缝衔接。

### 核心概念

- **Release Agent**：部署在目标服务器上的轻量守护进程
- **子节点注册**：Agent 启动后连接 CDS 主节点注册自己
- **发布指令**：CDS Dashboard 发出发布指令 → Agent 执行
- **回滚机制**：健康检查失败自动回滚

### 关键里程碑

| 里程碑 | 说明 |
|--------|------|
| Agent 协议定义 | WebSocket 通信协议、心跳、认证 |
| Agent 守护进程 | 镜像拉取 + 滚动更新 + 健康检查 |
| CDS 发布面板 | 选择分支 → 选择环境 → 一键发布 |
| 环境管理 | staging / production 标签 |
| 发布历史 | 审计日志、回滚记录 |

### 触发条件

当团队需要 CDS 覆盖"测试→发布"完整生命周期时启动此阶段。

---

## 关联文档

- **上手设计**：`doc/design.cds-onboarding.md`
- **环境配置**：`doc/guide.cds-env.md`
- **架构设计**：`doc/design.cds.md`
- **部署方案**：`doc/plan.cds-deployment.md`
