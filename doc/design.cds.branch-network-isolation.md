# design.cds.branch-network-isolation — 分支级网络隔离

- 类型: design（How）
- 应用: cds
- 状态: 进行中（代码已落地，待 CDS 灰度 docker 验证后默认生效）
- 更新: 2026-06-29

## 1. 管理摘要（30 秒）

同一个 CDS 项目下的所有分支预览**共享一张 docker 网络**，容器靠 `--network-alias <服务名>`（如
`apigateway` / `imp-api`）做服务发现。问题：别名是**项目级、不带分支前缀**的——当某个分支把
apigateway 拆成独立服务，多个分支在同一张网上注册了同名别名 `apigateway`，Docker 内置 DNS 轮询，
A 分支的后端可能解析到 B 分支的网关，造成**跨分支串流**，「一个分支动一下，影响所有分支」。

根治：**每个分支自动获得一张专属 app 网（`cds-br-<分支id>`）**，承载分支内 app↔app 的服务发现
（别名只在本分支可见）；mysql/redis 这类基础设施仍共享一张 infra 网（沿用 `cds-proj-<项目id>`，
不浪费）。app 容器主网 = 分支网（带 app 别名）+ 运行后连到共享 infra 网（**无别名**，仅为可达 DB）。
这样一个分支随便部署多少个临时/实验容器，都只落在自己的分支网，**永远影响不到别的分支**。

关键设计取舍（用户校正）：**不做项目级开关，也不限制分支**。隔离是每个分支天然的沙箱默认，
不 block 部署、不限额、不禁止加服务——只把爆炸半径收到本分支。一个「项目级开关一拨影响所有分支」
本身就是『一个影响多个』的设计误差，刻意不采用。只保留一个**系统级全局逃生开关**应对线上异常。

## 2. 背景：为什么会跨分支串流

- 端口已隔离：`allocatePort` 扫描全量分支去重，不会撞。
- 容器名已隔离：`cds-<分支>-<服务>` 全局唯一。
- **唯独网络别名没隔离**：`computeProfileAliases` 产出的别名（`apigateway` / `mysql` / `imp-api`）
  按项目共享网注册。多分支同名别名 → 同一张网里多个容器应答同一个名字 → DNS 轮询串流。
- 拓扑不变时不明显；一旦某分支新增/搬动服务（如拆 apigateway），新别名出现，串流就暴露。

## 3. 方案：分支网 + 共享 infra 网

| 容器类型 | 主网络（--network） | 别名 | 附加连接 |
|---|---|---|---|
| app/profile（隔离开） | 分支网 `cds-br-<分支id>` | app 别名（仅本分支可见） | 连共享 infra 网，**无别名** |
| app/profile（隔离关/老项目） | 共享网 `cds-proj-<id>` | app 别名 | 无（= 现状，零回归） |
| infra（mysql/redis…） | 共享 infra 网 `cds-proj-<id>` | infra 别名 | 不变 |
| 一次性 job（migration 等） | 共享网 | 无别名 | 不碰（无别名 → 不串流） |

服务发现结果：
- `后端@A → apigateway`：两者都在 `cds-br-A`，解析到 A 的网关。隔离（成立）
- `后端@A → mysql`：后端连着共享网，mysql 别名在共享网，解析到共享 DB。共享（成立）
- `后端@B → A 的 apigateway`：不同分支网；共享网上 A 的容器无 app 别名 → 解析不到。**杜绝串流**（成立）

docker 多网语义：容器同时挂分支网 + 共享网时，DNS 跨其所连网络解析——既能找到分支内 app，又能找到
共享 infra，且找不到别分支的 app 别名。正是所需。

## 4. 默认与逃生

- 默认**开**（每分支自动隔离）。迁移天然渐进：**分支下次部署即自动落到分支网**，存量运行容器照常，
  无需 flag day。
- 系统级逃生开关 env `CDS_BRANCH_NETWORK_ISOLATION`：置 `0`/`false`/`off`/`no` 全局回退旧共享网行为
  （线上若异常可一键退，改 env 重启 CDS 即可）。这是系统级逃生阀，不是项目/分支级旋钮。

## 5. 实现位置（official/self-built 边界无关，纯自建）

- `cds/src/services/branch-network.ts`：纯函数 SSOT（`branchAppNetworkName` / `resolveAppNetworkPlan`
  / `branchNetworkIsolationEnabled`）。`branchAppNetworkName` 超 60 字符时截断 + 追加完整 id 短哈希后缀
  保唯一（Codex P2，避免长 id 撞同网）；≤60 输出零回归。单测 `cds/tests/services/branch-network.test.ts`。
- `cds/src/services/container.ts`：
  - `runService`（app 容器，隔离时）：**create → connect(infra) → start** 时序——先 `docker create`
    （进程不启动）落在分支网，再 `connectContainerToSharedNetwork` 连共享 infra 网，**最后 `docker start`**。
    保证进程启动前两张网都已就位，避免 entrypoint 阶段就开 DB 连接的镜像在 infra 网就位前连库失败
    （Codex P1）。未隔离路径仍走单步 `docker run -d`，零回归。
  - `connectContainerToSharedNetwork`：无别名 connect，幂等，连不上则部署显式失败（connDB 是硬需求）。
  - `removeBranchNetwork`：分支删除后尽力清理 `cds-br-*`（best-effort）。
  - infra 路径、一次性 job 路径不动。
- 分支网清理已接线：主节点 `finalizeBranchDelete`（`branches.ts`）+ **远端执行器 `/exec/delete`
  （`executor/routes.ts`）** 各自在删容器后调 `removeBranchNetwork`——分支网是在**哪台 docker host**
  上创建就由那台删，避免 worker 节点上隔离网随删分支堆积（Bugbot Medium）。

## 6. 风险与已知边界

- **docker 行为未在沙箱验证**：CDS 开发沙箱无 docker，纯函数已单测，但「多网 connect + DNS 解析」
  必须在 CDS 灰度上真机验证后再放心默认开。逃生开关是兜底。
- **分支网清理已接线**（2026-06-29 review 修复）：主节点删分支 + 远端执行器 `/exec/delete` 都已调
  `removeBranchNetwork`。仍可加一个周期性 sweep（prune 无容器的 `cds-br-*`）兜底极端漏删，记入 debt。
- **prune-by-network**（2026-06-29 review 修复）：`pruneStaleAppContainersForProfile` 现按
  `netPlan.runNetwork`（隔离=分支网）扫别名，与别名实际所在网一致；否则失败/半成功重部署会在分支网
  残留同别名僵尸端点。配合按容器名 `docker rm -f` 的主清理，覆盖完整。
- **一次性 job**：留在共享网（无别名，不串流）；若将来 job 需要访问分支内 app 服务，再扩展。
- **迁移过渡窗口的残留 app 别名**（Codex P2，2026-06-29，已知边界，非新代码 bug）：隔离默认开后，
  已迁移分支的 app 主网是分支网，但仍 connect 共享网以可达 infra。若**兄弟分支还有旧容器跑在共享网上**
  （尚未重部署），那些旧 app 的 `--network-alias` 仍挂在共享网，已迁移分支的容器解析一个**本分支网内
  不存在**的 app 名时，可能在共享网解析到兄弟旧端点 —— 即「默认开的隔离要等所有兄弟都重部署后才完全
  生效」。这是**无 flag day 的渐进迁移固有的过渡态**，非新代码缺陷：① 兄弟分支下次部署即落分支网、旧别名
  随之消失；② 运营可一次性重部署存量分支或 prune 共享网上的存量 app 别名加速收敛；③ 逃生开关
  `CDS_BRANCH_NETWORK_ISOLATION=0` 可整体回退。彻底根治（让 app 只连「infra-only 专网」、共享网不再承载
  app 别名）是更大的架构改动，记 `debt.cds.branch-isolation` 待专项。

## 7. 关联

- 根因排查与 bug 修复见 `changelogs/2026-06-29_*`。
- 跨项目隔离（P4，项目级网络）见 `.claude/rules/cross-project-isolation.md`；本设计在其下做**分支级**细分。
