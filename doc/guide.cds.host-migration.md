# CDS 宿主迁移 Runbook（拉取 / 构建 / 性能检查单）

> **类型**:guide(怎么操作) · **更新**:2026-07-15 · **状态**:待执行（迁移窗口未定）
>
> 背景:用户计划迁移 CDS 宿主。本 runbook 把迁移前中后的检查单固化下来,数据依据来自
> `doc/debt.cds.performance.md`(2026-06-21/22 性能专项实测)与 `doc/debt.cds.ci-prebuilt.md`。

---

## 一、迁移前(旧实例上,提前做)

- [ ] **注册 cds-self 项目**(见 `doc/design.cds.self-hosting.md` §四):迁移期是 CDS 改动最频繁、最怕生产不稳的窗口,迁移相关的 CDS 改动先在预览实例上验收,生产实例只在确认后 self-update 一次。
- [ ] **抄录当前调度器配置**:`GET /api/scheduler/state`(2026-07-15 实测:enabled=true, maxHotBranches=14, idleTTLSeconds=1800)。该配置持久化在 state 里,随数据迁移;但迁移后必须核对(见 §三.1)。
- [ ] **抄录构建并发闸**:`CDS_MAX_CONCURRENT_BUILDS`(默认 3),迁移后按新机核数调。
- [ ] **盘点必迁清单**(只有这三样是不可再生的,见 §二):mongo-split 状态库、`.cds.env`、TLS 证书。
- [ ] **给 ghcr 镜像包确认 public**(极速版依赖,`debt.cds.ci-prebuilt` #1):新宿主匿名 `docker pull` 才能工作。

## 二、迁移中(必须迁 vs 不要迁)

### 必须迁(不可再生)

| 项 | 位置 | 注意 |
|---|---|---|
| mongo-split 状态库 | CDS_MONGO_URI 指向的库 | 项目/分支/profile/调度器 override 全在里面 |
| `.cds.env` | `cds/.cds.env` | **`CDS_JWT_SECRET` 一个字都不能变**——它同时是所有项目容器的 `Jwt__Secret` 注入源、MAP 平台 key 的 AES 加密密钥(隔离穿透台账通道 1/2:换它 = 存量密文全哑) |
| TLS 通配证书 | `/etc/nginx/certs/<domain>.{crt,key}` | `*.miduo.org` 单层通配 |

### 不要迁(可再生,迁了只会带垃圾)

- `.cds-repos/` 与 `.cds-worktrees/`:到新机重 clone(项目 clone 本来就是 `--depth 1`,分钟级);
- docker 镜像 / named volume 缓存(pnpm store、NuGet):新机重建 + 预热(§三.3);
- systemd 单元:CDS 启动时 `systemd-sync` 自动重写,无需手抄。

### 切换纪律

- [ ] DNS 切换前后两个实例会短暂并存:**旧实例先停 CDS 进程再切 DNS**,避免两个实例同时写共享 Mongo 的全局状态行(隔离穿透通道 4;`DeploymentAuthority` 只挡分支预览,挡不住两个"都自认生产"的实例)。

## 三、迁移后第一天(逐条核对)

1. **调度器**:`GET /api/scheduler/state` 确认 `enabled:true`。2026-06-21 的头号性能事故就是它被禁用——43 个容器全天跑、load 143%、构建从几分钟拖到 10 分钟以上。maxHotBranches 按新机核数定(参考:18 核配 14)。
2. **perf-health**:`GET /api/cds-system/perf-health` 无红色告警。当前实例(2026-07-15)有一条黄色:运行容器 67 个超过核数 2 倍阈值(36)——迁移后观察这个数是否回落,不回落说明有容器没被调度器纳管。
3. **缓存预热**:手动部署一次 main,把 pnpm store / NuGet volume 焐热,再放开日常分支。
4. **极速版首拉限流**:新宿主镜像缓存全冷,首拉 api 镜像是数百 MB 的一次性重 I/O(`debt.cds.ci-prebuilt` #8 记录过一次把控制台压到无响应 1 小时)——**头几个分支串行部署**,别一口气全量重建。
5. **构建并发闸**:`CDS_MAX_CONCURRENT_BUILDS` 已按核数调好。实测铁证:同一构建 isolated 353s,双构建重叠被拖到 636-754s——机器再强也别放开。
6. **webhook**:GitHub App 的 webhook URL 指向新域名/新 IP;push 一个测试分支确认 push-即部署链路活着。
7. **预览域名**:任选一个 running 分支的 v3 域名从公网打开(HTTPS 证书 + forwarder 路由双验证)。

## 四、选机建议(一句话版)

历史实测:磁盘从来不是瓶颈(54% 时构建已拖慢),内存也不缺(42%);vite/dotnet 编译是 **CPU 固有成本**(并行旋钮实测无收益)。**CPU 单核性能 > 核数 > 内存 > 磁盘**。更多服务改走极速版(CI 预构建)比升级磁盘划算。

## 五、关联

- `doc/debt.cds.performance.md` — 性能根因实测台账(调度器禁用事故、并发闸、两个假设证伪)
- `doc/debt.cds.ci-prebuilt.md` — 极速版债务(ghcr public、首拉 I/O、回退链)
- `doc/design.cds.self-hosting.md` — cds-self 预览实例(迁移期 CDS 改动的验收通道)
- `.claude/rules/cross-project-isolation.md` — 通道 1/2(JWT 密钥两用)、通道 4(共享库全局状态)
