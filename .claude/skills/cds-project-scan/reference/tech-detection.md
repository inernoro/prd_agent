# 技术栈检测规则

> 被 SKILL.md Phase 2 引用。详细的后端/前端/Monorepo 检测信号和推断规则。

## 后端检测

| 信号文件 | 技术栈 | Docker 镜像 | 典型命令 |
|----------|--------|-------------|----------|
| `*.sln` + `*.csproj` | .NET | `mcr.microsoft.com/dotnet/sdk:8.0` | `dotnet restore && dotnet build && dotnet run` |
| `go.mod` | Go | `golang:1.22-alpine` | `go build -o app && ./app` |
| `Cargo.toml` | Rust | `rust:1.77` | `cargo build --release && ./target/release/app` |
| `requirements.txt` / `pyproject.toml` | Python | `python:3.12-slim` | `pip install -r requirements.txt && python app.py` |
| `pom.xml` / `build.gradle` | Java/Kotlin | `eclipse-temurin:21` | `mvn package && java -jar target/*.jar` |

## 前端检测

| 信号文件 | 技术栈 | Docker 镜像 | 典型命令 |
|----------|--------|-------------|----------|
| `vite.config.*` | Vite (React/Vue) | `node:20-slim` | `{pm} install && npx vite --host 0.0.0.0` |
| `next.config.*` | Next.js | `node:20-slim` | `{pm} install && npx next dev -H 0.0.0.0` |
| `nuxt.config.*` | Nuxt.js | `node:20-slim` | `{pm} install && npx nuxi dev --host 0.0.0.0` |
| `angular.json` | Angular | `node:20-slim` | `{pm} install && npx ng serve --host 0.0.0.0` |

## 包管理器检测（`{pm}` 替换规则）

| Lock 文件 | 包管理器 | corepack 要求 |
|-----------|---------|--------------|
| `pnpm-lock.yaml` | `pnpm` | installCommand 和 runCommand 前缀 `corepack enable &&` |
| `yarn.lock` | `yarn` | 同上 |
| `package-lock.json` | `npm` | 无需 corepack |
| 都不存在 | `npm` | 无需 corepack |

**corepack 规则**：pnpm/yarn 在 `node:20-slim` 未预装，所有命令必须以 `corepack enable &&` 开头。

## Node.js 容器运行时注意事项

CDS 运行时会自动为 `node:*` 镜像注入 `CHOKIDAR_USEPOLLING=true`，避免多分支并行时耗尽内核 inotify watches（ENOSPC 错误）。cds-scan 生成的 YAML **无需**手动添加此变量。

## Monorepo 处理

多个可部署子目录时：
- 每个子目录作为独立 `buildProfile`
- `workDir` 设为相对路径（如 `"prd-api"`, `"prd-admin"`）
- `id` 使用目录名的 kebab-case

## 容器端口推断

| 场景 | 端口推断规则 |
|------|-------------|
| .NET `--urls http://0.0.0.0:XXXX` | 提取 XXXX |
| Vite `--port XXXX` | 提取 XXXX |
| `EXPOSE` in Dockerfile | 提取端口 |
| `package.json` scripts 中的 `--port` | 提取端口 |
| 都找不到 | 默认 8080（后端）/ 5173（前端） |

## 路由路径前缀推断 (`pathPrefixes`)

| 信号 | pathPrefixes 推断值 |
|------|-------------------|
| 后端 + 代码中有 `/api/` 路由 | `["/api/"]` |
| 后端 + 有 `/graphql` 端点 | `["/api/", "/graphql"]` |
| 后端 + 有 WebSocket 路径 | 追加 `"/ws/"` |
| 前端 vite.config 有 `server.proxy` | 提取代理路径前缀给后端 |
| Next.js / Nuxt.js | `["/"]`（前后端一体） |
| 纯前端 | `["/"]` |

## Docker Compose 解析

### 服务提取条件（全部满足）

1. 有 `image` 字段（纯镜像服务）
2. **没有** `build` 字段（有 build 的是应用服务，跳过）
3. 有 `ports` 声明

### Volume 处理

| 格式 | CDS 支持 | 说明 |
|------|---------|------|
| `named_vol:/container/path` | ✅ | 命名卷，自动持久化 |
| `./relative/path:/container/path` | ✅ | 绑定挂载 |
| `/absolute/path:/container/path` | ✅ | 直接使用 |
| `*:/path:ro` | ✅ | 保留只读标记 |

### 多文件优先级

`cds-compose.yml` > `docker-compose.yml` > `docker-compose.dev.yml`

### Compose 兼容性

| 特性 | CDS 状态 | 备注 |
|------|---------|------|
| `depends_on` | ✅ | 按拓扑排序启动 |
| `working_dir` | ✅ | 容器内工作目录 |
| `command` | ✅ | 合并为单一命令 |
| `labels` | ✅ | `cds.path-prefix` 用于路由 |
| `${CDS_*}` | ✅ | 自动替换 |
| `networks` (自定义) | ❌ 忽略 | CDS 使用统一网络 |
| `read_only: true` | ❌ 忽略 | 不支持只读文件系统 |
| 端口范围 | ❌ 忽略 | 仅支持单端口映射 |

## 环境变量推荐写法

| 基础设施 | App environment 推荐写法 |
|----------|-------------------------|
| `mongodb` | `MongoDB__ConnectionString: "mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}"` |
| `redis` | `Redis__ConnectionString: "${CDS_HOST}:${CDS_REDIS_PORT}"` |
| `postgres` | `DATABASE_URL: "postgres://${CDS_HOST}:${CDS_POSTGRES_PORT}/dbname"` |
| `mysql` | `DATABASE_URL: "mysql://${CDS_HOST}:${CDS_MYSQL_PORT}/dbname"` |

命名规则：`CDS_` + 服务名大写（连字符转下划线）+ `_PORT`
