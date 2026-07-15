# CDS 生命周期原子性 · 架构设计（对账收敛取代命令式级联）

> **类型**:design(怎么做) · **更新**:2026-07-15 · **状态**:收割器 + 删除级联已实现,网络/卷/worktree 收割与 UI 可视化为后续波次

---

## 一、管理摘要

用户实锤了一类反复出现的问题:**删除了项目/分支,它的容器、基础设施却还在后台跑**。24 小时日志取证证明这不是孤例——上次启动对账发现 **68 个孤儿 app 容器**(最早是 5 月删除的测试分支),外加用户看到的已删项目 infra 容器,合起来正是 perf-health「运行容器 67 个超过核数 2 倍」告警的主要来源。

根因是一个**架构级**问题,不是某一处 bug:CDS 的状态(state)和物理资源(docker 容器/网络/卷、worktree)是**两个世界的两次写**,任何一条命令式清理链路(删分支、删项目、崩溃恢复)只要有一步失败、超时、或者干脆没写(项目删除的容器清理是**故意不做**的),两个世界就永久漂移,而且**没有任何机制把漂移收敛回来**——startup reconcile 看见孤儿只记一条 warn,"看得见、不动手"。

本设计确立一条架构原则:**物理资源以 state 为唯一权威,靠周期性对账收敛(reconcile-and-reap),命令式级联只是加速路径**。首批落地:孤儿容器收割器(每小时把 state 中无 owner 的 cds-managed 容器停掉)+ 项目删除连带容器物理清理(先容器后网络,修正顺序错误)。

## 二、问题分类(原子性问题的五个形态,均有实证)

| # | 形态 | 实证 | 后果 |
|---|---|---|---|
| A | **级联故意残缺** | `DELETE /projects/:id` 注释明写"Container teardown is intentionally NOT done here" | 已删项目的 infra/app 容器永久存活(用户实锤场景) |
| B | **顺序错误** | 同一路由先 `docker network rm` 后才(不)清容器——网络上挂着容器时 rm 必然失败 | 僵尸网络 + 僵尸容器双输 |
| C | **检测-无动作** | startup reconcile 对孤儿容器只记 `app.reconcile.orphan` warn(单日 68 条);infra 孤儿只有 console.warn 连事件都不进 | 问题可见但永不收敛,告警疲劳 |
| D | **best-effort 吞错无兜底** | janitor/branch delete 的容器清理 `catch { /* best effort */ }`——失败即残留,没有下一次机会 | 偶发失败累积成常态漂移 |
| E | **两阶段写崩溃窗口** | state 写成功 ↔ docker 操作之间进程崩溃/重启(历史案例:deploy-dispatch 幽灵、self-update stale dist,各自打过专项补丁) | 每类窗口单独打补丁,打不完 |

五个形态同根:**把"删除/创建做对"寄托在单次命令式链路上,而链路天然会失败**。

## 三、架构原则:Reconcile-and-Reap(对账收敛)

参照 Kubernetes 的 desired-state 模型收敛到 CDS 的规模:

1. **Ownership 标签是硬契约**:每个 CDS 创建的 docker 资源必须带 `cds.managed=true` + `cds.type=infra|app` + owner 标签(`cds.branch.id` / `cds.service.id`)。无 label 的资源 CDS 永不触碰(误杀零容忍)。
2. **state 是唯一权威**:资源存在于 docker、owner 不存在于 state → 孤儿 → 收割。判定函数唯一(`orphan-container-reaper.ts`),不允许各路径各写一套。
3. **命令式级联 = 加速路径,收割器 = 最终一致**:删除操作仍尽力当场清理(用户预期"删了就没了"),但清理失败**不再是终局**——最迟一个 sweep 周期(1h)后收敛。routes 层因此可以保持"响应快 + best-effort",不必做成慢速强一致。
4. **安全边界宁漏勿误**:label 过滤;docker 查询失败本轮放弃;state 空库守卫(空库更可能是加载失败,不是"全员孤儿");系统级容器(`cds-infra-cds-state-mongo`)硬编码免死;默认只 stop 不 rm(数据卷保留,删除语义只在显式项目删除路径走 rm)。
5. **每次处置留痕**:收割动作写 server-event(`container.orphan.stopped`),Activity Monitor / 运维面板可见,不做静默魔法(expectation-management)。

## 四、本次落地(2026-07-15)

| 交付 | 位置 | 行为 |
|---|---|---|
| 孤儿容器收割器 | `cds/src/services/orphan-container-reaper.ts` + `index.ts` 后台服务 | 启动 2 分钟后首扫,每小时一轮;孤儿 infra/app 容器 → `docker stop`;事件留痕;`CDS_ORPHAN_CONTAINER_REAPER=0` 逃生阀 |
| 项目删除连带容器 | `routes/projects.ts` DELETE | 先抄容器清单(分支 services + 项目级 infra,排除系统 infra)→ state cascade → 后台 `docker rm -f` 容器 → 再删网络(顺序修正);响应体 `containerTeardown` 如实声明 |
| 单测 | `tests/services/orphan-container-reaper.test.ts` + `tests/routes/projects.test.ts` | 孤儿判定口径、安全阀(空库/查询失败/逃生阀/系统容器免死)、先容器后网络的顺序、系统 infra 免删 |

生产生效路径:本分支合并 → 生产 CDS self-update 一次 → 收割器首扫自动停掉存量孤儿(预期回收数十个容器,perf-health 的 too-many-containers 告警应消退)。

## 五、后续波次(防丢清单)

1. **网络/卷/worktree 收割**:同一判定模型扩展到 `cds-br-*` / `cds-proj-*` 网络、无主 named volume、无主 worktree 目录(janitor 已管 TTL,补"owner 已删"维度);
2. **孤儿处置可视化**:运维监控面板加「孤儿资源」页签,展示收割历史 + 当前孤儿清单 + 一键 rm(人类确认后才删);
3. **infra 容器补 `cds.project.id` label**:当前 infra 只有 `cds.service.id`,补项目 label 后孤儿判定可以直接按"项目已删"给出 ownerHint;
4. **删除操作的 saga 化审计**:branch/project 删除产出结构化「清理账单」(哪些资源、哪步成功/失败),失败项自动进收割器的优先队列而不是等下一轮全量扫;
5. **创建侧对账**:`docker run` 成功但 state 写失败的反向窗口(罕见但存在),startup reconcile 已覆盖大半,补齐事件留痕口径。

## 六、关联

- `cds/src/services/orphan-container-reaper.ts` — 孤儿判定与收割 SSOT
- `.claude/rules/cds-first-verification.md` / `closed-loop-acceptance.md` — 验收纪律
- `doc/debt.cds.performance.md` — too-many-containers 告警(本设计消除其主要来源)
- `doc/design.cds.self-hosting.md` — 预览实例(收割器在预览实例中随后台服务整体跳过)
- `.claude/rules/cross-project-isolation.md` — 系统级容器免死名单的依据

## 七、风险与已知边界

- 收割器只 stop 不 rm:已停孤儿容器仍占磁盘(镜像层/卷),需二期可视化 + 人工确认后删;
- 判定依赖 label:历史上手工 `docker run` 起的、无 label 的残留容器不在收割范围(宁漏勿误),需人工一次性盘点;
- 项目删除的物理清理是响应后异步:极端情况下进程在异步段崩溃 → 残留交由收割器下一轮收敛(这正是本架构的设计意图);
- 收割 stop 与 auto-restart 巡检的交互:孤儿容器不在 state,auto-restart 只扫 state 内 infra,不会把被收割的孤儿重新拉起(已核对口径)。
