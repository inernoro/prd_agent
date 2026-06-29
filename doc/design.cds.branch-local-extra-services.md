# design.cds.branch-local-extra-services — 分支级临时额外服务

- 类型: design（How）
- 应用: cds
- 状态: 进行中（代码 + 单测就绪，待 CDS 灰度真机演示）
- 更新: 2026-06-29

## 1. 管理摘要（30 秒）

CDS 里「一个项目」有一份**项目级 build profiles** 作为稳定底座（改它走 dashboard 审批、影响该项目
所有分支）。但有个真实需求一直没满足：**单条分支想临时加自己的服务/容器做实验**（例：把某模块拆成
独立服务、起个调试用的 sidecar），却只能改项目底座——而那是全局的、要审批、会逼所有分支都起这个
服务（worktree 里没这服务代码的分支会部署失败）。

本设计加一层**分支级「临时额外服务」（branch-local extra services）**：一条分支可以声明自己的额外
服务,它们

- **只在这条分支部署**,跑在分支专属网（`cds-br-<id>`,见 `design.cds.branch-network-isolation`）里,
  **不进项目 profiles、不需要全局审批、不影响别的分支**;
- **随分支生命周期走 —— 删分支即消失**(挂在 `BranchEntry.extraProfiles` 上,删分支连带清掉;额外容器
  由分支 teardown 一并 rm,分支网由 `removeBranchNetwork` 清理)。

**兼容性是硬约束**:纯增量、可选字段。没声明额外服务的分支 = 与现状**完全一致**(老行为零回归)。

两层关系:**项目底座(稳定,审批改,影响全体) + 分支额外(临时,自助加,只影响自己)**。底座给每条分支
一个「默认这样部署」的指导;分支可以照着来,也可以在上面加自己的东西,还可以什么都不加。

## 2. 为什么需要(背景)

- 部署 worker 取服务清单是 `getBuildProfilesForProject(项目)` —— 整个项目共享一份,每条分支部署全部。
- 源码模式直接挂 `分支worktree/workDir`,没存在性检查;所以「把新服务加进项目」会让 worktree 里没这
  服务代码的分支部署失败(openvisual 事故、本次 LLM 网关剥离都是这个)。
- 缺的就是「分支级、临时、不波及全体」的加服务能力。本设计补上。

## 3. 方案

### 3.1 数据模型(纯增量)

`BranchEntry.extraProfiles?: BuildProfile[]`(可选)。每个元素就是一个服务定义(复用现有 `BuildProfile`
结构:id / dockerImage / workDir / command / containerPort / prebuiltImage / env …)。absent = 老行为。

### 3.2 合并规则(纯函数 SSOT:`branch-extra-services.ts`)

`mergeBranchProfiles(项目profiles, branch)` = 项目底座 + 分支额外:
- 没额外 → 项目原样返回(零回归);
- 额外只能 ADD **新 id**;撞项目 id → **以项目为准**(忽略额外项,保护底座;要按分支改项目服务用
  `profileOverrides`,不是这里);额外项之间 id 重复 → 留首个;非法 id 丢弃。

`StateService.getEffectiveProfilesForBranch(branch)` 封装「项目 profiles + 合并」,**部署与资源/拓扑
展示都走这一函**,保证额外服务在哪儿都一致可见且天生 scoped 在本分支。

### 3.3 部署与隔离

- 部署 worker 用 `getEffectiveProfilesForBranch`(替换原 `getBuildProfilesForProject`)→ 额外服务作为额外
  容器在本分支起来,落在分支专属网(已有的网络隔离)→ 不串流、不影响别的分支。
- 额外容器进 `branch.services` 快照,孤儿清理按 `branch.services` 判活,不会误删额外容器。

### 3.4 生命周期(删分支即消失)

- `extraProfiles` 是 `BranchEntry` 字段 → `removeBranch` 一并清除;
- 额外容器由现有分支 teardown(按 `branch.services` 全部 rm)清掉;**移除单个额外服务**(extraProfiles 删掉它/置空)时,下一次部署会把它从期望清单识别为孤儿并拆容器+删条目(2026-06-29 补的对称收尾);
- 分支删除收尾调 `removeBranchNetwork(id)` 清分支网(本次接线)。

### 3.5 API

- `GET /api/branches/:id/extra-services` → 当前额外服务列表。
- `PUT /api/branches/:id/extra-services` `{ extraProfiles: [...] }` → 设置/清空(空数组=清空)。校验:id 合法、
  不撞项目 id(撞则 400 明确告知)、dockerImage/containerPort 必填。只改这一条分支。
- **`PUT …/extra-services?redeploy=1`(或 body `{redeploy:true}`)→ 持久化后立刻 fire-and-forget 触发一次
  真正的分支重部署**(走和 webhook 自调相同的 localhost 自 POST `/deploy`),让新增/改动的额外服务真正起容器、
  被移除的真正下掉。响应回 `redeployTriggered` + `hint`。**这是关键**:声明额外服务是纯配置变更,**不会**
  自动重建已在运行的分支(2026-06-29 实测痛点:在已运行、同 commit 的 main 上声明额外服务,deploy 被去重/
  不重跑启动循环,容器不出现);`?redeploy=1` 补上「声明即生效」这一步。不带 redeploy 时,响应 hint 明确提示
  需触发一次部署才会起容器。

## 4. 兼容性与影响面

- **对老分支**:零影响(没 extraProfiles 就走原路径)。
- **对别的分支**:零影响(额外服务只进声明它的那条分支的部署清单 + 它自己的网络)。
- **新影响**:仅落在**主动声明了额外服务的那条分支**。
- **项目底座**:一行不动,仍走审批改(稳定路径不变)。

## 5. 风险与已知边界

- docker 行为(额外容器在分支网起来 + 连共享 infra)需 CDS 灰度真机演示后才算闭环;纯函数 + 状态层已单测。
- 额外服务的「极速版(CI 预构建镜像)」适用性:若额外服务声明 `prebuiltImage` 但镜像不存在,沿用现有
  镜像缺失回退/失败语义(本设计不特殊处理)。
- 「项目新增服务会让缺代码分支部署失败」这个**项目层**老问题本设计不直接修(它属审批改底座的范畴);
  本设计提供的是「不动底座、改用分支额外服务」这条更安全的路。记 `debt.cds.branch-isolation`。

## 6. 关联

- `design.cds.branch-network-isolation`（每分支专属网,本设计的隔离地基）。
- `.claude/rules/cross-project-isolation.md`（跨项目/跨分支隔离总纲）。
- 实现:`branch-extra-services.ts` / `state.ts` `getEffectiveProfilesForBranch` `setBranchExtraProfiles` /
  `branches.ts` 部署+展示+API / 单测 `branch-extra-services{,-state}.test.ts`。
