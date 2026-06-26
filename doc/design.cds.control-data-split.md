# CDS 控制面 / 数据面分离设计(蓝绿部分已废弃)

> **版本**:v2.0 | **日期**:2026-05-09 | **状态**:**Forwarder 已落地,蓝绿方案已弃用**
>
> 2026-05-09 更新:本设计的"控制面/数据面分离 + 独立 Forwarder"部分已 100% 落地
> (见 `doc/report.cds.forwarder-success.md`),但"Admin Daemon 蓝绿热替换"部分
> 因 verify-target stage 反复卡死导致放弃,改为更简单的"daemon 走 systemd 重启,
> 业务流量由独立 forwarder 进程承接"的方案。本文档下文中所有 supervisor /
> standby / active-color / blue-green 相关章节已**不再代表当前实现**,仅保留作为
> 决策记录。蓝绿相关代码(`blue-green-bootstrap.ts` / `blue-green-supervisor.ts`
> / `standby-controller.ts` / `active-color-store.ts` 等)已从仓库删除。
>
> 历史信息(原始 v1.0):2026-05-08 方案审批中,代码未启动。
>
> 本文档回答一个核心问题:**CDS 自更新时,业务流量为什么会断,怎么改成永远不断?**
>
> 关联主文档:`doc/design.cds.md`(CDS 整体架构)、`doc/design.cds.resilience.md`(容量与故障隔离)、`doc/report.cds.self-update-timing-audit.md`(self-update 时序审视)

---

## 一、管理摘要

- **解决什么问题**:CDS daemon 兼任"REST API + UI + 反向代理"三个角色,自更新时整个进程 process.exit + 重启,**反向代理也跟着断 8-17s**,所有正在访问预览域名的用户、SSE 长连接、Bridge 操作全部受影响。即使 Phase A 把后端编译时间降到 60s 以内,daemon 重启那 8 秒钟仍是硬伤
- **方案概述**:把 CDS 一个进程拆成两个 — **Forwarder(数据面,永不重启)+ Admin Daemon(控制面,蓝绿切换)**。nginx 顶层只做 TLS 与域名分发,不参与动态路由;forwarder 用 TypeScript 写,路由表来自 mongo,毫秒级生效;admin daemon 自更新时 spawn 第二个实例(绿),健康检查通过后切流再退役旧实例(蓝),**业务流量永远 0 中断**
- **业务价值**:用户访问预览域名 100% 0 抖动;admin UI 切换感知 ≤0.5s 且不再有"CDS 重启中"全屏 overlay;为后续灰度发布、版本并存、多副本横向扩展奠定基础
- **影响范围**:`cds/` 新增 `forwarder/` 子模块、新增 `cds-forwarder.service` systemd unit、admin daemon 增 `--standby` 模式 + graceful shutdown;nginx 配置简化(不再 per-branch 渲染 location);新增系统级网络拓扑视图 `/network-topology`
- **预计风险**:中 — 拆进程边界要小心写时序(双 daemon 短窗口);通过 `--standby` flag 强排他写入 + supervisor 编排单点切流 + 全自动回滚兜底,把风险压到与现行单进程同级;失败回退开关 `CDS_DISABLE_BLUE_GREEN=1` 让运维一键回到老路径

---

## 二、产品定位

CDS 是 **多租户分支预览部署平台** — 给开发团队的每个 git 分支起独立容器、绑定子域名供产品/QA/老板验收。它本质是个 **mini-PaaS**。任何成熟 PaaS(Vercel、Netlify、Heroku、Cloudflare Pages)都做了控制面/数据面分离 — 这是 CDS 走向生产可用的必经一步。

**业务特征**:
- 转发流量(99% 请求):一个 HTTP 反代,容器端口很少变,极少需要重启
- Admin 操作(1% 请求):部署、查日志、改配置、自更新,频繁变化,需要随时升级

**两件事的更新频率与风险等级根本不同**,不应共进退。

---

## 三、用户场景

### 场景 1:前端开发者点"立即更新"

**今天**:点完 banner 显示"CDS 重启中 · 17s",同时打开的预览域名也卡住,SSE 报告流断了。

**改造后**:点完 banner 显示"切换中 · 0.5s",同时打开的 *.miduo.org 预览域名**完全无感**(forwarder 没动)。admin 子域名 `cds.miduo.org` 仅在 nginx upstream reload 那一瞬间(<200ms)有 buffered 等待。

### 场景 2:多团队同时使用

**今天**:Bob 在用 prj-a 的预览域名验收,Alice 触发 self-update,Bob 的浏览器卡 17 秒。Bob 投诉。

**改造后**:Alice 自更新和 Bob 验收互不干扰。Bob 100% 无感。

### 场景 3:灰度发布(未来能力)

**今天**:不可能,CDS 只能"全量切换"。

**改造后**:forwarder 路由表加 `weight` 字段 — 同一子域名 50% 流量打到 v2、50% 留 v1,实时观测对比。

### 场景 4:故障定位

**今天**:admin daemon 崩溃 → 整站 502,运维去服务器看 systemd 日志。

**改造后**:admin 崩溃 → forwarder 仍转发业务流量,只有 admin UI 不可用,业务零影响;系统级网络拓扑面板一眼看出"控制面 down,数据面 up"。

---

## 四、核心能力

### 4.1 Forwarder(数据面)

无状态反向代理进程。职责清单:

| 能力 | 实现 |
|---|---|
| 监听 9090,接收 nginx 透传的所有 *.miduo.org 流量 | Node `http.createServer` |
| 根据 `Host` + `Path` 查路由表 → 决定 upstream(分支容器端口) | TypeScript Map 查表 + LRU cache |
| 转发请求(支持 HTTP/1.1 + WebSocket Upgrade + SSE 长连接) | `http-proxy` lib(已成熟,1.5k 行) |
| 路由表实时刷新(mongo change stream) | `MongoClient.watch()` + 内存原子替换 |
| 路由表本地 JSON fallback(mongo 不可达时) | 启动加载 `.cds/forwarder-routes.json` |
| 健康检查 / 灰度权重 / 版本路由 | TypeScript 数据结构,代码层任意逻辑 |
| 容器不可达时 503 + 友好等待页 | 复用现有 `cds-waiting.html` |
| 不接触 mongo write、不调度、不 build | 写一次再不动 |

**关键设计决策**:

- **进程独立**:与 admin daemon 完全分离的 systemd unit,各自 Restart=always
- **共享状态只读**:forwarder 只 read mongo / 文件,从不 write
- **更新频率极低**:逻辑稳定后 forwarder 几个月不需要重新发版;它本身的更新走 **rolling restart**(短暂 502 用 nginx fallback page 兜底),不再用蓝绿(过度工程)

### 4.2 Admin Daemon(控制面)

承担今日 daemon 除"反向代理"外的所有职责:REST API、UI、调度、Worker、SSE 推送、self-update。蓝绿切换:

| 阶段 | 行为 |
|---|---|
| 部署绿 | self-update 路由 spawn 第二个 admin daemon,监听 9901,启用 `--standby` flag |
| 健康检查 | supervisor 轮询 `http://127.0.0.1:9901/healthz?probe=routes`,连续 3 次 200 即就绪(≤2s) |
| 切流 | 改 `nginx-active-upstream.conf` 把 `cds_admin` upstream 指向 9901,`docker exec cds_nginx nginx -t && nginx -s reload` |
| 解禁绿 | `POST http://127.0.0.1:9901/api/_internal/promote` 让绿退出 standby,接管写入 |
| 退役蓝 | SIGTERM 给蓝(pid 9900)→ graceful drain SSE / worker → 30s 兜底 SIGKILL |
| 身份对调 | 写 `.cds/active-color` = green,下次切换变 spawn 9900 端口的"蓝" |

### 4.3 系统级网络拓扑面板

新页面 `/network-topology`(系统级,放 cds-settings 旁边或独立路由)。**一张图**:

- 左列:所有子域名(根域 / `*.<root>` 通配)
- 中列:nginx 顶层 upstream 表 → forwarder / admin
- 中右列:forwarder 路由表(host + path 前缀 → 容器端口)
- 右列:所有运行中的容器(分支预览 + admin 蓝绿 + infra services 如 mongo/redis)

每条边可点击 → 弹出详情(健康状态、最近 1 小时流量、最近一次响应时间)。**所有"端口、前缀、转发关系"一览无余**。

### 4.4 版本可视化(防"以为更新了实际没更新")

- Dashboard 左上 / 顶部常驻 chip:`build: d931074 · active: green`
- 不一致检测:`/api/self-status` 返回 `{ gitHead, builtSha, activeDaemonSha, activeColor, activePort }`,任两个不一致 → 红色"漂移"告警
- self-update 流水里每条记录都带 `buildShaAtFinish`;UI 历史区如果某条记录的 toSha ≠ buildShaAtFinish,直接红字标 mismatch

---

## 五、架构

```
                     ┌─────────────────────────────────┐
                     │ nginx (cds_nginx 容器,永不动)   │
                     │ TLS 终结 + 域名分发              │
                     │   *.miduo.org   → forwarder:9090│
                     │   cds.miduo.org → admin_active  │ ← active-upstream.conf
                     └─────────────────────────────────┘
                              ↓                   ↓
        ┌──────────────────────────┐   ┌──────────────────────────────┐
        │ Forwarder(:9090)         │   │ Admin Daemon                 │
        │ ─ 永不重启 ─             │   │ 蓝(:9900) / 绿(:9901)        │
        │ TypeScript 反代          │   │ ─ 蓝绿切换,supervisor 编排 ─ │
        │ 路由表(mongo + JSON)     │   │ REST API / UI / 调度 / Worker│
        │ Host+Path → 容器端口     │   │ self-update 切这里,流量不动 │
        │ 灰度权重 / 版本路由       │   │ standby/promote 强排他写入   │
        └──────────────────────────┘   └──────────────────────────────┘
                              ↓                   ↓
           ┌───────────────────────────────────────────────────┐
           │ docker network: 所有分支预览容器 + infra services │
           └───────────────────────────────────────────────────┘
```

### 进程清单(systemd 视角)

| Unit | 端口 | 重启频率 |
|---|---|---|
| `cds-nginx.service`(已有,docker-compose) | 80 / 443 | 几乎不动 |
| `cds-forwarder.service`(新增) | 9090 | 几月不动 |
| `cds-master.service`(已有,改造为 admin) | 9900 / 9901 蓝绿 | 每次 self-update 切换,业务无感 |

---

## 六、数据设计

### 6.1 mongo 路由表(forwarder 消费)

新 collection `cds_forwarder_routes`,每行一条路由规则:

| 字段 | 含义 |
|---|---|
| `_id` | 自增 |
| `host` | `*.miduo.org` 通配段或精确域名 |
| `pathPrefix` | 可选路径前缀,如 `/api/` |
| `upstreamHost` | 目标容器 IP / hostname(默认 127.0.0.1) |
| `upstreamPort` | 目标端口 |
| `branchId` | 反查用 |
| `weight` | 灰度权重 1-100,默认 100 |
| `version` | 版本标(future) |
| `healthState` | running / unhealthy / unknown |
| `updatedAt` | mongo change stream 触发依据 |

部署分支时,scheduler 写一条;停掉分支时,删一条。forwarder mongo watch 实时拿到变更。

### 6.2 active-color / active-port 文件

`cds/.cds/active-color` 内容:`blue` 或 `green`(纯文本,supervisor 切换时原子写)
`cds/.cds/active-port` 内容:`9900` 或 `9901`(同上)

文件持久化,daemon 启动时读决定身份。

### 6.3 build 元信息

`cds/dist/.build-meta.json`:`{ buildSha, buildTime, gitBranch }`,esbuild 后写入。daemon 启动时读取并暴露给 self-status。

---

## 七、接口设计

### 7.1 admin daemon 新增内部接口(只接受回环)

| 接口 | 用途 |
|---|---|
| `POST /api/_internal/promote` | supervisor 调用,让 standby 实例转为 active(允许写) |
| `POST /api/_internal/standby` | 让当前实例进入 standby(不接 worker / scheduler) |
| `POST /api/_internal/graceful-shutdown` | 触发优雅关停,与 SIGTERM 等价但可携带 reason |
| `GET /healthz?probe=routes` | 已存在,加返回 `{ buildSha, color, port }` |

`_internal/*` 路由强制校验 `req.ip === '127.0.0.1'`,拒绝外部访问。

### 7.2 forwarder 内部接口(diagnostic 用)

| 接口 | 用途 |
|---|---|
| `GET /__forwarder/healthz` | 自身健康 |
| `GET /__forwarder/routes` | dump 当前路由表(只接受回环) |
| `GET /__forwarder/stats` | 统计信息 |

### 7.3 网络拓扑面板 API

新增 `GET /api/cds-system/network-topology` 返回:

```
{
  domains: [{ root, hasTls, ... }],
  nginxUpstreams: [{ name, target }],
  forwarder: { port, healthy, routesCount },
  adminDaemons: [{ color, port, alive, buildSha }],
  containers: [{ name, branchId, profileId, port, status }],
  edges: [{ from, to, label }]  // 给 ReactFlow 画线
}
```

---

## 八、关联设计文档

- `doc/design.cds.md` — CDS 整体架构(本设计是其子模块)
- `doc/design.cds.resilience.md` — 容量预算与休眠池(forwarder 健康探测可复用其热度策略)
- `doc/design.platform.server-authority.md` — Run/Worker 模式(admin daemon 蓝绿切换时 worker 怎么接力)
- `doc/report.cds.self-update-timing-audit.md` — 时序审视(本方案是 Phase B+C 合并实施)
- `doc/spec.cds-blue-green-mece-acceptance.md` — MECE 验收清单(本设计的契约,先于实现)

---

## 九、风险

| 风险 | 概率 | 后果 | 缓解 |
|---|---|---|---|
| 双 admin daemon 短窗口同时写 mongo | 中 | 状态错乱 | `--standby` 隔离写入路径,promote 之前 daemon 不接 worker / scheduler / 业务 POST/PUT/DELETE,仅接 healthz + read API |
| nginx reload 失败导致全站 502 | 低 | 业务中断 | reload 前 `nginx -t` 校验语法 + 原 upstream 文件备份 + supervisor 一键回滚 |
| Forwarder 自身崩溃 | 低 | *.miduo.org 全断 | systemd Restart=always(<2s 拉起);nginx 顶层 502 fallback 给 cds-waiting.html;告警立即触发 |
| Forwarder mongo watch 断线 | 中 | 路由表不再更新 | 心跳重连 + 启动加载 JSON 快照兜底 + UI 顶部告警 |
| Worker 任务跨 daemon 接力 | 中 | 长跑任务被切到新 daemon 时丢失 | graceful shutdown 30s 等 worker 完成;Run/Worker 模式本身已持久化 run state,新 daemon 起来会扫 stale runs 接管 |
| supervisor 进程崩 | 极低 | 切到一半卡住 | 单一原子动作完成才标记切换成功;失败状态可被下次 self-update 通过 reconcile 修复 |
| 路由表与实际容器不一致 | 中 | 流量打错地方或 503 | scheduler 写路由表时同时校验容器健康;forwarder 收到上游连不上时降级到等待页并标 healthState=unhealthy |
| 配置写错(nginx / forwarder routes) | 中 | 业务 502 | spec 测试覆盖所有路由变更场景(见 MECE 清单);系统级网络拓扑面板提供实时可视化排查 |

---

## 十、实施分阶段

| 阶段 | 内容 | 可独立上线? |
|---|---|---|
| **B'.1** | spec / test / 设计文档(本批) | 文档独立合,不影响代码 |
| **B'.2** | Forwarder 进程骨架(无路由表 watch,先静态) | 与现有 daemon 并存,默认未启用 |
| **B'.3** | Admin daemon `--standby` + graceful shutdown + promote | 不影响现有 self-update 路径(默认走老路) |
| **B'.4** | nginx active-upstream 拆 conf + 模板更新 | 可独立合,不开蓝绿仍走老路 |
| **B'.5** | supervisor 编排 + self-update 路由切到 supervisor | 通过 `CDS_ENABLE_BLUE_GREEN=1` 开关启用,默认关 |
| **B'.6** | 网络拓扑面板 + 顶部 build SHA chip | 独立合,任何阶段都受益 |
| **B'.7** | mongo change stream 路由表 + 灰度权重 | forwarder 升级,需 mongo replica set |
| **B'.8** | 端到端验证 + 灰度开启 `CDS_ENABLE_BLUE_GREEN=1` 默认值切到 1 | 真正上线 |

每个阶段都有独立的 TDD 测试集,失败不阻塞前置阶段已合并代码。
