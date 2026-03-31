---
name: cds-project-scan
description: Scans project structure and generates CDS (Cloud Dev Space) compose YAML for one-click import. Detects tech stacks, infrastructure services, environment variables, and routing prefixes. Outputs standard docker-compose format with CDS conventions. Trigger words: "扫描项目", "生成 CDS 配置", "cds scan", "/cds-scan".
---

# CDS Project Scan — 项目结构扫描 & 配置生成

扫描项目技术栈、目录结构、Docker Compose、环境变量，生成可直接粘贴到 CDS Dashboard 的 compose YAML。

## 目录

- [强制规则](#强制规则)
- [执行流程](#执行流程)
- [输出格式](#输出格式)
- [端到端示例](#端到端示例)
- [异常处理](#异常处理)
- [关联文档](#关联文档)

## 强制规则

1. **禁止**在用户确认前输出最终配置
2. **禁止**未检查 Docker 可用性前执行 docker 命令
3. **禁止**未经用户同意执行基础设施初始化
4. **禁止**猜测密码/密钥，用 `"TODO: 请填写实际值"` 替代
5. **禁止**创建项目实际不需要的 buildProfile
6. **必须**先展示扫描摘要 → 用户确认 → 再生成配置
7. **必须**输出标准 docker-compose YAML + CDS 扩展（`x-cds-project`、`x-cds-env`）
8. **必须**区分全局环境变量（放 `x-cds-env`）和服务特有变量（放 `services.*.environment`），禁止重复声明
9. **必须**在 `x-cds-project` 中包含 `name`、`description`、`repo`（git remote URL）

## 执行流程

复制此 checklist 跟踪进度：

```
CDS 扫描进度：
- [ ] Phase 1: 识别项目根目录
- [ ] Phase 2: 扫描技术栈（后端/前端/Monorepo）
- [ ] Phase 3: 扫描基础设施（Docker Compose / 连接串）
- [ ] Phase 4: 扫描环境变量
- [ ] Phase 5: 展示摘要 → 用户确认
- [ ] Phase 6: 生成 CDS Compose YAML
- [ ] Phase 7: 使用说明（CDS 自动管理基础设施）
```

### Phase 1: 识别项目根目录

```bash
git rev-parse --show-toplevel
```

### Phase 2: 扫描技术栈

按优先级检测可部署单元，每发现一个记录一个 buildProfile 候选。

**详细检测规则**（后端/前端/包管理器/端口/路由推断） → 见 [reference/tech-detection.md](reference/tech-detection.md)

### Phase 3: 扫描基础设施

优先解析 `docker-compose*.yml`，提取 image + ports + volumes + environment。

无 Compose 文件时，搜索代码中的连接串引用：
```bash
grep -rn "mongodb://\|redis://\|ConnectionString" --include="*.json" --include="*.yml" --include="*.cs" .
```

**详细的 Compose 解析规则和兼容性检查** → 见 [reference/tech-detection.md](reference/tech-detection.md)

### Phase 4: 扫描环境变量

按优先级检查：`.env.example` → `appsettings.json` → `docker-compose environment` → 代码引用

敏感值 → `"TODO: 请填写实际值"`；连接串可从 infraServices 推导 → 使用 `${CDS_HOST}:${CDS_<SERVICE>_PORT}` 模板

**分类规则（禁止重复声明）**：

| 归属 | 放置位置 | 示例 |
|------|----------|------|
| 全局共享（所有容器都需要） | `x-cds-env` | COS 凭证、PAT、密码、AI_ACCESS_KEY |
| 服务特有（仅该服务使用） | `services.*.environment` | ASPNETCORE_ENVIRONMENT、连接串模板 |
| 两处都有引用的 | 仅放 `x-cds-env`，服务用 `${VAR}` 引用 | `Jwt__Secret: "${JWT_SECRET}"` |

CDS 运行时会自动将 `x-cds-env` 注入所有容器（优先级低于 `services.*.environment`），因此全局变量**禁止**在 `environment` 中重复声明。

### Phase 5: 展示摘要 → 用户确认

> **关键检查点。禁止跳过。**

以 Markdown 表格展示扫描结果（不是 JSON，不是最终配置）：

```markdown
## CDS 扫描摘要

### 构建配置 (Build Profiles)

| # | ID | 名称 | 技术栈 | 工作目录 | 端口 | 路由前缀 |
|---|-----|------|--------|---------|------|---------|
| 1 | api | 后端 API | .NET 8 | prd-api/ | 5000 | /api/ |
| 2 | web | 前端 | Vite + React | prd-admin/ | 8000 | / |

### 基础设施服务

| # | 服务 | 镜像 | 端口 | 来源 |
|---|------|------|------|------|
| 1 | MongoDB | mongo:7 | 27017 | docker-compose.dev.yml |

### 环境变量

| 变量名 | 值 | 来源 |
|--------|-----|------|
| Jwt__Secret | TODO: 请填写实际值 | appsettings.json |

### ⚠️ 兼容性告警
（如有）
```

使用 AskUserQuestion 确认：
- **确认无误，生成配置**
- **需要调整** → 用户说明修改 → 重新展示
- **重新扫描**

### Phase 6: 生成 CDS Compose YAML

标准 docker-compose 格式 + CDS 扩展，通过约定自动推断：

| 约定 | 含义 |
|------|------|
| `x-cds-project` | 项目元数据（name, description, repo） |
| `x-cds-env` | 全局共享环境变量（注入所有容器） |
| 有相对路径 volume mount（`./xxx:/app`） | **App 服务** |
| 无相对路径 mount + 有 ports | **基础设施** |
| `depends_on` | 启动顺序 |
| `labels.cds.path-prefix` | 代理路由前缀 |
| `${CDS_HOST}` / `${CDS_<SERVICE>_PORT}` | 运行时替换 |

命名规则：`CDS_` + 服务名大写（连字符转下划线）+ `_PORT`

**环境变量分层原则**：
- `x-cds-env`：全局共享变量（凭证、密钥、第三方服务配置），CDS 自动注入所有容器
- `services.*.environment`：仅该服务特有的变量（框架配置、连接串模板）
- 禁止同一变量在两处重复声明；如需引用全局变量，用 `${VAR_NAME}` 模板语法

配置后附带使用说明：
```
1. cd cds && ./exec_cds.sh --background
2. 打开 CDS Dashboard → http://<服务器IP>:9900
3. 设置 → 一键导入 → 粘贴 YAML → 确认应用
```

### Phase 7: 使用说明 & 回退初始化

配置输出后附带 CDS 导入说明。CDS Dashboard 导入 YAML 后**自动创建基础设施容器**，无需手动 `docker run`。

仅当用户明确表示不通过 CDS 管理时，才提供手动初始化选项 → 见 [reference/infra-init.md](reference/infra-init.md)

## 输出格式

完整的 CDS Compose YAML 示例：

```yaml
# CDS Compose 配置 — 由 /cds-scan 自动生成
# 导入方式：CDS Dashboard → 设置 → 一键导入 → 粘贴此内容

x-cds-project:
  name: prd_agent
  description: "PRD Agent 全栈项目 (.NET 8 + React 18 + Tauri 2.0)"
  repo: https://github.com/inernoro/prd_agent.git

# 全局共享环境变量 — CDS 自动注入所有容器，禁止在 services.*.environment 中重复
x-cds-env:
  ASSETS_PROVIDER: tencentCos
  TENCENT_COS_BUCKET: "TODO: 请填写实际值"
  TENCENT_COS_REGION: "TODO: 请填写实际值"
  TENCENT_COS_SECRET_ID: "TODO: 请填写实际值"
  TENCENT_COS_SECRET_KEY: "TODO: 请填写实际值"
  TENCENT_COS_PUBLIC_BASE_URL: "TODO: 请填写实际值"
  TENCENT_COS_PREFIX: data
  JWT_SECRET: "TODO: 请填写实际值"
  AI_ACCESS_KEY: "TODO: 请填写实际值"

services:
  # ── App Services (有相对路径 volume mount) ──

  api:
    image: mcr.microsoft.com/dotnet/sdk:8.0
    working_dir: /app
    volumes:
      - ./prd-api:/app
    ports:
      - "5000"
    command: >-
      dotnet restore &&
      dotnet build --no-restore &&
      dotnet run --project src/PrdAgent.Api --urls http://0.0.0.0:5000
    depends_on:
      mongodb: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      # 仅服务特有变量，全局变量已由 x-cds-env 注入
      ASPNETCORE_ENVIRONMENT: Development
      MongoDB__ConnectionString: "mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}"
      MongoDB__DatabaseName: prdagent
      Redis__ConnectionString: "${CDS_HOST}:${CDS_REDIS_PORT}"
      Jwt__Secret: "${JWT_SECRET}"
      Jwt__Issuer: prdagent
    labels:
      cds.path-prefix: "/api/"

  admin:
    image: node:20-slim
    working_dir: /app
    volumes:
      - ./prd-admin:/app
    ports:
      - "8000"
    command: >-
      corepack enable &&
      pnpm install --frozen-lockfile &&
      pnpm exec vite --host 0.0.0.0 --port 8000
    labels:
      cds.path-prefix: "/"

  # ── Gateway (本地端口模式统一入口，模拟线上子域名路由) ──
  # 线上 CDS 通过子域名 + cds.path-prefix 路由，本地端口模式无此能力
  # gateway 用 nginx 反代实现相同效果，用户通过 gateway 端口统一访问

  gateway:
    image: nginx:alpine
    ports:
      - "80"
    environment:
      API_TARGET: "${CDS_HOST}:${CDS_API_PORT}"
      ADMIN_TARGET: "${CDS_HOST}:${CDS_ADMIN_PORT}"
    volumes:
      - ./deploy/nginx/nginx.gateway.conf.template:/etc/nginx/nginx.gateway.conf.template:ro
    command: >-
      /bin/sh -c "envsubst '$$API_TARGET $$ADMIN_TARGET' < /etc/nginx/nginx.gateway.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"
    depends_on:
      - api
      - admin

  # ── Infrastructure Services (无相对路径 mount) ──

  mongodb:
    image: mongo:8.0
    ports:
      - "27017"
    volumes:
      - mongodb-data:/data/db
    healthcheck:
      test: mongosh --eval "db.runCommand({ping:1})" --quiet
      interval: 10s
      retries: 3

  redis:
    image: redis:7-alpine
    ports:
      - "6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: redis-cli ping
      interval: 10s
      retries: 3

volumes:
  mongodb-data:
  redis-data:
```

## 端到端示例

**输入**: 用户对 prd_agent 项目说 `/cds-scan`

**Phase 1**: 根目录 `/home/user/prd_agent`

**Phase 2**: 检测到 3 个可部署单元
- `prd-api/` → .NET 8，端口 5000，路由 `/api/`
- `prd-admin/` → Vite + React，pnpm，端口 8000，路由 `/`
- `prd-desktop/` → Tauri 桌面端 → **跳过**（非 web 服务）

**Phase 3**: 从 `docker-compose.dev.yml` 提取 MongoDB (27017) + Redis (6379)

**Phase 4**: 从 `appsettings.json` 提取连接串 + COS 凭证 + JWT 密钥，分类为：
- 全局（→ `x-cds-env`）：COS 凭证、JWT_SECRET、AI_ACCESS_KEY
- 服务特有（→ `api.environment`）：ASPNETCORE_ENVIRONMENT、连接串模板

**Phase 5**: 展示摘要表（含环境变量分类列）→ 用户确认 "确认无误"

**Phase 6**: 生成含 `x-cds-project` + `x-cds-env` + services 的完整 YAML → 附带使用说明

**Phase 7**: 输出 CDS 导入说明（CDS Dashboard 自动管理基础设施）

## CDS 运行时自动处理

以下问题由 CDS 运行时自动处理，cds-scan **无需**在生成的 YAML 中额外配置：

| 问题 | CDS 运行时行为 |
|------|---------------|
| Node.js 多分支 inotify ENOSPC | 自动注入 `PNPM_HOME=/pnpm`，将 store 移出 bind mount |
| Vite HMR WebSocket | CDS 代理自动转发 WebSocket upgrade（含 Sec-WebSocket-Accept） |
| `${CDS_*}` 环境变量模板 | 运行时自动解析为实际地址和端口 |
| 包缓存跨分支共享 | 自动挂载 `/data/cds/{project-slug}/cache/{nuget,pnpm,...}`，restore/install 秒级完成 |
| `/data/cds/` 目录不存在 | 容器启动时自动 `mkdir -p`，无需手动创建 |

## 异常处理

| 场景 | 处理 |
|------|------|
| 找不到可部署单元 | 输出空配置 + 提示手动添加 |
| Docker Compose 解析失败 | 跳过 infra + 警告 |
| 端口无法推断 | 默认值 + `TODO` 注释 |
| 多个 Dockerfile 冲突 | 每个生成 profile + 提示用户选择 |
| 检测到生产数据库连接串 | 警告不要在 CDS 中使用生产地址 |

## 质量规则

1. 每个 App 服务必须有 `command` 字段
2. 输出格式为标准 docker-compose YAML + CDS 扩展（`x-cds-project`、`x-cds-env`）
3. 敏感值用 `"TODO: ..."` 替代
4. 基础设施端口引用使用 `${CDS_<SERVICE>_PORT}` 格式
5. App 服务必须有相对路径 volume mount
6. 必须包含 `x-cds-project`（name + description + repo）
7. 全局环境变量放 `x-cds-env`，服务特有变量放 `services.*.environment`，禁止重复
8. 服务引用全局变量时使用 `${VAR_NAME}` 模板语法（如 `Jwt__Secret: "${JWT_SECRET}"`）
9. 当项目同时有前端和后端服务时，必须生成 `gateway` 服务（nginx 反代），通过 `${CDS_HOST}:${CDS_<SERVICE>_PORT}` 统一路由，模拟线上子域名模式。详见 [reference/tech-detection.md](reference/tech-detection.md) 的「Gateway 统一路由」

## 关联文档

- CDS 设计文档：`doc/design.cds-onboarding.md`
- CDS 环境变量指南：`doc/guide.cds-env.md`
- CDS 路线图：`doc/plan.cds-roadmap.md`
