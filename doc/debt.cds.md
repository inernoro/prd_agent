# CDS 平台杂项 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：开发中

**一句话**：云开发套件里十二个小模块的欠账合成一册：教程、报告治理、编排密钥、项目初始化与迁移、过期分支页、转发重启、存活监控、可视化部署、复制集、看门狗、后端部署冻结。
**谁该读**：接手其中任一小模块的工程师；排障时想确认「是不是已知边界」的人。
**读完能做什么**：按模块小节定位欠账，判断眼前现象是已知边界还是新故障。

---

> 本台账由 12 份同模块台账合并而成，内容原样保留、只做归位；原文件已回收，引用已改指本文。

## CDS 教程

从零开始的教程与示例工程的已知边界与后续可补项。

记录「从零开始的 CDS 教程」(示例工程 + 隔离知识库 + compose 评分/自愈)的已知边界与后续可补项。

### 已知边界

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| T1 | 低 | 2026-05-30 | `verify --fix --write` 用 PyYAML 重序列化整文件,注释丢失、缩进风格变化 | 对带注释的 compose 跑 `--write` | open | 默认只打印 diff;文档已提示先看 diff 再 write。后续可换保留注释的 ruamel.yaml |
| T2 | 低 | 2026-05-30 | 自愈覆盖面有限:目前只自动修 `env-var-unresolved` / `depends-on-hint`,其余只给建议 | 遇到 app-ports-missing / infra-image-missing 等需人决策的 ERROR | open | 这是有意为之(机器不能瞎猜端口/镜像);扩面时按 §4.5 加 fixer |
| T3 | 低 | 2026-05-30 | `env-var-unresolved` 自动修补的是占位值 `CHANGE_ME`,verify 会过但值是假的 | 用自愈后直接部署没改占位 | open | 输出已标 needsReview;部署前必须人工改真值 |
| T4 | 低 | 2026-05-30 | 4 个示例工程的可部署性仅本地 verify(评分 A)确认,完整 deploy+冒烟依赖 CDS 环境 | 无 CDS 凭据的环境 | open | 评分门禁已挡静态问题;真机冒烟需 `cdscli deploy` 在有 CDS 的环境跑 |
| T5 | 低 | 2026-05-30 | 知识库发布脚本需要 `CDS_TUTORIAL_IMPERSONATE`(真实用户名),不提供则退出 | 跑 publish 脚本 | open | 有意要求:store 必须归属真实 owner,不允许匿名建库 |

### 后续可补

- 把 `cds/examples/tutorial-04-fullstack-infra` 与 `cds/examples/fullstack-infra-smoke` 的 compose 收敛为单一来源,避免双份维护漂移。
- `verify --fix` 支持保留注释(ruamel.yaml),消除 T1。
- 评分 rubric 增加「最佳实践」维度(如 `:latest` tag 扣分),目前只看部署正确性。

## CDS 验收报告治理

验收中心报告散在项目根、文件夹跨项目串扰的治理记录与剩余债务。

> 创建：2026-07-10
> 背景：2026-07-10 用户反馈验收中心 54 份报告大半散在项目根、文件夹跨项目串扰。当轮 PR #1062 已修：文件夹树随项目筛选联动、顶栏三件套（项目筛选/筛选/全部折叠展开）、标题搜索、删除确认统一 Dialog、「30 天前」视图、全部项目视图按项目分组、归档技能默认按模块进文件夹（--folder-path > cdsFolder > --module 三级解析）。本台账记录**未随该 PR 落地**的剩余项。

### 剩余债务

| # | 项 | 现状 | 建议方案 | 优先级 |
|---|---|---|---|---|
| 1 | 存量未归类报告迁移 | 归档默认进文件夹只对**新报告**生效，存量 50+ 份仍在项目根 | 一次性脚本：按标题第二段（模块名）批量 `PATCH /api/reports/:id { folderId }`；或人工在 UI「移动到文件夹」归类 | P2 |
| 2 | 报告保留策略（retention） | 巡检/日报类报告只增不减，无自动清理 | 文件夹级「保留最近 N 份 / N 天」配置 + 定时清理 worker；先有「30 天前」视图人工批量清理兜底 | P2 |
| 3 | 批量操作 | 列表只有单条删除/移动，清理 30 天前的报告要逐条点 | 多选 checkbox + 批量删除/批量移动（配合「30 天前」视图使用） | P3 |
| 4 | 日期类根文件夹归并 | 「2026-06 这几天 CDS 验收」等历史日期文件夹仍平铺在根上 | 借助已支持的嵌套 folderPath 归并到「每日验收/<YYYY-MM>」结构；属一次性数据整理 | P3 |
| 5 | 搜索只覆盖标题 | 标题搜索已上线；正文/verdict/branch 不参与 | 如有需要再扩展服务端搜索端点（正文全文检索需索引支持） | P3 |

### 已还（供追溯）

- 文件夹树/移动菜单/筛选菜单跨项目串扰（PR #1062）
- 验收归档不进文件夹：archive_report.py 三级解析 + SKILL.md 固化「文件夹归类是默认行为」（PR #1062）
- 每日验收按月分桶：[guide.acceptance.daily-sop.md](./guide.acceptance.daily-sop.md) 要求 `--folder-path "每日验收/<YYYY-MM>"`（PR #1062）

## CDS compose 模板 TODO secrets

自动生成的编排模板里留了占位密钥，重新导入时可能把真实值覆盖掉，本文记这条风险与处置。

### 总览

| 指标 | 当前值 |
|------|--------|
| open | 1 |
| in-progress | 0 |
| paid | 1 |

模块范围：仓库根 `cds-compose.yml` 的 `x-cds-env` 段 + admin profile readiness 配置，以及任何走 `cdscli import` 的全量 compose 重导入路径。

### 背景

`cds-compose.yml` 头部注释写明"由 /cds-scan 自动生成、粘贴导入"，其 `x-cds-env` 段把
`JWT_SECRET` / `AI_ACCESS_KEY` / `TENCENT_COS_*` 等敏感键以 `TODO: 请填写实际值`
占位符形式保留在仓库里。但这些密钥的**真实值已存在于 CDS env scope `prd-agent`**
（`cdscli env get --scope prd-agent` 可见 23 个键，含全部真实 secret）。

后果：任何 `cdscli import --project prd-agent --compose cds-compose.yml` 全量重导入
都会被 CDS 审核**拒绝**，理由 "reject stale cdscli import with TODO secrets;
unblock deploy"——因为全量导入会用 TODO 占位覆盖线上真实密钥。这条路径对该项目
结构性失效。

2026-05-18 发现链路：admin profile 因 static 模式每次 `pnpm install + vite build`
（重型依赖冷构建实测 ~614s）撞 `cds.readiness-timeout: 600` 上限，必现"就绪探测
超时：容器已启动但端口未在超时时间内响应"。修复需把 readiness-timeout 提到 1200，
但该改动**无法经全量 import 落地**（被上述规则拒），最终由 CDS 管理者在 dashboard
直接改 profile 配置。

### 债务条目

#### D1（paid，2026-07-06 运行实例验证通过）cds-compose.yml 的 x-cds-env 携带 TODO secrets，全量 import 必被拒

**偿还验证（2026-07-06，运行实例 cds.miduo.org）**：
1. `cdscli env get --scope prd-agent`(CDS_HOST + AI_ACCESS_KEY)：env scope 共 37 键,
   被剥离的 8 个密钥键(`TENCENT_COS_*` / `JWT_SECRET` / `ApiKeyCrypto__Secret` /
   `AI_ACCESS_KEY`)**全部 present 且非空、非 TODO**(值经 API 脱敏,只核对键存在 + 非占位)。
   → 从 repo 剥离**没有丢失密钥的权威来源**。
2. `cdscli branch status prd-agent-claude-cds-config-wave-4-5-dkpd7g`:本分支(commit
   `8624a95`,构建自**已剥离密钥的** cds-compose.yml)5 个服务全 running,含
   `api-prd-agent: running`。prd-api 无 `JWT_SECRET` / `ApiKeyCrypto__Secret` / mongo 凭据
   会启动即崩;它 running 即证明 **CDS 从 env scope 把这些密钥注入了容器且值可用** ——
   即「移除后注入不丢」的端到端确证。
→ D1 判 **paid**。剩余仅理论项(未逐字读容器内明文值,API/exec 均脱敏,但 running 的
   api 已是充分证据)。

---

#### D1（历史·代码层偿还记录）cds-compose.yml 的 x-cds-env 携带 TODO secrets，全量 import 必被拒

- 现状（2026-07-06 波4 更新）：**repo `cds-compose.yml` 的 `x-cds-env` 已剥离全部
  TODO 密钥键**（`TENCENT_COS_*` / `JWT_SECRET` / `ApiKeyCrypto__Secret` /
  `AI_ACCESS_KEY`），只保留非密钥结构默认（`ASSETS_PROVIDER` / `TENCENT_COS_PREFIX`）。
  剥离后 `parseCdsCompose` 仍解析出全部 5 个 profile + 2 个 infra，`envVars` 里
  零密钥、零 `TODO:` 占位 → 全量 import 不再有可覆盖线上密钥的占位值，D1 的
  import-reject 根因（占位覆盖真实密钥）在代码层消除。
- 配套能力：`config-authority.classifyEnvSeed` 给每个 env 键判「repo 结构种子 /
  CDS env scope」；`compose-drift.computeComposeDrift` + `POST /projects/:id/
  compose-drift-scan` 做 repo→CDS 单向漂移巡检，密钥若再次混入 repo 会被
  `secretsInRepo` 标为「应剥离」违规。
- **仍 open 的最后一环（隔离穿透高风险，需 CDS 管理者确认）**：必须在**运行实例**上
  验证 CDS env scope `prd-agent` 确实把这 6 个密钥注入到容器（`cdscli env get
  --scope prd-agent` 应见真实值 + 部署后容器内变量非空），确认剥离后注入不丢，
  才能把 D1 判为 **paid**。此步依赖对生产实例的读权限，AI 无法自闭环，见
  `.claude/rules/cross-project-isolation.md` 通道 1/2（共享密钥通道）。在该验证
  通过前，D1 记为 in-progress，禁止声称「已彻底偿还」。

#### D2（open）admin static 模式每次部署全量 vite build，就绪窗口长期紧绷

- 现状：readiness-timeout 已（拟）提到 1200s 作为缓冲，但根因是每次部署冷构建
  重型前端（mermaid/katex/cytoscape）耗时数百秒
- 影响：每次部署到就绪要等十几分钟，UX 差；构建再变重会再次撞顶
- 偿还方向：评估 admin 改用 dev(Vite HMR) 预览模式（端口秒起，按需编译），或
  引入预构建产物 / 构建缓存层 / manualChunks 拆包降低冷构建时长

### 关联

- `cds-compose.yml`、`.claude/skills/cds/` cdscli、`.claude/rules/cds-auto-deploy.md`
- 触发本台账的会话：涌现 UI 重构分支 `claude/redesign-ui-layout-awNDL` 部署排查

## CDS 项目初始化

项目初始化流程（从选仓库到自动识别再到首次部署）这一段的欠账台账与明细。

### 台账

| 编号 | 类型 | 描述 | 影响 | 状态 |
|---|---|---|---|---|
| D1 | 风险 | `curl \| sh` 存在供应链风险 | CDS 被攻破时脚本可被替换 | 未偿（有缓解） |
| D2 | 已知边界 | 首版只做 POSIX sh，无 Windows 原生脚本 | Windows 用户必须走 WSL 或 Git Bash | 未偿 |
| D3 | 已知边界 | 只有预设，不能自选技能组合 | 想要「PM 套装减一个加一个」的用户只能逐个装 | 未偿 |
| D4 | 已知边界 | 四个预设已全部落地（pm / dev / qa / cds-only） | 无 | 已偿 |
| D5 | 风险 | 代理缓存与 MAP 技能更新存在一致性窗口 | MAP 发了新版技能，CDS 可能仍发旧版 | 未偿 |
| D6 | 已知边界 | `phase0-guard` 技能已写，但未在真实客户项目里检验过约束力 | 护栏是否真能拦住 AI 提前写业务，尚无实证 | 部分偿还 |
| D7 | 风险 | `export-skill` 需登录且依赖本地 `.claude/skills` | 曾导致所有场景都装不上 CDS 命令行技能 | 已偿 |
| D8 | 已知边界 | 上手助手首版的角色推荐仍复用三套 starter bundle | 老板和业务专家暂时共用产品经理技能起点 | 未偿 |
| D9 | 已知边界 | 自定义技能组合由浏览器现场生成脚本，没有服务端可复现 manifest | 刷新页面后不会恢复上次选择 | 未偿 |
| D10 | 风险 | 临时验收账号的创建能力取决于客户项目 | 部分项目只能交付登录入口，无法自动生成账号 | 未偿 |
| D11 | 已知边界 | 首版一键脚本只支持 POSIX sh | Windows 原生用户仍需 WSL 或 Git Bash | 未偿 |
| D12 | 已知边界 | 创建项目本身就要求宿主有可用 Docker（建项目即建项目网络），无 dockerd 时 `POST /api/projects` 直接 500 | 零凭据接入链路能走到最后一步，却在建项目时失败；报错指向 docker.sock 而不是「本机缺 Docker」 | 未偿 |
| D13 | 风险 | 页面批准换来的一次性 create-only Key 对**全部只读接口**放行，不止建项目所需的那点信息 | 陌生 Agent 一经批准即可枚举项目清单、分支清单、全局变量名、全局 Key 清单与自更新历史（值与密钥明文已掩码，泄露的是元数据） | 未偿 |

### 明细

#### D13 一次性建项目授权的只读面过宽

- **是什么**：签发给「只能创建新项目」的全局 Key，在系统级门卫处的规则是「放行创建项目 + 放行一切 GET」。于是这把本该只用来建一个项目的钥匙，可以读到整台实例的元数据。
- **实测（2026-08-25，线上真实实例）**：项目清单 200、分支清单 200、全局变量 200（值为掩码）、全局 Key 清单 200（无明文）、自更新状态 200（含内部 commit 与更新历史）。单个项目详情仍是 403，密钥明文与变量值没有泄露。
- **为什么当初这么设计**：门卫是逐路由补授权检查失败后的兜底，「只读一律放行」是当时能兜住全部写路由的最省事口径；而且建项目前确实需要读一次项目清单来查重，避免重复建项目。
- **影响**：接入流程的信任模型是「人点一下批准，就给陌生 Agent 一把一次性钥匙」。人以为批的是「让它建个项目」，实际附赠了整台实例的元数据可见性——项目叫什么、绑了哪些仓库、有哪些分支、配了哪些全局变量名，都能读走。
- **什么条件下必须还**：对外开放接入（给不完全可信的第三方 Agent 用）之前。收敛方向是给 create-only Key 一份显式只读白名单（查重所需的项目清单精简字段 + 自己刚建的项目），而不是「所有 GET」。

#### D12 建项目依赖 Docker

- **是什么**：`POST /api/projects` 在创建项目记录的同时就会创建该项目的 Docker 网络，宿主没有运行 dockerd 时整个创建失败（HTTP 500）。
- **怎么发现的**：2026-08-25 零凭据接入链路复测。子智能体在一台没有 dockerd 的机器上零凭据走完「匿名装技能 → 免密申请 → 人工批准 → 一次性建项目权」，最后卡在建项目这一步；启动 dockerd 后同一条命令即成功。认证链路本身没有问题。
- **影响**：真机 CDS 宿主一定有 Docker，所以正常部署不受影响；受影响的是测试机、CI 沙箱和「只想先建个项目占位」的场景，而且报错文案指向 docker.sock，读起来像环境坏了而不是「本机没有 Docker」。
- **什么条件下必须还**：要支持无 Docker 宿主建项目时。把网络创建延后到首次部署，或在创建时捕获 Docker 不可用并返回可读原因（项目照建、标记为待初始化）。

#### D1 管道执行的供应链风险

- **是什么**：`curl ... | sh` 把远端内容直接交给 shell 执行。CDS 被攻破或 DNS 被劫持时，脚本内容即可被替换。
- **缓解**：UI 默认展示「先下载、可阅读、再执行」的两步版本，管道版折叠为快捷方式；脚本内不含任何密钥；脚本不改 shell profile、PATH 和用户主目录，破坏面限定在项目目录内。
- **什么条件下必须还**：对外正式推广之前，给脚本加校验和或签名，UI 同时展示期望的校验值。

#### D2 无 Windows 原生脚本

- **是什么**：引导脚本是 POSIX sh，Windows 原生 PowerShell 环境跑不了。
- **为什么欠着**：目标用户（产品经理、老板）里 Windows 占比未知，先把一条路做穿比同时铺两套半成品有价值。
- **什么条件下必须还**：第一个 Windows 客户出现时。届时 CDS 按 User-Agent 或显式参数发 `.ps1` 版本，脚本契约不变。

#### D3 预设不可自定义

- **是什么**：只能选预设，不能勾选技能自由组合。
- **为什么欠着**：先验证「预设」这个形态成立。过早给自由度会让「官方推荐组合」的价值被稀释——非技术用户面对二十个勾选框只会更迷茫。
- **什么条件下必须还**：出现多个用户反馈预设不合用时。MAP 侧已有依赖递归展开与打包逻辑，加一个接受技能列表的端点即可。

#### D4 预设清单（已偿）

`pm-project` / `dev-project` / `qa-project` / `cds-only` 四个预设均已落地，
对应的 `pm-starter` / `dev-starter` / `qa-starter` 三个套装同步就位。

#### D5 代理缓存一致性窗口

- **是什么**：MAP 发布了新版技能后，CDS 缓存在过期前仍会发旧版。
- **缓解方向**：缓存带 TTL 且回源时比对 ETag；MAP 侧技能版本变更时可主动让 CDS 失效。
- **什么条件下必须还**：出现「客户装到的技能版本与预期不符」的实际反馈时；或缓存 TTL 需要拉长到小时级以上时。

#### D6 phase0-guard 的约束力未经实证

- **已完成**：`.claude/skills/phase0-guard/SKILL.md` 已写并随 `pm-starter` 套装分发，含 Phase 0 边界、六段式回复规范、术语翻译表、文档读者分层。
- **还欠什么**：技能能被正确分发已验证（zip 里在位、frontmatter 合规），但**它到底能不能拦住 AI 在定位没定清楚时就开始建表写 API，没有实证**。护栏的价值全在约束力，而约束力只有在真实项目里被考验过才算数。
- **什么条件下必须还**：第一个真实客户项目跑完一轮之后，回看 AI 有没有越界，据此调整措辞强度。

#### D7 CDS 技能包取不到（已偿）

- **是什么**：原计划让引导脚本走已有的 `GET /api/export-skill` 取 CDS 的 5 个技能。端到端实测发现该端点**需要登录**——公共 CDS 上匿名请求直接返回 401。
- **为什么是硬伤**：这是鸡生蛋。客户在拿到任何 CDS 凭据之前就得装上 cdscli 和 preview-url，否则连「运行 connect 申请授权」这一步都做不了。不修的话，方法论套装装得上，但用户根本操作不了 CDS。
- **怎么修的**：新增匿名端点 `GET /api/skills/cds-pack/download`，本地技能目录优先、缺失时回源上游公共 CDS 的同名端点。内容是技能说明与 CLI 源码（同款内容早已在海鲜市场公开），不含任何凭据。已有的 `export-skill` 语义不变，仍需登录。
- **遗留**：上游回源要等公共 CDS 更新到含本端点的版本之后才生效；在那之前，自托管实例只能靠自带的本地技能目录。

#### D7 匿名端点仍无全局限流

- **是什么**：`/api/bootstrap/*`、`/api/skills/*`、`/api/skills/cds-pack/download` 全部匿名，而 CDS 全局没有限流中间件（仓库内查无 `express-rate-limit` 一类实现）。
- **本次已做**：把最贵的那条路径（CDS 技能包）从「每请求递归 cp + spawn tar」改为**内容签名缓存 + 单飞**，并发请求共享同一次构建，技能内容不变就不再构建。放大倍数从「请求数」降到「技能变更次数」。
- **还欠什么**：真正的按 IP 限流。当前剩余成本是缓存命中后的一次 buffer 发送（几百 KB），以及套装代理转发 MAP 的带宽。
- **什么条件下必须还**：对外正式推广、或日志里出现单 IP 高频拉取时。做法是给这几条匿名路由挂一个轻量令牌桶中间件，不要全局挂（会误伤 Agent 的正常轮询）。
- **顺带**：本地 CDS 技能包改为**五个齐全才发**。此前只要有一个技能目录就出包，客户会拿到缺部署或预览命令的半成品，而脚本看到合法的 `skills/` 目录就认为装好了、不再回源上游。

#### D8-D11 上手助手首版边界

上手助手已经把经验锚点和角色拆成独立注册表，但老板和业务专家暂时复用产品经理套装。自定义选择只存在浏览器当前会话，尚无服务端可分享 manifest。临时验收账号依赖客户项目自身的账号机制，无法安全创建时必须明确阻塞。安装脚本沿用 POSIX sh，Windows 原生 PowerShell 后续按同一 manifest 生成，不能维护第二份技能事实源。

## 项目迁移（CDS 项目移植）

把一个项目连配置带数据复刻到另一个节点，本文记已落地范围与还没覆盖的边界。

> 模块：cds
> CDS「项目设置 → 迁移」Tab：把一个 CDS 项目打包复刻到另一个 CDS 节点（配置 + 数据）。
> 本台账记录本次交付的已知边界与后续可补项，避免下一个 session 重复踩坑。

### 背景

用户反馈"以前 CDS 的一键导出可被其他平台复刻部署的配置功能不见了"。排查确认：
`CdsPeer` / `DataMigration` 类型、`state.ts` 的 CRUD、`server.ts` 的 `/data-migrations/*`
API label 都还在，但**路由处理器文件与前端 UI 早已丢失**——这就是"消失的功能"。本次
在既有底座上补回，并明确做成**项目级移植**：新增迁移路由 + 项目设置页的「迁移」Tab。

### 已落地（2026-06-23）

- 迁移目标（远端 CDS 节点 = `CdsPeer`）增/删/列 + 连接测试（真实打远端 `/api/me`）。
  远端鉴权用目标自带 accessKey，留空回退本机 `AI_ACCESS_KEY`（同密钥跨节点场景，用户确认）。
- 配置复刻：导出本项目 `cds-compose`（复用 `toCdsCompose`，与 `/api/export-config?project=`
  同口径）→ 推送到目标 `/api/import-config`，支持 `dryRun` 预演 / `merge` / `replace-all`。
- 数据迁移：**只读扫描**（源库 MongoDB infra + 目标可达性）+ 手动桥接清单。
- 安全：accessKey 明文不出库到前端（只回 `hasKey` + 掩码）；`replace-all` 二次确认。
- 验证：unit test（脱敏/归一化/对外视图不泄密）+ Playwright 真机截图 + 对 `noroenrn.com`
  的真实 dry-run（远端 HTTP 200，`infraServices 新增1`）。

### 已知边界 / 后续可补

| # | 边界 | 说明 | 后续 |
|---|------|------|------|
| 1 | 数据全量落库未做成一键 | 全量库迁移走既有、已测的 `/api/infra/:id/backup`(mongodump) → 远端 `/api/infra/:id/restore`(mongorestore) 手动桥接；本路由只做只读扫描，不在本端点直接执行破坏性写入 | 后续可加"一键全量迁移"端点（流式 dump → 远端 restore + SSE 进度 + 强确认 + 目标快照回滚） |
| 2 | 远端无 dry-run 回滚预览 | `replicate-config` 的 dryRun 仅返回远端 import 预览，未做"复刻后一键回滚到迁移前快照"的反向链路 | 复用远端 ConfigSnapshot（import 前自动拍快照）暴露回滚入口 |
| 3 | accessKey 明文落 state | `CdsPeer.accessKey` 当前明文存 state（与既有设计一致）；留空走本机 key 时不落 | 评估是否走 `sealToken` 加密（参考 remote-hosts 的密文存储） |
| 4 | 仅 MongoDB 数据扫描 | data-plan 只识别 mongo infra；redis/postgres 未纳入迁移扫描 | 扩展到其它 infra 类型（infra-backup 已支持 redis/generic tar） |
| 5 | CDS 面板不可分支预览 | 该功能在 CDS 控制台（cds.miduo.org），非分支预览域名；视觉验收靠 headless 截图 + self-update 灰度 | 无（CDS 控制台架构使然） |
| 6 | 迁移仅限人类管理员（cookie/GitHub 会话） | PR #909 review（Codex P1 / Bugbot High）指出：迁移会跨节点并可能回退本机 bootstrap `AI_ACCESS_KEY` 鉴权远端，任何非人类调用方（项目级 Agent Key、AI 配对会话 `x-cds-ai-token`/`_aiSession`、全局 key、静态 AI_ACCESS_KEY）都能加攻击者控制 baseUrl 的 peer 诱导服务端外泄 bootstrap key。`guard()` 已改为 `isHumanAdmin = _cdsCookieAuth || (cdsUser && cdsSession)`，与 operator-console / remote-hosts 等系统级管理端一致（secret-revealing 须 cookie 鉴权）；AI / 各类 key 一律 403 | 若将来要支持 AI/项目级自助迁移，需把 CdsPeer 下沉为项目级资源 + 禁用 bootstrap-key 回退（强制每 peer 显式 key，杜绝外泄路径） |
| 7 | 远端 import 落到目标 legacy 项目 | 远端 `/api/import-config` 不带 projectId，导入的 infra/profile 落到目标的 legacy/default 项目，不会在目标建同名项目；故多项目目标上「复刻」语义不精确。已**移除 replace-all**（其为全局破坏，会清掉目标其它项目配置），强制 merge（纯新增/更新，不删存量） | 在远端加项目级 import 路径（`POST /api/projects/:id/import-config`），迁移时带目标 projectId 精确落库 |
| 8 | env 元数据（required/auto）不随迁移过去 | PR #909 Codex P2：迁移走 `toCdsCompose`，只序列化 env 的**值**（`x-cds-env`），不带 `envMeta`（哪些是 required/auto/infra-derived）。目标 import 后 `getMissingRequiredEnvKeys` 为空 → 不再弹「必填 env」提示，含空/TODO 必填值的项目在目标可能直接放行部署。**非本 PR 引入**：`/api/export-config`→`/api/import-config` 手动 round-trip 一直如此 | `toCdsCompose` 增 envMeta 参数并 emit `x-cds-env-meta`（parser 已支持解析）+ 远端 import-config 落 `setEnvMeta`。属共享序列化 + 远端契约改动，需跨同版本双端验证后单独做 |
| 9 | 无 command 的 build profile 迁移会被远端 400 | PR #909 Codex P2：`toCdsCompose` 只在 `p.command` truthy 时 emit command；而 `/build-profiles` 允许缺 command（归一为空串，依赖镜像 CMD/ENTRYPOINT）。这类项目导出的 YAML 没 command，远端 import-config 校验 `if (!p.command)` 直接 400，dry-run/apply 失败。**非本 PR 引入**：是 toCdsComposeimport-config 共享 round-trip 的既有不一致 | 让 import-config 校验接受空 command（与 build-profiles 一致，归一空串=用镜像 CMD），或 toCdsCompose 显式 emit 空 command 标记。同属共享契约改动，需双端同版本验证 |

### 相关

- [doc/design.cds.data-migration.md](./design.cds.data-migration.md) —— 原始数据迁移设计（本次校正"已落地"口径）

## CDS 过期分支预览页

分支被删后预览页按墓碑原因分流（已合并、已废弃），本文记边界与等待镜像时的可观测性欠账。

> 关联：墓碑页渲染与分流在 CDS 主入口，墓碑记录写在状态存储，触发来自 GitHub webhook（文件见文末「实现来源」）

### 背景

PR 合并/关闭后分支被删，原先一律落「启动失败」错误页。现按分支墓碑（`BranchTombstone.reason`）分流：

- `merged` → 「已合并到主分支」中间页 + 主按钮切换到主分支预览（已完成，本次重点）
- `abandoned` → 「分支已放弃」页 + 跳 PR（基础版已完成）

两页沿用 transit/waiting 页同款 `shapeGridBg` 动效网格背景 + 暖色双主题 token。

### 已知边界 / 后续可补

| # | 项 | 说明 | 优先级 |
|---|----|------|--------|
| 1 | commit 直链 | 放弃页目前只跳 PR；可补「查看最后一次 commit」直链（墓碑已存 `mergeCommitSha`，但 abandoned 通常无合并提交，需另取 head sha） | 低 |
| 2 | 放弃页推荐可用分支 | 复用 `liveBranchesForGonePage` 的模糊匹配，给放弃页也列出最匹配的在跑分支 | 低 |
| 4 | 合并页无自动跳转 | 按需求「希望用户点击切换」，刻意不做自动跳转（避免预期失控）。若后续想加兜底，需带可见倒计时 + 可取消 | 低 |
| 5 | 墓碑容量上限 200 | 超出按 removedAt 淘汰最旧；大流量多项目实例可能淘汰过快，可改为按项目分桶或调大上限 | 低 |
| 6 | previewSlug 口径依赖 | 墓碑 key = `computePreviewSlug(branch, projectSlug)`，若未来预览 slug 公式再变（v4），历史墓碑 key 会对不上（与现有预览链接同此风险） | 低 |
| 7 | 墓碑 merged 粘性的「无 prNumber raw delete」歧义（接受的权衡，**won't-fix**） | `recordRemovedBranch` 用 30min 时间窗 + prNumber 区分「合并后的自动删除」与「同名分支复用后删除」。但 GitHub 的 raw branch `delete` webhook **不带 prNumber**，在合并后 ~30min 窗口内与「快速复用再删」**本质不可区分**（无生命周期标识）。任何窗口都会顾此失彼：窗口短→破坏「合并→自动删除保持 merged」（每个合并 PR 都触发的常见路径，前轮 Codex/Bugbot 明确要求保护）；窗口长→「30min 内复用再删」仍显示「已合并」（本条 Bugbot 指出的罕见路径）。现取 30min **刻意偏向压倒性常见的合并自动删除**。彻底解需把被删分支的 `createdAt` 透传进 delete 路径的墓碑做确定性生命周期比对（更大改面，收益边际）。带 prNumber 的「不同 PR 关闭」已确定性处理，不受此歧义影响 | 低（接受） |
| 10 | ~~停止但未删除的 PR 分支不走分流页~~（完成 2026-06-24） | PR closed 后分支**未被自动删除**时 `BranchEntry` 仍在、`stopped`，原先 `proxy.routeToBranch` 命中现存 entry 服务泛化停止页、走不到 `serveBranchGonePage`（Codex P2）。已修：`routeToBranch` 在 stopped 分支分支兜底前先查墓碑（`findRemovedBranchByIdentifier(branch.id)`），命中且为真实 HTML 导航则走新增 `onBranchGone` 回调 → `serveBranchGonePage` 分流到合并/放弃页。fail-safe（无墓碑照旧、asset 请求不拦），且置于 auto-wake/恢复副作用之前（不复活已合并分支）。守卫测试 `proxy-tombstone.test.ts` | 完成 |

### 极速版「等待 CI 镜像」可观测性（2026-06-24，关联但独立）

> 根因调查：分支卡显示「容器停止 · 无记录 · 时间未知」，实为极速版分支卡在
> `ciImageStatus='waiting'` 永不部署。实证 `claude/nice-newton-zngjw1`（PR #919，
> `82ff0df`）：分支 tree 缺 `.github/workflows/branch-image.yml`（从旧 main 切出）→
> GitHub 该分支 `branch-image.yml` 运行 0 次 → CDS 等 `workflow_run.completed` 永不到达 →
> 无限期 idle / `lastDeployAt=null`，且无任何记录。前端把它误标成「停止」。

已修：
- **A. UI 说真话**（`BranchListPage.tsx`）：拆出 `等待 CI 镜像 / CI 镜像未就绪 / 待部署` 三态，
  `shouldShowStopReason` 对齐后端 `isStoppedBranch` 口径（真有停止信号才显示停止面板）。
- **B. waiting 看门狗**（`index.ts` `startCiWaitWatchdog`）：`ciWaitingSince` 计时，超时
  （默认 15min，`CDS_CI_WAIT_TIMEOUT_MS` 可调）翻 `failed` + 写 `ciImageError` 归因 +
  server-event（`app.ci-image.wait-timeout`）+ `branch.updated` 事件。failed 不阻断恢复
  （真 CI 晚到仍 failed→ready）。

后续可补：

| # | 项 | 说明 | 优先级 |
|---|----|------|--------|
| 7 | 入口校验（C-full） | done (2026-07-09)：`github-webhook-dispatcher.ts` isExpress 分支进 waiting 前先查分支 tree 是否有 `branch-image.yml`（`github-app-client.ts` 新增 `workflowFileExists()`，repo@branch 10min 结果缓存）；缺文件 → 不进 waiting、直接 `ciImageStatus='failed'` + 归因文案（提示切源码编译）+ `branch.updated`；GitHub API 失败 fail-open 照旧 waiting（看门狗兜底不变）。单测 `ci-prebuilt-express.test.ts` 两用例 | 中 |
| 8 | 详情页 CI 态 | `BranchDetailDrawer` / `BranchDetailPage` 暂未单独渲染 `ciImageStatus=waiting/failed`（已不会误标停止，但缺主动提示）。可补与卡片一致的 CI 状态块 | 低 |
| 9 | 自动回退源码编译 | 看门狗目前只翻 failed + 提示「可手动切源码编译」，未自动触发源码部署（避免后台任务抢资源）。可做成项目级开关 | 低 |

### 验证状态

- 单测：`tests/services/github-webhook-dispatcher.test.ts`（merged/abandoned 的 tombstoneRequest + delete 路径 abandoned）、`tests/services/state.test.ts`（record/get/cap/persist + merged 粘性 + CI 字段 round-trip）全绿
- `pnpm tsc --noEmit`（cds 后端 + cds/web）零错误；`cds/web` `pnpm build` 通过
- 真机验收：待 CDS 部署后，`claude/nice-newton-zngjw1` 应由看门狗翻 failed、卡片显示「CI 镜像未就绪（缺 branch-image.yml…）」而非「停止/无记录」
- `pnpm tsc --noEmit` 零错误
- 真机视觉验收（双主题截图合并页/放弃页）：待 CDS 部署后补

## CDS Loading Pages

转发进程目前是硬重启而不是优雅排水，切换瞬间可能丢请求，本文记这条已知债务。

### 已知债务

#### D1 — forwarder 硬重启（~3s 预览抖动）

**现状**：`master-run` 启动时检测到 `dist/ mtime > forwarder 进程启动时间`，直接执行
`systemctl restart cds-forwarder.service`（硬重启，非 graceful drain）。
每次 CDS self-update 重建 dist 后，forwarder 重启期间所有预览流量 502 约 3 秒。

**位置**：`exec_cds.sh` L2916-2925

**修法（待做）**：
1. forwarder 监听 `SIGUSR2` → 开始 graceful drain（停接新连接，等进行中请求完成）
2. `master-run` 改为发 `SIGUSR2` 替代 `systemctl restart`
3. 或：`cds-forwarder.service` 启用 `ExecStop` graceful timeout + socket 继承（`SO_REUSEPORT`）

**优先级**：低（3s 抖动用户感知不强，且已有 nginx 等待页兜底）

---

#### D2 — nginx waiting page 有多个散落的硬编码 HTML 模板

**现状**：8 个 loading/waiting HTML 页面分散在 5 个文件中，没有统一的 SSOT：

| # | 文件 | 函数/位置 |
|---|------|-----------|
| 1 | `cds/web/src/pages/PreviewPreparingPage.tsx` | React 组件（已迁移） |
| 2 | `exec_cds.sh` L738 | `write_waiting_html()` heredoc |
| 3 | `src/forwarder/waiting-page.ts` | `buildForwarderWaitingPageHtml()` |
| 4 | `src/routes/branches.ts` L13935 | `buildLegacyWaitingPreviewHtml()` |
| 5 | `src/routes/branches.ts` L14108 | `buildLoadingPreviewBranchGoneHtml()` |
| 6 | `src/index.ts` L2351 | `buildBranchGonePageHtml()` |
| 7 | `src/index.ts` L2435 | `buildTransitPageHtml()` |
| 8 | `src/services/proxy.ts` L890 | `serveDeployErrorLightPillarPage()` |

各自的 CSS token / 色值 / 双主题支持程度不一致，导致每次"更新样式"只能改到几个，
其余继续用旧风格，被用户发现后再修再遗漏，循环往复。

**已完成**：
- #2（`write_waiting_html`）已迁移到 `src/loading-pages/index.ts`，
  `exec_cds.sh` 调用 `node dist/cli/render-page.js nginx-waiting` 生成，SSOT 统一到 TypeScript。
- #3（`buildForwarderWaitingPageHtml`）2026-07-09 迁入 `src/loading-pages/index.ts`，
  原 `src/forwarder/waiting-page.ts` 只剩 re-export；vitest 快照锁字节级等价。
  顺手修掉 loading-pages 里 `DUAL_THEME_TOKENS` 的伪 light 块（诚实单主题 dark，注释说明）。
- #7（`buildTransitPageHtml`）2026-07-09 对账发现**零调用点**（dead code），
  直接删除（index.ts 留 3 行墓碑注释），不再迁移——「样式基准」角色由 loading-pages 现有模板承担。

**待做（按优先级）**：
- [ ] #4 `buildLegacyWaitingPreviewHtml` 迁移并统一双主题
- [ ] #5 `buildLoadingPreviewBranchGoneHtml` 已有双主题，迁移到统一模块
- [ ] #6 `buildBranchGonePageHtml` 升级样式 + 迁移
- [ ] #8 `serveDeployErrorLightPillarPage` 迁移

**完成标准**：所有 loading page HTML 都从 `src/loading-pages/index.ts` 导出，
`exec_cds.sh` 调用 TypeScript CLI 渲染，添加 vitest 快照测试防止各自漂移。

---

#### D3 — CDS_USE_FORWARDER 默认 0（隔离未启用）

**现状**：`exec_cds.sh` 默认 `CDS_USE_FORWARDER=0`，`cds_worker` upstream 指向 master 9900。
CDS self-update 重启 master 期间（pnpm install + tsc 编译，约 30s~2min），
所有预览流量 502，nginx 返回 `cds-waiting.html`。

**修法（待评估）**：
在 `init` 向导中主动询问用户是否启用 forwarder，或改为默认 1 + 自动安装 systemd service。
需确认所有生产部署节点的 systemd 版本兼容性。

**优先级**：中（影响所有自升级窗口的预览可用性）

---

#### D4 — 预览访问自动唤醒（preview auto-wake）的已知边界

**背景**：2026-06-23 用户要求"降温分支被访问时自动唤醒"，不再甩诊断死页。已落地
`proxyService.setOnReviveCooled`（`src/index.ts`）+ `ProxyService.triggerCooledWake/
shouldAutoWakeCooled`（`src/services/proxy.ts`），对**调度器降温**的分支
（`status='idle'` 且 `lastStopSource='scheduler'`，容器被 `docker stop` 保留）在
真实页面导航时做一次 `containerService.restartServiceInPlace`（docker restart，不重建代码）
并展示等待页，就绪后落到真实页面。这是 `src/index.ts` 旧注释里写的"Phase 2 lighter-weight
restart path"。

**已知边界 / 待补**：
- [ ] **沙箱无 docker，未端到端验证**：scoping 决策已有 vitest 守卫
  （`tests/services/proxy-auto-wake.test.ts`，7 例），但真实的 docker restart →
  健康 → 落地真实页面只在 CDS 环境可验。首次部署后需人工复测一次。
- [ ] **容器被 janitor 回收后无法原地重启**：`restartServiceInPlace` 返回 false →
  分支转 `error` 展示诊断页（不再无限 spinner）。此时正确做法是引导用户「重新部署」
  （全量重建），目前未在等待页给一键重部署入口。可后续补。
- [ ] **爬虫/链接预取仍可能唤醒**：已用「仅顶层 HTML 导航请求（`isHtmlNavigationRequest`）」
  过滤静态资源/非 document 请求，但发送 `Accept: text/html` 的爬虫仍可能触发一次唤醒。
  缓解而非根除。Kill-switch：`CDS_PREVIEW_AUTOWAKE=0` 整体关闭。
- [ ] **多服务分支**：逐个 `restartServiceInPlace`，任一失败该分支转 `error`。未做部分
  成功的细粒度展示。
- [ ] **与调度器 tick 的竞态**：靠 `branchOperationCoordinator` 租约（kind=`auto-restart`
  → priorityOf 35）抢占——高于 scheduler-cooling（30，可抢占），低于 auto-lifecycle（40）/
  webhook deploy（50）/ manual restart·deploy（80，让位）。唤醒成功后刷新 `lastReadyAt` +
  `lastAccessedAt` 再 `markHot`，避免下一 tick 立刻按陈旧时间戳降温或 auto-publish（与手动
  `/restart` 同款修法）。容量驱逐 best-effort（驱逐失败不毒化本分支）。

**完成标准**：CDS 环境实测「降温 → 访问预览域名 → 看到唤醒等待页 → 落到真实应用页」
闭环；并对 janitor 回收后的 fallback、kill-switch 各验一次。

## CDS 存活监控（uptime-monitor）

自建存活监控只会按固定间隔直连端口探测，非网页类服务判定不准，本文记三条债务。

### 总览

CDS 自建存活监控按固定间隔直连容器宿主端口探测每个分支服务，产出可用率柱条、故障事件时间线与状态页。

本台账记录首版复审暴露、且**有意延期**的边界项，防止下一次 session 无人记得。
第一条是本次已缓解但未根治的核心债务：**探测口径假定所有对外服务都说 HTTP**。

### 债务 1（核心）：非 HTTP 服务会被误判为故障

#### 现象

`selectProbeTargets` 对每个 running 分支的每个 build profile，只要拿到 `hostPort` 就产出
`http` 类型的探测目标；默认探测 `GET http://127.0.0.1:<hostPort>/`，以「状态码 < 500 即存活」判定。
于是下列服务会连续判失败：

- gRPC / h2c 服务（对 HTTP/1.1 GET 返回连接重置或非 HTTP 响应）；
- 纯 worker（端口只为占位或做内部通信，根本不监听 HTTP）；
- profile 发布出来的裸 TCP 端口（数据库代理、消息通道等）；
- 根路径本身就返回 5xx 的服务（未配置根路由、根路径故意 500）。

后果不是「多一条红」而是**状态页整体失真**：故障计数常年非 0，横幅永远显示「N 个服务异常」，
每个误判目标还会合成一条永不结束的 incident，真故障被噪声淹没——比没有状态页更糟。

#### 当前缓解手段（2026-07-27 落地）

| 手段 | 做法 | 覆盖 |
|------|------|------|
| 逃生阀 | 环境变量 `CDS_UPTIME_EXCLUDE` 排除名单，逗号/分号/空白分隔，单条支持 `*` 通配，按「目标 id / profile id / 分支 id / 项目 或 服务 / 展示名」任一维度匹配。命中者不探测、不计故障，状态页标「未纳入监控」并列出命中的规则 | 全部四类，但需要运维显式配置 |
| 自动降级 | 目标**从未**成功答过 HTTP、且连续 `failureThreshold` 次拿到**协议层**错误（连接被重置 / 响应解析失败 / 非 HTTP 响应 / socket hang up）时，自动改按容器状态判定，状态页标「已自动降级 · 按容器状态判定」并写明原因。连接被拒、超时、5xx 一律**不**降级（那是真故障） | gRPC / 裸 TCP（端口开着但不说 HTTP）自动生效，零配置 |

回归用例两组：「排除名单（逃生阀）」与「非 HTTP 响应自动降级为容器状态判定」。

#### 仍然欠着的（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | 纯 worker / 端口无人监听仍会误报 | 这类目标探测拿到的是 `ECONNREFUSED`（不可达），与「HTTP 服务真挂了」不可区分，故意不自动降级。只能靠 `CDS_UPTIME_EXCLUDE` 手动排除 | 未配置排除名单时仍会红 |
| 2 | 根路径返回 5xx 的服务仍会误报 | 拿到 HTTP 状态码说明对面在说 HTTP，按现有口径就是故障。根本解法是让 profile 声明健康检查路径（复用 `readinessProbe`），本次未做——`ProbeTarget` 只从 `BranchEntry.services` 推导，拿不到 profile 定义 | 需手动排除 |
| 3 | 排除名单只有环境变量入口 | 没有项目级 / profile 级字段，也没有 UI 开关，改名单要改环境变量并重启 CDS。后续可加 `BuildProfile.uptime.enabled` 与「CDS 系统设置」里的开关 | 运维便利性 |
| 4 | 降级是粘性的 | 一旦降级，只有该服务的宿主机端口发生变化（重新部署重分配端口）才会解除并重新试 HTTP。同端口重启的服务从「不说 HTTP」变成「说 HTTP」时，需删除 `.cds/uptime-monitor.json` 才能回到 HTTP 探测 | 概率低，可手动清台账 |
| 5 | 降级前的失败采样仍计入可用率 | 触发降级前的 `failureThreshold - 1` 次协议层失败已经落进采样与日聚合，会把该目标 24h 可用率压低一截（不开 incident、不判 down） | 首次接入后 24 小时内的可用率数字偏低 |
| 6 | 探测路径固定为 `/`，方法固定 GET | 不支持自定义路径 / 方法 / 期望状态码，鉴权网关型服务只能靠「< 500 即存活」兜底 | 判定精度 |

### 债务 2：状态页与探测器的次要边界（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 2 | 探测台账不跨实例共享 | 落盘在单机 `.cds/uptime-monitor.json`，多实例部署各存各的，可用率不合并 | 集群场景数据分散 |
| 3 | 状态页无单目标下钻 | `GET /api/uptime/targets/:id/history` 已就绪并做了降采样，前端尚未提供点开柱条看时序的入口 | 排障需直接调 API |

### 债务 3：服务端通知账本的残留边界（open，2026-07-29 随告警外发一并登记）

告警外发这条链路已经打通（事件总线 → `notice-ledger` → 可选 MAP 外发 → 前端铃铛），
但下面几条是本轮**刻意没做**的，交付时已声明，不得因为「债务 2-1 已偿还」就当作全解决。

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | 只有 MAP 一个外发适配器 | 没有 Webhook / 邮件 / 企微。新增渠道要照 `notice-outbound-map.ts` 再写一个适配器并在 `startNoticeLedger` 处分发 | 只能发到 MAP |
| 2 | 借用 MAP 的 `system-alert` 来源 | `AdminNotificationSourceCatalog.SourceDefinitions` 白名单里没有 CDS 专属来源，未知 source 会被 MAP 直接 400。本轮不改 prd-api，默认取 `system-alert`（可用 `CDS_NOTICE_MAP_SOURCE` 覆盖）。后果：MAP 站内信里 CDS 告警与模型池 / 平台密钥告警混在一起，无法按来源筛 | 下一轮给 prd-api 补一条 `new("cds", "CDS 部署", Admin, ...)` |
| 3 | 账本不跨实例共享 | 与债务 2-2 同因：落盘在单机 `.cds/notice-ledger.json`，多实例各存各的，通知不合并 | 集群场景数据分散 |
| 4 | `readAt` / `dismissedAt` 不分用户 | 从 localStorage（每浏览器一份）搬到服务端后语义变成全实例共享：一个人点「不再提醒」对所有人生效，一个人打开面板就把所有人的未读清零。CDS 是运维工具、用户数很少，v1 接受；要按用户需先确认全局网关在 `req` 上盖的用户标识字段名 | 多人同时用时未读数会互相影响 |
| 5 | 系统级告警拿不到项目归属 | `preview.canary.alert`（`services/preview-canary.ts`）与 `infra.flap.circuit-breaker`（`services/infra-flap-watchdog.ts`）的 payload 都不含 `projectId`，只能记为系统级条目，项目级 Key 一条都看不到。要让项目 owner 也收到，得先给这两个 payload 补 `projectId` | 项目级凭据看不到这两类告警 |
| 6 | 系统级密钥存储未配置加密密钥时明文兼容 | `sealToken` 在系统加密密钥未设置时原样返回明文，包括「外部接入」一节的缺陷转发凭据（`BugReportForwardingSettings.tokenEncrypted`）。已有运行时自检暴露「当前是否加密落库」，但未配置加密密钥不会阻止该功能启用 | 未配置加密密钥的实例，缺陷转发凭据以明文形式落库；运维应显式配置加密密钥而非假设默认已加密 |

本轮实际覆盖的告警源共七类：发布失败、自动回滚（`rollbackOf` 存在的成功）、发布现场漂移、
生产/分支健康掉线（连续失败达阈值）、CDS 自更新失败、预览入口探测失败、基础设施抖动熔断。
成功类事件默认**不**通知（判据在 `cds-events-bus.ts` 的 `shouldLedgerEvent`）。

### 相关

- 通知账本：账本服务 + 外发映射 + 通知路由三件套，回归用例齐备；
- 规则：`.claude/rules/concurrency-gate-discipline.md`（周期收敛 / 健康不变量）、
  `.claude/rules/expectation-management.md`（状态页的三态与等待反馈）。
- 回归：存活监控周期与指标聚合两套用例，

## CDS 绝对可视化一键部署 · 工程债务与待补台账

onboarding→部署核心已商业级可用（经验收通过）；以下是诚实记录的已知边界与低边际 backlog，按价值排序，供后续按需取用——不在表里的都已落地。

> **关联**：[design.cds.visual-deploy.md](./design.cds.visual-deploy.md)、[guide.cds.one-click-deploy.md](./guide.cds.one-click-deploy.md)

### 一、已知边界（设计取舍，当前不做）

| # | 边界 | 现状 / 取舍原因 | 影响 |
|---|---|---|---|
| B1 | 同类型多实例**仅对数据库**（supportsDbName）开放 | 只有数据库的连接串 host 能被安全改写到实例别名；缓存/队列多实例需各自的连接串改写规则 | 想挂两个 Redis 暂不支持，单个够用 |
| B2 | initSql **不随容器就绪自动执行** | 现为"随项目保存 + 拓扑数据面板一键载入执行"；自动执行需 DB 就绪轮询 + 幂等标记 + 错误处理 | 用户需手动点一次 |
| B3 | 检测覆盖有限 | `DetectedStack` 只有 `nodejs/python/go/rust/java/ruby/php/dockerfile/unknown` 九值；**.NET / 静态站点没有独立 stack id**——.NET 带 Dockerfile 落 `dockerfile`（manualSetupRequired），静态站点落 `nodejs` + framework(Vite 等)走 suggestedBuildCommand。故 `detect-runtime` 的 `stackToRuntime` 对这九值已穷尽，**不要给它加 `dotnet`/`static` 键**（detectStack 永不产出，纯死代码——2026-06-03 Cursor 误报过一次）。冷门栈/魔改构建落"未识别" | 少数项目要手填 + 靠试运行兜底 |
| B4 | 试运行只验**单服务**「镜像+命令+端口能否常驻 + 端口响应」 | 多服务联调依赖、基建连接串注入（DATABASE_URL 等）在正式部署才有，不在一次性容器里 | 试运行测"这条命令能起住"，非"全栈联调" |
| B5 | 端口探活极简镜像降级 | 首选 `/proc/net/tcp`（任何容器都有）；无 `/proc` 的极特殊镜像降级为"容器常驻=需确认"而非误判失败 | 极少数镜像探活降级 |
| B6 | AI 生成 compose **仅设计未实现** | 见 [design.cds.ai-compose.md](./design.cds.ai-compose.md)；按用户"备选"定位，借用 CDS Agent/OpenRouter，未写代码 | 当前靠确定性检测器，AI 路径待建 |
| B7 | CDS 自身跑在本特性分支 | 经 `self-force-sync` 上线；合并 main 后应 `self update --branch main` 切回 | 运维提醒 |
| B9 | detect-runtime / validate-runtime **仅管理员/控制台会话可用**(项目级 agent key 403) | 这两个"项目创建前"接口用服务器级 GitHub Device Flow 凭据克隆任意仓库 + 跑任意命令 + 回流日志,绑不到具体项目;放行项目级 key 等于借服务器凭据 exfil 任意私有仓库(PR #711 P1 修复)。同理数据/备份端点省略 ?project= 且 id 跨项目歧义时 400 要求指定项目 | 用项目级 key 的自动化流程跑不了 pre-create 检测/试运行,需用管理员凭据;若未来要支持,得先把 clone 绑定到该 key 授权的仓库白名单 |
| B8 | 后台任务(worker)就绪探测走 **noHttp（TCP 探活）**，不支持"完全不监听端口"的纯 worker | worker 角色的 BuildProfile 现设 `readinessProbe.noHttp=true`：跳过 HTTP "/" 探测，只 TCP 探活端口（PR #711 review 修复"活着的 worker 被 HTTP 探测超时误判失败"）。但 deploy 的 noHttp 仍要求 TCP accept——绑健康/TCP 端口的 worker 即就绪；**完全不 listen 任何端口的纯 worker 仍会超时**，需 `startupSignal`(日志正则)模式，而创建弹窗暂未收集该输入 | 纯无端口 worker 暂不可一键部署，需手填 startupSignal（后续可在弹窗加"就绪日志关键字"输入） |

### 二、Backlog（低边际打磨，按价值排序）

> 勘探确认部署机制本身扎实（SSE 事件流、容器日志、`docker restart` 恢复、TCP+HTTP 就绪探测、依赖拓扑、预览域名生成均已实现）。以下为锦上添花，每项边际价值已不高。

1. **实时部署阶段流到前端**：后端已发阶段事件，前端目前靠日志事后推断（部署中只见转圈）。改为显式 SSE 阶段事件 + 前端 live 阶段树。可单测（mock SSE → 组件渲染阶段）。
2. **就绪探测进度计数**：`waitForReadiness` 内部有 attempt/max，UI 未透出（用户在 3-5 分钟启动时看不到"第 15/90 次")。
3. **HTTPS/DNS 就绪校验**：当前假定 Nginx + 证书就绪，不主动探 `https://<preview>`；失败时是静默 404/TLS 错。
4. **一键回滚 / 从错误态一键重部署**：现需回分支列表重新触发；无版本快照/回滚。
5. **onboarding 三个 P3**（最终验收子智能体提）：
   - 试运行按钮在未填仓库时给 disabled 提示，而非点击后才报；
   - 用户手改镜像（非改运行时下拉）时，启动命令不自动联动 → 易产生第一次"不通过"；
   - 检测把 2 个默认服务合并为 1 个（单入口应用）是对的，但回填文案可更明确说明"服务数变了"。
6. **CLI `_INFRA_TEMPLATES` 收敛到 `infra-catalog.ts`**：消除三处漂移的最后一处（前端 + 后端已收敛，CLI 待收）。
7. **拓扑「新增基础设施」弹窗接多实例/库名/initSql 输入**：后端 `infra-presets` 已支持 infraConfigs/infraExtra，创建弹窗已全接，拓扑弹窗 UI 待接。

### 三、观察到的既有问题（非本轮引入，建议单独过一遍）

- **分支详情抽屉底部容器日志块在白天主题下偏暗**：疑似 `--bg-terminal`（light = `#1f1d2b` 暗色）与 `cds/CLAUDE.md` §0「白天禁暗色背景」的历史矛盾。值得按 `.claude/rules/cds-theme-tokens.md` 单独过一遍（终端/日志块在白天应浅底深字）。

### 四、独立 fixture demo 阻塞（承接 plan §六）

用真实示例 fixture 在 CDS 建一个全新独立 demo 项目跑通，仍受“onboard 只在仓库根探测 compose、示例位于子目录、当前仓库权限不足以创建独立 fixture 仓库”约束。可行路径是准备独立示例仓库，或在确认不会污染生产项目后使用专用 fixture 分支。CDS 已有多项目运行证据，因此此项属于独立演示取证，不是平台能力缺失。

## CDS 复制集模式工程债务

一个入口并排跑多版本的复制集模式，本文记真机验收结论与数据库隔离边界。

>
> 关联：[design.cds.replica-set.md](./design.cds.replica-set.md) | 创建：2026-07-23（MVP-1 落地时）

| # | 状态 | 债务 | 影响 | 偿还方向 |
|---|------|------|------|----------|
| 1 | done(2026-07-23) | 一键隔离数据库（dbMode=isolated + 数据克隆） | 已落地：replica-db-clone 三适配（mongodump / mysqldump / pg_dump），克隆完成才启动成员；隔离库保留语义 + 数据快照列表 + 手动删除 drop | 残留边界：克隆是停快照不追增量；pg 源库超大时 pg_dump 耗时（600s 超时上限）；mongo 镜像缺 database-tools 时明确报错不静默 |
| 2 | open | scheduler / auto-lifecycle 冷却分支时不感知复制集成员 | 分支被调度器休眠时成员容器可能继续运行占资源（显式 stop / delete 路径已级联收割） | scheduler coolFn 复用分支 stop 的成员级联；或复制集化分支视同 color-marked 不驱逐（设计文档既定方向） |
| 3 | open | promote 在 deploy 派发成功后立即解散复制集，不等 run 终态 | 若版本部署中途失败，成员已被收割，主容器仍是旧版本（入口不受损，但「提升」未达成需人工重试） | promote 改为跟踪 runId 终态后再解散；失败回滚为「保留成员」 |
| 5 | open | 成员直达子域未接 HTTPS 证书边界校验之外的墓碑/等待页 | 成员 provisioning 期间访问直达链会落 forwarder 等待页兜底，体验可接受但无成员级文案 | forwarder 等待页识别成员路由，给「成员启动中」文案 |
| 6 | done(2026-07-23) | remote executor 分支（executorId 指向远端）未支持复制集 | addMember 已对远端执行器分支返回 409 明确拒绝（isRemoteBranch 经 registry 判定） | 后续如需远端支持，成员物化改走 /exec 通道 |
| 7 | open | 灰卡渐显动画固定 2.4s，先于真实就绪结束（独立验收 R1 P3-1） | 创建 30s+ 时卡片提前恢复全彩，仅靠文字/脉冲块提示仍在创建 | 动画时长与 provisioning 状态联动（就绪才去灰），或改持续脉冲直至 running |
| 8 | open | 分流实测「实时日志」实为服务端完成后的逐条回放（R1 P3-2） | 探测进行中仅首行提示，非逐请求实时推送 | probe 端点改 SSE 流式逐请求推送 |
| 9 | open | 存量成员未迁移 res-N 命名规范（R1 P3-3） | 旧随机命名成员（rsXXXX）与新 res-N 并存，追踪性打折 | 一次性迁移脚本或成员重建时自动换名 |
| 10 | open | 成员直达域名响应缺 X-CDS-Replica 标记头（R1 P3-4） | 直达访问无法从响应头确认落点（主入口有头） | forwarder 成员直达路由也注入标记头 |
| 11 | open | 流量舞台一次仅渲染一个服务（R1 P3-5） | 多服务复制集拓扑需回行式逐行看 | 舞台支持多 profile 分区或服务切换器 |
| 12 | done(2026-07-26) | **forwarder 被动健康摘除已落地**（第三道防线，补控制面对账的秒级坏窗）：数据面观察上游连接结果，连接级死亡信号（ECONNREFUSED/EHOSTUNREACH/ENOTFOUND）连续 2 次 → 临时摘除（15s 起指数退避封顶 120s）→ 冷却到期半开试探 → 一次成功完全回池；被摘成员退出粘性与加权随机，全组皆摘仍回落主成员（绝不无出口）；诊断端点 `/__forwarder/replica-health`。此前已有：TCP 实测展示层 + die 事件秒级/每分钟对账标 error 摘流。**刻意不摘**：HTTP 5xx（应用层合法响应）、超时（可能只是慢）、ECONNRESET（重启瞬间）——宁可漏摘不可误摘 | 残留：应用僵死但端口存活（挂起不响应）仍不摘——属超时类，误摘风险大于收益，暂维持 | — |
| 13 | open | 隔离过渡期入口探测 servedBy 短暂变 untagged（复制集路由暂退，R4 P3） | 隔离/失败期间主实例落点在探测里不可辨识 | 过渡期保持 primary 单路由并带标记头 |
| 14 | open | 克隆错误文案头段仍是进度日志，真实原因在尾段（R4 P3，已不再被挤掉） | 可读性一般，需读到尾段 | 错误摘要优先提取匹配 error/failed 的行 |
| 15 | open | 共享 infra 容器无内存上限，mongod WT cache 默认吃半机内存（R4-P0 环境根因） | 任何大写入负载（不限克隆）都可能把 mongod 顶到宿主 OOM | CDS infra 供给时默认加内存上限 + 匹配的 --wiredTigerCacheSizeGB；需评估存量容器重建影响（cross-project-isolation 通道 4） |
| 17 | done(2026-07-24) | 崩溃现场不可追溯 | InfraLifecycleWatcher 常驻 docker events（oom/die/kill/start），GET /api/infra/:id/lifecycle-events 回看；die 137 无 oom=外部 SIGKILL、oom=cgroup OOM、其他=进程自身退出。R7 实战定罪 139 | 残留：只覆盖 cds-infra- 前缀容器；rsdb 专用实例暂不入取证范围 |
| 18 | open | mysql / postgres 克隆路径无源库大小闸门（mongo 已加），且仍走共享实例内克隆 | 大 mysql/pg 库克隆理论上有同类宿主压力风险（未实测出崩溃） | dataSize 预检推广到双引擎；必要时同款专用实例通道 |
| 19 | done(2026-07-26) | **删分支/删项目级联清理隔离库已落地**（Codex 双 P1）：删分支在删台账前逐快照 dropReplicaDb（专用实例 rm -f -v 连匿名卷；共享库 DROP `_rs_` 库；失败记服务器事件不阻断）；删项目把成员容器 + rsdb 容器写入墓碑清单，异步段先 dropReplicaDb 再跑墓碑处理（墓碑 rm -f 兜底，卷可能残留）。同轮连带：分支停止/降温/重启级联副本容器（此前重启不复原副本、降温漏停副本） | 残留：孤儿收割器仍不认领 cds.type=rsdb（讨论过的台账比对路径未做——删除路径已闭环后仅剩「删除瞬间进程被杀」窗口，靠墓碑覆盖删项目、删分支暂无墓碑） | — |
| 20 | open | 分支列表卡「复制集 xN」徽章不随抽屉内变更实时刷新（R10 P3） | 下线副本后列表卡计数滞后，整页刷新才对齐 | 抽屉变更后失效列表缓存或走分支 SSE 事件 |
| 21 | open | 整组复制 =「隐藏影子分支」方向已定（用户提议 + 判定采纳，波 6） | 当前 profile 级隔离下其他服务仍写主库，整组真隔离待影子分支 | shadowOf 分支 + 服务注册进主分支 replicaGroup（forwarder 数据面已支持），详见 design.cds.replica-set |
| 27 | done(2026-07-26) | **隔离 MECE 审计落地 + 生产实测「隔离有效」**（用户点名「隔离测过有效吗 + 没有可观测性」）。replica-isolation-audit 五面实测：意图（标记/台账/dbMode）、配置（逐容器 docker inspect 真实 env——副本指隔离库+专用实例、主实例仍指主库）、实例（rsdb 容器 running + 端口 TCP 实连）、数据（**双向金丝雀真写真查**：隔离库写入主库查无、主库写入隔离库查无 + 克隆基线）、边界（显式列出主实例仍连主库 #25 / redis 未隔离 #24 / 同库其他服务未隔离 #21——穷尽性要求没隔住的部分可见）。未隔离服务退化为逐容器连接观测。画布「隔离审计」入口（隔离区卡 + 页脚常驻）弹窗矩阵。**生产真跑一轮**（2026-07-26T08:50Z，安全协议：权重0摘流 → 隔离 api → 审计 → 回切 → 权重恢复）：OVERALL=effective，10/10 核心 pass——副本真实连 prdagent_rs_guard_1@专用实例:32771、主实例真实连 prdagent、克隆基线 239 collections、双向金丝雀 0 穿透；3 条边界如实列出。契约测试 4 例 | 残留：审计是抽查不是持续监控（可考虑接入定时巡检）。mysql/pg 数据面金丝雀已于 2026-07-26 补齐（共享实例通道建 canary 表真写真查、测完 DROP） | — |
| 28 | done(2026-07-26) | **Codex 第三轮安全/正确性五连修**：(1) mongo 专用隔离实例启用认证——复用源库 root 凭据（快照 dedicatedAuth 标记，凭据活取 infra env 不落盘），治 -p 27017 全网卡裸端口暴露生产派生克隆；(2) 隔离库名加分支哈希段 `<源库>_rs_<hash6>_<成员>`，治跨分支 guard-N 同名互杀（容器名由库名派生天然唯一）；(3) resolveReplicaDbTarget 合入分支级 env（与部署路径同优先级）；(4) promote 终态门——run 成功终态才解散复制集，失败/超时保留作回退出口；(5) /__forwarder/replica-health 补 loopback 门禁 | 残留：存量生产专用实例（cds-rsdb-prdagent_rs_guard_1，pre-auth 命名/无认证）维持原样直到重新隔离——快照无 dedicatedAuth 标记，消费方不会对其误发凭据；源库本身无认证的项目其隔离实例保持同姿态（克隆不比源更暴露） | — |
| 26 | done(2026-07-26) | **孤儿收割器误杀副本事故（已根治）**。事发链：res-N 成员容器带 `cds.profile.id=<profileId>--<memberId>` 但运行态在 branch.replicaSets 不在 services → 收割器 knownAppPairs 不认识 → 过 30 分钟宽限期被当孤儿优雅停掉（21:41 建的 5 副本 23:09 全灭，07:10 的早批死亡同因）→ state 仍标 running → forwarder 按权重把入口真实流量打到死端口，实测 admin 路径 50% 503。修复三件套：(1) 收割器认领成员容器（台账内成员任何状态都有主，已移除成员的残留容器仍照收）；(2) ReplicaSetService 真身对账：启动 + 每分钟 docker ps 对账，消失的 running 成员标 error 摘流（executor 节点不跑，防共享 state 误杀）；(3) 取证器 die 事件秒级回调摘流（计划内收割窗口 status 非 running 天然跳过）。UI 红色「N 个容器副本异常」自此永远是真异常 | — | — |
| 25 | open(专项排期) | 主实例切库通道未落地：零副本隔离已可先建隔离库并钉住隔离态（此后新副本自动连隔离库、同源库多服务复用同一隔离实例），但**主实例**仍连主库——切换主实例需要部署主路径的 env 覆写层（源码模式容器无法走成员物化路径），涉及重建容器 + revert + 收敛 | 「隔离数据库作用于分支所有部分」在主实例这一环仍是预告（UI 主库置灰是预览语义） | 部署主路径注入 branch 级 env 覆写（materialize 同款 profile.env 合并点）+ dispatchVersion 重建 + revert 对称清理 + 启动收敛与测试 |
| 29 | open | 共享 mongod 8.0.20 大批量写随机 SIGSEGV（承接已结清 #16 的残留：克隆路径已改走专用隔离实例绕开，问题本身没修） | 未来任何大批量写共享库的功能都可能撞上（同 cgroup / 辅助容器 / WT cache 收紧 / 单并发 / 索引串行全部无效，纯读安全） | 排期升级 mongo 镜像版本；容器重建需拍板 |
| 24 | open | 隔离区预览已按「复制整套基础设施」设计（mongodb+redis 镜像拷贝、原件全部置灰），但保存执行时真正克隆切换的仅数据库（mongo/mysql/pg 专用隔离实例通道）；redis 尚无专用实例 + 连接串覆写通道 | 保存后 redis 副本卡不会真实出现，预览与执行存在差距（已在交付说明中明示） | redis 隔离通道：docker run 专用 redis + 成员 Redis__ConnectionString/REDIS_URL 覆写（缓存冷启动语义可接受，无需数据克隆），复用 rsdb 命名与快照台账 |
| 23 | done(2026-07-24) | 二次纠偏五点定案已落地：(1) 管理模式二选一——分支级 replicaMode 首次保存计划钉住（存量有副本分支默认钉容器级），另一页签上锁，副本清零自动解除，后端 409 拦跨模式计划；(2) 容器级 = 展开的容器盒（主实例/副本/草稿收纳盒内，加号就地，连线盒对盒不遮挡）；(3) 项目级 = 三节点（入口 → 项目 → 基础设施），整组副本为项目节点右侧生长的节点（放不下换行），带全容器状态点/整组权重/整组下线；(4) 分支卡徽章改每容器专属色 chip + xN（replica-colors 稳定 hash 与画布同色），废除合计「复制集 xN」；(5) 复制集并入「部署」子页签（发布 / 复制集），不占顶级页签 | 残留边界：「容器级+项目级同时开启」按用户拍板暂不提供；模式切换必须先关完全部副本，无强制迁移通道 | — |
| 22 | done(2026-07-24) | 两页签统一节点卡画布已落地：容器级 = 一屏自上而下调用关系画布（边由 service-graph 服务端从 env 主机名引用/`CDS_<INFRA>_PORT` 模板/depends_on 推导，最长 id 优先，接口只暴露 env 键名），每容器独立加副本/历史版本/权重/下线/分流实测，下拉框已废除；项目级 = 原版舞台形态（入口 → 全部容器 → 基础设施），副本以「复制集成员 xN · 已负载」叠卡特殊标记不隐藏，整组加副本画布按钮直达；数据隔离统一战线升到分支级——隔离区一键覆盖全部有副本服务切同一专用隔离实例，部分隔离黄牌「统一战线未对齐」可一键补齐 | 残留边界：整组「影子分支」真隔离（其他无副本服务仍写主库）仍归 #21；调用边标签超过 3 条汇入同一目标时错落循环可能再次靠近 | — |

---

### 真机验收结论：MySQL/PG 隔离（2026-07-28）

对生产 CDS 上的标识中台 (IMP) —— 真实的 Java/Spring + MySQL 项目 —— 做只读核对，
连续发现并修掉**两个叠在一起的坑**，任一存在都会让「关系型隔离」名存实亡：

| # | 坑 | 后果 | 修复 |
|---|---|---|---|
| 1 | `rewriteRelationalUrlDb` 的 scheme 段不允许内嵌冒号 | `jdbc:mysql://` 一律解析失败 → 连接串进不了改写集合 → **静默不改写**，副本照旧写主库 | scheme 允许 `:`；3 条 JDBC 回归 |
| 2 | 库名 key 必须自带引擎名才能归类 | Spring 风格的 `DB_NAME` 归类不了 → 隔离**入口**即判「没有数据库名」，坑 1 修好也走不到 | 引擎中立 key + 从连接串 scheme 推引擎（推不出唯一引擎则拒绝）；5 条 fail-closed 回归 |

**验证证据**（生产 `GET /api/branches/:id/replica-sets` 返回，六个服务一致）：

```
{"ok": true, "plan": {"engine": "mysql",
                      "dbNameKeys": ["DB_NAME"],
                      "urlKeys": ["SPRING_DATASOURCE_URL"]}}
```

`engine` 由 `jdbc:mysql://` 推出、`DB_NAME` 被识别、`SPRING_DATASOURCE_URL` 进入改写集合 ——
两个修复都在真实数据上生效。同时 `KEY_VAULT_DB_URL` / `SUPPLIER_ECOSYSTEM_DB_URL` 被正确排除
（指向别的库、路径段对不上源库），没有过度改写。

#### 仍未做的部分（如实登记）

| # | 状态 | 债务 | 说明 |
|---|------|------|------|
| A | open | 物理克隆未在 IMP 真跑 | 解析层已在真实数据上验证；`mysqldump \| mysql` 那一段是跨项目验证过的既有机械，但**未在 IMP 上端到端跑过**。真跑会在别的团队的共享 MySQL 上产生 dump 负载，并留下一个按「保留语义」不自动删的库，需项目方知情后再做 |
| B | open | 引擎中立 key 仅认 `DB_NAME` / `DATABASE_NAME` | 其它无引擎命名（如 `SCHEMA_NAME`）仍不认；等真实项目出现再按同样的「从连接串推引擎」路子扩 |
| C | open | 同一来源层级内多个库名 key 指向不同库时无法判准 | 库名 key 取用现按「来源层级（profile > 分支 scope > 项目 customEnv）优先，同层再比引擎专属度」（Codex 九轮 P1）。若 `MYSQL_DATABASE` 与 `DB_NAME` **同在一层**且值不同，没有任何归属信息可依，只能按引擎专属度选前者——可能选错。唯一能判准的是「值等于同 env 某条关系型 URL 的库名段」，但 `dbScope=per-branch` 下 `applyPerBranchDbIsolation` 给白名单 key 追加 `_<slug>` 而**不改 URL**，该判据会稳定偏向未加后缀的 key，反引入新的错选。真实项目出现再处理（届时需连带解决 per-branch 不改 URL 这一前置缺口） |
| D | open | 多引擎项目里中立库名 key 依赖 `dependsOn` 声明 | 中立 key 的引擎判定为「全 env URL 唯一引擎」，判不出时取「`dependsOn` 声明且在运行的 infra 引擎 ∩ URL 中出现的引擎」，仍不唯一即 fail-closed（Codex 八轮 P2）。因此**多引擎项目里没写 `dependsOn` 的 profile 用不了中立 key 隔离**——这是有意的保守，但对用户表现为「隔离入口不可用」，诊断文案已给出提示，长期应在 UI 上直接建议补 `dependsOn` |

## CDS executor 卡死看门狗

卡死看门狗在两种运行模式下判定口径不一致，本文记边界、根治方案与延期项。

### 总览

PR #940 让通用部署卡死看门狗（`reconcileStuckDeployStates`）在 master 与 executor 两种模式都跑。
master 的部署（本地 + 远端代理）都持 `BranchOperationCoordinator` 租约，看门狗的 `hasActiveOperation`
判活准、`allowHardTimeout` 可安全开启。**executor 节点不持该租约**，于是当前用 `allowHardTimeout:
isMaster` 在 executor 上**关闭硬超时**，只做时间戳证据收敛 + 告警。

### 已知边界 / 待补（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | executor 卡死构建无人硬超时 | Bugbot High #228 要求关 executor 硬超时（无租约判活，怕误杀 >45min 合法远端构建）；Codex P2 #233 反向要求开（否则 executor 卡在 building/starting 的构建永不被收敛）。两条机器人评审结论冲突。当前取保守侧（关），代价是 executor-owned 分支若真卡死，本地看门狗不会把它收敛成 error，要等 master 侧或人工介入 | 仅 **cluster 模式**；生产是单机 master、executor 未启用，无实际影响 |

### 根治方案（待实施）

给 executor 加「本地在途部署感知」，同时满足两条评审：

1. executor 侧维护一份「本机正在跑哪些分支的部署」的集合（部署开始时加入、结束时移除）。
2. executor 模式下，看门狗判断「有没有在途操作」改读这份本机集合（而不是 master 的协调器），并允许硬超时。
3. 效果：部署进行中 → `hasActiveOperation=true` → 整条跳过（不误杀，满足 #228）；部署结束/从未开始却卡死 → `hasActiveOperation=false` → 硬超时可收敛成 error（满足 #233）。

未在 PR #940 内实施的原因：本沙箱无法端到端验证 executor 集群模式（CLAUDE §8.1 自测优先），不在安全可验证范围内加未测的集群管线代码。等真正启用 executor 集群、有可验证环境时按上方方案补。守卫：`reconcileStuckDeployStates` 的 `hasActiveOperation` / `allowHardTimeout` 单测已覆盖核心逻辑，补 executor 接线时复用。

### 其它 #940 评审延期项（cluster/UI 可见性，非安全阻塞）

下列均为本 PR 新增「构建历史元数据 / 极速版告警」的**可见性/准确性**边界，非安全回归，集中在 cluster/executor
或前端渲染，沙箱无法端到端验证，故记债务、不在 PR #940 内强行接线：

| # | 债务 | 现状 | 影响面 |
|---|------|------|--------|
| 2 | 远端 executor 部署的 commit SHA 不回传 | `/exec/deploy` 完成 SSE 只把 SHA 放进 `title` 字符串、未放进 `data/detail`；master 侧 `opLog.commitSha` 拿不到 executor `pull()` 的真实 HEAD，cluster 手动部署历史「版本」列可能停在派发前旧 SHA（Codex P2）。**本地/主 deploy 路径已修**（源码 pull 后 opLog 以 pulledSha 为准，不再冻结在 requestCommitSha）。根治需改 executor SSE 协议：complete 事件 data 带 `pullResult.afterFull` | 仅 cluster；单机 master 不触发 |
| 3 | 远端 executor 部署的 deployMode 不回传刷新 | executor-proxy 的 opLog.deployMode 在构建前按 master 现有 profiles 冻结，executor 真实 `deployedMode`（含 express→source 回退）不回传，远端历史「部署类型」列可能显示旧值（Codex/Bugbot）。本地路径已按实际 ran profiles 重算 | 仅 cluster |
| 4 | TYPE1 极速版落后告警在分支卡片不可见 | 看门狗对「ciImageStatus=ready 但 ciTargetSha≠HEAD 且含运行时改动」写 `ciImageError`、status 保持 `ready`；分支卡片 UI 只在 `ciImageStatus==='failed'` 渲染 error 文案，故该告警目前只进系统事件日志/字段、不在主分支列表醒目显示（Codex P2）。根治需前端加 ready-with-error 渲染路径，或引入 `stale` 状态枚举（涉 enum 全栈涟漪，见 `enum-ripple-audit.md`） | UI 可见性；告警本身已落库/落日志 |

根治原则同 #1：等有可验证的 executor 集群环境 + 前端可视验收时按上表补；当前不在安全可验证范围内加未测代码。

### 相关

- [doc/debt.cds.ci-prebuilt.md](./debt.cds.ci-prebuilt.md) —— 极速版（CI 预构建）债务（同属 cluster/部署模式族）
- PR #940 评审：Bugbot #228（关）、Codex #233（开）；#2-#4 见 PR #940 review threads

## CDS 后端部署冻结 · 分支 api 跑旧代码 · debt

某分支的后端始终跑旧代码：构建成功不等于运行的是新代码，本文记判定信号与被卡住的两处修复。

| 字段 | 内容 |
|---|---|
| 模块 | CDS 部署管线（分支 worktree 构建 → api 容器运行） |
| 状态 | open（阻塞中，需 CDS 主机层介入；2026-06-19 发现） |
| 关联 | `cds/src/services/worktree.ts`、`cds/cds-compose.yml`(api 服务 `dotnet build && dotnet run --no-build`)、分支 `claude/visual-agent-redesign-9vt3lm`、提交 `6a459698` |
| 提出 | 图生视频成片下载修复 + 额度提醒推了 5 次都"不生效"，逐层排查后定位为 CDS 部署冻结，非代码问题 |

### 债务主题：构建成功 ≠ 运行的是新代码

某分支的 prd-api 在 CDS 上**始终执行旧的后端代码**，无论往 GitHub 推多少次、用何种方式部署。前端（prd-admin，static/vite 模式）改动能正常部署；后端（.NET 源码模式）`.cs` 改动**进不到运行进程**。

#### 复现与证据（2026-06-18 ~ 06-19，分支 `claude/visual-agent-redesign-9vt3lm`）

跨副本可信的判定信号：图生视频下载端点 `GET /api/v1/videos/{id}/content` 的 LLM 日志 `answerText`：
- 旧代码：把 mp4 字节按字符串读 → `answerText` = `\0\0\0 ftypisom…mdat…`（原始 mp4 当字符串）。
- 新代码（应有）：先无损读字节 + 魔数嗅探 → `answerText` = `[binary:application/json, N bytes]`，下载成功落 COS。

所有部署方式跑完，日志恒为**旧行为**：

| 尝试 | 结果 |
|---|---|
| `git push` + GitHub webhook 自动部署 | 旧代码 |
| 强制 `POST /api/branches/:id/deploy` | 旧代码（dll mtime 不变，只重启没重编） |
| 删除分支 + `branch create` 重建 worktree | 旧代码 |
| 强制 `POST /api/branches/:id/pull`（返回 `head=6a459698, updated=false`）+ 重新部署 | 旧代码 |

`/pull` 确认 CDS 仓库侧引用已是 `6a459698`，构建日志显示 `PrdAgent.Infrastructure -> …dll` 编译成功、`API listening` 正常启动、无 `error CS`，**但运行进程仍是旧下载代码**。

`branch exec --profile api-prd-agent` 一度回报 worktree HEAD=`97329c58`（一个不在本分支历史里的旧/孤儿提交）且 `git reset --hard` 不持久 —— 说明 exec 起的是一次性容器，不能代表真正在跑的部署，也不能用来修。

#### 已排除
- 不是代码编译错误（CDS 构建成功，本地 ImplicitUsings 校验通过，重建后 api 正常 listening）。
- 不是 CDS 仓库没拿到提交（`/pull` 报 `6a459698`）。
- 不是 2 副本竞争（该项目 api+admin 各 1 容器，2/2 指两个服务非两副本）。
- 不是 CDS 版本旧（`cds version` 报 0.6.8 = latest）。

#### 仍未定位（留给下一手）
为什么"构建成功的 dll"与"运行进程的行为"对不上。候选方向：
1. **Debug/Release 输出路径错配**：`cds-compose.yml` api 命令是 `dotnet build --no-restore --no-incremental`（构建日志落 `bin/Release`）然后 `dotnet run --project … --no-build`（`dotnet run` 默认 Debug，找 `bin/Debug`）。若靠 props 强制 Release 才一致；一旦不一致，`--no-build` 可能跑到旧/别处产物。需在真正运行的容器里核对运行的 dll 路径与 mtime。
2. **`git worktree add origin/<branch>` 用的远程跟踪引用**与 `/pull` 更新的引用不是同一个，导致 worktree 源码停在旧提交（exec 看到的 `97329c58` 可能是真相而非 throwaway 假象——需在**真正运行的**容器而非一次性 exec 容器里核对）。
3. CDS deploy 实际"只替换容器、复用旧编译产物"，没真正 `rm -rf bin && build`。

#### 一锤定音的验证（需 CDS 宿主机 shell）
```bash
WT=/root/inernoro/prd_agent/.cds-worktrees/prd-agent/prd-agent-claude-visual-agent-redesign-9vt3lm
cd "$WT" && git rev-parse HEAD
grep -c LooksBinary prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs   # 期望 1
# 若 HEAD 不是 6a459698：git fetch origin && git reset --hard 6a459698，再强制 clean rebuild
# 核对真正运行的容器跑的是哪个 dll：docker exec <api容器> sh -c 'ls -la …/bin/Release/net8.0/PrdAgent.Infrastructure.dll; ps aux|grep dotnet'
```

---

### 被这条债务卡住、已就绪未生效的两处修复（代码在 `6a459698`，待部署修好后复验）

#### 1. 图生视频成片下载鲁棒修复
`LlmGateway.ExecuteRawWithResolutionAsync` 改为**先 `ReadAsByteArrayAsync` 无损读全部字节，再判二进制/文本**，并新增 `LooksBinary()` 按文件魔数嗅探（mp4 `ftyp` / png / jpeg / gif / webp / 标称文本却以 NUL 开头）。根因：OpenRouter `GET /videos/{id}/content` 回的是真 mp4 字节却把 `Content-Type` 标成 `application/json`，旧逻辑用 `ReadAsStringAsync` 损坏字节 → `BinaryContent` 空 → `DownloadVideoBytesAsync` 在 HTTP 200 下误判失败「视频下载失败: HTTP 200」。同时下载失败 error 附诊断 `(ct=…, binLen=…, textLen=…)` 随 run 落库便于跨副本复盘。

复验脚本（绕过拆分镜，2-3 分钟出结果）：`direct` 模式 `POST /api/video-agent/runs`（`{mode:'direct', directFirstFrameUrl:<公开图 URL>, directPrompt, directAspectRatio, directDuration}`）→ 轮询 `GET /api/video-agent/runs/{id}` 到 terminal。已验证：**提额后生成链路跑通**（提交 → Wan 2.6 渲染 → 进 `downloading` 95%），只差下载落库（本修复）。

#### 2. 大模型额度用尽 / key 限额主动提醒（用户 2026-06-19 提出"额度不够就要及时提醒出来"）
- `LlmGateway` 在上游非 2xx 时识别限额类错误（OpenRouter `Key limit exceeded`、HTTP 402、`insufficient credits` / `quota exceeded` / `billing limit`）→ 返回专门错误码 `LLM_QUOTA_EXCEEDED` + 清晰中文提示（替代笼统的 `LLM_ERROR`）。
- 通过 `IPoolFailoverNotifier.NotifyQuotaExceededAsync`（复用 `PoolFailoverNotifier.UpsertNotificationAsync` 去重 upsert）发 error 级**主动站内告警**（key `llm-quota-exceeded`），覆盖 chat（拆分镜）/ image（关键帧）/ video（图生视频）全部走网关的调用。
- 背景：2026-06-19 这把 OpenRouter key 触顶（`Key limit exceeded (total limit)`），导致拆分镜空态、关键帧失败、视频提交失败，但全程**静默**——用户从各功能"全死"反推才发现是额度。提醒上线后，额度不足应一眼可见。
- 后续可加：额度恢复后自动关闭该告警（参考 `PoolFailoverNotifier` 的 recovered 路径）；额度阈值预警（用尽前提示）。

---

### 影响面与临时绕过
- 该分支预览当前为 **running**（已从 error 救回），但后端跑旧代码：图生视频出片、额度提醒在此分支预览上不可见，直到 CDS 部署修复。
- 其它分支是否同样冻结未逐一验证；若是 CDS 管线通病，影响所有走源码模式的 .NET 分支部署。
- 临时绕过：无 agent 侧手段（push/deploy/重建/pull/exec 均试过）。只能 CDS 宿主机层介入。

---

## 基础设施暴露面 · 端口绑定与默认认证

CDS 给每个 infra 服务分配一个宿主端口，本意只是让容器之间能经网桥地址互访。但
`docker run -p <hostPort>:<containerPort>` 省略绑定地址等于绑 `0.0.0.0`——数据面
被顺带挂到宿主的每一张网卡上，**包括公网网卡**。

这一层**宿主防火墙挡不住**：Docker 发布的端口经 nat PREROUTING 的 DNAT 改写后走
`FORWARD` 链，不经过 `INPUT`。宿主上配了默认拒绝的 iptables / ufw 规则，运维看着
「防火墙已开」，实际一个数据库都没挡住。这是 Docker + iptables 的经典坑，不是配置
失误——**不配置就是这个结果**，所以必须在发布这一步而不是防火墙那一步解决。

### 已经做了的

绑定地址收敛成唯一一份判定：默认只绑 docker 网桥地址与回环，两者都不是对外地址。

不选「只绑回环」是因为应用容器拿到的连接串里写的是网桥地址，而容器访问不到宿主的
loopback——只绑回环等于全线断库。所以绑的是「消费方实际使用的那个地址」，这既收紧了
暴露面又不破坏任何现有连接。逃生阀 `CDS_INFRA_PUBLISH_HOST` 可覆盖，填 `0.0.0.0`
恢复旧行为。

这份判定同时是「注入给应用的宿主地址」的来源，两者必须同源：否则连接串指向一个地址、
端口绑在另一个地址，编译过、测试绿，只有真连库时才炸。

回归覆盖 15 条，其中三条跑真实的 infra 启动流程、从录下来的 docker 命令里读实际绑定
参数——把绑定改回裸绑，这三条立刻变红。

### 已知边界

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| E1 | 高 | 2026-08-16 | 绑定地址在容器创建那一刻就固化了，改代码对**存量**容器一个都不生效 | 升级后不重建 infra 容器 | open | 启动流程对已在跑的容器直接返回、对停止的容器走唤醒，两条路径都不重拼发布参数。要生效必须逐个删掉重建；有状态服务重建前必须先有备份 |
| E2 | 高 | 2026-08-16 | infra 的**默认认证**仍不一致：走服务目录建的 mongo 带 root 凭据，走其它路径（快速启动 / compose 导入 / 手工）建出来的没有认证 | 走非服务目录路径新建 mongo | open | 收窄绑定地址只把攻击面从「全互联网」缩到「同宿主全部容器」。宿主上跑着大量分支预览容器，任一被投毒的构建都能横向访问。需要把默认认证补齐到所有创建路径 |
| E3 | 中 | 2026-08-16 | 服务目录里的 redis 默认不设访问密码 | 新建 redis | open | 补密码会连带改下发给应用的连接串，而各项目的 compose 契约存在 CDS 自己的状态库里、不在本仓库，改动前需要逐项目核对消费姿势 |
| E4 | 中 | 2026-08-16 | infra 没有周期备份，只能手工触发 | 需要回滚或恢复时 | **已跑通** | 周期自动备份（mongo / redis / mysql / postgres）已上线并真实产出，带磁盘闸与保留策略（每服务 7 份 / 14 天，**最新一份永不删**）。两轮实跑各抓出一个真缺陷：落盘目录写死且宿主上不存在（已改逐个候选试写）、台账的存活字段是 `status` 而调用点按 `running` 判（已映射）。凭据一律在容器内展开，不进宿主命令行。**仍缺：离机副本、恢复演练**——见 G4，没演练过的备份不算备份 |
| E8 | 中 | 2026-08-16 | 手工备份的历史接口把「目录不存在」显示成「没有备份」 | 备份目录从未创建过 | **已修** | `ls` 带着 `2>/dev/null`，两种情况返回一样的空列表——于是「一份备份都没有」可以一直不被发现。现在响应里带 `directoryExists` 区分二者 |
| E5 | 中 | 2026-08-16 | 「无认证 + 对外端口」这个组合没有**存量**扫描守卫，只有新增路径的单测 | 已有 infra 被改回裸绑，或建库时跳过认证 | **已建，未上线** | 已实现周期自检：判据取运行态真值（容器的真实端口映射），不读台账里的 hostPort 数字；「对外 + 无认证」判 critical 并按 error 级记事件。它同时覆盖不经 CDS 起的容器——那些恰恰最容易被忘掉 |
| E9 | 中 | 2026-08-16 | `cds/tests/` 不在任何 tsconfig 的 include 里，测试代码不受类型检查 | 夹具跟着被测类型一起改 | open | 改窄一个共享类型时，用旧形状构造夹具的测试不会编译报错，只会在跑到那一行时才炸——本轮就有一个 `lastRelease` 夹具是这么漏过去的。补 include 会一次性暴露存量测试里的类型问题，需要单独一轮收敛，不在功能 PR 里顺手做 |
| E7 | 中 | 2026-08-16 | 待批的运维请求扛不住一次重启：审批队列只在内存里，CDS 自更新后全部消失 | 提交请求后 CDS 重启 | open | 「AI 发起 → 人类审批」这条通道在自更新前后是断的，而自更新恰恰是 AI 最常做的动作。发起方也收不到「你的请求没了」的信号，只会一直等 |
| E10 | 中 | 2026-08-16 | 暴露面自检的去重签名只含严重度、身份与绑定地址，**不含防火墙状态与实际端口** | 端口一直绑在全网卡，宿主防火墙规则中途消失 | open | 两种状态签成同一个串，后一次告警被 `lastSignature` 抑制——「易失的防火墙保护没了」恰恰是这份自检想抓的事。修法是把 `firewallBlocked` 与生效端口并进签名；本轮按边界处理，未改判据 |
| E16 | **高** | 2026-08-16 | redis / memcached / kafka / nats 四个预设**从创建起就没有认证**（catalog 无 `secretKeys`，连接串是裸的 `redis://redis:6379`） | 用这些预设建服务；叠加端口公网暴露即裸奔 | **已修（2026-08-21 三个补齐）** | 不是「轮换」问题——没有口令可换。redis 已补：secretKeys + `sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD"'`（口令只走 env，不进宿主 ps / docker run 字符串）+ 连接串带口令，三处同批改，消费方（数据面板 / 备份探测 / 脱敏）本来就认 `REDIS_PASSWORD`。memcached / kafka / nats 于 2026-08-21 补齐（见 E49）。**只对新建服务生效**：存量 redis 的 env 与连接串存在 state 里，不会被 catalog 改动追溯，要靠 E17 的轮换路径补 |
| E17 | **高** | 2026-08-16 | 基建口令只在建服务时生成一次，之后**没有任何轮换路径**（`createInfraPreset()` 的 `makeSecret()` 是唯一生成点） | 需要换库口令时 | open | 且改 env 重建容器是**假轮换**：`MONGO_INITDB_ROOT_PASSWORD` / `MYSQL_ROOT_PASSWORD` 只在空卷首次初始化生效，已有卷上旧口令照样能登、新口令登不上，而连接串已经换成新的 → 消费方全 401，看起来像轮换打坏了系统。手工流程见 [doc/guide.cds.infra-credential-rotation.md](./guide.cds.infra-credential-rotation.md)；代码侧要补的是「库内改口令 + 更新 envVars + 列出待重部署消费方」一条龙 |
| E31 | **高** | 2026-08-17 | runbook 只让改 `DATABASE_URL`，而 mysql / postgres 各注入**两个**连接串变量、minio 四个 | 用未改那个变量的消费方重部署后连不上 | **已修** | §2.0 表格补「注入的连接串变量」列并逐个列全，第 4 步与收尾清单都点明「每一个都要改」 |
| E32 | **高** | 2026-08-17 | runbook 的 PostgreSQL 验证走容器内 socket，而官方镜像默认对本地连接 trust——**拿错口令也会看到 `SELECT 1` 成功** | 按原步骤验证 PG 轮换 | **已修** | 假验证比不验证更危险：操作者会把错口令存进 env 再全线断连。改成走 TCP 验新口令 + 反向验旧口令必须被拒，并把「验证要走消费方真正用的路径」升格为通则 |
| E33 | 中 | 2026-08-17 | §0 表把 sqlserver / clickhouse / rabbitmq / elasticsearch / minio 指向 §2，而那里根本没有它们的步骤 | 操作者照表去找步骤 | **已修** | 空承诺会诱使人自己猜命令。改成如实标注「本文没有核对过的步骤」，给出四条通则让人自己组装并自验；未在真实镜像核对过的命令不再假装提供 |
| E34 | 中 | 2026-08-18 | redis 备份的凭据兜底「扫进程命令行找 `--requirepass`」，对默认配置的 redis 是一条走不通的路 | 某个 redis 开了认证、而口令不在容器 env 里 | **已修** | 拿真 redis 量过：默认 `set-proc-title yes` 时它启动后会把自己的 argv 整个改写成 `redis-server *:6379`，口令连同其它参数一起消失；显式关掉 proc-title 才扫得到。线上 6 个 redis 里唯一还失败的那台正是这种——口令原原本本存在 CDS 自己的启动命令里，容器里哪儿都扫不到。改法：由 CDS 从自己的服务定义取口令，经 **stdin** 送进容器（`docker exec -i c sh -s`），宿主命令行上只剩 `sh -s`；不走 `docker exec -e`，那会把明文摆进 argv 让同机 `ps` 看见。三个探测点统一改完并加了盯形状的守卫 |
| E35 | **高** | 2026-08-18 | Redis 恢复是「往运行中的容器写 RDB，然后 `docker restart`」——关闭时 redis 会按 save 点把当前数据存一次，**正好覆盖掉刚上传的快照** | 恢复一个配了 save 点的 redis（默认配置就是） | **已修** | 覆盖之后重启加载到的是覆盖后的内容，而接口回「已恢复」。恢复场景里这种谎话代价最大。顺带第二个口子：`appendonly yes` 的实例启动读 AOF 不读 RDB，同样「恢复成功」但一条没变。改法：顺序换成 停容器 → 拷出当前快照（这时才准确，用作撤销）→ 覆盖 → 启动——把关闭时那次 save 从对手变成帮手；AOF 实例直接 409 拒绝并说明理由；redis 分支此前根本没有撤销快照，一并补上。顺序由纯函数产出并被断言（把顺序改回事故写法，两条用例变红）。2026-08-18 收窄绑定时读代码发现，当时那台恰好是空库，没踩到 |
| E36 | **高** | 2026-08-18 | 暴露面自检的失败路径（读不到容器列表、任何一步抛异常）都只 `console.warn` 就返回，不落任何事件 | 自检中途失败 | **已修** | 面板上「没跑成」和「跑了没问题」长得一模一样，于是最近一条结果被当成当前状态。当天坐实：去重用的签名是进程内变量、重启后必落事件，而 CDS 重启三次后一条都没有——即没跑完，不是状态没变。改法：新增自检活性账本，失败一律落事件并按「距上次成功多久」升级严重程度（偶发 warn，连着一个周期没成功升 error 并明说结论不可信；从没成功过同样算哑）。三处周期任务一起接上——暴露面自检两条失败路径、入口可达性自检、周期备份整轮失败。备份的活性打点刻意放在成功/部分失败分岔**之前**：长期部分失败（某个库口令不对）不该被误报成「备份已经哑了」，假警报比不报更糟 |
| E37 | **高** | 2026-08-18 | 自更新回滚之后，历史记录仍然写 `status: success` 且 `error: null`，回滚这件事在任何地方都查不到 | 新版本启动即崩溃、systemd 重试超限后退回旧版 | **已修** | 2026-08-18 实测：更新到 6d2da7de 记录为 success（含 web 重建 19.8s），而机器上 HEAD 退回 b4b6b01b 且处于 detached 状态、`currentBranch` 为空、`fetchOk` 为 false。我据此以为改动已上线，实际没有——这正是「报告不是事实」。改法（已落地）：重启后回头对账——把记录声称的 toSha 和真实 HEAD 比一次，对不上就落一条 error 事件说明「构建成功不等于更新成功」。读不出 sha 时明说无法对账，不猜。仍未做的是自动回滚本身，那由 systemd 兜，回滚要单独记一条 error 事件写明从哪退到哪、为什么；detached HEAD 要在状态里显式标红，否则后续自更新都会从一个没人注意的状态出发 |
| E38 | **高** | 2026-08-18 | CDS 全仓没有 `unhandledRejection` 兜底：任何「发出去就不管」的后台动作失败，都能让整个进程被 Node 终止 | 后台异步动作失败且调用方无从捕获 | **已修** | 2026-08-18 全站 18 分钟不可用的根因。离机审计上传收到 R2 的 401，失败被 rethrow 进没人接的 promise 链，Node 默认把无人处理的拒绝当致命错误 → 进程退出 → systemd 反复重启超限 → 回滚。本地逐字复刻确认退出码 1。两头都修：引信侧（sink 记一条失败 + 累计连续次数后咽下，不 rethrow，并把连续失败次数暴露出来供健康判断）；保险丝侧（master 与 forwarder 两个入口都装总兜底——拒绝记一笔继续跑，未捕获异常记下调用栈再照常退出）。第二条同样重要：这次进程死了，事件流一个字都没有，只能靠 systemd 那句话猜。**线上实证（2026-08-18 15:13 部署 7b84cd39）**：同一个 R2 401 仍在，离机审计连续失败 46 次，CDS 全程运行未中断，保险丝一次都没跳（0 条 process-fuse 事件）——因为引信已拆，拒绝根本没逸出。修复前是第一次失败就杀掉进程 |
| E39 | **高** | 2026-08-18 | 基础设施认证门禁把「不许再造新的」和「立刻停掉已有的」混成一个判定，上线即停摆 | 门禁装在「启动基础设施」这一步，而分支部署必然要确保依赖的库在跑 | **已修（限期）** | 2026-08-18 15:13 门禁随安全基线上线，五个项目十几个无认证存量库全部启动不了，prd-agent 主分支预览与所有 PR 预览部署失败；台账把 prd-agent 的 mongodb 标成 error（容器其实活着，业务未断）。策略文件注释写的是「只阻止创建新的」，调用处却故意拦所有启动——两处意图矛盾，实际行为是后者。改法：判定拆两档，按**登记时间**分新旧，门禁上线前登记的存量库限期放行、之后新建的照拦；登记时间读不出来按新建处理（不确定就不放行）。豁免带三条边界：只给存量、会到期（默认 2026-09-17，可由运维显式推迟但那是一次动手的决定）、每次放行都落事件且临近到期升 error。**到期即欠条到账**：届时存量库同样启动不了，必须在此之前完成 E17 的认证迁移 |
| E40 | 中 | 2026-08-18 | 数据工作台直接拿台账里的 env 拼命令，不解析 `${...}` 模板占位，于是用户名被当成字面量传进去 | 服务的 env 里存的是模板（compose 导入常见） | **已修** | 实例：mytapd 的 mysql 台账里 `MYSQL_USER` 是 `${CDS_MYSQL_USER}`，工作台查询报 `Access denied for user '${CDS...`。容器本身没问题——启动时会把模板解析成真值，所以备份（走容器内展开）是通的、数据也完好，只有工作台这条路把占位符当账号用。与容器重建无关：台账里存的就是模板，重启前后一样。改法（已落地）：工作台拼命令前走与启动同一套模板解析。判据有个坑——解析器对解不出来的模板返回**空字符串**而不是留占位符，所以不能看「还有没有 ${...}」，要看「原本是模板、解析完却空了」，否则用户名会悄悄变空再回落成 root，等于静默换个账号连库 |
| E41 | **高** | 2026-08-18 | 手工下载对 mysql 掉进兜底的 `tar -C /data`（数据其实在 /var/lib/mysql），**回 200 却只有 22 字节的空壳**；恢复端点则根本没有 mysql 分支 | 点「下载备份」或想恢复一个 mysql | **已修** | 两个缺口合起来等于「mysql 既没有可信备份、也没有恢复入口」，而它看起来是成功的。当天想给一个 170MB、303 张表的 mysql 补数据卷再重建，正因此被迫中止。更早还被我当成「数据完好」的证据写进过看板——用一个坏掉的判据证明了一件碰巧为真的事。改法：下载走与周期备份同一段 mysqldump（流式压缩、两端退出码都保住），失败不再伪装成功；恢复补 mysql 分支，大 dump 走宿主暂存 + docker cp 而不是 stdin 字符串（170MB 塞进字符串会顶爆进程），恢复前先存一份当前状态、存不下就中止——没有退路的恢复不该开始 |
| E42 | **高** | 2026-08-18 | mysql 恢复用裸管道 `gunzip -c f | mysql -uroot` 加 `code=$?`，读到的是**管道最后一环**的退出码：上游解压失败、下游 mysql 收到零字节正常退出 0，接口回 `restored: true` | 恢复任何一个 mysql | **已修** | 实测：恢复返回成功、耗时 4 秒，库里一张用户表都没有（`information_schema.tables` 按 schema 分组后没有任何用户库）。同一个坑在**导出**侧早就踩过并在注释里写清楚了，恢复侧却又裸写了一遍——判据分裂成两份、只修了一份。改法：两侧共用同一套 fd 退出码回传写法，任一环非零整条失败；灌库前先 `gunzip -t` 验完整性，空文件/截断文件在动库之前出局；上传 0 字节直接 400；响应带上收到字节数与恢复前后表数，让「已恢复」这句话带可核对的数字。教训是响应里只有 `restored: true` 时，真成功和假成功长得一模一样 |
| E43 | **高** | 2026-08-18 | 恢复接口的上传 body 在到达路由之前就被 HTTP 日志中间件读光了：中间件挂 `req.on('data')` 把请求流切进 flowing 模式，路由跨过几次 await 才 `req.pipe()`，落盘 0 字节 | 任何「先 await、后读原始请求体」的路由（恢复、上传类） | **已修** | 这是 E42 的另一半，也是它的真正上游：管道退出码修完后拿 113 字节的合法 gz 再试，仍然什么都没落地。同一个 tick 里挂上的消费者（路由自带的 json 解析器）不受影响，所以几乎所有接口毫无异样——只有「跨过 await 才读原始流」这一类会静默丢 body。改法：恢复路由进函数第一句 `req.pause()`（必须在任何 await 之前），pipe 时自动 resume。守卫用真 express + 真 HTTP 请求复现时序，并断言 pause 的位置排在第一次 await 之前——挪到后面等于没修。同类横扫：forwarder 的 `proxy-handler.ts` 有同样的 `req.on('data')` 写法，但它到 `req.pipe(upstream)` 之间**一个 await 都没有**（同 tick 挂上消费者不丢数据），因此不受影响——经预览域名的上传是好的。判据不是「有没有挂 data 监听」，而是「挂了之后到读流之间跨没跨 await」 |
| E44 | **高** | 2026-08-18 | 离机（R2）上传失败时，那份**已经通过 gzip -t 校验的本地副本会被一起删掉**，于是离机一断，本地周期备份就整体停摆 | R2 凭据失效 / 未配置 R2 的部署 | **已修（2026-08-19，用户决定保留）** | 实测：R2 从某刻起 401，此后每一轮 12 个目标都走「导出成功 → 校验通过 → 上传 401 → 删掉本地文件」，本地 auto 备份停了半天。用户裁定：**失败要留本地，但要避免一直失败重试导致更彻底的问题**。按此实现三条：① 离机失败不再 throw，本地照常转正并纳入保留策略；② 仍不算成功（`ok=false` + `localOnly=true`，健康状态与 coverageComplete 不刷新），摘要把「仅本地副本」与「彻底失败」分开报，避免把「还有救」说成「什么都没有」；③ **止损**：同一轮内离机连续失败达 `OFFSITE_ROUND_FAILURE_THRESHOLD`（2）即判定该路不通，本轮剩余目标跳过上传只留本地，成功一次归零、跨轮不惩罚（离机恢复可自愈）。写满根盘的上界仍由既有保留策略（份数 7 / 天数 14）与每轮磁盘闸承担 |
| E45 | 中 | 2026-08-18 | mysqldump 写死 `-uroot`，而 `cloudbridge-db` 是用 `MYSQL_RANDOM_ROOT_PASSWORD` 起的——root 口令由镜像随机生成、只打进首次初始化日志，**谁都没有**，于是每轮备份 `Access denied` | 任何用随机 root 口令起的 mysql 容器 | **已修** | 我一开始把它记成「凭据不对，等用户给口令」，是错的：不存在可给的口令。真因是判据把「root 一定有口令」当前提（形状 1）。而这类容器带着 `MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DATABASE`，那个账号对自己那个库有全部权限。改法：容器内按能力分档，有 root 口令走 `--all-databases`，否则回落应用账号 `--databases <db>`，两样都没有才退 78 并说清缺哪几个变量；恢复侧同步，且 `FLUSH PRIVILEGES` 只在 root 档执行（应用账号没有 RELOAD 权限，强来会让整条恢复失败）。**已知边界**：应用账号档只覆盖它那一个库，不含 `mysql` 系统库与其它库——「备了」和「备全了」是两件事，脚本用 `CDS_MYSQL_SCOPE_LABEL` 把档位标出来。**第二层**：光换账号还不够——mysqldump 8.0 默认要读 `INFORMATION_SCHEMA.FILES` 导表空间，需要**全局** PROCESS 权限，而这类账号实测只有 `GRANT ALL ON <db>.*` + `GRANT USAGE ON *.*`，于是第一版修完仍然只产出 20 字节空 gzip；应用账号档补 `--no-tablespaces` 才通（root 档不加，保持四个在用容器命令逐字不变）。**已验证**：修后实拉 `cloudbridge-db` 备份 8,784 字节、`gzip -t` 过、10 张 CREATE TABLE（与 SQL 数出来的表数一致）、库 `webhook_platform`、有 Dump completed 结尾 |
| E29 | **高** | 2026-08-17 | runbook 的 MySQL 段逐条 host 分开执行，存在绕不开的顺序死结 | root 同时有 `localhost` 与 `%` 两条记录 | **已修** | 先改 localhost 则后续命令的旧口令立即失效；先改 % 则紧接着走 socket 的验证仍用未改的 localhost 账号。改法：用旧口令开一个会话把所有 host 一次改完，验证拆成本地 socket 与 TCP 两条分别做——这已是同一段第三轮返工，所以改的是形状（原子会话）而不是再出一版命令变体 |
| E49 | **高** | 2026-08-21 | memcached / kafka / nats 三个预设**从创建起就没有认证**，而认证门禁 `assertInfraAuthenticationConfigured` 对这三类**静默放行**（落到函数末尾的 `configured = true` 默认值） | 用这三个预设建服务；叠加端口公网暴露即裸奔 | **代码已改，未在真容器验证** | 门禁的缺口比预设本身更值得记：它看起来管着所有数据服务，实际有三个类型从来没被判过，而缺口不发一声（形状 1，判据太窄且沉默）。三处同批改：预设补认证、门禁补判据、暴露面自检把硬编码的 `return false`（目录补上后它就从保守判定变成谎报）换成读真实配置。各自的机制：memcached 用 `-Y` ASCII 认证文件（SASL 要在容器里装 cyrus-sasl，alpine 没有，等于换镜像）；kafka 客户端监听器改 SASL_PLAINTEXT + PLAIN，**三处必须同时改**（监听器、协议映射、自我广播地址——广播地址还写着 PLAINTEXT:// 的话客户端拿到的重定向仍是明文，SASL 等于没开，判据也盯着这一条）；nats 覆盖 entrypoint 成 sh，口令在容器内展开后再 exec 回二进制（它的 ENTRYPOINT 是二进制本身，没有 shell，直接写 `--pass <明文>` 会把口令摆进宿主 ps）。顺带给 catalog 补了 `entrypoint` 字段并接到 InfraService。**已知边界**：① memcached 的 ASCII 认证要求客户端支持这套握手，只实现 SASL 二进制认证的客户端连不上——账号口令已一并注入项目环境变量，接不上的只能换库或换镜像；② kafka 的 JAAS 值一律不带双引号，因为 CDS 拼 `docker run` 时 env 走 `-e "K=V"` 且不转义值里的 `"`（这条本身是个潜在缺陷，见 E50）；③ nats 覆盖 entrypoint 后镜像默认的 nats-server.conf 不再加载（那份只设默认值）。④ 真容器测试自己也有个洞并已修：只在 daemon 不可用时打印跳过原因，**镜像拉不到那一档静默跳过**——首轮实测就撞上，输出是干净的 `3 skipped`、一句原因没有，正是「静默空跑的绿灯比没有测试更糟」。现在每个镜像各判一次、各自出声。⑤ **compose 这条路只补到了 nats 与 kafka**：cdscli 的模板表与两个示例工程（demo-events-nats / demo-stream-kafka）已同批改成带认证，memcached 没改——它的认证要先在容器里写一个 `user:pass` 文件，而 cdscli 的 `service_command` 是个会按空白切词的字符串、文本渲染器又不写 `service_labels`，`sh -c` 那套在这条路上表达不出来。后果是 **cdscli 脚手架生成的 memcached 会被门禁拒绝启动**（报错明确），要么手工给它加 `cds.entrypoint: sh` + 列表形态的 command，要么改用后端预设。根治要给 cdscli 的模板表加列表形态的命令字段并让文本渲染器输出 labels。⑤ compose 这条路的口令**进容器 argv**（`--pass ${CDS_NATS_PASSWORD}` 解析后是明文），沿用 cdscli 里 redis 早就有的取舍；后端预设那条路没有这个问题。**真容器实测（2026-08-21，外部智能体在有 docker 的机器上跑）**：memcached 通过；**nats 与 kafka 各暴露一个源码扫描看不出来的真 bug，已修**。① nats：`sh -c` 包一层再 `exec ... --pass "$NATS_PASSWORD"` 只挡住了宿主那一侧，exec 之后展开的明文就是 nats-server 自己的 argv，容器里 `/proc/1/cmdline` 一读就有、宿主 `ps` 同样看得见。redis 同样写法没事是因为**它自己改写 argv**（E34），我把一个特例当成了通则。改法：容器内写一份 `chmod 600` 的 authorization 配置再 `-c` 加载，argv 里只剩路径——与 memcached 的 `-Y` 同一套（那一条实测是过的）。② kafka：监听器名也叫 `SASL_PLAINTEXT`，于是 JAAS 那条 env 得叫 `KAFKA_LISTENER_NAME_SASL_PLAINTEXT_..._SASL_JAAS_CONFIG`；镜像把下划线**全部**转成点，算出来的属性名少了监听器名里那个下划线，configure 脚本在 SASL 分支 `!1: unbound variable` 退出，**容器根本起不来**。改法：监听器改名 `CLIENT`（名字与协议解耦，不带下划线）。③ 顺带修掉两处判据缺陷：kafka 的判据原来看「广播地址是不是 PLAINTEXT:// 开头」——那读的是**名字**，改名叫 CLIENT 而协议仍是明文就能骗过它（形状 6）；现在顺着 security.protocol.map 解析出生效协议。nats 的新判据一度写成 `hasFlagValue('-c')`，而这些命令外面都套着 `sh -c`，等于恒真——写测试时当场撞上，改成必须是 nats-server 自己被带着 `-c` 拉起来、且同一条命令构造过 authorization 块。三处都补了会红的单测（红绿闭环各只红对应那一条）。**仍未验证**：nats 与 kafka 的修复**还没在真容器上重跑过**，要再跑一轮 `pnpm vitest run tests/services/infra-auth-presets.docker.test.ts` 才算完 |
| E50 | 中 | 2026-08-21 | 拼 `docker run` 时 env 走 `-e "K=V"`，**不转义值里的双引号**；值里出现 `"` 会当场截断那段 shell 引用 | 任何 env 值含双引号（用户自填的 customEnv、需要 JAAS 之类结构化配置的预设） | open | 这一轮撞上：kafka 的 `sasl.jaas.config` 按官方文档写法要给 username / password 加双引号，那样容器根本起不来。绕过办法是不加引号（账号 `app`、口令是 hex，JAAS 不带引号也解析得了），但这只是躲开，没修根因。根治要把 env 值按 shell 规则转义（或改用 `--env-file`）。在那之前，任何值含 `"` 的 env 都是雷 |
| E48 | **高** | 2026-08-21 | postgres 是一等预设，却**完全不在备份范围里**：判据只认 mongo/redis/mysql，手工下载又掉进兜底 `tar -C /data`（数据其实在 /var/lib/postgresql/data） | 任何 postgres 实例 | **已修** | 三处缺口一起：周期备份把它记进「暂不支持的类型」（整轮健康长期红着——**红着不等于备着**，磁盘上一份都没有）、手工下载回 200 但只有空壳（与 E41 的 mysql 同一形状）、恢复端点直接 400。根因是同一件事被判了三遍：周期备份 `backupKindOf`、下载端点 `detectKind`、暴露面自检 `detectInfraKind`，三份覆盖的类型各不相同，于是「自检认得出、备份跳过」（形状 3）。改法：判据收敛成一份（复用 `detectInfraKind`，还能用服务 id / 容器名兜底认出私有仓库镜像）；补 pg_dump 导出、psql 恢复、数表取证，与 mysql 同一套 fd3/fd4 退出码写法。**postgres 独有的坑**：psql 默认遇错继续、跑完照样 exit 0——连管道退出码都拦不住的假成功，必须 `-v ON_ERROR_STOP=1`。执行层改成穷尽分支 + `never`，新增备份类型忘了接线时由编译器当场报错（防形状 2）。**已知边界**：只导出 `POSTGRES_DB` 那**一个**库，不含角色、权限与同实例其它库——用 `pg_dump` 而不是 `pg_dumpall` 是有意的，后者的产物灌不回一个已存在的集群（CREATE ROLE 撞已有角色，加 --clean 又要 DROP 掉当前连接的角色），「导得出、灌不回」等于没有备份。其它库由导出脚本当场写进 stderr（`cds-backup-scope:`）并进到一轮结论那句话里，不是悄悄的取舍。**未验证**：脚本用假 psql/pg_dump 跑过退出码矩阵，但**没有对真 postgres 容器跑过一轮导出 + 恢复**（本机无 docker daemon）。真容器用例已写好（起库塞数据 → 导出 → gzip -t → 清库 → 灌回 → 比对行数，外加「有语法错的 dump 必须失败」这一条守 ON_ERROR_STOP、「不是 gz 就退 65 且不动库」、范围提示、连不上退 78）；没有 docker 时整体跳过并打印「本次未验证」。按 G4「没演练过的备份不算备份」，在有 docker 的机器上跑一次 `pnpm vitest run tests/services/infra-backup-postgres.docker.test.ts` 才算完 |
| E52 | **高** | 2026-08-25 | **线上两台 nacos 在跑、零备份，而且系统连「这是什么」都认不出来**：`detectInfraKind` 里没有 nacos 这个类型、8848 也不在端口兜底表里，于是它落进 `other`——安全面判不了它有没有认证，备份面只能说「认不出的服务」 | 任何 nacos 实例 | **代码已改，未在真容器验证** | 发现方式值得记：这条不是读代码读出来的，是去查线上真实在跑的 19 个数据服务时撞出来的——8 个项目里 nacos 有 2 台，仅次于 redis(6) 和 mysql(5)，而我此前一直以为「预设清单里没有 nacos就等于没人用」。**预设清单不等于线上实际**，别人是用 compose 导进来的。里面存的是那两个项目的全部配置，丢了两个项目起不来。改法：`detectInfraKind` 补 nacos（镜像名 + 8848/9848 端口兜底）、暴露面自检补认证判据（判的是 `NACOS_AUTH_ENABLE` 真的打开了，不是「env 里有没有口令」——口令配了开关没开等于没配，形状 6）、周期备份接上配置导出。**为什么走 HTTP 导出不拷数据目录**：nacos 的配置可能落内嵌 Derby 也可能落外部 MySQL，同一个镜像两种形态、容器外看不出是哪种，而配置导出接口对两种形态给同一份产物；热拷一个正在写的 Derby 目录拿到的东西可能根本打不开，那是「导得出、灌不回」。**已知边界**：① 导出的是配置，**不含服务注册列表**（各实例自己上报、重启会重来，本来就不该备）**与用户/角色/权限**（在库里，配置导出接口不含）——每轮由脚本往 stderr 报一行；② 导入是 `policy=OVERWRITE` 的**合并**，备份之后新建的配置不会被删掉，能救「配置被删/被改坏了」，救不了「配置被加错了」，nacos 没给「清空后导入」这个语义；③ 导入不会替你建命名空间，备份里有而目标上没有的那一包会被拒绝、整轮失败；④ 鉴权开着且容器里只有 wget 时**拒绝备份而不是把口令摆进命令行**（nats 那次的教训），此时退 78；⑤ 认证判据只认 `NACOS_AUTH_*` 那组变量，用其它方式（自定义配置文件、外部网关）做的鉴权会被误报成无认证。**没有把 nacos 加进认证门禁**：那会让线上这两台在 2026-09-17 豁免到期后直接起不来，属于另一个决定，不在本次范围。**未验证**：脚本用假 curl 跑过全部控制流与失败模式（32 条，含三次红绿闭环），但**没有对真 nacos 容器跑过一轮导出 + 恢复**（本机无 docker daemon）。真容器用例已写好（起服务 → 写配置 → 导出 → 解包核对 zip 里有那个 dataId → 删掉 → 灌回 → 比对内容一致，外加「OVERWRITE 真的覆盖而不是跳过同名」「不是 gz 退 65 且不动配置」「连不上退 78」）；没有 docker 时整体跳过并打印「本次未验证」。**镜像里到底有没有 curl 只有真容器能回答**——没有的话这条路根本走不通，脚本会退 78 说清楚，但那和「能备」是两回事。跑一次 `pnpm vitest run tests/services/infra-backup-nacos.docker.test.ts` 才算完 |
| E53 | 中 | 2026-08-25 | **rabbitmq 与 nacos 的真容器用例在 GitHub runner 上跑不起来**，原因都在镜像与 runner 的环境层，不在本仓库代码 | 想靠 CI 验这两条备份链路时 | **已显式关闭，改为按需开** | 首轮 CI 四个重型容器并行冷启动全挂，加了跨进程互斥与失败留证之后拿到了真原因：rabbitmq 是 `Error when reading /var/lib/rabbitmq/.erlang.cookie: eacces`（容器 exitCode=1，镜像在该 runner 上的权限怪癖）；nacos 是镜像里那个老 JDK 解析不了 runner 的 cgroup v2，`CgroupV2Subsystem.getInstance` 抛空指针、Spring 起不来。**两者都与备份脚本无关**，继续在 CI 里追只会把「验备份脚本」变成「修别人镜像在某台机器上的启动问题」，而且修好了也不会让脚本更可信一分。所以这两个文件改成 `CDS_DOCKER_TESTS=1` 才跑，跳过时把上面这个原因原样打印。postgres 与 auth-presets（memcached/kafka/nats）**留在 CI 里继续跑**——它们首轮的失败是并行抢资源加我自己的探活 bug，互斥与探活修好之后已经不再报错。**这一条的含义是「没测」不是「测过了」**：rabbitmq definitions 的导出与灌回、nacos 配置的导出与灌回，至今没有在真容器上跑通过一次。在能起得来这两个容器的机器上跑一次 `CDS_DOCKER_TESTS=1 pnpm vitest run tests/services/infra-backup-rabbitmq.docker.test.ts tests/services/infra-backup-nacos.docker.test.ts` 才算完 |
| E51 | 中 | 2026-08-23 | 「备不了」的类型共用一句「暂不支持自动备份的类型」，且**一律**拖垮整轮健康——于是任何项目只要跑着一个 memcached 或 nats，备份健康位从上线那天起就永远是红的；同时 rabbitmq 明明有标准的一致性导出手段，却和它们一起躺在这句话里 | 跑着 memcached / nats / rabbitmq / minio / kafka 的项目 | **代码已改，rabbitmq 未在真容器验证** | 那一句话把三件完全不同的事说成了同一件：memcached 压根没有持久化功能（没东西可丢）、MinIO 里有真实文件但要的是桶到桶复制、SQL Server 有标准 `BACKUP DATABASE` 只是还没接。后果不只是措辞难看——一个永远红着的健康位没有人会当真，红了几个月和绿了几个月对磁盘上的份数没有任何区别，这正是 E48（postgres）被埋三个月的同一个形状。改法：跳过原因按桶分类（已覆盖 / 要另一套手段 / 有手段还没接 / 没有持久状态 / 认不出），只有真的有东西可丢才算缺口，且当场说清缺的是哪一套手段。rabbitmq 同批接进来：`rabbitmqctl export_definitions` 导出、`import_definitions` 灌回、队列数取证，与 mysql / postgres 同一套 fd3/fd4 退出码写法；下载与恢复端点的「三段脚本 + 扩展名」从两处三元链收敛成一张表。**已知边界**：① definitions **不含队列里的消息**，RabbitMQ 没有一致性消息快照命令——导出脚本每轮往 stderr 报一行「默认 vhost 当前积压 N 条不会被带走」，不做成藏在文档里的免责声明；② `import_definitions` 是**合并**不是替换，备份之后新建的队列/交换机/用户不会被删掉，这条路能救「配置被删了」，救不了「配置被加错了」，RabbitMQ 就没给替换语义；③ 队列数取证只覆盖默认 vhost，而 definitions 是跨 vhost 的——那个数字是证人不是账本；④ nats 判「有没有持久状态」看的是 JetStream 开关（命令行 `-js`/`--jetstream`、配置块、`JS_ENABLED`），开了就重新算缺口；写法之外的开法会被漏判。**未验证**：rabbitmq 的脚本没有对真容器跑过一轮导出 + 恢复（本机无 docker daemon）。真容器用例已写好（起节点 → 声明队列与 vhost → 导出 → `JSON.parse` 产物 → 删掉 → 灌回 → 核对队列还在，外加「不是 gz 退 65 且不动节点」「坏 definitions 必须失败」「连不上退 78」）；没有 docker 时整体跳过并打印「本次未验证」。按 G4「没演练过的备份不算备份」，在有 docker 的机器上跑一次 `pnpm vitest run tests/services/infra-backup-rabbitmq.docker.test.ts` 才算完 |
| E54 | 中 | 2026-08-25 | **nacos 认不出认证 → 暴露面判 critical，但创建门禁照放行**：`assertInfraAuthenticationConfigured` 的 `configured` 默认是 `true`，nacos 没有分支就一路默认放行，于是同一台库两处判定互相打架——自检天天报「无认证」，创建流程却允许再造一台 | 新建 / 导入 nacos 的项目 | **故意没做，等一个决定** | Codex review 第三轮 P1 提的，事实成立。没有当场修是因为它不是一行判据的事：`assertInfraAuthenticationConfigured` 同时被创建（硬拦）和启动（走 `evaluateInfraAuthentication` 的存量豁免）调用，给它加 nacos 分支会一起带来两件事——① 新建/compose 导入一台没开 `NACOS_AUTH_ENABLE` 的 nacos 会被拒，而本仓库**没有 nacos 预设也没有扫描模板**，被拒之后产品里没有任何地方能帮用户把那四个变量配出来，等于把这一类服务的接入整个堵死；② 线上那两台存量 nacos 会挂上 2026-09-17 的豁免到期悬崖，到期即起不来。第 ② 条是停机决定，不该由一条 review 意见顺手做掉（AGENTS.md §5.5 的 B 类：建议合理但引入新产品行为）。**要做的话是三件一起**：先补一个能生成 `NACOS_AUTH_TOKEN` / `IDENTITY_KEY` / `IDENTITY_VALUE` 的 nacos 预设，再把 nacos 接进门禁，最后给线上两台排迁移窗口。**现状不是没人管**：暴露面自检与每日体检都会天天报这两台，只是拦不住新建 |
| E55 | 中 | 2026-08-26 | **一台「没有东西需要备份」的部署，备份健康位永远读不出来**：周期备份在 `plan.targets.length === 0 && coverageGaps.length === 0` 时直接 return，健康文件一次都不写；写入点自己还有第二道 `outcomes.length > 0 || allCoverageGaps.length > 0`。于是每日体检读不到那个文件，天天报 `backup.unknown`（critical，措辞是「读不到上一轮备份结果」），而事实是**这轮跑过了、只是没有东西要备** | 只跑着 memcached 和/或没开 JetStream 的 nats 的部署；以及**一台基础设施都没有的 CDS** | **故意没做，等一个决定** | Codex review 第九轮 P2 提的，事实成立，我按 AGENTS.md §5.5 判成 B 类没有当场修。**为什么不是一行的事**：`isBackupRoundHealthy` 里那句 `outcomes.length > 0` 是特意加的，防止一轮什么都没干的空转冒充健康。所以「把健康文件照写一遍」解决不了——零目标的轮次会被判成不健康，`completedAt` 仍是 null，体检照样报 unknown。要真修，得给健康契约加一个**新状态**：「本轮无需备份」（与「备成功了」「备漏了」并列），并让每日体检认这个状态。那是新语义类别，正是 §5.5 熔断点名的那种扩张，而本 PR 到此已有 8 个 review 修复提交、diff 6600+ 行 / 57 文件。**要做的话是三件一起**：① 健康文件加 `notApplicable`（或让 `coverageComplete` 能表达「零目标且零缺口」）；② `isBackupRoundHealthy` 放行这一档，但必须同时保住原来的防线——「有目标却一个都没跑」仍要判红，两者的区别只在 `plan.targets.length`，判据要写得让这两条各自能红（红绿闭环各验一次）；③ 每日体检的 `backup.unknown` 分出「这台机器没有需要备份的东西」这一句，别让人以为备份坏了。**当前影响面有多大**：本仓库自己的部署都跑着 mongo/redis/mysql/nacos，`targets.length > 0`，健康文件照常写，所以线上看到的备份健康位是真的。受影响的是上面那两类部署——对它们来说，这是这个模块最想治的那个病（一盏永远亮着的灯）的第三次复发 |
| E56 | 中 | 2026-08-26 | **nacos 登录的表单体没有做 URL 编码**：`printf 'username=%s&password=%s'` 直接拼，口令里出现 `&` `+` `=` `%` 就会被 nacos 解析成别的值，登录失败 → 该实例的备份 / 计数 / 恢复全部走不通 | 开了鉴权、且口令含表单保留字符的 nacos | **故意没做，与 E52/E53 的真容器验证一起做** | Codex review 第十轮 P1，事实成立。**没有当场改是因为最直观的改法会把口令送回 argv**：`--data-urlencode "password=$P"` 是命令行参数，容器里 `ps` 一读就有——那正是 E49 里 nats 栽过的跟头（当时也是「看起来没问题」的写法，真容器一跑才发现 `/proc/1/cmdline` 里是明文）。安全的写法是把口令写进一个 `chmod 600` 的临时文件再 `--data-urlencode "password@$file"`，外加退出时清理；这是一段要小心写、且**必须对真 nacos 验一遍**的代码，而 E52/E53 已经欠着「从没对真容器跑过一轮 nacos 导出 + 恢复」。两件事一起做才有意义：单改编码而不验证，等于把一个没验过的功能改成另一个没验过的功能。**现状不是静默失败**：登录拿不到 token 时脚本退 78 并打印用户名，看得出是登录这一步挂了 |
| E57 | 中 | 2026-08-26 | **每日体检的「平台自身存储」只数了两个 Mongo 消费方，实际有四个**：`httpLogStoreFromEnv` 与 `serverEventLogStoreFromEnv` 只看 `CDS_MONGO_URI` 有没有值（外加各自的关闭开关），与 `CDS_STORAGE_MODE` / `CDS_AUTH_BACKEND` 无关。于是 `CDS_STORAGE_MODE=json` + 内存鉴权 + 配了 `CDS_MONGO_URI` 的部署里，两个正在写请求日志与诊断日志的 Mongo 从体检里完全消失 | json 状态后端 + 内存鉴权 + 仍配着 CDS_MONGO_URI 的部署 | **故意没做，要一次数清楚** | Codex review 第十轮 P2，事实成立。**这已经是同一个函数第三次被 review 补消费方**（最早只有状态库 → 第四轮补鉴权库 → 这次是两个日志库），说明问题不在「漏了哪一个」，而在判据的形状：它**逐个枚举消费方**，而枚举天生会漏，漏了还不出声（形状 1）。再打第三个补丁不会让人更有把握下次不漏。要做的是一次性把「CDS 里谁会开 Mongo 连接」数清楚——`grep -rn "new MongoClient\|MongoClient(" cds/src` 起手，把每一处的启用条件列出来，然后要么全部接进判据、要么改成「只要 CDS_MONGO_URI 有值且不是全部消费方都被显式关掉，就报」，并补一条守卫：**新增一个 Mongo 消费方而没有登记进判据时，测试要红**（否则第四次仍然会漏）。**当前影响面**：标准安装是 mongo-split，状态库已在判据里、报得出来；受影响的只有上面那种混合配置 |
| E58 | 低 | 2026-08-26 | **备份覆盖缺口只带服务 id，不带项目**：`BackupPlan.skipped`、运行时范围缺口、健康文件与每日体检的渲染全程只有 `id`，而 infra id 只在项目内唯一。同一台机器上两个项目各有一个 `kafka` / `postgres` 时，缺口清单出现两条一模一样的条目，运维看不出该去补哪个项目 | 一台 CDS 上多个项目有同名服务，且其中某个类型备不了 | **故意没做** | Codex review 第十轮 P2，事实成立，与我这轮修过的体检结论加项目标识（svcRef）是同一类问题的另一处。没有一起改是因为它要把 `projectId` 一路穿过四层——计划的 skipped、运行时范围缺口、**持久化的健康文件**、以及渲染——健康文件的形状变了就要考虑存量文件怎么读（旧文件没有这个字段），那是新的数据契约，不是加个字段。**严重度低于另外两条**：缺口条目重复只是难读，不会把「没备份」说成「备了」，健康位该红还是红 |
| E59 | 低 | 2026-08-26 | **暴露面自检在启动时偶发失败（例如 docker 一时不可用）会让每日体检整整停摆一天**：体检拿不到暴露面报告就直接返回，而暴露面每小时重试、体检的定时器要等 24 小时。于是备份新鲜度、平台存储凭据、恢复演练、豁免倒计时**全部**缺席一天——它们其实都不依赖那份报告 | 启动时暴露面自检首轮失败 | **故意没做** | Codex review 第十一轮 P2，事实成立。要做的是：缺前提时安排一次短重试（而不是把这次跳过当成「今天已经体检过了」），或者更彻底——把**不依赖暴露面报告**的那几档先跑掉，只把基础设施那两档标成「本轮未检查」。后者更对，但它要给体检结论引入「部分完成」这个新状态。与本轮其余各条同批熔断（§5.5）。**严重度低**：只在启动首轮失败时发生，且下一次容器重启就会自愈 |
| E60 | **高** | 2026-08-26 | **手动下载走的是「成功」路径，导出脚本报的范围限制一个字都不给调用方**：postgres 只导了 `POSTGRES_DB` 那一个库、rabbitmq 的队列积压不会被带走、nacos 不含用户与权限——这些都由脚本写到 stderr，而 `code === 0` 那条分支把 stderr 整个丢掉，只把字节流推给浏览器。用户拿到一份看着完整的文件，**要到恢复那一刻才发现少了东西** | 手动下载 postgres（有多个库）/ rabbitmq（有积压）/ nacos | **故意没做** | Codex review P1，事实成立，且后果是这批债务里最难受的一类：不是「灯亮着没人看」，是「灯根本没有」。**为什么不是一行的事**：这是个**流式二进制响应**，body 已经在推字节，塞不进 JSON。可选的路子都要新机制——响应头必须在流开始前写，而范围限制要等 dump 跑完才知道（只能用 trailer，浏览器基本不认）；或者改成「先落盘再给下载链接」，那是把一个同步端点改成两步异步；或者下载前先跑一次探测把范围算出来，等于把每次下载的耗时翻倍。三条都是新语义。**在做出来之前，缓解只能靠人**：周期备份那条路径的范围限制是**有**去处的（进 `backupScopeGaps` → 健康文件 → 每日体检），所以「想知道自己这台漏了什么」应当看每日体检，而不是看下载有没有成功。这句话必须写进下载入口的说明里——那也是本条要补的一部分 |
| E61 | 中 | 2026-08-26 | **只要有一个覆盖缺口，每日体检就同时说两句自相矛盾的话**：写入端在 `coverageComplete` 为假时把 `completedAt` 写成 null，体检读到 null 就报 critical 的 `backup.unknown`「读不到上一轮备份结果，不确定备份到底有没有在跑」，同时又报 warn 的 `backup.coverage-gaps` 逐个列出这一轮的真实缺口——健康文件明明证明刚跑过一轮 | 任何有覆盖缺口的部署（跑着一个 minio 或 kafka 就够了） | **故意没做** | Codex review P2，事实成立。**这是 E55 的同族、且触发面更大**：E55 说的是「零目标」那一档，本条说的是「跑了但没备全」那一档，而后者是常态——只要有一台 minio 在跑，健康位就永久卡在 critical unknown。这正是这个模块最想治的那个病（一盏永远亮着的灯）的第四次复发，`platform-daily-health.ts` 自己的注释里还写着「不能自己先犯」。**修法与 E55 是同一件事**，应当一起做：健康契约要能分开表达「这一轮跑到了什么时候」（attempt）与「这一轮备全了没有」（complete），体检的新鲜度判据看前者、覆盖判据看后者。单独给本条打补丁会和 E55 的补丁打架 |
| E62 | 低 | 2026-08-26 | **体检读健康文件取「第一个读得到的候选目录」，而写入端取「第一个写得进去的」**：早先那个候选若还留着一份旧文件、但已经不可写，自动备份会跳过它写到后面的目录，体检却停在那份旧文件上——报出来的完成时间和缺口都是过期的 | 早先的候选目录可读不可写、且留着历史健康文件 | **故意没做** | Codex review P2，事实成立。判据形状是「读的不是生效的那一个」（predicate-and-wiring-discipline 形状 6）。**正解是把目录选择收敛成唯一一处**：写入端把实际选中的目录记下来，读取端照着读；或者退一步，读全部候选取 `completedAt` 最新的那份。前者更对但要动写入端的落盘契约，与 E61 那次改动碰同一块，**三条应当一起做**。**概率低**：要凑齐「可读 + 不可写 + 有旧文件」三个条件 （**2026-08-27 挂在这里的真机证据后来查明不属于本条，2026-08-28 更正**：当时观察到「体检报读不到、而备份文件确实在写」，归因写成了目录选择，实际根因是落盘那一行 `completedAt: coverageComplete ? completedAt : null`——只要有目标失败，完成时间就被抹空。线上长期有两个目标失败（redis / cds-state-mongo），于是每轮都抹。该根因已修：完成时间只回答「跑没跑」，备全与否交给 coverageGaps 与新增的 failedTargets。同时更正的还有「rabbitmq-mdimp 被列进没有被周期备份覆盖」——那不是矛盾，它备份成功了、只是导出脚本自报只覆盖到一部分，是体检的措辞把两种缺口说成了一种，已改。**本条剩下的仍然是原始的目录选择问题**，仍未修、仍属低概率。） |
| E63 | **高** | 2026-08-26 | **postgres 恢复没有包在事务里，导入中途失败会把库留在改了一半的状态**：`psql -v ON_ERROR_STOP=1` 只保证「出错就停」，不保证「停下来之前做过的 DROP / CREATE 会撤销」。端点如实回「恢复失败」，而库已经被这份没导完的 dump 改过了 | 上传的 dump 中途有一条语句失败（版本不兼容、扩展缺失、权限不足都会） | **故意没做** | Codex review P1，事实成立。**改法看着只有一个 `--single-transaction`**，但它会改变恢复语义：带 `CREATE INDEX CONCURRENTLY`、`VACUUM`、多库 `\connect` 的 dump 在单事务里跑不了，本来能恢复的会变成恢复不了。所以这一条**必须对真容器验过再上**——而 E52/E53 已经欠着「从没对真容器跑过一轮 postgres 之外的导出+恢复」。要做就连着把真容器用例一起补：正常 dump 能进、中途失败的 dump 必须让库保持原样（红绿闭环各验一次）、含 CONCURRENTLY 的 dump 给出可读的失败原因而不是静默退化 |
| E64 | **高** | 2026-08-26 | **nacos 导出不校验拿到的是不是 ZIP，一份废产物能被当成好备份存下来、还会顶掉旧的好备份**：`curl -f` / `wget` 只看 HTTP 状态，2xx 但 body 是空、是 HTML 错误页、是 JSON 报错，全都算成功。后面的 tar / gzip / 体积 / 外层 `gzip -t` 校验的是**打包**是否完整，不是**成员**是否可用，于是一路通过、上传、进保留策略，把一份真能用的老备份挤出去 | nacos 导出接口返回 2xx 但 body 不是 ZIP（鉴权半通、命名空间为空、网关插一脚） | **故意没做** | Codex review P1，事实成立，形状很典型：**校验的是外壳不是内容**（predicate-and-wiring-discipline 形状 6）。改法是每个命名空间的产物下载后立刻验「非空 + ZIP 魔数 `PK\x03\x04`」，任一不合格就整轮作废——这条路径自己的注释里已经写过「半份备份比没有更危险」，只是那句话管的是下载失败，没管下载成功但内容不对。**与 E52/E53 同批**：改完必须对真 nacos 验一遍，否则又是「把一个没验过的功能改成另一个没验过的功能」 |
| E65 | **高** | 2026-08-26 | **nacos 多命名空间恢复没有前置校验，后面某个命名空间失败时，前面几个已经被覆盖写掉了**：恢复是逐个命名空间循环导入，中途失败就退出，端点回一句笼统的失败——而目标上前几个命名空间的配置已经按备份覆盖过了，用户既不知道改了哪几个，也不知道怎么回去 | 备份里有多个命名空间，且目标上缺其中之一（或某个导入被拒） | **故意没做** | Codex review P1，事实成立，且它是 E64 的镜像面：**导出路径守住了「半份不如没有」，恢复路径没守**。三条改法按代价排序——① 先把所有命名空间在目标上存在性预检一遍再开始导（最便宜，挡住最常见的「目标缺命名空间」）；② 失败时把「已经改了哪几个」如实报出来，让人知道从哪儿捡（次便宜，且符合 user-readable-errors）；③ 真回滚（要先把每个命名空间导出一份再导入，代价最大）。至少要做 ①+②。同样要真容器验证 |
| E83 | 低 | 2026-08-28 | **备份缺口只有一栏，装着两种需要不同动作的东西**：「按服务类型压根备不了」（minio / kafka）和「备成功了但导出脚本自报只覆盖到一部分」（rabbitmq 只有定义没有消息、nacos 只有配置没有注册表）共用同一个清单，落盘时只留 id、丢掉 reason，体检读到的就只是一串名字 | 任何同时存在这两类缺口的部署 | **故意没做** | 2026-08-28 从体检报文自相矛盾这件事上带出来的：原文案说「N 个正在跑的服务没有被周期备份覆盖：…rabbitmq-mdimp」，而按项目查备份历史，rabbitmq-mdimp 每轮都在备。**当前处置是把话改准**（改成「备份不完整（没备到，或只备到一部分）」），报文不再自相矛盾；**没有做的是把两类分开报**——那要让缺口带上类型一路传到体检，动落盘契约，与 E61/E66/E67 碰的是同一块「一轮备份对外怎么表述」，应当一起做。代价：两类需要的动作不同（前者去补一种导出手段，后者去查为什么只备到一半），现在合成一句，读者得自己去翻备份历史才分得清 |
| E84 | 低 | 2026-08-28 | **备份面板只能看，不能当场跑一轮**：设计稿里有「立即备份一轮」按钮，实现时没有做——周期备份那段执行逻辑是 index.ts 里的一个闭包（带一把「上一轮还没跑完」的互斥锁），对外没有任何入口 | 想在改完口令后立刻验证「这回能不能备成」的人 | **故意没做** | 2026-08-28 建面板时的边界。做它要把那段执行逻辑提出来、配一个防重入的触发端点（并发闸的纪律见 concurrency-gate-discipline），属于另一件事，不塞进这个 PR。当前的替代路径：单个服务可以在分支详情里手工备份/下载；周期备份最多等 6 小时下一轮。**代价**：改完一个失败目标的凭据后，要到下一轮才知道修没修好——而面板恰恰是给这种时刻用的 |
| E85 | 低 | 2026-08-28 | **这一轮没跑的目标会从备份面板上整个消失，而它的旧备份还在页脚被数着**：容器停着时 `planInfraBackups` 记的是「容器未运行」这类**不阻塞健康**的跳过，它既不进 `objects` 也不进落盘的 `coverageGaps`；面板的目标清单只从这几个集合来，于是这台服务一行都没有，可它盘上留存的几份备份仍计入「备份文件 N 个」 | 有服务停着、但盘上还留着它旧备份的项目 | **已做（2026-08-29）** | Codex review P2（PR #1442）。事实成立，但它不是假绿灯——结论不会因此说这台服务没问题，它只是没被提起。修它有两条路：把非阻塞跳过也落进健康文件（动落盘契约 + 新增一档「这一轮没跑」的语义），或从文件名反推历史目标（新增一条推断路径）。两条都是新语义类别，按 CLAUDE.md §5.5 属 B 类，不在当前 PR 展开；与 E83（两类缺口合一栏）、E84（面板不能手动触发）碰的是同一块「一轮备份对外怎么表述」，应当一起做。代价：一台停着的服务在面板上看不见，要靠「备份文件数」对不上才察觉 **落地**：Codex 第二轮 P1 指出同一个根的另一面——上一轮之后才建的库同样从清单上消失，而且它连一份旧备份都没有，第一屏还在说一切正常。两者一起修：目标清单改成「上一轮的记录 ∪ 项目此刻的基础设施台账」，只在台账里出现的落 `not-in-last-round`（能不能备走 `backupKindOf` 同一份判据，备不了的仍归「这类还备不了」）。取并集而不是改用台账，是因为「服务已删、备份还在」也要列得出来。 |
| E66 | 中 | 2026-08-26 | **一轮备份的摘要只念 `note`，不念 `gapNote`**：postgres 有多个库、rabbitmq 有积压时，`gapNote` 会让 `allCoverageGaps` 非空并记一条 warn 事件，但运维在面板上看到的那句 `summary` 是更早由另一个 helper 拼的，只渲染 `note`。于是警告事件里写着「有数据没被保护」，摘要那一行却只说「成功 1 个」 | 任何 gapNote 非空的轮次 | **故意没做** | Codex review P2，事实成立。这是我这一轮拆 `note` / `gapNote` 时留下的接线尾巴——拆完之后 `backupScopeGaps` 与健康文件都改读 `gapNote` 了，摘要那一处没跟上（形状 2：反方向那半没接）。改法本身很小（摘要拼接把 gapNote 一起收进去），**但要和 E61 一起做**：E61 要改的正是「一轮备份对外怎么表述」这件事，两处口径必须一次对齐，否则摘要说一套、体检说另一套 |
| E67 | 中 | 2026-08-26 | **只在本地备成功、离机上传失败的那一轮，会把有效的范围缺口一起丢掉**：这种 outcome 被有意标成 `localOnly: true` + `ok: false`，而收集 `gapNote` 的条件只认完全成功的 outcome。结果是「postgres 还有几个库没备到」这种**与离机无关**的缺口，被离机失败这件事顺手盖住，健康文件里一个字都不留 | 本地导出成功、R2 缺失或上传失败，且该目标本身有范围缺口 | **故意没做** | Codex review P2，事实成立。判据把「这一轮整体成不成功」和「本地这份产物有没有覆盖全」混成了一件事——它们是两回事，一个失败不该抹掉另一个的证据（形状 1：判据比它该管的范围窄）。改法是让 `backupScopeGaps` 也接受「本地已验证」的 outcome。**与 E66 / E61 同属一次「备份轮次对外表述」的对齐**，一起做 |
| E68 | **高** | 2026-08-26 | **我这轮给 nacos 加的「按端口认出来」在备份这条路上根本用不上**：`planInfraBackups` 交给判据的 hints 只有 `{id, containerName}`，没有 `containerPort`，而端口兜底恰恰是 `detectInfraKind` 认 nacos 的那一半。于是一台 compose 导入的、镜像名是私有仓库、id 与容器名都很中性的 nacos，仍然被判成「认不出的类型」——落进 unknown 那一档 | 私有镜像 + 中性命名 + 只能靠端口认出来的服务（8848 的 nacos 是现成例子） | **故意没做** | Codex review P2，事实成立，**但严重度要往上提**：E52 记的正是「线上两台 nacos 零备份」，而我这轮声称「周期备份接上配置导出」的前提是它能被认出来。备份路径拿不到端口，等于那条修复在最需要它的那种部署上**没有接上线**——形状 2「建了一半」，而且是建在我自己刚补的那一半上。改法很小（`BackupCandidate` 加 `containerPort`，hints 一起传），**但必须连着一条守卫**：私有镜像 + 中性命名 + 8848 的候选必须被认成 nacos，否则下一个靠端口认的类型还会漏  **修正（当天）**：本条只在本 PR 内部成立——`main` 上既没有每日体检、也没有 nacos 的端口识别（`grep -c nacos infra-exposure-audit.ts` 在 main 上是 0）。所以它**不能独立出一条分支修**，也**不影响线上现状**；线上真实存在的是 E52 那条「两台 nacos 零备份」，本条是「本 PR 想解决它、但在这类部署上没解决到」。|
| E69 | **高** | 2026-08-26 | **运行时认证自检只读 `.Config.Cmd`，不读 `.Config.Entrypoint`，于是把认证参数写在 entrypoint 里的服务天天误报成裸奔**：创建门禁那一侧是把 command 与 entrypoint 合起来看的（本轮刚对齐过），运行时这一侧没跟上。两侧判据对同一台服务给出相反结论，而运行时这侧是每天发告警的那一侧 | 认证参数写在 entrypoint 里的自定义服务 | **已做（2026-08-27）** | Codex review P2，事实成立，**严重度按「假警报」提到高**：这不是漏报（漏报是危险但安静），是**天天响的假警报**——而这个模块最想治的病就是「一盏永远亮着的灯没人会看」。一条假警报会让人开始怀疑整张表，进而连真警报一起不看，那比这条本身糟得多。改法是 docker inspect 的 format 加 `{{json .Config.Entrypoint}}`、把它并进有效参数列表。**与 E68 同批**：两条都是「判据只看了两个来源里的一个」，同一次改动里一起对齐，并各补一条守卫  **修正（当天）**：同 E68——`main` 上的创建门禁并不合并 command 与 entrypoint，两侧结论相反这件事是本 PR 引入新门禁之后才成立的。所以它**不能独立出一条分支修**，也**不影响线上现状**；本 PR 未合并前，那条会误报的每日告警根本还不存在。 **落地**：docker inspect 的 format 加上 `{{json .Config.Entrypoint}}`，与 Cmd 合并成一条有效参数列表。**这一条从「可以缓」变成「必须同批」**：E81 把认证判据收敛成只认启动参数之后，采集侧少采半条命令就直接变成假警报，判据与它读的输入必须一起改。配了接线守卫（采下来还要真的并进 args，只取不用会红）。 |
| E70 | 中 | 2026-08-26 | **nacos 的 accessToken 进了 curl 的命令行**：`CDS_NACOS_AUTH="&accessToken=$TOKEN"` 被拼进每一个 URL，而 URL 是 curl 的位置参数——备份、恢复、计数三条路径全程在宿主的进程表里明文可读。能读 docker 宿主 `ps` 的人可以在 token 过期前拿去用 | 开了鉴权的 nacos，且宿主上有能读进程表的其它进程/用户 | **故意没做** | Codex review P2，事实成立。**这条的分量在于它是自己刚学过的教训**：E49 记的正是「nats 口令进 argv」，本 PR 为此专门把 nacos 的**口令**挪出了命令行（走 `--data-binary @-` 从 stdin 喂），却把换来的 **token** 又摆回了 argv——把前门锁上、后门留着。改法与 E56 是同一处：用受保护的 curl config （`--config` 读一个 chmod 600 的临时文件，URL 与 header 都写在里面）统一走 stdin/文件，别再往命令行拼。**与 E56 / E52 / E53 同批**：E56 要改 nacos 登录的表单编码、E52/E53 欠着真容器验证，这几件是同一段脚本上的同一次改动，分开做等于把一段没验过的代码改成另一段没验过的代码。**严重度不按「高」**：token 有过期时间，且要读宿主进程表本身已意味着相当的访问权——但它与本 PR 自己立的标准不一致，该修 |
| E71 | 低 | 2026-08-26 | **恢复端点按住上传流之后，只有前两个提前返回放开了它**：`req.pause()` 之后配了一个 `bail()` 负责 resume，但只挂在「找不到服务」「服务未运行」两处；redis 那条路上「解析不出 RDB 路径」「AOF 探测失败」「开着 AOF 不给恢复」以及「不认识的类型」几处都是直接 return。客户端还在发那几十 MB，服务端既不读也不结束，上传方看到的是卡住而不是那条 4xx | 上传一份大 dump 恢复 redis，且撞上上面那几种拒绝 | **故意没做** | Codex review P2，事实成立。`bail()` 这个函数和它上面那句注释（「按住之后，任何提前返回都要把流放开」）本身就是为这件事写的——**写对了规矩，只挂了两处**，形状 2「建了一半」。改法是让每一条 pre-upload 的返回都走同一个出口（包一层 helper，或把校验段整体挪进一个 `try/finally`），并补一条守卫：这个 handler 里 `req.pause()` 之后的每个 `return` 都必须经过 resume/destroy。**严重度低**：不丢数据也不写错数据，后果是上传方卡住直到超时；且 keep-alive 连接最终会被回收 |
| E72 | 中 | 2026-08-27 | **JetStream 写在挂载进去的 `nats.conf` 里时，判据看不见它**：`natsHasJetStream` 只读 command / entrypoint / env 的文本，`nats-server -c /etc/nats.conf` 这种启动方式下配置内容不在这三处，于是一台真开着 JetStream 的 nats 被判成「没有持久状态」——不进缺口、不挡健康位，整轮备份报健康而它的流与消费者位点没有任何副本 | 把 JetStream 开关写在挂载配置文件里的自定义 nats | **故意没做** | Codex review P1，事实成立。**不改的理由不是它不成立，是两种改法都不该在这个 PR 里做**。改法一「保守地把带 `-c` 的 nats 一律当有持久状态」会撞上一条**专门为此写的用例**（`JetStream 判据不是恒真：普通 nats 配置不许被误判`，连注释都写着「没有这条，上面那组即使在永远返回 true 时也会绿」）——那不是顺手写的断言，是把一个决定钉住的守卫，反转它等于把一盏永远亮着的灯重新点上，而这正是 E55 / E61 记着的、这个模块已经复发四次的病。改法二「真去读生效的配置」是对的，但那是**新机制**（定位挂载点、从容器里读文件、解析 nats 配置），不是新判据，属于 §5.5 的 B 类。**线上触发面为零**：当前 CDS 上一台 nats 都没有。真要做时与 E68 / E69 同批——三条都是「判据只看了 N 个来源里的一部分」，一次对齐 |
| E73 | 中 | 2026-08-27 | **「开了鉴权」不等于「默认口令换过」**：nacos 判据看的是 `NACOS_AUTH_ENABLE` 加三个服务端鉴权变量，这四样齐全就判「已配认证」。但内置的 `nacos` 账号口令存在 nacos 自己的库里，**不由这几个 env 决定**——一台开着鉴权、账号却还是出厂口令的实例，会从「未认证」这个 critical 降级成「已配认证」，而知道那对通用口令的人照样读写全部配置 | 开了鉴权但没改内置账号口令的 nacos | **故意没做** | Codex review P1，事实成立。**但它问的是另一个维度**：判据答的是「服务在不在校验凭据」，这条问的是「凭据强不强」。两条改法都越界——「探一次默认登录还成不成功」是**新机制**（要拿凭据去打运行中的实例），「在证明轮换过之前一律判 unknown」会把每一台 nacos 永久挂在 unknown 上，正是 E55 / E61 那盏永远亮着的灯。按 §5.5 属 B 类。**线上当前不受影响**：两台 nacos 都只设了 `NACOS_AUTH_ENABLE`，三个必需变量一个都没有，判据现在就判它们未认证——这条要成立得先有人把鉴权配全。真要做时它自成一类（凭据强度检查），不该塞进「有没有开认证」那个判据里 |
| E74 | 中 | 2026-08-27 | **janitor 的用例会摸到真 docker，在有 docker 的机器上结果不确定**：`janitor.test.ts` 的 `setup()` 注了 docker prune 的桩，注释写着「测试环境无 docker」，却**没注镜像客户端**——`runImageRetention` 于是走真实实现去 shell 出 `docker`。这个假设在 CI runner 上不成立（那台机器有 docker，且上面有什么镜像不可控）。2026-08-27 `Build & Test` 在 `340074555` 上红过一次（424 行「孤儿扫描失败要进 errors」拿到 false、565 行拿到空的 imageRetention），同一份代码本地与随后的 CI 都是绿的 | 在装了 docker 的机器上跑 cds 全量 | **故意没做** | **诊断只完成了一半，如实记**：已证实的是 `setup()` 确实没注镜像客户端、真实路径会调 docker；**没证实**这两条断言失败与它的因果链——565 行那个用例自己注了镜像客户端，按理不该受影响，所以至少还有第二个机制没找到。排掉的猜测：`sweep()` 单飞泄漏（`beforeEach` 每例新建实例，泄不了）、start() 的 30 秒首轮定时器（`stop()` 两个都清）。**不在本 PR 修的理由**：它不是本 PR 引入的，属 janitor 模块的存量测试债；而随手给 `setup()` 补个桩只能挡住第一个机制，第二个没找到就动等于把一个不确定换成另一个不确定。正解是把这份用例里所有对外部进程的出口都显式注桩，并加一条「跑完断言真的没调过 docker」的守卫，那是一次单独的收敛 |
| E75 | **高** | 2026-08-27 | **每日体检把生 env / command 喂给认证判据，于是豁免倒计时不提示**：`index.ts` 的体检循环传的是 `service.env` / `service.command` / `service.entrypoint` 原样，而容器启动那条路（`container.ts`）传的是 `resolveEnvTemplates` / `resolveCommandTemplate` 之后的值。存量服务若把凭据写成 `${CDS_*}` 而项目里没有对应值，启动路径解析成空串、只能靠限期豁免放行；体检这边却把没展开的占位符当成非空凭据，判它「已配认证」，于是**不记豁免倒计时**——到期那天直接起不来，而承诺过的提前预警一次都没出现 | 凭据写成模板、且项目 env 里没有对应值的存量服务 | **已做（2026-08-27）** | Codex review P1，核实属实（源码逐字对过）。**这是今天第三次同形状**（形状 6：判据读的不是真正生效的那个值），前两次在凭据派生上已修；这一处是另一个调用点。改法与前两次相同、也很小。**不在本 PR 修的唯一理由是熔断**：AGENTS.md §5.5 的判据「Review 修复提交达 8 个」今天已越线（9 个），规则要求停止追加修复、回到原始目标。**这条应当优先于 E72/E73/E74 处理**——它有明确的用户可见后果（到期停机且无预警），不是覆盖面问题 **落地**：体检循环改传 `resolveEnvTemplates` / `resolveCommandTemplate` 的结果，变量表按服务所属项目取（`getCustomEnv(service.projectId)`，拿错项目解出来是空值等于没解析）。配接线守卫一条，红绿闭环验过。 |
| E76 | 中 | 2026-08-27 | **`report:read` 进了全局默认范围，于是非 MAP 的连接类型也默认拿得到**：通用签发端点不指定 scopes 时用 `DEFAULT_SCOPES`，而 `accept()` 保留 scopes、只改 `partnerKind`；结果 `cli` / `other` 这些与报告同步无关的连接，默认也能读全部验收报告的清单与正文 | 用通用端点签发、且 partnerKind 不是 MAP 的连接 | **故意没做** | Codex review P2，事实成立。**有一层现成的缓解**：授权页会把 `DEFAULT_SCOPES` 逐项显示出来给人过目，所以走页面批准那条路的用户是看见了 `report:read` 才点的头——不是静默授予。缺口在「不走页面的签发路径」。正解是**按 partnerKind 分别定义默认范围**，那是新语义类别（默认值从一份变成一张表），按 §5.5 属 B 类；且本 PR 已冻结、熔断已越线 |
| E77 | 中 | 2026-08-27 | **手工备份那条路又收窄了一次 `Pick`，把 `basePresetId` / `containerPort` 丢了**：`detectInfraKind` 支持用这两项兜底识别，而这个适配器不传，于是私有镜像 + 中性命名的服务落进 `generic`——下载走 `tar -C /data` 而不是引擎自己的 dump，对那些数据不在 `/data` 的引擎，下下来可能是个空壳 | 私有镜像 + 中性 id/容器名、只能靠 preset 或端口认出来的服务 | **故意没做** | Codex review P2，事实成立，**且与 E68 同族**：E68 记的是**自动**备份那条路丢 `containerPort`，这条是**手工**那条路，两处各自收窄了一次入参。正解是两处一起把完整的 `InfraService` 提示传下去，并配一条「私有镜像 + 中性命名 + 已知端口必须被认出来」的守卫，一次做完；分两次改等于把同一个形状修两遍还容易只修一半。熔断已越线，与 E68 同批 |
| E78 | **高** | 2026-08-27 | **口令只写在启动命令里的 redis，凭据一个都发不出去**：`redis-server --requirepass <口令>` 这种写法认证门禁是接受的，备份那边的 `redisAuthFromServiceDefinition` 也把它当受支持的生产形态，而凭据派生表要求 env 里先有 `REDIS_PASSWORD` 才会看这类服务。于是消费方只拿到地址和端口，连上去 `NOAUTH` | 口令只写在 command、env 里没有 `REDIS_PASSWORD` 的自定义 redis | **已做（2026-08-27）** | Codex review P1，事实成立，**而且是我今天那条修复的反面**：我给 redis 加了「必须由启动参数证明服务端在校验」，却仍然只从 env 取口令值——证明看命令行、取值看 env，两个来源没对齐。正解是命中 `--requirepass` 时**顺手把那个值取出来**当口令（`--aclfile` 那条仍然只能从 env 取用户名口令，因为 ACL 文件内容不在命令行上）。**线上不受影响**：现有每一台 redis 的 env 里都有 `REDIS_PASSWORD`。不修的唯一理由是熔断——§5.5 的「Review 修复提交达 8 个」今天已越线 **落地**：账号候选新增 `passwordFlags` / `userFlags`，取值走与认证判据同一套分词的 `readStartupFlagValue`——判据说「命令行上有」，取值就从同一份 token 里取，不会再出现「证明看命令行、取值看 env」。**env 优先、命令行兜底**（命令行上可能是待 shell 展开的 `$REDIS_PASSWORD`，分词器会当它没有值）。取值必须走保留大小写的那份 token，专门配了一条混合大小写口令的用例——判据为匹配开关名把 token 转成了小写，复用那份会派生出一个大小写被抹平的口令，它长得像凭据、也真会发出去，而 CDS 自己生成的十六进制口令正好不会暴露这个 bug。 |
| E79 | 低 | 2026-08-27 | **限流用例的「等到新窗口」等在了建库之前**：`DelayUntilFreshWindow` 算出「这一分钟还够用」之后，才去跑 `TryCreateDatabaseAsync` / `InsertServiceKeyAsync`；CI 上 Mongo 慢时这段建库耗时会把刚算出来的余量吃掉，请求照样跨过分钟边界，正是这条修复本来要防的那种假红 | CI 上 Mongo 建库慢的时候 | **已做（2026-08-27）** | Codex review P2，事实成立。改法就是把那句等待挪到建库之后、紧挨着发请求那一批之前，三条用例各挪一次，纯测试改动、无产品影响。熔断已越线，与 E75 同批 **落地**：三条用例的等待各自挪到建库建索引之后、紧挨着发请求那一批之前。顺带：跳过用例时不再白等一次。 |
| E80 | **高** | 2026-08-27 | **compose 导入基础设施时把 `command` / `entrypoint` 整个丢了**：`importCdsComposeFromFile` 构造 `InfraService` 时只搬 id/镜像/端口/卷/env/健康检查，**两个启动字段一个都不带**（源码逐字对过）。后果比 review 说的更宽——不只是 NATS 的 `--user/--pass` 没了导致文档里的 demo 起不来：**从 compose 导入的 redis 会同时丢掉 `--requirepass` / `--aclfile`**，于是认证门禁判它没配认证而拒绝创建，凭据派生也因为拿不到启动参数证明而一个键都不发。这三件事撞在一起 | 任何走 compose 导入创建的、认证写在启动命令里的基础设施 | **已做（2026-08-27）** | Codex review P1，事实成立且范围更大。改法很小（把 `def.command` / `def.entrypoint` 一起搬进去，另一条 compose 导入路径已经这么做了），**但必须配一条守卫**：导入一份带 `command` 的 compose，断言落库的 `InfraService` 上那两个字段还在——否则下一个字段还会这么漏。**线上当前不受影响**：现有 redis 的 `command` 里都带着 `--aclfile`，说明它们不是走这条路径建的。不修的唯一理由是熔断（§5.5「Review 修复提交达 8 个」已越线）。**与 E75 / E78 / E79 同批**，都是「小、明确、有用户可见后果」的那一类 **落地**：`def.command` / `def.entrypoint` 一起搬进去，**外加 `def.restartPolicy`**——排查时发现被丢的是三个字段不是两个，yaml 里写了 `restart: always` 也照样丢。守卫按 review 要求配了，但没有把字段名写死：它真跑一次 `parseCdsCompose`，拿解析器的**实际输出**去比导入侧读了哪些 `def.*`，解析器哪天多读一个字段、导入侧没跟上就会红，不需要谁记得回来改测试。 |
| E81 | **高** | 2026-08-27 | **同一件事三处判据、两个口径，安全结论出假阴性**：`detectInfraAuth('redis')` 认「env 里有 `REDIS_PASSWORD`」**或**「命令行上有 `--requirepass`/`--aclfile`」，两者取或；而创建门禁 `assertInfraAuthenticationConfigured` 对 redis **只认命令行**，我今天给凭据派生加的判据也只认命令行。于是一台「env 里有口令、启动却没开认证」的 redis：门禁拒绝创建、凭据派生不发凭据、**而每日体检判它「已认证」并压掉 `infra.naked-internal`**——同一台库，一边说裸奔一边说安全，而对外发声的是判错的那一边 | 内网 redis，env 里有 `REDIS_PASSWORD` 但启动没开认证 | **已做（2026-08-27）** | Codex review P1，源码逐字核对属实。`detectInfraAuth` 那两行注释写着为什么也读 env（「只看 env 会把它误判成裸奔」——防的是假阳性），但这个取或让它在**另一个方向**变成假阴性，而安全结论上假阴性比假阳性贵。同一个文件对 memcached / kafka / nats 明确写着「口令存在不等于服务在校验它」，redis 这一支没照做。正解是把三处收敛成**一份** redis 认证判据（只认命令行），并配一条「三处判据对同一输入给同一答案」的守卫。不修的唯一理由是熔断已越线 **落地**：`detectInfraAuth` 的 redis 分支收敛成只认启动参数，创建门禁改为委派给它，凭据派生问同一份判据（`provenByAuthKind`）。守卫按 review 要求配了「三处对同一台库结论一致」，四种输入逐个过。**换来一条新的已知边界**：读不到启动命令时（docker inspect 失败），一台 env 里有口令的 redis 会被判成裸奔、多报一次。这是有意的取舍——安全结论上假阴性比假阳性贵，而运行态那一路读的是容器真实的 Entrypoint + Cmd（见 E69），读不到才落到从严那一档。 |
| E82 | **高** | 2026-08-27 | **凭据派生表里没有 NATS**：走 `POST /api/infra` 直接建的 NATS，带 `NATS_USER`/`NATS_PASSWORD` 加 `--user`/`--pass` 时门禁是接受的，而凭据表零覆盖，于是消费方只拿到地址和端口、认证不上 | 直接建的、认证写在 `--user`/`--pass` 上的 NATS | **已做（2026-08-27）** | Codex review P1，事实成立（表里 `NATS` 出现 0 次）。**与 E78 是同一件事的两面**：NATS 的口令同样可以只写在命令行上，所以 E78 那条「命中 `--requirepass` 时顺手把值取出来」如果做成通用的「从启动参数取凭据」，NATS 这条一并解决。两条应当一起做，各配守卫。不修的唯一理由是熔断已越线 **落地**：与 E78 做成同一个通用机制（`passwordFlags` / `userFlags`），凭据表新增 NATS 源。两条真实形态都覆盖：直接建的把账号口令写在 `--user` / `--pass` 上，取得到；预设那条路在容器内写配置文件、明文不进 argv，命令行上看不出认证开着，于是一个键都不发——不能证明就不发，与 redis 同一口径。 |
| E30 | 中 | 2026-08-17 | 备份单飞闸只有一个布尔，堵住时看不出「谁占着、占了多久、错过几次」 | 一轮跑过六小时间隔 | **已修** | 只有 console.warn，面板上看不见，「定时备份实际停摆」可以一直没人发现。改法：闸带持有者身份（轮次 id + 起始时间），跳过时把年龄与连续跳过次数写进事件流，超过一个完整间隔升级为 error。仍未做的：健康探针端点与自动恢复，按并发闸纪律那条规则属于后续 |
| E28 | **高** | 2026-08-17 | redis 预设的 `sh -c` 顶掉了官方镜像 entrypoint 的 `redis-server` 分支，导致 redis 以 **root** 运行、`/data` 变成 root 属主 | 本 PR 引入口令后新建的每个 redis | **已修** | entrypoint 只在第一个参数是 `redis-server` 时才 chown + 降权，看到 `$1 = sh` 就走兜底 `exec "$@"`。改法：在 sh 里显式再调一次镜像自带的 entrypoint 并把 `redis-server` 作为第一个参数传给它——口令照样在容器内展开、不进宿主命令行，降权分支照常生效。**判据同步升级**：原来那几条只扫命令字符串（两种写法长得几乎一样，扫不出差别），新增一条**真容器**判据（无 docker 环境跳过并打印原因，CI 上真跑），断言「PID 1 是 redis-server、属主是 redis、/data 属主是 redis、不带口令连不上」 |
| E25 | **高** | 2026-08-17 | 暴露审计把 `"$REDIS_PASSWORD";`（尾巴粘着 shell 分隔符）当成非空字面量，判为已认证 | compose 导入的 `sh -c` 命令以 `;` / `&&` 收尾且变量未设置 | **已修** | 一个公网裸奔 redis 会因此从 critical 名单里消失。上一轮刚给这个解析器加过一次语法（拆 `sh -c`），这是第二次——按熔断规则停止逐形态打补丁，改结构化判据：单引号内一律当字面量（`'p$ss'` 不误伤），其余只要含 `$` 就必须整体解析成有值的变量，否则按「没有值」处理，一次覆盖 `"$X";` / `"$X" &&` / `${X:-}` / `pre$X` 全部形态 |
| E26 | 中 | 2026-08-17 | runbook 的 MySQL 段把 host 写死成 `%`，而第 0 步查出来的 host 组合并不固定（预设未设 `MYSQL_ROOT_HOST`） | 实例只有 root@localhost | **已修** | ALTER 会因「用户不存在」失败，而操作者可能已经把 env 改成新口令 → 库里还是旧的，备份当场全挂。改成逐个 host 执行 + 改完复查一遍 |
| E27 | 低 | 2026-08-17 | runbook 让统一生成 16 字节 hex 口令，但 SQL Server 默认强制复杂度，纯 hex 会被拒 | 轮换 sqlserver | **已修** | 预设建库时会拼 `Aa1_`，runbook 现在同样写明 |
| E23 | **高** | 2026-08-17 | 磁盘闸只在导出**之前**查一次，而那次写入是无界的：单个大库能吃掉最后一个字节 | 单份压缩产物大于当前可用空间 | **已修** | 逐目标复查保护的是后面的目标，救不了正在写的这一个；等命令报错时宿主根盘已经满了，事后删残骸来不及。改法：`buildSizeCappedCommand` 用 `ulimit -f`（可用空间减 2 GiB 保留余量，换算成 512 字节块）给每次导出套硬上限，超限由内核中断、走既有失败路径删残骸；`ulimit` 设不上时不阻断导出（否则从「可能撑爆」退化成「必然不跑」），退回只有前置闸的旧行为 |
| E24 | 中 | 2026-08-17 | 轮换 runbook 的 PostgreSQL 段对着 `postgres` 角色操作，而 catalog 建的超级用户是 `app` | 照 runbook 轮换 PG | **已修** | 官方镜像按 `POSTGRES_USER=app` 建超级用户，不会再有 `postgres` 角色，两条命令都报 role does not exist。根因是修 MySQL 那条时**没横扫同类**；这次把九个预设的真实账号名做成一张表放进 runbook §2 开头（mongodb/postgres/clickhouse/rabbitmq/minio 都是 `app`，mysql 是 `app`+`root`，sqlserver 是 `sa`，elasticsearch 是 `elastic`），从「逐个踩」变成「动手前对一行」 |
| E21 | **高** | 2026-08-17 | MySQL 导出脚本只捕获 dump 一端的退出码；gzip 中途失败（磁盘满 / I/O 错误）时脚本仍返回 0 | 压缩写盘中断 | **已修** | 产物是一份非空但解不开的截断 gzip，调用方看「退出码 0 + 非空」就转正，保留策略再删掉一份真正可用的旧备份——用坏的换掉好的。注释里当时写着「由调用方的 gzip -t 兜住」，而调用方**根本没有** gzip -t（拿不成立的证据当证明）。改法：两端退出码分别经 fd4 回传，任一非零整条失败；宿主侧补真正的 `gzip -t`，排在转正之前 |
| E22 | **高** | 2026-08-17 | `CONFIG GET dir/dbfilename` 失败时静默退回 `/data/dump.rdb`，且当时的测试把这个退回行为锁进了 CI | CONFIG 被 rename-command 改名或被 ACL 拒绝 | **已修** | 恢复流程会照猜出来的路径写文件、重启、报「已恢复」，而 redis 加载的还是旧数据。改法：问不出来就报错（四种失败各自的退出码 27/28/29/30），默认值只在 redis 自己回答「就是默认」时才出现；锁死行为的那条用例改写成「失败即报错」 |
| E20 | **高** | 2026-08-17 | 手工下载 `GET /api/infra/:id/backup` 与恢复 `POST /api/infra/:id/restore` 都写死 `/data/dump.rdb`；下载还忽略 BGSAVE 退出码、只 sleep 1.2s | redis 配了 requirepass（本 PR 起新建的都有）或改过 dir/dbfilename | **已修** | 下载：BGSAVE 返回 NOAUTH 被忽略 → 直接 cat 旧文件 → 用户拿到**陈旧快照**却以为是新的，而项目迁移正是从这个端点取数。恢复：写到 redis 不读的路径，重启后加载的还是旧数据，接口却回「已恢复」。改法：下载复用完整探测脚本（认证 + INFO persistence 确认 + mtime 证明 + 回传真实路径），恢复复用只解析路径那半段；路径判据抽成 `REDIS_RDB_PATH_LINES` 单一来源，三处共用 |
| E19 | 中 | 2026-08-16 | 暴露审计只把容器 `.Config.Cmd` 的每个元素当独立 token 比对，`sh -c "redis-server --requirepass x"` 整条是**一个**元素 | compose 用 sh -c 包一层启动（很常见，本仓库 redis 预设也是这个形状） | **已修** | 比不中 `--requirepass` → 一个真有口令的库被报成「无认证 critical」，而该模块自己的原则是「假警报比不报警更糟」。改法：每个 arg 再按空白拆一层；顺带把取值判据收严——`--requirepass ""` 与引用空变量的 `"$X"` 都不再算认证（前者是空口令，后者 redis 会 FATAL） |
| E18 | 中 | 2026-08-16 | 凭据轮换无审计：谁在什么时候换过哪个库的口令，系统里没有记录 | 事后复盘轮换时间线 | open | 轮换端点落地时一并写 server event（category=system, action=infra.credential.rotated），只记服务 id 与时间，不记值 |
| E15 | **高** | 2026-08-16 | Redis 备份写死 `/data/dump.rdb`，而 BGSAVE 落在 `CONFIG GET dir` / `dbfilename` 指定的位置 | 实例配了非默认 dir 或 dbfilename（compose 导入常见） | **已修** | 那种配置下每一次正常的 BGSAVE 都会被判失败（stat 到的是不存在或很旧的文件），而 `docker cp` 也拷错文件——自动备份永远不会成功一次。改法：探测脚本用 `CONFIG GET` 取运行时真值，最后一行把绝对路径回传给宿主，宿主按它 `docker cp`；回传缺失就报错，不许再拼默认路径 |
| E12 | **高** | 2026-08-16 | 事件驱动发布在**分支产物就绪之前**触发：`firePushRules()` 排在 commit 盖戳之后、分支部署派发之前 | push 命中生产发布规则，且该分支已在运行 | open | 上一轮修的是「规则读到旧 SHA」，这一轮是**产物本身还是旧的**——worktree / 预览 / 容器都还停在上一个 commit，预检却按新盖的 SHA 放行，消费 `artifactPath` 的策略会把旧内容当新版本发出去；docs-only 推送必然复现（它根本不触发部署）。正解是改由**部署完成**触发，或先物化本次 commit 的产物。在此之前不应把 push 事件规则当可用能力 |
| E13 | **高** | 2026-08-16 | MySQL 备份把未压缩 dump 整份中转落盘，而磁盘闸是**每轮一次的固定阈值**（2 GiB） | 逻辑 dump 大于剩余空间 | **已修** | 为了拿到 mysqldump 的真实退出码（dash 没有 pipefail）改成了两步落盘，代价是中转全量 raw。闸只在轮次开头查一次、不按目标复查，单个大库就能把宿主根盘写满——那会同时打死所有预览、构建和 CDS 自己。改法：容器内用 POSIX 文件描述符腾挪拿 pipeline **上游**的退出码（`buildMysqlDumpScript`），gzip 直接写回原 stdout——零中转文件，dash / busybox 都吃；磁盘闸提成 `diskGate()` 并在**每个目标之前**复查，不足就把剩余目标记成「未执行」而不是少备几个报全绿。判据是拿真 shell 配假 mysqldump 跑的：dump 退 3 时整条退 3（老写法在这里拿到 0） |
| E14 | 中 | 2026-08-16 | 共享的「任务计划」编辑器不认识 `push` 这一档：列表把它显示成每日任务，表单回填后保存会转成 `daily` 且分支 ID 为空 → 400；「立即执行」还会在没有事件上下文的情况下跑出失败记录 | 建了 push 规则后打开任务计划页 | open | 枚举扩了一档但只接了新页面，老消费方没跟上（`enum-ripple-audit` 的典型形态）。正解是让共享编辑器支持 push，或把 push 规则连同它的手动执行动作一起排除在该编辑器之外 |
| E11 | 中 | 2026-08-16 | 周期自动备份没有单飞闸，一轮跑过六小时就会与下一轮重入 | 目标很多且逐个串行、单库超时 20 分钟叠加 | **已修** | 两轮共用同一个 `.tmp` 目录，后一轮进门先删重建，会把前一轮正在写的文件删掉，双双记失败。改法：`inFlight` 单飞闸，放闸放在 `finally`——放在别处一旦漏掉，往后每轮都被自己挡在门外，而日志只说「上一轮还没跑完」，是个不会自愈的静默停摆 |
| E6 | 高 | 2026-08-16 | CDS 控制面自身的监听地址此前是全部网卡：`listen(port, cb)` 不给 host，Node 就绑全网卡，控制面裸端口绕过前置 nginx 直接可达 | 单机 + nginx 在前的默认部署 | 代码已修，**存量实例未切换** | 已改成单机绑回环、集群角色自动放开。但切换前必须确认 nginx 的**运行时** upstream 确实指向回环——那份配置是可写的，转发器可能在运行时改指到别的地址。改错就是控制面自锁，且没有第二条进入路径。另：绑回环后**首个 executor 只能经前置 nginx 注册**——连接码里的主节点地址走 rootDomains（https 域名）时这条路是通的；没配 rootDomains 时会按 Host 头兜底出一个带裸端口的地址，那种码远端连不上，签发时已当场告警并给出两条出路 |
| E46 | **高** | 2026-08-17 | **IPv6 对外端口巡检从落地起从未产出过一次有效结论**，而且原因有两层：① 正式环境的目标 Secret `PRODUCTION_EDGE_AUDIT_IPV6` 没配，job 停在缺目标那步；② 更要命的是 CDS 侧目标**配了、也真跑了**，却回 `open=none passed=false`——全 65535 端口扫描 1.3 秒就结束，同一台主机的 IPv4 扫描同时扫出 22/80/443。这个形状不是「IPv6 没开端口」，是**观测点自己发不出 IPv6 报文**——加上自检那步之后已当场证实：运行器上 `ip -6 addr show scope global` 一条全局地址都没有，GitHub 托管运行器不提供 IPv6 出网 | 源站有全局 IPv6，而防火墙只按 IPv4 配 | **已登记不查（2026-08-18 决定，2027-02-18 复审）** | 校验器这一层是对的：它用「必需端口一个都没扫到就判失败」把这次失败拦住了，没让「什么都没扫到」冒充「很干净」——假绿没有发生。真正的坑在于**两种失败在报告里长得一样**（都是 `openPorts: []`），谁要是日后放宽那条必需端口判据，一次根本没发生的扫描就会直接显示成绿。已在扫描前加一步观测点自检：运行器没有全局 IPv6 就当场判失败并写明「本次未扫描、与目标无关」，把「没扫成」和「扫了没发现」彻底分开。**剩下要人做的决策不是填一个地址**：得给这条巡检换一个有 IPv6 出网的观测点（自托管运行器接双栈网络，或外部扫描服务），只配 Secret 不换观测点仍然过不了。三条出路择一并显式登记：换观测点真扫 / 显式登记「该环境不做 IPv6 巡检」并说明为什么可接受 / 关掉主机的全局 IPv6。**不许**改成「没配就跳过」——留空与忘了配无法区分，那等于挂一条永远不会红的巡检，比没有巡检更糟 **2026-08-18 处置**：用户在三条出路里选了「显式登记不做 IPv6 巡检」。落地成一份仓库内的豁免登记（理由 / 决定人 / 决定日期 / 复审期限 / 残留风险五样缺一不可，缺任何一样按「没登记」处理并判失败），巡检读到有效登记才短路，并在结论里写明「本次未扫描、该面未经证明」；复审期限一过登记自动失效、巡检重新变红，防止临时决定无声变成永久盲区。IPv4 侧不受影响，仍在真扫。**残留风险未消除**：两套环境的 IPv6 暴露面依旧没有任何扫描证据，绿灯只代表有人决定不查。 |
| E47 | 中 | 2026-08-19 | 自更新记 `status: success` 的时刻**早于进程真正被替换**——重启要几分钟才落地，这期间 `/api/self-status` 同时呈现「上次更新成功」与 `restartStatus: incomplete`，读的人会判成「重启失败了」 | 自更新之后的几分钟内 | **未修（先记账）** | 实测时间线：07:57:34 记 `mode=restart, status=success, toSha=8545381`；此后 `pidStartedAt` 一直停在 06:18，新合并的路由持续 404；直到 **08:02:43** 进程才真正换掉，`restartStatus` 转 `completed`、路由随即可用。**我在这中间下过一个错误结论**——看到「记录成功但 pid 没动」就断定「重启把发出指令当成了进程已换掉」，还据此改了自更新的 no-op 判据；实际重启并没有坏，只是慢。那个改动的前提不成立，已撤回（不合入），因为它会让重启窗口内的每次自更新都多跑一次完整构建。真正该补的是**如实反映进行中**：重启未落地时不要记成终态 success，给一个「重启中」的中间态 + 预计耗时，让人和 Agent 都不必靠猜。相关：`expectation-management.md`（让人随时知道现在什么情况） |

### 两层暴露面的区别（别混为一谈）

| | infra 容器端口 | CDS 控制面自身 |
|---|---|---|
| 谁在监听 | docker 发布的容器端口 | 宿主上的 Node 进程 |
| 走哪条链 | DNAT 之后走 `FORWARD` | 走 `INPUT` |
| 宿主防火墙管不管得着 | **管不着**，这是最反直觉的一点 | 管得着 |
| 默认收窄成什么 | 网桥地址 + 回环 | 回环（集群角色自动放开） |
| 逃生阀 | `CDS_INFRA_PUBLISH_HOST` | `CDS_BIND_HOST` |

两层都要收，但优先级不同：infra 那层**必须**在发布这一步解决，因为防火墙那一步根本
拦不到；控制面这层防火墙能兜底，收窄只是不该依赖运维记得配。

### 后续波次（按先后）

1. **上线周期备份与存量自检**（E4 / E5，代码已就绪）。这两条纯增量、不改既有行为，
   是后面所有动作的安全网与眼睛。
2. **存量容器重建**（E1）。代码改动只对新建生效，存量要逐个重建才落地。**前置条件是
   第 1 步的备份已经真的产出过至少一份**——否则重建有状态服务是在没有安全网的情况下
   动数据。
3. **默认认证补齐**（E2 / E3）。需要先把各项目的连接姿势捞出来核对——它们的 compose
   契约存在 CDS 自己的状态库里、不在本仓库，看不全就动会打断别人的项目。
4. **审批队列持久化**（E7）。否则每次自更新都会把待批的运维请求清空，而自更新恰恰是
   高频动作。

### 用户点名的四条遗漏（2026-08-16）

这次不只是「有个洞」，而是**四层防护同时不存在**。任何一层在，损失都会小一个量级。
逐条立账，别让它们散在对话里。

| ID | 遗漏 | 现状 | 为什么它单独成立 |
|---|---|---|---|
| G1 | 真实环境的端口暴露没人核过 | **部分补上**：自检已上线，但判据只覆盖 CDS 认识的数据面容器；**从公网回头扫自己**这一步仍然没有 | 「配置上应该没暴露」和「从外面真的连不上」是两回事。全仓测试绿、面板显示正常，与一台机器在公网上敞着 63 个端口，可以同时为真 |
| G2 | 没有环境自动自查 | **大部分补上**：「今天这台机器健康吗」的统一结论已经每天跑一次，覆盖公网无认证库、内网无口令库、平台自身存储（门禁管不到的那一块）、存量豁免倒计时、备份新鲜度与覆盖缺口、恢复演练日期。**仍缺三样**：恢复演练没有任何地方记录（判定层的入参恒为 null，于是每天都报「从来没演练过」——结论诚实，但在补上记录之前它是一条常亮的红灯）；证书到期与磁盘水位仍未纳入 | 自查要覆盖的不止端口：认证、备份新鲜度、证书到期、磁盘水位、防火墙规则是否还在，都该有一个「今天这台机器健康吗」的统一结论。这一条的证据是 2026-08-23 那次人工审计——查出来的每一项本来都该由系统自己说出来，而不是等人想起来查一次 |
| G3 | 操作日志可被删改 | **未做** | 现有事件流与审批记录都存在同一台机器、同一个库里。攻击者拿到宿主后第一件事就是抹痕迹；能被删的日志在事后取证时等于没有 |
| G4 | 无自愈、备份不离机 | **部分补上**：周期备份已上线，但**只落在同一台机器上** | 同机备份挡得住误删，挡不住整机沦陷或磁盘损坏。这次真正致命的不是被清空，是清空之后**没有任何一份可用副本** |

四条的共同点：**它们都是「平时看不出缺失」的东西**。缺一份离机备份、缺一条自检、
缺一份不可删日志，系统在 99% 的日子里表现完全正常——只有出事那天才发现它们不在。
所以不能靠「想起来再补」，必须变成常设机制。

### 不在范围内

「资源公网 TCP 访问」是**有意**的对外暴露，且已强制要求非空 IP allowlist + 防火墙
兜底——它自己拼发布参数，不走上面这条收窄路径，也不该被收窄。那是本仓库唯一做对了的
暴露路径，改它只会破坏功能而不提升安全。

## 2026-08-27 排查中撞见的两条（活账）

### A. 项目发布门禁可以被两次 API 调用绕过（高）

发布路由上的那道门禁（`rejectUnscopedAiMutation`）明确写着「AI 操作项目发布必须使用
项目级 Agent Key，禁止用全局 AI key 配置或执行项目发布」，配置发布目标与触发发布都被它挡住。
但**签发项目级 Key 的那个接口没有同样的门禁**：`POST /api/projects/:id/agent-keys`
只做 `assertProjectAccess`——项目级 Key 持有者只能给自己项目签，
而**全局 AI key 不受这条限制**，可以给任意项目签一把 `cdsp_*` 再拿回来过门禁。

也就是说这条门禁挡的是「没读过代码的调用方」，不是「拿着全局 key 的 AI」。要么给签发接口补上
同一条判据（全局 AI key 不许签项目 Key，必须走页面批准），要么承认这条门禁只是提示、别当成边界。

发现经过：本次要修一个发布目标脚本，用全局 key 提交被 403 拦下；顺着看签发路径时发现它没设防。
**没有利用它**——绕过去等于把这条门禁作废。

### B. prd-agent 的 redis / mongo 连接串不带凭据，新建的分支容器全崩（高，正在发生）

线上 prd-agent 的 redis 跑 `redis-server --aclfile`（ACL 认证）、mongo 跑 `mongod --auth`，
但分支容器拿到的是：

```
MongoDB__ConnectionString = mongodb://<host>:<port>
Redis__ConnectionString   = <host>:<port>
```

一个凭据都没有，于是每个**新建**的容器启动即崩（`NOAUTH Returned - connection has not yet
authenticated`）。已经在跑的容器没事——它们的连接是在改动之前建立的，所以面板上看着还有一半分支
是 running，掩盖了这件事。2026-08-27 当时 18 条分支里 5 条 error，全是这个原因。

根子在判据指向了一个不存在的名字：项目 build profile 里写的是
`Redis__ConnectionString: ${CDS_REDIS_URL}` / `MongoDB__ConnectionString: ${CDS_MONGODB_URL}`，
而 **`CDS_REDIS_URL` 与 `CDS_MONGODB_URL` 这两个名字在 CDS 源码里一次都没出现过**
（`getCdsEnvVars` 只产 `CDS_<服务>_HOST` / `CDS_<服务>_PORT`）。当前容器里那个值是老 profile
（`${CDS_HOST}:${CDS_REDIS_PORT}`）留下的，下一次部署会拿到空串。属于形状 8：声明了但永远不生效。

**已修（2026-08-27 当天）**。原先卡在「口令必须由人给」——CDS 对基础设施凭据全链路脱敏，
没有接口能把值交出来。真正的解法不是把口令要出来，而是**让 CDS 自己去发**：它本来就存着
那对账号口令，只是从没往消费方容器发过。

- 生产侧：新增一个凭据派生模块，接进 `getCdsEnvVars`，按镜像约定的
  env 键名（不按服务 id，多实例改名都不受影响）派生 `CDS_<服务>_USER` / `_PASSWORD` / `_URL`，
  URL 的 userinfo 段做百分号编码。没口令的服务一个键都不发。
- 消费侧：三个 profile（`api-prd-agent` / `llmgw-prd-agent` / `llmgw-serve-prd-agent`）的连接串
  改成引用凭据；仓库里那份 compose 声明同步改掉，避免下次重新导入打回原样。
  Mongo 用 `${CDS_MONGODB_URL}`；Redis 因为 StackExchange.Redis 不吃 `redis://` URI，
  按它的格式拼 `host:port,user=,password=`。

顺序上先让生产侧真的存在，再改消费侧——不能重蹈「profile 指向不存在的变量」那个覆辙。

**留下的已知边界**：原始 `USER` / `PASSWORD` 交给消费方自己拼时，转义责任在消费方。口令里若出现
StackExchange 格式的保留字符（`,` `=`），拼出来的串会被解析歪。CDS 生成的口令是十六进制不会命中，
**用户手工改过口令的服务才有这个风险**。要根治得给 redis 也提供一个「已转义、可直接用」的形态，
或者在 CDS 侧拒绝含保留字符的手工口令。

**留下的第二条已知边界**：`CDS_<服务>_URL` 只带地址与凭据，**不带库名、不带 `authSource`**
（Codex review P1 提的就是这条）。mongo 这一侧是有意为之——不写库名时 authSource 按 URI 规范
默认落到 `admin`，正好是 root 账号所在的库；补 `/<库名>` 却不同时补 `?authSource=admin`
会直接把认证打死。而且 CDS 知道的 `MONGO_INITDB_DATABASE` 是**初始化用的库**，不等于消费方
要读写的库——当前唯一消费方 prd-agent 就是另外用 `MongoDB__DatabaseName` 指定的。
mysql / postgres 的 `_URL` 目前没有任何消费方，等真有人用再按引擎补库名，不在这个 PR 里
凭空替不存在的消费方决定语义（AGENTS.md §5.5 的 B 类）。

**顺带**：把 profile 改成引用 `${CDS_REDIS_URL}` 的那次改动，从落地起就没生效过——那个名字当时
在 CDS 里根本不存在。现在它存在了，那次改动的意图反而是对的，只是缺了生产侧那一半。

**第三条已知边界（欠一次收敛）**：「哪些 env 键算凭据」现在有两份——认证门禁一份、
凭据派生一份。正解是抽一份共享的键名表两边都读它，但那要动认证门禁本身，而门禁是安全件、
所在 PR 已冻结，所以先用守卫钉住：扫门禁源码里 `hasValue(env, ...)` 认的键，逐个断言派生表
也认，往门禁加别名却忘了加到派生表，CI 会红并点名缺哪个键。**共享键名表这次收敛还欠着。**

这条边界不是假想的：线上一台 mysql 只设了 `MYSQL_ROOT_PASSWORD`（门禁明确接受这种），
而派生表第一版只认 `MYSQL_USER` / `MYSQL_PASSWORD`，于是门禁放行、服务真开着认证、
消费方一个键都收不到——比「服务没开认证」难查得多。同批补齐的还有 mongo / minio 的
第二套别名，以及门禁认、派生表整个没有的 sqlserver / clickhouse / elasticsearch。

### 实现来源（本节两条）

- `cds/src/routes/releases.ts` —— 发布门禁 `rejectUnscopedAiMutation`
- `cds/src/routes/projects.ts` —— 项目级 Agent Key 签发接口
- `cds/src/services/infra-credential-env.ts` —— 凭据派生与已知边界
- `cds/src/services/state.ts` —— `getCdsEnvVars` 接线与模板解析
- `cds-compose.yml` —— prd-agent 三个 profile 的连接串声明

---

## 已结清（供回溯）

下列条目台账里已自己标记为解决/交付，移到文末只为让上文只剩未还的账；内容原样保留。

### 已知边界 / 后续可补

| # | 项 | 说明 | 优先级 |
|---|----|------|--------|
| 3 | ~~墓碑来源仅 PR closed~~（完成 2026-06-24） | `handleDelete` 现在也返 `tombstoneRequest`（reason='abandoned'），`recordRemovedBranch` 加 merged 粘性防降级。直接 `git push --delete` 也落「已放弃」页 | 完成 |

### 债务 2 的已闭环行（原「状态页与探测器的次要边界」，未闭环的行仍在上方活账）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | ~~无告警外发~~（2026-07-29 已偿还；这条链路没做完的部分另立活账，见活账区「债务 3」） | 判 down 现在会经 `uptime.target.down` 上 `cds-events-bus`，由服务端通知账本（`src/services/notice-ledger.ts`）记进 `.cds/notice-ledger.json`，并可选外发到 MAP 站内通知 | 已闭环 |

### CDS 复制集模式工程债务

| # | 状态 | 债务 | 影响 | 偿还方向 |
|---|------|------|------|----------|
| 4 | done(2026-07-25) | ~~成员容器无独立日志入口~~ 已偿还：container-logs 端点接受 memberId（合成 svc 形状复用主容器同一条归档/掩码/事件链路），抽屉「日志 → 容器」chips 行追加全部副本成员容器（靛蓝区分，项目级/容器级同源） | — | — |
| 16 | done(2026-07-24) | ~~大库整库克隆在共享宿主上无安全路径~~ **已根治：mongo 隔离改「专用隔离实例」通道**。终局取证（生命周期取证器 die exitCode=139）：共享 mongod 8.0.20 在本宿主上凡大批量写入随机 SIGSEGV（同 cgroup/辅助容器/WT cache 收紧/单并发/索引串行全部无效；纯读 dump 五次全程安全）。方案：dump 只读共享库落盘 → docker run 独立 mongo:7.0 实例（内存 1.5G 上限、CDS_REPLICA_ISO_MONGO_IMAGE 可覆盖）→ restore 写入专用实例 → 副本连接串覆写直连；快照删除 = 整容器移除。R9 终验闭环 PASS，共享库全程零事件 | 本条已闭环；共享 mongod 自身的大批量写不稳定另立活账 #29（见上方活账表） | — |

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 |
|------|------|
| 总览 | `cds/src/services/uptime-monitor.ts`、`cds/src/services/uptime-metrics.ts`、`cds/src/routes/uptime.ts`、`cds/web/src/pages/StatusPage.tsx`、`cds/web/src/lib/statusView.ts`、`cds/src/services/deploy-stuck-reconciler.ts`、`cds/src/index.ts`、`cds/src/executor/routes.ts` |
| 相关 | `cds/tests/routes/notices-scope.test.ts`、`cds/tests/web/status-page-view-state.test.ts` |
| 相关 | `cds/src/routes/project-migration.ts`（路由处理器） |
| 相关 | `cds/web/src/pages/ProjectSettingsPage.tsx`（`ProjectMigrationTab`） |
| 相关 | `cds/src/routes/branches.ts`（导出/导入配置，复刻底座） |
| 相关 | `cds/src/routes/infra-backup.ts`（mongodump/mongorestore，数据迁移底座） |
| 相关 | `cds/src/services/deploy-stuck-reconciler.ts`（看门狗纯函数 SSOT） |
| 相关 | `cds/src/services/build-log-meta.ts`（构建历史元数据纯函数，已单测） |
| 过期分支预览页 | `cds/src/index.ts`（墓碑页渲染与分流）、`cds/src/services/state.ts`（墓碑记录）、`cds/src/routes/github-webhook.ts`（触发） |
| 存活监控回归 | `cds/tests/services/uptime-monitor-cycle.test.ts`、`cds/tests/services/uptime-metrics.test.ts` |
| 通知账本 | `cds/src/services/notice-ledger.ts`、`cds/src/services/notice-outbound-map.ts`、`cds/src/routes/notices.ts` |
| 基础设施端口绑定 | `cds/src/services/infra-publish.ts`（唯一判定）、`cds/src/services/container.ts`（`startInfraService` 调用点）、`cds/src/services/state.ts`（网桥地址与注入同源）、`cds/src/index.ts`（适配器接线） |
| 端口绑定回归 | `cds/tests/services/infra-publish-host.test.ts` |
| CDS 自身监听地址 | `cds/src/services/listen-host.ts`（唯一判定）、`cds/src/index.ts`（`listenWithRetry` 调用点） |
| 监听地址回归 | `cds/tests/services/listen-host.test.ts` |
| 暴露面自检 | `cds/src/services/infra-exposure-audit.ts`（判定）、`cds/src/index.ts`（`startInfraExposureAudit` 周期运行） |
| 周期备份 | `cds/src/services/infra-backup-schedule.ts`（判定）、`cds/src/index.ts`（`startInfraAutoBackup` 执行）、`cds/src/routes/infra-backup.ts`（同目录的手工备份与历史） |
| 自检与备份回归 | `cds/tests/services/infra-exposure-audit.test.ts`、`cds/tests/services/infra-backup-schedule.test.ts` |
| 有意的对外暴露（不受收窄影响） | `cds/src/routes/branches.ts`（`applyResourceExternalFirewall`，allowlist + 防火墙兜底） |
