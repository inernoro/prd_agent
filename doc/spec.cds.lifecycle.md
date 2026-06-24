# SPEC: CDS Service Lifecycle & Cache Scope

> Status: draft v1, 待 review
> Author: claude (开会讨论 + R2 实战验证后落档)
> 目的: 让用户像 Railway 一样自由控制 service 数量/路径/生命周期 + 缓存隔离/共享分级
> 实现阶段: MVP / 完整 / 进阶

---

## 1. 设计动机（real pain）

### 1.1 当下痛点（已被实战验证）
- **Ghost service 爬满浮窗** — onboard 阶段 CDS auto-detect 跟 cdscli scan 打架，生成 4-5 个 jdk-only 占位 profile，DELETE build-profile 不联动清 `branch.services`，红条永远顶着面板（mdimp 反复 5 个 ghost、需手工调 `/api/cleanup-cross-project-services` 清）
- **mysql 数据反复丢** — cacheMount 用裸 `mysql_data` 全局共享 named volume，重置项目时撞库；改成 host bind mount 又踩"路径不可写"陷阱（mdimp v1 → v2 → v3 折腾）
- **init SQL 不落 docker entrypoint** — cdscli 不识别 `init/*.sql`，必须手工 `container-exec` 灌库，每次 mysql 重起都要再灌一遍
- **Spring Boot 多模块 + actuator readinessProbe 不识别** — 业务 service 容器明明活着，readiness 探到根 `/` 返 500 导致永挂 error，forwarder 不发路由 → preview 是占位页
- **PUT profile 写回 `***[masked]***` 字面值** — UI/脚本读完改一个字段写回，原密码全变 `***`，下次 deploy 100% 跑挂
- **想加/删 service 没法自助** — 用户想"我就要 2 个 service 不要 5 个"或"再加一个 worker"，目前必须改 cds-compose 重 import，不能在 UI 改

### 1.2 用户想要的（原话整理）
1. 像 Railway 一样自由编辑 service 数量、路径
2. 各阶段生命周期可自定义（preStart / start / readiness / preStop 等）
3. 项目级缓存 vs 分支级缓存分离，有些共享有些隔离
4. 默认值用 cds-compose.yml 填充，不用从零配
5. 不需要的或短期复杂的可以一次性配置跳过

### 1.3 设计原则
- **declarative-first，imperative 兜底**：cds-compose.yml 字段直接映射 lifecycle，复杂场景才升级到 hook 脚本
- **能用为主**：MVP 只做 5 个核心 hook + 5 个 cache scope，UI 用最小可用版本
- **可扩展**：所有数据模型为 11 hook + complete UI 留位，MVP 不实现的字段保留 schema
- **破坏性安全**：默认 per-branch isolation，opt-in 才能升到共享

---

## 2. Service Lifecycle 三层抽象

### 2.1 完整 11 hook（最终目标，不在 MVP）

#### Layer A — 项目级（一个项目一辈子跑一次）
| Hook | 触发 | 默认行为 | 用户可写 |
|---|---|---|---|
| `onProjectInit` | `POST /api/projects` 后 git clone 完成 | cdscli scan + auto-import compose | DB schema seed、KMS key 注册、外部资源开通 |
| `onProjectArchive` | 项目 archive/delete | 清 project network + cache mount + audit log 归档 | S3 bucket teardown、外部 webhook 通知 |

#### Layer B — 分支级（每分支独立一份）
| Hook | 触发 | 默认行为 | 用户可写 |
|---|---|---|---|
| `onBranchCreate` | 新分支首次 deploy 前 | 复制 main scope env + alloc 端口 | 跨分支 db schema clone、subdomain DNS 注册 |
| `onBranchDestroy` | 分支删除/合并/30 天无活 | 释放端口 + 清 services 表 + 删 cache | tear-down 通知、外部资源回收 |
| `onWebhookPush` | GitHub push 命中本分支 | 重 deploy + 通知 PR bot | 自定义触发条件（仅特定文件改动才 deploy）|

#### Layer C — 容器/Service 级（每次 deploy 跑一遍）
| Hook | 触发 | 默认行为 | 用户可写 | docker-compose 对应 |
|---|---|---|---|---|
| `preStart` | 容器创建后、ENTRYPOINT 前 | 无 | DB migrate、cache warmup、灌 `init/*.sql` | - |
| `start` | 容器启动主进程 | 用 cds-compose `command` | 覆盖 command | `command:` |
| `readinessProbe` | start 后定期探测 | TCP 探 containerPort | HTTP path / SQL ping / 自定义 cmd | `healthcheck:` |
| `livenessProbe` | running 中持续探测 | 同 readiness | 同上 | `healthcheck:` |
| `onUnhealthy` | liveness 失败 N 次 | 重启容器 | snapshot logs、上报告警、不重启留尸调试 | `restart:` |
| `preStop` | 收到 stop、SIGTERM 前 | 无 | drain、flush queue、unregister from LB | `stop_grace_period` |
| `postStop` | 容器退出后 | 释放端口、保留 logs | cleanup tmp、上报最后 metrics | - |

### 2.2 MVP 范围（5 hook，必做）

只做 Layer C 的 5 个高频 hook，其它 6 个 schema 留位但 UI 不暴露：

| Hook | MVP 行为 |
|---|---|
| `preStart` | 用户可写 shell 脚本（在 ENTRYPOINT 前 `sh -c` 跑），失败则 service 进 error 不启动 |
| `start` | 默认读 cds-compose `command`，用户可在 UI 覆盖 |
| `readinessProbe` | 支持 3 种类型：`tcp`（默认探 containerPort）、`http`（指定 path）、`exec`（自定义命令）|
| `preStop` | 用户可写 shell 脚本，30s 内不结束被 SIGKILL |
| `postStop` | 用户可写 shell 脚本，best-effort，10s 上限 |

剩下 6 个（Layer A/B 全部 + Layer C 的 livenessProbe / onUnhealthy）放进配置 schema，**但 UI 不显示编辑入口**。CLI 可手工配置走"高级模式"。

---

## 3. Cache Scope 五级分级

### 3.1 完整 5 scope（MVP 全实现）

| Scope | 谁写 | 谁读 | host 路径 pattern | 用例 |
|---|---|---|---|---|
| `global` | CDS host 自己 | 全部 branch 全部 service | `/data/cds/_global/cache/<volname>` | 镜像层 / OS 包镜像 / Maven Central 镜像 |
| `project:shared` | 任一分支首次写 | 该项目全部分支 | `/data/cds/<projectId>/shared/<volname>` | `.m2/` / `.gradle/` / Go modules / Python wheels |
| `project:per-branch`（默认）| 单分支写 | 单分支读 | `/data/cds/<projectId>/branch/<branchId>/<volname>` | mysql data / redis dump / ES index / 用户上传 |
| `project:per-deploy` | 单次 deploy | 单次 deploy | `/data/cds/<projectId>/branch/<branchId>/deploy/<deployId>/<volname>` | `target/` / `dist/` / `.next/cache` |
| `project:per-service` | 单 service | 单 service | `/data/cds/<projectId>/branch/<branchId>/svc/<serviceName>/<volname>` | service 内独立索引 |

**默认是 `project:per-branch`**（最安全，避免 mdimp 那种撞库）。用户**显式 opt-in** 才能升到 `shared` 或 `global`。

### 3.2 cds-compose.yml 表达

复用 docker-compose 原生 `volumes:` + CDS 自定义 `x-cds-cache-scope` 标签：

```yaml
services:
  mysql:
    volumes:
      - mysql_data:/var/lib/mysql            # 默认 per-branch
      - ./init:/docker-entrypoint-initdb.d:ro  # bind mount worktree（CDS 自动 mount /app）
  imp-api:
    volumes:
      - maven_cache:/root/.m2                # opt-in shared
      - target_build:/app/target             # opt-in per-deploy

volumes:
  mysql_data: {}                              # 不写 scope = 默认 per-branch
  maven_cache:
    x-cds-cache-scope: project:shared
  target_build:
    x-cds-cache-scope: project:per-deploy
```

CDS 服务端解析 compose 时把 volume 名 + scope 翻译成具体 host 路径，container runtime 自动 bind mount 上去。**用户完全不用关心 host 路径**，只表达意图（shared 还是 isolated）。

### 3.3 改 scope 时的安全机制

UI 改 scope 下拉框 → CDS 弹确认框：
- `per-branch → shared`：警告"会跨分支共享数据，是否继续"
- `shared → per-branch`：警告"现有跨分支数据会迁移到当前分支独占副本，其它分支数据被清空"
- `per-deploy → per-branch`：警告"会从临时缓存升级为持久存储"
- 任何方向改 → 提供 `dry-run` 看影响

---

## 4. UI 布局（左右两栏 → 项目设置页 6 tab）

```
项目设置页：

┌─────────────────────────────────────────────────────────┐
│ [Services] [Volumes] [Env] [Domains] [Lifecycle] [Logs]│
├─────────────────────────────────────────────────────────┤
│                                                          │
│ Services tab → 左栏选 service，右栏改 image/path/replicas│
│ Volumes tab  → 表格列所有 volume + scope，可改可删       │
│ Lifecycle tab→ 选 service / 选 hook，编辑脚本            │
│ Env tab      → KV 表，scope=_global/项目/单分支          │
│ Domains tab  → 自定义子域名 + path-prefix 绑某 service   │
│ Logs tab     → service x deploy x 时间 三维过滤          │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 4.1 Lifecycle tab 的左右两栏设计

```
┌─────────────────────────────────────────────────────────┐
│ Lifecycle for: [选 service: imp-api-mdimp ▼]           │
├──────────────┬──────────────────────────────────────────┤
│ Hooks        │  Selected: preStart                      │
│              │                                          │
│ [edited] preStart  │  ┌────────────────────────────────────┐ │
│ [default] start    │  │ #!/bin/sh                          │ │
│ [edited] readiness │  │ # 灌 init SQL                      │ │
│ [empty] liveness   │  │ for f in /app/init/*.sql; do        │ │
│ [empty] onUnhlth   │  │   mysql -uroot -p$ROOT_PWD < $f     │ │
│ [edited] preStop   │  │ done                                │ │
│ [empty] postStop   │  │                                    │ │
│              │  └────────────────────────────────────┘ │
│ + Layer A/B  │                                          │
│   (折叠高级) │  [Dry run]  [Save]  [History]            │
│              │                                          │
│              │  Last execution: 2 min ago, exit=0, 1.3s│
│              │  > View logs                             │
└──────────────┴──────────────────────────────────────────┘
```

- 左栏：hook 列表，三态（已编辑 / 默认 / 未启用）
- 右栏：脚本编辑器（Monaco / CodeMirror）+ dry-run + 历史
- Layer A/B 折叠在底部"高级模式"，避免 MVP 时 UI 复杂

### 4.2 Services tab 的左右两栏

```
┌─────────────────────────────────────────────────────────┐
│ Services                                                │
├──────────────┬──────────────────────────────────────────┤
│ Service list │  imp-api-mdimp                           │
│              │  ┌─────────────────────────────────────┐ │
│ [x] mysql    │  │ Image: maven:3.9-eclipse-temurin-21 │ │
│ [x] redis    │  │ Tag:   [latest      v]              │ │
│ [x] rabbitmq │  │ Path prefixes: /api/,/actuator/...  │ │
│ [x] imp-api  │  │ Replicas: [1     ]                  │ │
│ [x] imp-admin│  │ CPU/Mem:  [0.5 / 2GB]               │ │
│              │  │ Volumes:  -> 跳到 Volumes tab       │ │
│ + 新建 svc   │  │ Env:      -> 跳到 Env tab           │ │
│ - 删除选中   │  │ Lifecycle:-> 跳到 Lifecycle tab     │ │
│              │  └─────────────────────────────────────┘ │
└──────────────┴──────────────────────────────────────────┘
```

- 左栏：service CRUD（用户的"自由编辑创建 2 或 3 个"诉求）
- 右栏：选中 service 的核心字段（image/path/replicas/资源），其它字段跳到对应 tab

---

## 5. cds-compose.yml 自动映射规则

CDS scan 时，把 compose 字段翻成 lifecycle 配置，用户在 UI 看到默认值已填好：

| compose 字段 | 自动填到 hook | 用户编辑后 |
|---|---|---|
| `command:` | `start` | 覆盖 compose 的 `command:` |
| `healthcheck.test:` | `readinessProbe` + `livenessProbe` | 同上 |
| `depends_on:` | `preStart` 自动加 wait-for-it | 用户可关 |
| `restart:` | `onUnhealthy` policy | 升级到自定义脚本 |
| `stop_grace_period` + `stop_signal` | `preStop` | 升级到自定义脚本 |
| `volumes: ./init:/docker-entrypoint-initdb.d` | `preStart` 自动跑 SQL | （用户基本不改）|
| `x-cds-lifecycle:` 扩展段 | 直接给 hook 写脚本 | declarative+imperative 共存 |

`x-cds-lifecycle` 扩展段示例：

```yaml
services:
  imp-api:
    image: maven:3.9-eclipse-temurin-21
    command: mvn spring-boot:run
    healthcheck:
      test: curl -f http://localhost:8080/actuator/health
    x-cds-lifecycle:
      preStart: |
        echo "warming maven cache"
        mvn dependency:go-offline -q
      preStop: |
        curl -X POST http://localhost:8080/actuator/shutdown
        sleep 5
      readinessProbe:
        type: http
        path: /actuator/health
        timeoutSeconds: 600
```

---

## 6. 跟现有 bug 的耦合（顺手一起解）

| 老 bug | lifecycle/cache 设计如何解 |
|---|---|
| **L** cdscli mysql 不挂 init 目录 | scan 时识别 `init/*.sql` 自动挂 `/docker-entrypoint-initdb.d` 或填 `preStart` hook |
| **N** auto-detect 跟 cdscli scan 打架（5 ghost 来源） | `onProjectInit` 只跑 cdscli scan，auto-detect 默认关 |
| **F** DELETE profile 不清 branch.services | DELETE 联动调 `cleanup-cross-project-services`；或 `onBranchDestroy` 重建 services 列表 |
| **E** PUT profile 把 mask 字面量当真值 | hook 编辑器保存前比对 `***[masked]***`，强制"重输或保留"二选一 |
| **P** imp-scan-web stopped 不重启 | `onUnhealthy` 用户自定义 retry 策略，CDS 不假设 |
| **C** infra 不重新 attach 网络 | infra 用 `global` cache scope；deploy 仅重 attach 不重建 |
| **D** profile 容器没短别名 | `onBranchCreate` 自动给所有 service 加 `--network-alias <serviceName>` |
| **G** noHttp:true 不 fallback TCP 探测 | readinessProbe MVP 默认就是 TCP 探 containerPort |
| **K** cdscli env 名错配 (`CDS_MYSQL_USER=app` vs `imp_user`) | scan 优先读 docker-compose.yml 凭据，不另起新名 |

---

## 7. 实现阶段拆分

### 7.1 MVP（2-3 周）

#### 后端
- [ ] BuildProfile schema 加字段：`lifecycle.{preStart,start,readinessProbe,preStop,postStop}` 5 个 hook
- [ ] Volume schema 加 `cacheScope` 字段（5 种 scope 之一），默认 `project:per-branch`
- [ ] CDS deploy runtime 解析 hook：preStart 在 ENTRYPOINT 前 `sh -c` 跑、preStop 在 stop 前调
- [ ] readinessProbe 支持 tcp/http/exec 三种 type
- [ ] cdscli scan 输出 `lifecycle:` + `volumes:` 带 scope（自动从 compose 字段映射）
- [ ] `POST /api/projects/:id/services` 增删 service（不再要求重 import 整个 compose）
- [ ] DELETE profile 联动调 cleanup-cross-project-services（解 bug F）
- [ ] PUT profile 拦截 `***[masked]***` 字面值（解 bug E）

#### 前端
- [ ] 项目设置页加 [Services] [Volumes] [Lifecycle] 3 个 tab（Env/Domains/Logs 复用现有）
- [ ] Services tab 实现增删 + 改 image/path/replicas
- [ ] Volumes tab 实现表格 + scope 下拉（含改 scope 时确认）
- [ ] Lifecycle tab 左右两栏 + Monaco 编辑器（5 个 hook 可编）
- [ ] dry-run 走 `POST /api/branches/:id/lifecycle/dry-run`，回显容器内 stderr/stdout

#### 验收
- [ ] mdimp 的 6 hack 全部通过 UI 配出来（init SQL preStart / readiness /actuator/health / mysql_data per-branch / etc）
- [ ] 用户能在 UI 把 mdimp 的 service 数从 5 改成 3（删 imp-supplier / imp-scan-web）不报错
- [ ] mysql 重启后表不丢（per-branch volume 默认）

### 7.2 完整版（额外 2 周）
- [ ] Layer A/B 全部 6 个 hook（Project/Branch 级）
- [ ] Lifecycle 历史日志 + 重放
- [ ] 改 cache scope 的 dry-run 影响预览
- [ ] hook 编辑器集成 LLM（自然语言 -> 脚本）
- [ ] hook marketplace（共享常用 hook 模板：spring-boot warmup / nginx graceful reload / etc）

### 7.3 进阶（差异化）
- [ ] LLM 帮用户从 cds-compose 写 hook（"我要在启动前 warm 缓存" -> 自动生成 preStart 脚本）
- [ ] hook A/B 灰度（同一 service 两个 hook 版本，按流量比例）
- [ ] hook 跨项目复用（"用 prd-agent 的 spring-boot warmup hook"）

---

## 8. 数据模型变更

### BuildProfile schema 新增字段

```typescript
interface BuildProfile {
  // ... existing fields
  lifecycle?: {
    preStart?: { script: string; timeoutSeconds?: number };
    start?: { command?: string };  // 覆盖 compose command
    readinessProbe?:
      | { type: 'tcp'; port: number; periodSeconds?: number }
      | { type: 'http'; path: string; port?: number; timeoutSeconds?: number }
      | { type: 'exec'; command: string; timeoutSeconds?: number };
    livenessProbe?: /* same as readiness */;
    onUnhealthy?: { script?: string; restart?: 'always' | 'never' | 'on-failure' };  // MVP 不 UI
    preStop?: { script: string; gracePeriodSeconds?: number };
    postStop?: { script: string; timeoutSeconds?: number };
  };
}

interface Volume {
  name: string;
  cacheScope?: 'global' | 'project:shared' | 'project:per-branch' | 'project:per-deploy' | 'project:per-service';
  // 默认 project:per-branch
}

interface Project {
  // ... existing
  lifecycle?: {
    onProjectInit?: { script: string };    // MVP 不 UI
    onProjectArchive?: { script: string }; // MVP 不 UI
  };
}

interface Branch {
  // ... existing
  lifecycle?: {
    onBranchCreate?: { script: string };    // MVP 不 UI
    onBranchDestroy?: { script: string };   // MVP 不 UI
    onWebhookPush?: { script: string };     // MVP 不 UI
  };
}
```

MVP 暴露 UI 编辑入口的只有 `BuildProfile.lifecycle.{preStart,start,readinessProbe,preStop,postStop}` + `Volume.cacheScope`。其它字段 schema 上有，CLI 能 PUT，UI 不显示。

---

## 9. 迁移路径

老 BuildProfile 的 `cacheMounts: [{hostPath, containerPath}]` 字段保留，但当 volume.cacheScope 存在时优先用 cacheScope。给 1 个 grace period，下版本 `cacheMounts` 字段标 deprecated，再下版本删除。

老 BuildProfile 没 lifecycle 字段时按 compose 默认行为，零迁移。

---

## 10. 跳过 / 一次性配置 list（按用户"短期不需要的可跳过"原则）

MVP 完全跳过：
- Layer A/B 6 个 hook 的 UI 入口
- livenessProbe / onUnhealthy 的 UI 入口
- hook 历史日志查看
- LLM 集成
- hook marketplace

**但数据 schema 必须留位**，CLI 能配，下版本可加 UI。

---

## 11. Open question（需要用户拍板）

1. Lifecycle hook 脚本的 runtime：是在 service 容器内跑（继承容器 PATH/env），还是 sidecar 容器内跑（隔离）？
2. preStop 脚本失败是阻塞 stop 还是 best-effort？
3. cache scope 改了之后是立刻迁移数据，还是下次 deploy 才生效？
4. Layer B `onWebhookPush` 是默认装好（重 deploy + 通知），还是要用户显式开？
5. hook 脚本能不能调 CDS API（`curl $CDS_API/...`）？要的话怎么注入凭据？

---

## 12. 验收标准

MVP 上线后必须能做到：
1. 新 onboard 项目无 ghost service
2. mdimp 类项目 mysql 重启不丢数据（默认行为，无需手工配）
3. 用户能在 UI 改 service 数量、改 path-prefix
4. 用户能在 UI 写 preStart 脚本，service deploy 时自动跑
5. 用户能改 readinessProbe 路径（解决 mdimp 那种 actuator/health 问题）
6. Volume scope 改 shared / per-branch，host 路径自动迁移
7. DELETE service 后浮窗里马上消失（无 ghost 残留）

7 项中任 1 项不达成，MVP 不算完工。
