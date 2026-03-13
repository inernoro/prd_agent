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
- `pnpm-lock.yaml` 存在 → `pnpm`
- `yarn.lock` 存在 → `yarn`
- `package-lock.json` 存在 → `npm`
- 都不存在 → `npm`（默认）

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

### Phase 3：扫描基础设施

#### 3.1 Docker Compose 解析

如果存在 `docker-compose*.yml`（包括 `.dev.yml`, `.local.yml` 等变体）：

```bash
# 找到所有 compose 文件
find . -maxdepth 2 -name "docker-compose*.yml" -o -name "compose*.yml"
```

对每个 service 提取：
- `image` → `dockerImage`
- `ports` → `containerPort` + `hostPort`
- `volumes` → `volumes[]`
- `environment` → `env`

**常见服务映射**：

| Docker Compose Service | CDS 预设 | 自动注入变量 |
|------------------------|---------|-------------|
| `mongo` / `mongodb` | `presetId: "mongodb"` | `MongoDB__ConnectionString` |
| `redis` | `presetId: "redis"` | `Redis__ConnectionString` |
| `postgres` / `postgresql` | 自定义 infra | `DATABASE_URL` |
| `mysql` / `mariadb` | 自定义 infra | `DATABASE_URL` |
| `rabbitmq` | 自定义 infra | `RABBITMQ_URL` |
| `elasticsearch` | 自定义 infra | `ELASTICSEARCH_URL` |
| `minio` | 自定义 infra | `S3_ENDPOINT` |

#### 3.2 无 Docker Compose 时

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
1. 复制下方 JSON
2. 打开 CDS Dashboard → 设置 → 一键导入
3. 粘贴 → 确认应用
```

#### 5.3 JSON 输出格式

```json
{
  "$schema": "cds-config-v1",
  "project": {
    "name": "项目名称",
    "description": "自动检测的描述"
  },
  "buildProfiles": [ ... ],
  "envVars": { ... },
  "infraServices": [ ... ],
  "routingRules": []
}
```

### Phase 6：异常处理

| 场景 | 处理 |
|------|------|
| 找不到任何可部署单元 | 输出空配置 + 提示用户手动添加 |
| Docker Compose 解析失败 | 跳过 infra 部分 + 警告 |
| 端口无法推断 | 使用默认值 + `// TODO` 注释 |
| 多个 Dockerfile 冲突 | 每个都生成 profile + 提示用户选择 |
| 检测到生产数据库连接串 | 警告用户不要在 CDS 中使用生产地址 |

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
