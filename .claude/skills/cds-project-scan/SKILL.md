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

1. **零门槛**：非程序员拿到配置就能用，不需要理解 Docker 命令
2. **全覆盖**：构建配置 + 环境变量 + 基础设施 + 路由，一个配置搞定
3. **容错友好**：无法确定的字段用 `"TODO: ..."` 标注，不猜测
4. **用户主导**：每个阶段的产出必须经过用户确认后才进入下一阶段
5. **安全执行**：任何 docker 操作必须先检查环境，且只在用户授权后执行

## 强制规则（禁止违反）

1. **禁止**：在用户确认前输出最终配置 JSON
2. **禁止**：在未检查 Docker 可用性前执行 docker 命令
3. **禁止**：未经用户同意直接执行基础设施初始化命令
4. **禁止**：猜测用户的数据库密码或密钥
5. **禁止**：输出超过项目实际需要的 buildProfile（不创建无用配置）
6. **必须**：先展示扫描结果摘要 → 等用户确认 → 再生成配置
7. **必须**：基础设施操作前先展示命令 → 等用户选择 → 再执行

## 执行流程总览

```
Phase 1-4: 静默扫描（不输出任何最终结果）
    ↓
Phase 5: 展示扫描摘要 → AskUserQuestion 确认
    ↓ 用户确认
Phase 6: 生成最终配置（compose YAML + 导入 JSON）
    ↓
Phase 7: AskUserQuestion 询问基础设施初始化
    ↓ 用户选择
Phase 8: 按用户选择执行（检查环境 → 执行/输出命令）
```

---

### Phase 1：识别项目根目录

确定 Git 仓库根目录作为扫描起点。

```bash
git rev-parse --show-toplevel
```

### Phase 2：扫描技术栈

按优先级依次扫描以下信号，**每发现一个可部署单元就记录一个 buildProfile 候选**。

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

**Volume 处理规则**：

| Volume 格式 | CDS 支持 | 说明 |
|-------------|---------|------|
| `named_vol:/container/path` | ✅ 命名卷 | 自动持久化 |
| `./relative/path:/container/path` | ✅ 绑定挂载 | 相对于项目根目录解析 |
| `/absolute/path:/container/path` | ✅ 绑定挂载 | 直接使用 |
| `*:/path:ro` | ✅ 只读标记 | 保留 `:ro` 后缀 |

**多文件去重规则**：如果项目有多个 compose 文件（如 `cds-compose.yml` + `docker-compose.dev.yml`），
同 ID 的服务只取第一个发现的版本。优先级：`cds-compose.yml` > `docker-compose.yml` > `docker-compose.dev.yml`。

**环境变量推荐写法**（v2 格式，写在 app 服务的 `environment` 中）：

| 基础设施服务 | App 服务 environment 推荐写法 |
|-------------|------------------------------|
| `mongodb` | `MongoDB__ConnectionString: "mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}"` |
| `redis` | `Redis__ConnectionString: "${CDS_HOST}:${CDS_REDIS_PORT}"` |
| `postgres` | `DATABASE_URL: "postgres://${CDS_HOST}:${CDS_POSTGRES_PORT}/dbname"` |
| `mysql` | `DATABASE_URL: "mysql://${CDS_HOST}:${CDS_MYSQL_PORT}/dbname"` |
| `rabbitmq` | `RABBITMQ_URL: "amqp://${CDS_HOST}:${CDS_RABBITMQ_PORT}"` |
| `elasticsearch` | `ELASTICSEARCH_URL: "http://${CDS_HOST}:${CDS_ELASTICSEARCH_PORT}"` |
| `minio` | `S3_ENDPOINT: "http://${CDS_HOST}:${CDS_MINIO_PORT}"` |

注意：`${CDS_HOST}` 和 `${CDS_<SERVICE>_PORT}` 在 CDS 启动容器时自动替换为实际值。
命名规则：`CDS_` + compose 服务名大写 + `_PORT`（连字符转下划线）。

#### 3.2 Compose 兼容性检查

扫描 compose 文件时，检测以下 CDS 不兼容的特性，记录到内部告警列表（Phase 5 展示给用户）：

| compose 特性 | CDS 支持状态 | 告警信息 |
|-------------|-------------|---------|
| `depends_on` | ✅ 支持 | CDS 按拓扑排序启动服务（先基础设施后应用） |
| `working_dir` | ✅ 支持 | 容器内工作目录 |
| `command` | ✅ 支持 | 合并 install+build+run 为单一命令 |
| `labels` | ✅ 支持 | `cds.path-prefix` 用于路由 |
| `${CDS_*}` 变量替换 | ✅ 支持 | CDS 自动替换 `${CDS_HOST}`、`${CDS_<SERVICE>_PORT}` |
| `networks` (自定义) | ❌ 忽略 | "CDS 使用统一网络，忽略自定义网络配置" |
| `read_only: true` | ❌ 忽略 | "CDS 容器不支持只读文件系统" |
| `restart` (非 unless-stopped) | ⚠️ 硬编码 | "CDS 硬编码 restart=unless-stopped" |
| 端口范围 `8000-8100` | ❌ 忽略 | "CDS 仅支持单端口映射" |

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

---

### Phase 5：展示扫描摘要 → 用户确认（关键检查点）

> **这是最重要的阶段**。Phase 1-4 的扫描结果在此处首次展示给用户。
> **禁止跳过此阶段直接输出配置。**

#### 5.1 展示格式

以人类可读的 Markdown 格式输出扫描摘要（**不是 JSON，不是最终配置**）：

```markdown
## CDS 扫描摘要

### 检测到的构建配置 (Build Profiles)

| # | ID | 名称 | 技术栈 | 工作目录 | 端口 | 路由前缀 |
|---|-----|------|--------|---------|------|---------|
| 1 | api | 后端 API | .NET 8 | prd-api/ | 5000 | /api/ |
| 2 | web | 前端 | Vite + React 18 | prd-admin/ | 8000 | / |

### 检测到的基础设施服务

| # | 服务 | 镜像 | 端口 | 来源文件 |
|---|------|------|------|---------|
| 1 | MongoDB | mongo:7 | 27017 | docker-compose.dev.yml |
| 2 | Redis | redis:7-alpine | 6379 | docker-compose.dev.yml |

### 检测到的环境变量

| 变量名 | 值 | 来源 |
|--------|-----|------|
| MongoDB__ConnectionString | mongodb://... | appsettings.json |
| Jwt__Secret | TODO: 请填写实际值 | appsettings.json |

### ⚠️ 兼容性告警

- `depends_on`: CDS 不保证启动顺序，应用需有重连逻辑
- ...（Phase 3.2 中记录的告警）
```

#### 5.2 使用 AskUserQuestion 确认

展示摘要后，**必须**使用 `AskUserQuestion` 工具询问用户：

**问题**：`扫描完成，以上是检测到的项目配置。请确认是否正确，或需要调整？`

**选项**：
1. **确认无误，生成配置** — 基于当前扫描结果生成最终的 CDS 配置
2. **需要调整** — 用户说明要修改的部分（增删 profile、调整端口、修改路由等）
3. **重新扫描** — 丢弃当前结果，从头开始

**如果用户选择"需要调整"**：根据用户反馈修改对应内容，然后重新展示摘要并再次确认。循环直到用户满意。

---

### Phase 6：生成最终配置（CDS Compose YAML）

> 只有在 Phase 5 用户明确确认后才执行此阶段。

#### 6.1 输出格式：CDS Compose YAML (v2 标准格式)

输出一个**纯标准 docker-compose 文件**，零自定义扩展。CDS 通过以下规则自动推断：
- **App 服务**：有相对路径 volume mount（`./xxx:/app`）的服务
- **基础设施**：没有相对路径 mount 的服务
- **启动顺序**：`depends_on` 声明（先启动基础设施，再启动 app）
- **路由前缀**：`labels.cds.path-prefix`（标准 compose labels）
- **端口注入**：App 服务 environment 使用 `${CDS_<SERVICE>_PORT}` 引用基础设施端口

```yaml
# CDS Compose 配置 — 由 /cds-scan 自动生成
# 导入方式：CDS Dashboard → 设置 → 一键导入 → 粘贴此内容
# 这是一个纯标准 docker-compose.yml，无任何自定义扩展

services:
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
      ASPNETCORE_ENVIRONMENT: Development
      MongoDB__ConnectionString: "mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}"
      MongoDB__DatabaseName: prdagent
      Redis__ConnectionString: "${CDS_HOST}:${CDS_REDIS_PORT}"
      Jwt__Secret: "TODO: 请填写实际值"
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

  mongodb:
    image: mongo:7
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
    healthcheck:
      test: redis-cli ping
      interval: 10s
      retries: 3

volumes:
  mongodb-data:
```

#### 6.2 CDS v2 Compose 自动推断规则

| 信号 | CDS 推断 |
|------|---------|
| `volumes: ["./xxx:/app"]`（相对路径挂载） | **App 服务** — 有源码需要构建运行 |
| 无相对路径挂载 + 有 ports | **基础设施** — 数据库/缓存等 |
| `depends_on` | 启动顺序（先启动被依赖的基础设施） |
| `labels.cds.path-prefix: "/api/"` | 代理路由前缀 |
| `${CDS_HOST}` | CDS 运行时替换为 Docker 宿主机 IP |
| `${CDS_MONGODB_PORT}` | CDS 运行时替换为 mongodb 服务分配的宿主端口 |

**命名规则**：`CDS_` + 服务名大写（连字符转下划线）+ `_PORT`。
例如：服务 `mongodb` → `CDS_MONGODB_PORT`，服务 `my-redis` → `CDS_MY_REDIS_PORT`。

**路由前缀**：CDS 代理根据 `labels.cds.path-prefix` 将请求转发到对应容器。
最长前缀优先匹配。`"/"` 表示兜底处理所有未匹配的路径。

#### 6.3 使用说明

在配置输出后附带使用说明：

```markdown
**使用方法**：
1. 启动 CDS（后台模式，默认端口 9900）：
   ```bash
   cd cds && ./exec_cds.sh --background
   ```
2. 打开 CDS Dashboard → http://<服务器IP>:9900
3. 设置 → 一键导入 → 粘贴上方 YAML → 确认应用
```

**注意**：CDS 默认端口为 **9900**（Dashboard）和 **5500**（Gateway），由 `cds.config.json` 的 `masterPort` / `workerPort` 控制。

---

### Phase 7：询问基础设施初始化

> 配置输出后，**必须**询问用户是否需要初始化基础设施。
> **禁止**未经询问直接执行任何 docker 命令。

#### 7.1 使用 AskUserQuestion 询问

```
配置已生成完毕。如果你还没有运行中的基础设施（如 MongoDB、Redis），需要先启动它们。
请问需要我帮你处理吗？
```

**选项**：
1. **只生成初始化命令，我自己执行** — 输出可复制的 shell 命令（**安全默认选项**）
2. **帮我初始化全部基础设施** — 检查 Docker 环境后自动执行
3. **不需要，我已有现成的数据库** — 跳过，仅提醒填写正确的连接地址

#### 7.2 初始化命令生成规则

根据 `infraServices` 中检测到的服务，生成对应的 docker 启动命令：

```bash
# 前置：创建 Docker 网络（已存在则忽略）
docker network create cds-network 2>/dev/null || true

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

---

### Phase 8：执行初始化（仅当用户选择"帮我初始化"）

> **关键前提**：此阶段只在用户明确选择"帮我初始化"时才进入。

#### 8.1 环境检查（必须先于任何 docker 命令）

```bash
# 检查 Docker 是否可用
docker info > /dev/null 2>&1
```

**如果 Docker 不可用**：
- 输出错误信息，停止执行
- 提示用户安装 Docker 或检查权限
- 回退到"只生成命令"模式，输出命令让用户在有 Docker 的环境执行

#### 8.2 执行初始化

逐个执行 Phase 7.2 中生成的命令，每个命令执行后检查结果。

#### 8.3 健康检查

初始化完成后，逐个验证服务是否正常运行：

```bash
# MongoDB 健康检查
docker exec cds-mongodb mongosh --eval "db.adminCommand('ping')" 2>/dev/null && echo "✅ MongoDB OK" || echo "❌ MongoDB 未就绪"

# Redis 健康检查
docker exec cds-redis redis-cli ping 2>/dev/null && echo "✅ Redis OK" || echo "❌ Redis 未就绪"
```

#### 8.4 初始化失败处理

如果执行失败：
1. 输出错误信息，诊断失败原因（端口占用、Docker 未安装、权限不足等）
2. 提供修复建议
3. 提示用户可以**重试**：重新执行失败的命令即可，已成功的服务不受影响

---

### Phase 9：异常处理

| 场景 | 处理 |
|------|------|
| 找不到任何可部署单元 | 输出空配置 + 提示用户手动添加 |
| Docker Compose 解析失败 | 跳过 infra 部分 + 警告 |
| 端口无法推断 | 使用默认值 + `// TODO` 注释 |
| 多个 Dockerfile 冲突 | 每个都生成 profile + 提示用户选择 |
| 检测到生产数据库连接串 | 警告用户不要在 CDS 中使用生产地址 |
| 基础设施初始化失败 | 诊断原因 + 修复建议 + 提示可重试 |

## 质量规则

1. **必须**：每个 App 服务都要有 `command` 字段，不能为空
2. **必须**：输出格式为 v2 标准 docker-compose YAML（零自定义扩展）
3. **必须**：敏感值不输出明文，用 `"TODO: ..."` 替代
4. **必须**：输出单一 YAML 文件，不要拆分或用 JSON 包装
5. **必须**：基础设施端口引用使用 `${CDS_<SERVICE>_PORT}` 格式，不使用旧的 `{{host}}`/`{{port}}`
6. **必须**：App 服务必须有相对路径 volume mount（如 `./prd-api:/app`）

## 关联文档

- 配置 JSON 格式规范：`doc/design.cds-onboarding.md`
- CDS 环境变量指南：`doc/guide.cds-env.md`
- CDS 路线图：`doc/plan.cds-roadmap.md`
