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
7. **必须**输出纯标准 docker-compose YAML，零自定义扩展

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
- [ ] Phase 7: 询问基础设施初始化（可选）
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

CDS v2 格式——纯标准 docker-compose，通过约定自动推断：

| 约定 | 含义 |
|------|------|
| 有相对路径 volume mount（`./xxx:/app`） | **App 服务** |
| 无相对路径 mount + 有 ports | **基础设施** |
| `depends_on` | 启动顺序 |
| `labels.cds.path-prefix` | 代理路由前缀 |
| `${CDS_HOST}` / `${CDS_<SERVICE>_PORT}` | 运行时替换 |

命名规则：`CDS_` + 服务名大写（连字符转下划线）+ `_PORT`

配置后附带使用说明：
```
1. cd cds && ./exec_cds.sh --background
2. 打开 CDS Dashboard → http://<服务器IP>:9900
3. 设置 → 一键导入 → 粘贴 YAML → 确认应用
```

### Phase 7: 基础设施初始化（可选）

**详细的 Docker 初始化命令和健康检查** → 见 [reference/infra-init.md](reference/infra-init.md)

## 输出格式

完整的 CDS Compose YAML 示例：

```yaml
# CDS Compose 配置 — 由 /cds-scan 自动生成
# 导入方式：CDS Dashboard → 设置 → 一键导入 → 粘贴此内容

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

## 端到端示例

**输入**: 用户对 prd_agent 项目说 `/cds-scan`

**Phase 1**: 根目录 `/home/user/prd_agent`

**Phase 2**: 检测到 3 个可部署单元
- `prd-api/` → .NET 8，端口 5000，路由 `/api/`
- `prd-admin/` → Vite + React，pnpm，端口 8000，路由 `/`
- `prd-desktop/` → Tauri 桌面端 → **跳过**（非 web 服务）

**Phase 3**: 从 `docker-compose.dev.yml` 提取 MongoDB (27017) + Redis (6379)

**Phase 4**: 从 `appsettings.json` 提取连接串，`Jwt__Secret` 标记 TODO

**Phase 5**: 展示摘要表 → 用户确认 "确认无误"

**Phase 6**: 生成上方 YAML → 附带使用说明

**Phase 7**: 询问是否初始化 → 用户选择 "不需要"

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
2. 输出格式为标准 docker-compose YAML
3. 敏感值用 `"TODO: ..."` 替代
4. 基础设施端口引用使用 `${CDS_<SERVICE>_PORT}` 格式
5. App 服务必须有相对路径 volume mount

## 关联文档

- CDS 设计文档：`doc/design.cds-onboarding.md`
- CDS 环境变量指南：`doc/guide.cds-env.md`
- CDS 路线图：`doc/plan.cds-roadmap.md`
