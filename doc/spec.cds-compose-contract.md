# cds-compose 契约 · SSOT

> **类型**:spec(规格) | **版本**:1.0 | **最后更新**:2026-05-01 | **状态**:已实现
> **依赖**:`cds/src/services/compose-parser.ts`(解析实现)、`cdscli scan/verify`(CLI 端校验)
> **替换**:废弃 README 里零散的"compose 怎么写"段落,本文为 SSOT

---

## 0. 30 秒读懂

`cds-compose.yml`(和它的兼容形式 `docker-compose.yml`)是 CDS 接入任意项目的**唯一**入口契约。AI / 用户写错任何一个字段,部署就会在某个阶段静默失败 —— 本文集中给所有字段语义、踩过的坑和校验规则。

- **AI 写 yaml 前必读** § 2(字段表) + § 3(踩过的 7 个坑)
- **用户改 yaml 前必读** § 4(verify 校验规则)
- **接力者修 compose-parser.ts 前必读** § 5(实现位置 + 改动安全性)

---

## 1. 文件位置 & 优先级

CDS 在项目根目录按下面顺序探测,**第一个命中即用**:

```
1. cds-compose.yml          ← 推荐:CDS 专用,可写 x-cds-* 扩展
2. cds-compose.yaml
3. docker-compose.yml       ← 兼容:用户已有的标准 compose 也能直接接
4. docker-compose.yaml
5. docker-compose.dev.yml
6. docker-compose.dev.yaml
7. compose.yml
8. compose.yaml
```

实现位置:`cds/src/services/compose-parser.ts:discoverComposeFiles`。

**cdscli scan** 还会做反向选择(用户尚未写 cds-compose.yml 时):

```
1. 根目录已有 cds-compose.yml → 直接读,不再重新生成(SSOT)
2. 否则按 priority 选 docker-compose.*.yml(dev > local > 无 stem > prod)
3. 都没有 → monorepo 子目录扫描兜底
```

实现位置:`.claude/skills/cds/cli/cdscli.py:cmd_scan`。

---

## 2. 字段契约表

下面每一行都是 SSOT。AI / 用户违反任何一条,要么部署炸,要么数据隔离失败。

### 2.1 顶层

| 字段 | 类型 | 必填 | 含义 | 实现位置 |
|---|---|---|---|---|
| `services:` | dict | 是 | 服务列表(应用 + 基础设施混合) | `parseStandardCompose` |
| `volumes:` | dict | 否 | 命名 volume 声明(给 infra 用) | `toCdsCompose` |
| `x-cds-project:` | dict | 否 | 项目元信息(name/description/repo) | `parseCdsCompose` |
| `x-cds-env:` | dict | 否 | **项目级共享变量**,所有 service env 都能 `${VAR}` 引用 | `expandVarsToFixedPoint` |
| `x-cds-routing:` | array | 否 | 路由规则(预留,主要用 path-prefix) | `parseRoutingRules` |
| `x-cds-deploy-modes:` | dict | 否 | 应用 service 的多模式定义(dev/static/prod) | `parseStandardCompose` |

### 2.2 应用 service(自带源码,有相对路径 volume mount)

判定规则:`volumes:` 里有任意一项以 `./` 或 `.` 开头 → 当作应用 service(写入 BuildProfile)。
判定函数:`hasRelativeVolumeMount`。

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `image:` | string | 是 | dev 镜像(node:20 / dotnet/sdk:8.0 / python:3.12) |
| `build:` | any | 否 | **存在则跳过**(CDS 不在 cds-compose 里 build,走 image + bind mount) |
| `working_dir:` | string | 否 | 容器内工作目录,默认 `/app`,存到 `BuildProfile.containerWorkDir` |
| `volumes:` | array | 是 | 必须含一项 `./<subdir>:/<containerWorkDir>` —— 这是 source mount |
| `ports:` | array | 是 | 取最后一段当 `containerPort`(应用真实监听端口,**必须**和应用代码一致) |
| `command:` | string \| array | 是 | 容器启动命令(`pnpm dev --port ${CDS_API_PORT}` / `dotnet run` / `npm start`) |
| `environment:` | dict \| array | 否 | 容器 env;**值可以含 `${VAR}` 引用** `x-cds-env` 或同 service env 里的其他 key |
| `depends_on:` | dict \| array | 否 | 启动顺序(对 infra service 的 `id` 引用);**Phase 2 起即使不写也兜底起所有 infra** |
| `labels.cds.path-prefix:` | string | 否 | 路由前缀,如 `/api/`,proxy 把 `域名/api/*` 转给该 service |
| `labels.cds.readiness-path:` | string | 否 | 就绪探测路径,默认 `/`,4xx 也算"HTTP 活" |
| `labels.cds.readiness-timeout:` | int | 否 | 单位秒,默认 180 |
| `labels.cds.readiness-interval:` | int | 否 | 单位秒,默认 2 |
| `deploy.resources.limits:` | dict | 否 | 标准 cgroup 限制(`memory: "512M"`, `cpus: "1.5"`) |
| `x-cds-resources:` | dict | 否 | CDS 优先扩展(`memoryMB: 512`, `cpus: 1.5`),与上面二选一,本字段优先 |

### 2.3 基础设施 service(无相对路径,纯下载镜像)

判定规则:`volumes:` 里**没有任何**相对路径 → 当作 infra service。
镜像要含 ports + image 才会被采纳。

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `image:` | string | 是 | 官方镜像(mongo:7 / mysql:8 / redis:7-alpine / postgres:16) |
| `ports:` | array | 是 | 取最后一段当 `containerPort`,host port CDS 自动分配(从 `portStart` 开始) |
| `volumes:` | array | 否 | 命名 volume(`mysql_data:/var/lib/mysql`) 或 bind mount(`./init.sql:/docker-entrypoint-initdb.d/init.sql:ro`) |
| `environment:` | dict \| array | 否 | 镜像需要的初始 env(`MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}`),**必须用 `${VAR}` 引用 `x-cds-env`,不能字面量** |
| `healthcheck:` | dict | 否 | 标准 compose healthcheck;CDS 把 `service_healthy` 作为 dependsOn 的等待条件 |

---

## 3. AI / 用户最容易踩的 7 个坑(geo 实战教训)

每条都是已经 push 进生产、回头修过的代码 + 测试。

### 坑 1:env 里 `${VAR}` 嵌套引用未展开 → 容器收到字面量

```yaml
# ❌ 出错的写法
x-cds-env:
  MONGO_PASSWORD: aE7aB6zX
  MONGODB_URL: mongodb://root:${MONGO_PASSWORD}@mongodb:27017/admin?authSource=admin

services:
  backend:
    environment:
      MongoDB__ConnectionString: ${MONGODB_URL}   # 容器收到 "mongodb://root:${MONGO_PASSWORD}@..." 字面量
```

**根因**:旧版 `resolveEnvTemplates` 单次替换,不展开 cdsVars 自身的嵌套引用。

**修复**:Phase 1 改为 fixed-point iteration,8 次迭代上限防循环。详见 `compose-parser.ts:expandVarsToFixedPoint`。

**怎么写不出错**:
- `${VAR}` 嵌套是正常的(需要),不要绕过
- 只要变量在 `x-cds-env` 里有 *最终可解析* 的值即可

### 坑 2:应用 `dependsOn` 没写 → infra 不自动起 → backend 报 DNS 解析失败

```yaml
services:
  backend:
    image: dotnet/sdk:8.0
    volumes: ['./backend:/app']
    # ❌ 漏写 depends_on,但 backend 内代码连 mongodb:27017
```

**根因**:旧版 deploy 路由只起 `dependsOn` 列表里的 infra,漏写就不起。

**修复**:Phase 2 在 deploy 兜底起项目下 *所有* 未运行 infra(以 docker 实际状态为准,不信 stale state)。详见 `cds/src/routes/branches.ts:1546+`。

**怎么写不出错**:
- 推荐显式写 `depends_on`(自文档化好)
- 但忘了也没事,Phase 2 兜底会起

### 坑 3:跨项目相同 `service.id` 撞 Map key

```
项目 A: services.mongodb (containerName: cds-infra-projA-mongodb)
项目 B: services.mongodb (containerName: cds-infra-projB-mongodb)
```

**根因**:`discoverInfraContainers` 旧版用 `cds.service.id` 当 Map key,跨项目同名时 `Map.set` 互相覆盖,A 的查询拿到 B 的容器状态。

**修复**:Phase 2 改用 `containerName`(全局唯一)当 Map key。详见 `container.ts:813`。

**怎么写不出错**:
- 多项目同名 infra 是允许且常见的
- AI 不要为了"避免冲突"硬给 service 加项目前缀,平 yaml 里不需要

### 坑 4:`volumes:` 相对路径在仓库里不存在 → CDS 静默 mount 空目录

```yaml
services:
  backend:
    volumes:
      - ./sgeo/backend:/app   # ❌ 仓库里没有 sgeo/ 目录,实际仓库根是 backend/
```

**根因**:CDS 信赖 yaml 里的 workDir 字段,docker mount 不存在的目录会自动创建空 dir,容器里看到空 /app → 应用一启动就"找不到 manifest"。

**修复**:Phase 2.5 `cdscli verify` 命令在 scan 后立刻校验所有应用 service 的 workDir 是否在仓库内存在,不存在直接 fail。

**怎么写不出错**:
- 写完 `./xxx:/app` 后 `ls xxx/` 一下确认目录在
- 或跑 `cdscli verify` 一次性扫

### 坑 5:`containerPort` 与应用真实监听端口不一致

```yaml
services:
  frontend:
    image: node:20
    command: pnpm dev   # ← webpack.config.js 里 devServer.port=8000
    ports: ['3000']     # ❌ ports 写 3000,但真实监听 8000
```

**根因**:CDS proxy 转 hostPort → containerPort=3000,但容器内 webpack 监听 8000,proxy 直接拿到 connection refused。

**修复**:Phase 3 cdscli scan 自动检测应用真实端口(node 读 webpack/vite config / package.json scripts;.NET 读 appsettings.Development.json Kestrel),写入 `containerPort`。Phase 2.5 `cdscli verify` 提示这种错位。

**怎么写不出错**:
- ports 数字必须等于应用代码里硬编码或读 env 决定的端口
- 不确定就让应用读 `${PORT}` env,CDS 自动注 `CDS_<SERVICE>_PORT` 进去

### 坑 6:CDS 不重新 detect 改后的 cds-compose

用户改了 `cds-compose.yml` push 上去,但 CDS 不会自动重新扫栈。

**根因**:CDS 的 `detect stack` 只在首次 clone 时跑,后续 push 不重跑。

**修复**:Phase 3 加 `cdscli sync-compose <projectId>` 命令显式刷,UI 上加按钮。

**怎么写不出错**:
- 改 cds-compose 后必须 `cdscli sync-compose <projectId>` 推一次
- 或本地跑 `cdscli scan --apply-to-cds <projectId>` 重新提交

### 坑 7:预览域名顺序写反

```
分支 master + 项目 geo
✅ master-geo.miduo.org
❌ geo-master.miduo.org   (项目在前,违反 v3 SSOT)
```

**根因**:AI 凭直觉拼 URL,SSOT 在 `cds/src/services/preview-slug.ts:computePreviewSlug`,但人记不住公式。

**修复**:`/preview-url` 技能 + SKILL.md 顶部固化公式 + `preview-slug.test.ts` 12 个 case 锁住实现。

**怎么写不出错**:
- 永远调 `computePreviewSlug(branch, projectSlug)`,不要手拼
- AI 在交付消息里强制走 `/preview-url` 技能,不要凭记忆

---

## 4. cdscli verify 校验规则(Phase 2.5)

`cdscli verify [path]` 在 scan 后立刻跑,生成的 yaml + 仓库实际结构对照,提前给警告。返回非零时阻止 `--apply-to-cds`。

### 4.1 必报 ERROR(部署一定挂)

| 检查 | 失败条件 |
|---|---|
| **app workDir 存在** | 应用 service 的相对 mount `./xxx` 在仓库根不存在 |
| **app containerPort 必填** | 没写 `ports:` 段 |
| **infra image 必填** | service 既无 build 又无 image |
| **${VAR} 解析闭环** | env 里引用的 ${VAR} 在 `x-cds-env` 也无 default 值 |

### 4.2 报 WARNING(很可能挂,看场景)

| 检查 | 失败条件 |
|---|---|
| **schemaful DB 缺 migration** | infra 命中 mysql/postgres/sqlserver,且应用 command 不含 `migrate` / `prisma` / `dotnet ef` |
| **app port 嫌疑错位** | node 项目 webpack.config.js / vite.config.* 里检测到的端口 ≠ ports 字段 |
| **init.sql 修改未重置 volume** | 检测到 `./init.sql:/docker-entrypoint-initdb.d/...` 但 yaml 里 named volume 已存在(用户改 init.sql 后应 reset volume) |

### 4.3 报 INFO(可选改进)

| 检查 | 描述 |
|---|---|
| **dependsOn 缺失** | 应用 service env 引用了 ${MONGODB_URL} 但 dependsOn 里不含 mongodb |
| **密码含转义不安全字符** | env 里见 `mongodb://...` 含 `!` `@` `#` 等需 URL 编码字符 |

实现位置:`.claude/skills/cds/cli/cdscli.py:cmd_verify`。

---

## 5. 实现 SSOT 索引

| 主题 | 文件 | 关键函数 |
|---|---|---|
| compose 解析 | `cds/src/services/compose-parser.ts` | `parseCdsCompose` / `parseStandardCompose` |
| ${VAR} 嵌套展开 | 同上 | `expandVarsToFixedPoint` / `resolveEnvTemplates` |
| infra 容器启动 | `cds/src/services/container.ts` | `startInfraService(service, customEnv?)` |
| infra 容器发现 | 同上 | `discoverInfraContainers` (Map key = containerName) |
| deploy 自动起 infra | `cds/src/routes/branches.ts:1546+` | Phase 2 兜底 + 不信 stale state |
| 预览域名公式 | `cds/src/services/preview-slug.ts` | `computePreviewSlug(branch, projectSlug)` |
| cdscli scan | `.claude/skills/cds/cli/cdscli.py` | `cmd_scan` / `_parse_compose_services` / `_yaml_from_compose_services` |
| cdscli verify | 同上 | `cmd_verify`(Phase 2.5 新增) |

每次改这些文件之前,**必须**通读对应函数注释 + 跑配套测试:
- `cds/tests/services/compose-parser.test.ts` — env 展开、resource limits
- `cds/tests/services/container-network-isolation.test.ts` — 多项目网络隔离
- `cds/tests/services/discover-infra-cross-project.test.ts` — 跨项目同名 infra(Phase 2.5)
- `cds/tests/services/state-vs-docker-sync.test.ts` — state vs docker 实际状态(Phase 2.5)
- `cds/tests/routes/deploy-auto-infra.test.ts` — deploy 自动起 infra(Phase 2.5)
- `cds/tests/services/preview-slug.test.ts` — URL 公式

---

## 6. 不要做的事

| ❌ 不要 | 为什么 |
|---|---|
| 在 yaml 里 `services.x.image: ${MYIMG}` —— image 字段不解析 ${VAR} | 标准 compose 行为,只 env 解析 |
| 把不同项目的 infra 加项目前缀(`projA_mongodb`) | 让 yaml 不通用,Phase 2 已用 containerName 隔离 |
| 在 cds-compose 里写 `build:` 段 | CDS 不在这里 build,走 image + bind mount + command |
| 把 `host:container` port 都写死(`3000:3000`) | host port 让 CDS 分配,只写 containerPort 即可 |
| 在 env 字面量里写真实密码 | 走 `x-cds-env` + `${VAR}`,密码放项目级 customEnv |

---

## 7. 历史 / 关联文档

- `doc/plan.cds-mysql-readiness.md` — 6 阶段计划(本文是 Phase 2.5 产出)
- `doc/guide.cds-handoff-2026-05-01.md` — 上一份接力(Phase 1+2 完成时写)
- `cds/CLAUDE.md` — CDS 模块约束
- `cds/.claude/rules/scope-naming.md` — 系统级 vs 项目级命名
- `.claude/rules/cds-auto-deploy.md` — push 即部署原则

---

## 8. 给接力 AI 的最后一句

**改 yaml 前先扫 § 3 的 7 个坑;改 compose-parser.ts 前先跑 § 5 的所有测试**;改完添加新坑请追加到 § 3,不要让下一个 agent 重新踩。
