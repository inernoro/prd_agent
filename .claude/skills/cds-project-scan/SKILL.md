---
name: cds-project-scan
description: Scans project structure and generates CDS (Cloud Dev Space) compose YAML for one-click import. Detects tech stacks, infrastructure services, environment variables, and routing prefixes. Outputs standard docker-compose format with CDS conventions. Optionally submits the generated YAML directly to CDS for human approval via the pending-import endpoint (removes copy-paste step). Trigger words: "扫描项目", "生成 CDS 配置", "cds scan", "/cds-scan", "提交到 CDS", "apply to cds", "帮我配置 cds", "让 Claude 装到 CDS 上", "--apply-to-cds".
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
- [ ] Phase 8 (可选): 提交到 CDS 等待批准 —— 仅在用户明确要求或传 --apply-to-cds 时执行
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

### Phase 8 (可选): 提交到 CDS 等待批准

> **默认关闭**。只有满足触发条件时才执行，默认流程（用户手动复制 YAML 到 Dashboard）始终优先。

#### 触发条件（任一即可）

- 用户明确说「提交到 CDS」/「apply to cds」/「帮我配置 cds」/「让 Claude 装到 CDS 上」
- 传递参数 `/cds-scan --apply-to-cds <projectId>`（或不带 projectId，见下方"缺失 projectId 兜底"）

满足任一则进入本阶段；否则执行完 Phase 7 即收尾。

#### ⚠ 进度可见性硬要求（必读）

Phase 8 是"脚本黑盒 + 网络请求"的组合，用户如果看不到每一步在做什么，就是"屏幕静止超过 2 秒"的体验缺陷（违反 CLAUDE.md 规则 #6）。AI **必须**逐步播报进度，推荐格式：

```
CDS 提交进度（正在进行）：
- [x] 步骤 1/5：检查环境变量（CDS_HOST / AI_ACCESS_KEY）
- [x] 步骤 2/5：确认目标 projectId = proj_abc123
- [>] 步骤 3/5：POST /api/projects/proj_abc123/pending-import …
- [ ] 步骤 4/5：解析响应 importId
- [ ] 步骤 5/5：打印审批链接
```

每进入下一步，AI 必须在回复中重新渲染一次进度清单（把 `[>]` 移到下一行、`[x]` 勾掉前一行），而不是静默执行然后甩一个最终结果。失败时同样要渲染 `[✗]` 并立即说明下一步。

**禁止**：
- 一上来就跑 curl 不说话等着看结果
- 失败后只打印 HTTP 状态码没有解释
- 成功后不把 importId 和审批链接同时显示给用户

#### ⚠ CDS 版本前提

**CDS 一方需要安装我新增的 `pending-import` 功能后才可用（见 CLAUDE.md 更新记录）**。老版本 CDS 没有这个接口，调用会返回 404。进入 Phase 8 时 AI 必须先向用户复述这句话，让用户自行确认 CDS 已升级，再继续。

#### 前置检查（4 条，任一缺失立即终止）

1. 环境变量 `CDS_HOST` 已设置（认证规范复用 [cds-deploy-pipeline](../cds-deploy-pipeline/SKILL.md)）
2. 环境变量 `AI_ACCESS_KEY` 已设置（与 cds-deploy-pipeline 同一把静态密钥）
3. 目标 `projectId` 已知 —— 默认由用户提供；缺失时走下方"缺失 projectId 兜底"
4. Phase 6 已生成完整 YAML（含 `x-cds-project` 头）

#### 缺失 projectId 兜底流程

如果用户没传 `--apply-to-cds <projectId>` 或环境里没有 `PROJECT_ID`，**禁止 AI 自己猜**。AI 必须：

1. 立即停下来，告知用户："需要一个 projectId 才能提交。请先到 CDS Dashboard 创建空项目（或选已有项目），然后把项目 ID 贴给我。"
2. 给用户可直接点击的 URL：`https://$CDS_HOST/project-list` （让他一键打开）
3. 使用 `AskUserQuestion` 工具让用户粘贴 projectId，**不要**用一般对话等着猜
4. 拿到后回到 Phase 8 正常流程

未来（等 Global Agent Key 上线）可能支持 `--apply-to-cds --auto-create-project`：用 Global Key 自动 `POST /api/projects` 创建空项目，再提交 pending-import。**在此之前禁止启用**。

#### 动作：POST pending-import（播报 + 执行）

按下面这个节奏向用户播报，每一行输出对应一次真实执行或一个关键决策：

```
CDS 提交进度：
- [x] 1/5 环境变量已就绪（CDS_HOST=cds.miduo.org, AI_ACCESS_KEY 长度 N）
- [x] 2/5 目标项目 proj_abc123 已确认
- [>] 3/5 正在 POST /api/projects/proj_abc123/pending-import（约 2s）…
```

实际 curl 命令（详细状态码分支见 reference/cds-pending-import.md）：

```bash
CDS="https://$CDS_HOST"

IMPORT_ID=$(curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "$CDS/api/projects/$PROJECT_ID/pending-import" \
  -X POST -H "Content-Type: application/json" \
  -d "$(jq -n --arg yaml "$GENERATED_YAML" \
        '{agentName:"cds-project-scan",purpose:"自动扫描并提交 CDS 配置",composeYaml:$yaml}')" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['importId'])")

echo "✓ 已提交，importId=$IMPORT_ID"
echo "➡️  请到 https://$CDS_HOST/project-list?pendingImport=$IMPORT_ID 批准"
```

执行后继续播报：

```
- [x] 3/5 HTTP 201 收到，耗时 1.8s
- [x] 4/5 importId = imp_xyz789
- [x] 5/5 审批链接：https://cds.miduo.org/project-list?pendingImport=imp_xyz789

✅ 已全部完成。请点击上面链接到 CDS Dashboard 审批。
```

#### 失败模式与修复建议

失败时必须把进度清单改成失败状态 + 附上具体修复动作，例如：

```
CDS 提交进度：
- [x] 1/5 环境变量已就绪
- [x] 2/5 目标项目已确认
- [✗] 3/5 HTTP 401 认证失败

排查建议：$AI_ACCESS_KEY 与 CDS 服务端 process.env.AI_ACCESS_KEY 或 customEnv 不一致。
详情见 cds-deploy-pipeline SKILL 的双层认证架构章节。
```

| HTTP | 含义 | AI 给用户的修复动作 |
|------|------|---------------------|
| 401  | `X-AI-Access-Key` 无效 / 未配置 | 复用 cds-deploy-pipeline 的认证排查：确认 `$AI_ACCESS_KEY` 与 CDS master 进程 env 或 customEnv 一致 |
| 404  | projectId 不存在 **或** CDS 版本过旧未安装 pending-import 接口 | 让用户重新从 Dashboard 复制 projectId；如果 projectId 确实正确，则 CDS 需升级 |
| 409  | 项目未 clone ready（仓库未挂载 / repoPath 为空） | 引导用户到 Dashboard → 项目 Settings → Repository，完成 git clone 后重试 |
| 5xx  | CDS 内部错误 | 让用户查看宿主机 `cds/cds.log`（AI 无法直接访问） |

> 完整脚本（含 HTTP 状态码分支、jq 兜底、端到端示例）见 [reference/cds-pending-import.md](reference/cds-pending-import.md)。

#### 与默认流程的关系

Phase 8 是**可选升级**，不替代 Phase 7。没有 `AI_ACCESS_KEY` 或 CDS 老版本的用户仍然走「复制 YAML → 粘贴到 Dashboard」的默认路径。

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

## 关联文档

- CDS 设计文档：`doc/design.cds-onboarding.md`
- CDS 环境变量指南：`doc/guide.cds-env.md`
- CDS 路线图：`doc/plan.cds-roadmap.md`
- Phase 8 提交脚本参考：[reference/cds-pending-import.md](reference/cds-pending-import.md)
- CDS 认证规范（与 Phase 8 共享 `AI_ACCESS_KEY`）：[cds-deploy-pipeline](../cds-deploy-pipeline/SKILL.md)
