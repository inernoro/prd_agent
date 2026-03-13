# CDS 极简上手设计：一键配置 + 项目扫描技能

> **版本**：v1.0 | **日期**：2026-03-13 | **状态**：设计中
>
> **核心目标**：非程序员用户 5 分钟内完成 CDS 从零到可用。

---

## 1. 问题背景

当前 CDS 配置流程对非程序员不友好：

| 步骤 | 当前操作 | 痛点 |
|------|----------|------|
| 构建配置 | 手动填写 Docker 镜像、命令、端口 | 需要知道 Docker 和构建命令 |
| 环境变量 | 手动逐条添加 MongoDB/Redis 连接串 | 需要知道变量名和格式 |
| 基础设施 | 手动创建 MongoDB、Redis 容器 | 需要知道 Docker 运行参数 |
| 路由规则 | 手动配置域名/头部匹配 | 需要理解反向代理概念 |

**目标**：将以上步骤统一为一个操作——**粘贴配置 JSON → 自动验证 → 一键应用**。

---

## 2. 解决方案总览

```
┌─────────────────────────────────────────────────────────┐
│                   用户视角（两步完成）                     │
│                                                          │
│  Step 1: AI 技能分析项目                                  │
│    /cds-scan → 扫描项目结构 → 输出 CDS Config JSON       │
│                                                          │
│  Step 2: 粘贴到 Dashboard                                │
│    设置 → 一键导入 → 粘贴 JSON → 验证 → 应用             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                   技术视角                                │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐           │
│  │ AI Skill │───→│ JSON Blob│───→│ CDS API  │           │
│  │ 项目扫描  │    │ 配置快照  │    │ 导入验证  │           │
│  └──────────┘    └──────────┘    └──────────┘           │
│                                       │                  │
│                       ┌───────────────┼───────────┐     │
│                       ▼               ▼           ▼     │
│                 buildProfiles    customEnv    infraServices│
│                 routingRules                              │
└─────────────────────────────────────────────────────────┘
```

---

## 3. CDS Config JSON 规范

### 3.1 完整格式

```jsonc
{
  "$schema": "cds-config-v1",
  "project": {
    "name": "prd_agent",                    // 项目名称
    "description": ".NET 8 + React 18 全栈"  // 简要描述
  },
  "buildProfiles": [
    {
      "id": "api",
      "name": "Backend API (.NET 8)",
      "dockerImage": "mcr.microsoft.com/dotnet/sdk:8.0",
      "workDir": "prd-api",
      "installCommand": "dotnet restore",
      "buildCommand": "dotnet build --no-restore",
      "runCommand": "dotnet run --no-build --project src/PrdAgent.Api/PrdAgent.Api.csproj --urls http://0.0.0.0:8080",
      "containerPort": 8080,
      "icon": "api",
      "cacheMounts": [
        { "hostPath": "/tmp/cds-cache/nuget", "containerPath": "/root/.nuget/packages" }
      ]
    },
    {
      "id": "admin",
      "name": "Admin Panel (Vite)",
      "dockerImage": "node:20-slim",
      "workDir": "prd-admin",
      "installCommand": "pnpm install",
      "runCommand": "npx vite --host 0.0.0.0 --port 5173",
      "containerPort": 5173,
      "icon": "web",
      "cacheMounts": [
        { "hostPath": "/tmp/cds-cache/pnpm", "containerPath": "/root/.local/share/pnpm/store" }
      ]
    }
  ],
  "envVars": {
    "MongoDB__ConnectionString": "mongodb://172.17.0.1:27017",
    "Redis__ConnectionString": "172.17.0.1:6379",
    "Jwt__Secret": "your-jwt-secret-here",
    "Jwt__Issuer": "prd-agent"
  },
  "infraServices": [
    {
      "presetId": "mongodb"
    },
    {
      "presetId": "redis"
    }
  ],
  "routingRules": []
}
```

### 3.2 字段验证规则

| 字段 | 必填 | 验证 |
|------|------|------|
| `$schema` | 是 | 必须为 `"cds-config-v1"` |
| `buildProfiles[].id` | 是 | 非空，唯一 |
| `buildProfiles[].dockerImage` | 是 | 非空 |
| `buildProfiles[].runCommand` | 是 | 非空 |
| `buildProfiles[].containerPort` | 是 | 1-65535 |
| `envVars` | 否 | Record<string,string> |
| `infraServices[].presetId` | 条件 | 如果使用预设则必填 |

### 3.3 导入行为

| 已存在的配置 | 导入行为 |
|-------------|---------|
| 同 ID 的 buildProfile | **替换**（以新配置为准） |
| 同 key 的 envVar | **覆盖**（新值替换旧值） |
| 同 ID 的 infraService | **跳过**（保留运行中的） |
| 同 ID 的 routingRule | **替换** |

---

## 4. AI 技能设计：cds-project-scan

### 4.1 工作原理

```
触发 → 扫描项目根目录 → 识别技术栈 → 检测配置文件 → 生成 Config JSON
```

### 4.2 扫描信号源

| 信号 | 推断 |
|------|------|
| `*.csproj` / `*.sln` | .NET 项目 → dotnet/sdk 镜像 |
| `package.json` + `vite.config.*` | Vite 前端 → node 镜像 |
| `package.json` + `next.config.*` | Next.js → node 镜像 |
| `go.mod` | Go 项目 → golang 镜像 |
| `Cargo.toml` | Rust 项目 → rust 镜像 |
| `docker-compose*.yml` | 提取 services → 映射为 infraServices |
| `Dockerfile` | 提取 FROM、EXPOSE、CMD |
| `.env` / `.env.example` | 提取环境变量模板 |
| `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` | 确定包管理器 |

### 4.3 排错与兼容

技能在生成配置时自动处理：

- **多包管理器**：检测 lockfile 确定正确的包管理器
- **Monorepo**：扫描子目录识别多个可部署单元
- **端口冲突**：不分配具体 hostPort（由 CDS 自动分配）
- **Docker Compose 迁移**：解析 services/volumes/networks 映射
- **缺失信息**：用占位符标注 `"TODO: ..."` 并提示用户确认

---

## 5. Dashboard 一键导入 UI

### 5.1 入口

设置菜单新增「一键导入」按钮，位于最顶部（最显眼位置）。

### 5.2 交互流程

```
[粘贴 JSON] → [实时验证] → [预览差异] → [确认应用]
                  │              │
                  ▼              ▼
             格式错误提示     显示将要:
             缺失字段提示     · 新增 N 个构建配置
                              · 覆盖 N 个环境变量
                              · 创建 N 个基础设施服务
                              · 跳过 N 个已存在项
```

### 5.3 配置导出

支持导出当前配置为 JSON，用于：
- 备份
- 分享给团队成员
- 迁移到新的 CDS 实例

---

## 6. 未来趋势

### 6.1 趋势一：多项目支持

**现状**：CDS 绑定单个 Git 仓库。

**未来**：左上角汉堡菜单（☰）切换项目。

```
┌──────────────────────┐
│ ☰ 项目选择            │
├──────────────────────┤
│ ★ prd_agent (当前)    │
│   ecommerce-platform  │
│   internal-tools      │
│ ─────────────────── │
│ + 添加项目            │
└──────────────────────┘
```

**数据隔离**：每个项目独立的 `state.json`、worktree 目录、端口段。

**配置结构变化**：
```jsonc
{
  "projects": {
    "prd_agent": {
      "repoRoot": "/home/user/prd_agent",
      "worktreeBase": "/home/user/.cds-worktrees/prd_agent",
      "portStart": 10000,
      "state": { /* current CdsState */ }
    },
    "ecommerce": {
      "repoRoot": "/home/user/ecommerce",
      "worktreeBase": "/home/user/.cds-worktrees/ecommerce",
      "portStart": 11000,
      "state": { /* ... */ }
    }
  },
  "activeProject": "prd_agent"
}
```

### 6.2 趋势二：集成发布代理

**现状**：分支测试通过 → 手动部署到生产。

**未来**：CDS 内置发布管道，测试满意后一键发布到目标环境。

```
CDS (测试验证)
    │
    ▼
发布代理 (Release Agent)
    │
    ├── 构建生产镜像
    ├── 推送到 Registry
    ├── 通知目标节点拉取
    │
    ▼
目标环境
    ├── 生产服务器 A
    ├── 生产服务器 B
    └── 预发布环境
```

**架构设想**：
- 发布代理是一个轻量守护进程，部署在目标服务器上
- 通过 WebSocket 与 CDS 主节点通信
- 注册为 CDS 的「发布子节点」
- CDS 发出发布指令 → 代理拉取镜像 → 滚动更新 → 回报状态

**代理能力清单**：
| 能力 | 说明 |
|------|------|
| 镜像拉取 | 从 Registry 拉取指定版本 |
| 滚动更新 | 旧容器 → 新容器无缝切换 |
| 健康检查 | 确认新版本启动正常 |
| 自动回滚 | 健康检查失败自动回到上一版本 |
| 日志收集 | 上报启动日志到 CDS Dashboard |
| 环境隔离 | 支持 staging / production 环境标签 |

---

## 7. 实施优先级

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **P0 (本次)** | 一键导入/导出 API + Dashboard UI | 立即实施 |
| **P0 (本次)** | cds-project-scan 技能 | 立即实施 |
| **P1 (下阶段)** | 多项目支持 (☰ 菜单 + 项目隔离) | 下一迭代 |
| **P2 (远期)** | 发布代理 (Release Agent) | 架构预留 |

---

## 关联文档

- **环境配置指南**：`doc/guide.cds-env.md`
- **部署方案**：`doc/plan.cds-deployment.md`
- **CDS 架构设计**：`doc/design.cds.md`
- **实施路线图**：`doc/plan.cds-roadmap.md`
