---
name: cds-project-scan
description: 扫描项目结构，自动生成 CDS 一键导入配置 JSON。触发词："扫描项目"、"生成 CDS 配置"、"/cds-scan"。
---

# CDS Project Scan — 项目结构分析 & 配置生成

扫描当前项目的技术栈、目录结构、Docker Compose、环境变量，自动生成可直接粘贴到 CDS Dashboard 的配置 JSON。

## 触发词

- "扫描项目"、"扫描 CDS 配置"
- "生成 CDS 配置"
- "/cds-scan"

## 核心理念

1. **零门槛**：非程序员拿到 JSON 就能用，不需要理解 Docker 命令
2. **全覆盖**：构建配置 + 环境变量 + 基础设施 + 路由，一个 JSON 搞定
3. **容错友好**：无法确定的字段用 `"TODO: ..."` 标注，不猜测
4. **可验证**：生成的 JSON 会被 CDS 的 `/api/import-config` 端点严格验证

## 执行流程

### Phase 1：识别项目根目录

确定 Git 仓库根目录作为扫描起点。

```bash
git rev-parse --show-toplevel
```

### Phase 2：扫描技术栈

按优先级依次扫描以下信号，**每发现一个可部署单元就生成一个 buildProfile**。

#### 2.1 后端检测

| 信号文件 | 技术栈 | Docker 镜像 | 典型命令 |
|----------|--------|-------------|----------|
| `*.sln` + `*.csproj` | .NET | `mcr.microsoft.com/dotnet/sdk:8.0` | `dotnet restore` → `dotnet build` → `dotnet run` |
| `go.mod` | Go | `golang:1.22-alpine` | `go build -o app` → `./app` |
| `Cargo.toml` | Rust | `rust:1.77` | `cargo build --release` → `./target/release/app` |
| `requirements.txt` / `pyproject.toml` | Python | `python:3.12-slim` | `pip install -r requirements.txt` → `python app.py` |
| `pom.xml` / `build.gradle` | Java/Kotlin | `eclipse-temurin:21` | `mvn package` → `java -jar target/*.jar` |

#### 2.2 前端检测

| 信号文件 | 技术栈 | Docker 镜像 | 典型命令 |
|----------|--------|-------------|----------|
| `vite.config.*` | Vite (React/Vue) | `node:20-slim` | `{pm} install` → `npx vite --host 0.0.0.0` |
| `next.config.*` | Next.js | `node:20-slim` | `{pm} install` → `npx next dev -H 0.0.0.0` |
| `nuxt.config.*` | Nuxt.js | `node:20-slim` | `{pm} install` → `npx nuxi dev --host 0.0.0.0` |
| `angular.json` | Angular | `node:20-slim` | `{pm} install` → `npx ng serve --host 0.0.0.0` |

**包管理器检测**（`{pm}` 替换规则）：
- `pnpm-lock.yaml` 存在 → `pnpm`（installCommand 需前缀 `corepack enable &&`，因为 `node:20-slim` 未预装 pnpm）
- `yarn.lock` 存在 → `yarn`（installCommand 需前缀 `corepack enable &&`，因为 `node:20-slim` 未预装 yarn）
- `package-lock.json` 存在 → `npm`
- 都不存在 → `npm`（默认）

**corepack 规则**：使用 pnpm 或 yarn 时，`installCommand` 和 `runCommand` 都必须以 `corepack enable &&` 开头，否则 Docker 容器内找不到命令。示例：
- installCommand: `corepack enable && pnpm install --frozen-lockfile`
- runCommand: `corepack enable && pnpm exec vite --host 0.0.0.0 --port 5173`

#### 2.3 Monorepo 处理

如果根目录包含多个可部署子目录：
- 每个子目录作为独立 `buildProfile`
- `workDir` 设为相对路径（如 `"prd-api"`, `"prd-admin"`）
- `id` 使用目录名的 kebab-case

#### 2.4 容器端口推断

| 场景 | 端口推断规则 |
|------|-------------|
| .NET `--urls http://0.0.0.0:XXXX` | 提取 XXXX |
| Vite `--port XXXX` | 提取 XXXX |
| `EXPOSE` in Dockerfile | 提取端口 |
| `package.json` scripts 中的 `--port` | 提取端口 |
| 都找不到 | 默认 8080（后端）/ 5173（前端） |

#### 2.5 路由路径前缀推断 (`pathPrefixes`)

CDS 代理通过 `pathPrefixes` 决定将请求转发到哪个 profile 的容器。**必须**为每个 buildProfile 推断路由路径前缀。

**推断规则**（按优先级）：

| 信号 | pathPrefixes 推断值 |
|------|-------------------|
| 后端 profile + 代码中发现 `/api/` 路由 | `["/api/"]` |
| 后端 profile + 代码中发现 `/graphql` 端点 | `["/api/", "/graphql"]` |
| 后端 profile + 代码中发现 WebSocket 路径 | 追加 `"/ws/"` 或实际路径 |
| 前端 vite.config 有 `server.proxy` 配置 | 提取代理的路径前缀给后端 profile |
| Next.js / Nuxt.js（前后端一体） | `["/"]`（处理所有路径） |
| 纯前端（无 API 路由） | `["/"]` |

**检测方法**：

```bash
# .NET 后端：检查 Controller 路由前缀
grep -rn '\[Route("' --include="*.cs" . | head -20

# Vite 项目：检查 proxy 配置
grep -A5 'proxy' vite.config.* 2>/dev/null

# Express/Koa：检查路由注册
grep -rn "app.use.*'/api'" --include="*.ts" --include="*.js" . | head -10

# Next.js API routes
ls -d pages/api/ app/api/ 2>/dev/null
```

**重要**：如果项目的 API 不在 `/api/` 下（如 `/v1/`、`/graphql`、`/rpc/`），必须准确推断，否则 CDS 代理会路由错误。
不填 `pathPrefixes` 时 CDS 回退到约定：profile id 包含 "api" 时自动处理 `/api/*`，其余路径走 web profile。

### Phase 3：扫描基础设施

#### 3.1 Docker Compose 解析

如果存在 `docker-compose*.yml`（包括 `.dev.yml`, `.local.yml` 等变体）：

```bash
# 找到所有 compose 文件
find . -maxdepth 2 -name "docker-compose*.yml" -o -name "compose*.yml"
```

对每个 service 提取：
- `image` → `dockerImage`（**跳过有 `build` 字段的应用服务**）
- `ports` → `containerPort`
- `volumes` → `volumes[]`（命名卷 + 绑定挂载均保留）
- `environment` → `env`

**Compose 服务提取规则**：

直接从 docker-compose 文件提取**同时满足以下条件**的服务：
1. 有 `image` 字段（纯镜像服务）
2. **没有** `build` 字段（有 build 的是应用服务，即使同时写了 image 也要跳过）
3. 有 `ports` 声明（无端口的不是 CDS 该管的网络服务）

转换为 CDS 兼容的 compose YAML 格式，并添加 `x-cds-inject` 扩展字段声明注入到应用容器的环境变量。

**Volume 处理规则**：

| Volume 格式 | CDS 支持 | 说明 |
|-------------|---------|------|
| `named_vol:/container/path` | ✅ 命名卷 | 自动持久化 |
| `./relative/path:/container/path` | ✅ 绑定挂载 | 相对于项目根目录解析 |
| `/absolute/path:/container/path` | ✅ 绑定挂载 | 直接使用 |
| `*:/path:ro` | ✅ 只读标记 | 保留 `:ro` 后缀 |

**多文件去重规则**：如果项目有多个 compose 文件（如 `cds-compose.yml` + `docker-compose.dev.yml`），
同 ID 的服务只取第一个发现的版本。优先级：`cds-compose.yml` > `docker-compose.yml` > `docker-compose.dev.yml`。

| Docker Compose Service | `x-cds-inject` 推荐值 |
|------------------------|----------------------|
| `mongo` / `mongodb` | `MongoDB__ConnectionString: "mongodb://{{host}}:{{port}}"` |
| `redis` | `Redis__ConnectionString: "{{host}}:{{port}}"` |
| `postgres` / `postgresql` | `DATABASE_URL: "postgres://{{host}}:{{port}}/dbname"` |
| `mysql` / `mariadb` | `DATABASE_URL: "mysql://{{host}}:{{port}}/dbname"` |
| `rabbitmq` | `RABBITMQ_URL: "amqp://{{host}}:{{port}}"` |
| `elasticsearch` | `ELASTICSEARCH_URL: "http://{{host}}:{{port}}"` |
| `minio` | `S3_ENDPOINT: "http://{{host}}:{{port}}"` |

注意：`x-cds-inject` 中的 `{{host}}` 和 `{{port}}` 会被 CDS 替换为实际的 Docker 宿主机地址和分配的宿主端口。

#### 3.2 Compose 兼容性检查

扫描 compose 文件时，检测以下 CDS 不兼容的特性，在输出的「需要手动确认」区域告警：

| compose 特性 | CDS 支持状态 | 告警信息 |
|-------------|-------------|---------|
| `depends_on` | ❌ 忽略 | "CDS 不保证启动顺序，应用需有重连逻辑" |
| `networks` (自定义) | ❌ 硬编码 | "CDS 使用统一网络，忽略自定义网络配置" |
| `read_only: true` | ❌ 忽略 | "CDS 容器不支持只读文件系统" |
| `tmpfs` | ❌ 忽略 | "CDS 不挂载 tmpfs，.NET 等需要 /tmp 的应用可能受影响" |
| `restart` (非 unless-stopped) | ⚠️ 硬编码 | "CDS 硬编码 restart=unless-stopped" |
| 端口范围 `8000-8100` | ❌ 忽略 | "CDS 仅支持单端口映射" |
| `${VAR:-default}` 变量替换 | ⚠️ 原样传递 | "环境变量替换由 Docker 处理，CDS 不展开" |

#### 3.3 无 Docker Compose 时

检查代码中的连接串引用：
```bash
# 搜索常见数据库连接模式
grep -rn "mongodb://" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.env*" .
grep -rn "redis://" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.env*" .
grep -rn "ConnectionString" --include="*.json" --include="*.cs" .
```

### Phase 4：扫描环境变量

按优先级检查：

1. `.env.example` / `.env.template` / `.env.sample` — 直接提取
2. `appsettings.json` / `appsettings.Development.json` — 提取连接串
3. `docker-compose*.yml` → `environment` — 提取变量
4. 代码中的 `process.env.XXX` / `Environment.GetEnvironmentVariable("XXX")` — 参考

**敏感值处理**：
- 密码/密钥类变量值设为 `"TODO: 请填写实际值"`
- 连接串类变量如果能从 infraServices 推导，使用模板 `"mongodb://172.17.0.1:{{port}}"`

### Phase 5：生成输出

#### 5.1 输出 JSON

输出完整的 CDS Config JSON（格式见 `doc/design.cds-onboarding.md` 第 3 节）。

#### 5.2 附带说明

在 JSON 之前输出一段简要说明：

```markdown
## CDS 配置扫描结果

**检测到的技术栈**：
- 后端：.NET 8 (prd-api/)
- 前端：Vite + React 18 (prd-admin/)

**检测到的基础设施**：
- MongoDB 7 (来自 docker-compose.dev.yml)
- Redis 7 (来自 docker-compose.dev.yml)

**需要手动确认**：
- ⚠️ `Jwt__Secret` 需要填写实际值
- ⚠️ `COS_SECRET_KEY` 需要填写实际值

**使用方法**：
1. 启动 CDS（后台模式，默认端口 9900）：
   ```bash
   cd cds && ./exec_cds.sh --background
   ```
2. 打开 CDS Dashboard → http://<服务器IP>:9900
3. 设置 → 一键导入 → 粘贴下方 JSON → 确认应用
```

**注意**：CDS 默认端口为 **9900**（Dashboard）和 **5500**（Gateway），由 `cds.config.json` 的 `masterPort` / `workerPort` 控制。

#### 5.3 JSON 输出格式

```json
{
  "$schema": "cds-config-v1",
  "project": {
    "name": "项目名称",
    "description": "自动检测的描述"
  },
  "buildProfiles": [
    {
      "id": "api",
      "name": "后端 API",
      "dockerImage": "mcr.microsoft.com/dotnet/sdk:8.0",
      "workDir": "backend",
      "runCommand": "dotnet run",
      "containerPort": 8080,
      "pathPrefixes": ["/api/", "/graphql"]
    },
    {
      "id": "web",
      "name": "前端",
      "dockerImage": "node:20-slim",
      "workDir": "frontend",
      "runCommand": "npx vite --host 0.0.0.0",
      "containerPort": 5173,
      "pathPrefixes": ["/"]
    }
  ],
  "envVars": { },
  "infraServices": "services:\n  mongodb:\n    image: mongo:7\n    ports:\n      - \"27017\"\n    volumes:\n      - mongodb-data:/data/db\n    healthcheck:\n      test: mongosh --eval \"db.runCommand({ping:1})\" --quiet\n      interval: 10s\n      retries: 3\n    x-cds-inject:\n      MongoDB__ConnectionString: \"mongodb://{{host}}:{{port}}\"\nvolumes:\n  mongodb-data:",
  "routingRules": []
}
```

**`pathPrefixes` 说明**：CDS 代理根据此字段将请求路由到对应 profile 的容器。
最长前缀优先匹配。`["/"]` 表示兜底处理所有未匹配的路径。
不填时回退到约定：profile id 含 "api" 自动处理 `/api/*`。

注意：`infraServices` 字段的值是 **compose YAML 字符串**（docker-compose 兼容格式），不再是 JSON 数组。
CDS 会解析该 YAML 并提取带 `image` 字段的服务。`x-cds-inject` 扩展字段定义注入到应用容器的环境变量。

### Phase 6：导入后系统初始化（反问用户）

**强制规则**：生成配置 JSON 并输出后，**必须主动反问用户**是否需要帮忙初始化基础设施。

#### 6.1 反问模板

配置 JSON 输出完成后，使用 `AskUserQuestion` 工具向用户提问：

```
配置已生成完毕。导入后，系统依赖的基础设施（如 MongoDB、Redis）需要先启动才能正常使用。
请问需要我帮你完成以下哪些操作？
```

**选项**：
1. **帮我初始化全部基础设施** — 自动生成并执行 docker run 命令启动所有检测到的 infra 服务
2. **只生成初始化命令，我自己执行** — 输出可复制的 shell 命令，用户自行在服务器上运行
3. **不需要，我已经有现成的数据库** — 跳过，仅提醒用户在 CDS 环境变量中填写正确的连接地址

#### 6.2 初始化命令生成规则

根据 `infraServices` 中检测到的服务，生成对应的 docker 启动命令：

```bash
# 示例：MongoDB
docker run -d \
  --name cds-mongodb \
  --restart unless-stopped \
  --network cds-network \
  -p 27017:27017 \
  -v cds-mongodb-data:/data/db \
  -e MONGO_INITDB_ROOT_USERNAME=root \
  -e MONGO_INITDB_ROOT_PASSWORD=TODO_请替换密码 \
  mongo:7

# 示例：Redis
docker run -d \
  --name cds-redis \
  --restart unless-stopped \
  --network cds-network \
  -p 6379:6379 \
  -v cds-redis-data:/data \
  redis:7 redis-server --appendonly yes
```

**前置命令**（始终包含）：
```bash
# 创建 Docker 网络（已存在则忽略）
docker network create cds-network 2>/dev/null || true
```

#### 6.3 初始化失败处理

如果用户选择"帮我初始化"但执行失败：
1. 输出错误信息，诊断失败原因（端口占用、Docker 未安装、权限不足等）
2. 提供修复建议
3. 提示用户可以**重试**：重新执行失败的命令即可，已成功的服务不受影响

#### 6.4 健康检查

初始化完成后，逐个验证服务是否正常运行：

```bash
# MongoDB 健康检查
docker exec cds-mongodb mongosh --eval "db.adminCommand('ping')" 2>/dev/null && echo "✅ MongoDB OK" || echo "❌ MongoDB 未就绪"

# Redis 健康检查
docker exec cds-redis redis-cli ping 2>/dev/null && echo "✅ Redis OK" || echo "❌ Redis 未就绪"
```

### Phase 7：异常处理

| 场景 | 处理 |
|------|------|
| 找不到任何可部署单元 | 输出空配置 + 提示用户手动添加 |
| Docker Compose 解析失败 | 跳过 infra 部分 + 警告 |
| 端口无法推断 | 使用默认值 + `// TODO` 注释 |
| 多个 Dockerfile 冲突 | 每个都生成 profile + 提示用户选择 |
| 检测到生产数据库连接串 | 警告用户不要在 CDS 中使用生产地址 |
| 基础设施初始化失败 | 诊断原因 + 修复建议 + 提示可重试 |

## 质量规则

1. **必须**：每个 `buildProfile` 都要有 `runCommand`，不能为空
2. **必须**：`$schema` 固定为 `"cds-config-v1"`
3. **必须**：敏感值不输出明文，用 `"TODO: ..."` 替代
4. **禁止**：猜测用户的数据库密码或密钥
5. **禁止**：输出超过项目实际需要的 buildProfile（不创建无用配置）

## 关联文档

- 配置 JSON 格式规范：`doc/design.cds-onboarding.md`
- CDS 环境变量指南：`doc/guide.cds-env.md`
- CDS 路线图：`doc/plan.cds-roadmap.md`
