# 扫描规则（cdscli scan）

## 产出契约

`cdscli scan` 产出 **CDS Compose YAML**——docker-compose 超集 + CDS 扩展：

```yaml
x-cds-project:              # 项目元数据
  name: <slug>
  description: "..."
  repo: https://github.com/...

x-cds-env:                  # 全局环境变量，CDS 自动注入所有容器
  JWT_SECRET: "TODO"
  AI_ACCESS_KEY: "TODO"

services:                   # 标准 docker-compose services
  api:
    image: mcr.microsoft.com/dotnet/sdk:8.0
    working_dir: /app
    volumes: [./:/app]      # 相对路径挂载 = App 服务
    ports: ["5000"]
    command: "..."
    labels:
      cds.path-prefix: /api/  # 代理前缀

  mongodb:
    image: mongo:8.0
    ports: ["27017"]        # 无相对路径 = Infra 服务
    volumes: [mongodb-data:/data/db]
```

## 扫描识别矩阵

| 信号 | 结论 |
|------|------|
| 子目录含 `.csproj` | `dotnet` 后端 → port 5000，`/api/` |
| 子目录 `prd-api|api|backend|server/` | 后端目录候选 |
| 根 / 子目录含 `package.json` | Node 前端，port 3000 或 8000 |
| `docker-compose*.y?ml` 里的 service name | Infra 候选（mongodb / redis / postgres 等）|
| 子目录含 `go.mod` / `Cargo.toml` | Go / Rust 后端（MVP 未自动识别） |

## 环境变量分类

- **全局共享**（所有容器用）→ `x-cds-env`：COS 凭证、JWT_SECRET、AI_ACCESS_KEY
- **服务特有** → `services.*.environment`：`ASPNETCORE_ENVIRONMENT`、连接串模板
- 全局变量在服务里引用用 `${VAR_NAME}` 语法，禁止重复声明

## 敏感值处理

扫描出的密钥字段一律写 `"TODO: 请填写实际值"`，**禁止**从 .env 直接读真实值并写入 YAML（防泄漏）。

## 路由前缀推断

| 栈 | 默认 labels.cds.path-prefix |
|----|------------------------------|
| .NET / 含 `Controller.cs` | `/api/` |
| Node Vite / React | `/` |
| 多后端共存 | 手动指定，CLI 不猜测 |

## --apply-to-cds 流程

```
cdscli scan --apply-to-cds <projectId>
  ├─ 扫描本地
  ├─ 拼装 compose YAML
  ├─ POST /api/projects/<projectId>/pending-import
  │    body: { agentName, purpose, composeYaml }
  └─ 返回 importId + 审批 URL
     https://$CDS_HOST/project-list?pendingImport=<importId>
```

用户点批准 → CDS 自动创建 infra 容器 + build profile。

## 前置检查（调用 --apply-to-cds 前）

1. `CDS_HOST` / `AI_ACCESS_KEY`（或 `CDS_PROJECT_KEY`）已设置
2. 目标 `projectId` 已知 —— 由用户从 Dashboard 项目卡片复制，**禁止 AI 自己猜**
3. 目标项目已完成 git clone（Settings → Repository）

## 常见栈的最小 YAML 样板

### .NET + Node 双服务

```yaml
x-cds-project:
  name: myapp
x-cds-env:
  JWT_SECRET: "TODO"
services:
  api:
    image: mcr.microsoft.com/dotnet/sdk:8.0
    working_dir: /app
    volumes: [./api:/app]
    ports: ["5000"]
    command: dotnet run --urls http://0.0.0.0:5000
    labels: { cds.path-prefix: "/api/" }
  web:
    image: node:20-slim
    working_dir: /app
    volumes: [./web:/app]
    ports: ["8000"]
    command: corepack enable && pnpm install && pnpm exec vite --host
    labels: { cds.path-prefix: "/" }
```

### 仅 Infra（数据库）

```yaml
x-cds-project: { name: data }
services:
  mongodb:
    image: mongo:8.0
    ports: ["27017"]
    volumes: [mongodb-data:/data/db]
    healthcheck:
      test: mongosh --eval "db.runCommand({ping:1})"
      interval: 10s
volumes: { mongodb-data: }
```

## CDS 运行时自动处理

以下问题**不要**在 YAML 里手工配置，CDS 运行时自动处理：

| 问题 | 自动处理 |
|------|---------|
| Node.js inotify ENOSPC | 自动注入 `PNPM_HOME=/pnpm`，store 移出 bind mount |
| Vite HMR WebSocket | 代理自动转发 WebSocket upgrade |
| `${CDS_*}` 模板 | 运行时解析为真实地址和端口 |
| 包缓存跨分支共享 | 自动挂 `/data/cds/<project>/cache/{nuget,pnpm,...}` |
| `/data/cds/` 目录 | 容器启动自动 `mkdir -p` |
