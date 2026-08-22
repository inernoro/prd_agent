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

### 明细

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
| E49 | **高** | 2026-08-21 | memcached / kafka / nats 三个预设**从创建起就没有认证**，而认证门禁 `assertInfraAuthenticationConfigured` 对这三类**静默放行**（落到函数末尾的 `configured = true` 默认值） | 用这三个预设建服务；叠加端口公网暴露即裸奔 | **代码已改，未在真容器验证** | 门禁的缺口比预设本身更值得记：它看起来管着所有数据服务，实际有三个类型从来没被判过，而缺口不发一声（形状 1，判据太窄且沉默）。三处同批改：预设补认证、门禁补判据、暴露面自检把硬编码的 `return false`（目录补上后它就从保守判定变成谎报）换成读真实配置。各自的机制：memcached 用 `-Y` ASCII 认证文件（SASL 要在容器里装 cyrus-sasl，alpine 没有，等于换镜像）；kafka 客户端监听器改 SASL_PLAINTEXT + PLAIN，**三处必须同时改**（监听器、协议映射、自我广播地址——广播地址还写着 PLAINTEXT:// 的话客户端拿到的重定向仍是明文，SASL 等于没开，判据也盯着这一条）；nats 覆盖 entrypoint 成 sh，口令在容器内展开后再 exec 回二进制（它的 ENTRYPOINT 是二进制本身，没有 shell，直接写 `--pass <明文>` 会把口令摆进宿主 ps）。顺带给 catalog 补了 `entrypoint` 字段并接到 InfraService。**已知边界**：① memcached 的 ASCII 认证要求客户端支持这套握手，只实现 SASL 二进制认证的客户端连不上——账号口令已一并注入项目环境变量，接不上的只能换库或换镜像；② kafka 的 JAAS 值一律不带双引号，因为 CDS 拼 `docker run` 时 env 走 `-e "K=V"` 且不转义值里的 `"`（这条本身是个潜在缺陷，见 E50）；③ nats 覆盖 entrypoint 后镜像默认的 nats-server.conf 不再加载（那份只设默认值）。④ **compose 这条路只补到了 nats 与 kafka**：cdscli 的模板表与两个示例工程（demo-events-nats / demo-stream-kafka）已同批改成带认证，memcached 没改——它的认证要先在容器里写一个 `user:pass` 文件，而 cdscli 的 `service_command` 是个会按空白切词的字符串、文本渲染器又不写 `service_labels`，`sh -c` 那套在这条路上表达不出来。后果是 **cdscli 脚手架生成的 memcached 会被门禁拒绝启动**（报错明确），要么手工给它加 `cds.entrypoint: sh` + 列表形态的 command，要么改用后端预设。根治要给 cdscli 的模板表加列表形态的命令字段并让文本渲染器输出 labels。⑤ compose 这条路的口令**进容器 argv**（`--pass ${CDS_NATS_PASSWORD}` 解析后是明文），沿用 cdscli 里 redis 早就有的取舍；后端预设那条路没有这个问题。**未验证**：本机没有 docker daemon，三个预设**没有在真容器上起过一次**。已按 redis 的先例写了真容器测试（`tests/services/infra-auth-presets.docker.test.ts`），有 docker 的环境跑一遍才算完——redis 那次正是靠真容器才发现进程以 root 在跑，源码扫描全绿 |
| E50 | 中 | 2026-08-21 | 拼 `docker run` 时 env 走 `-e "K=V"`，**不转义值里的双引号**；值里出现 `"` 会当场截断那段 shell 引用 | 任何 env 值含双引号（用户自填的 customEnv、需要 JAAS 之类结构化配置的预设） | open | 这一轮撞上：kafka 的 `sasl.jaas.config` 按官方文档写法要给 username / password 加双引号，那样容器根本起不来。绕过办法是不加引号（账号 `app`、口令是 hex，JAAS 不带引号也解析得了），但这只是躲开，没修根因。根治要把 env 值按 shell 规则转义（或改用 `--env-file`）。在那之前，任何值含 `"` 的 env 都是雷 |
| E48 | **高** | 2026-08-21 | postgres 是一等预设，却**完全不在备份范围里**：判据只认 mongo/redis/mysql，手工下载又掉进兜底 `tar -C /data`（数据其实在 /var/lib/postgresql/data） | 任何 postgres 实例 | **已修** | 三处缺口一起：周期备份把它记进「暂不支持的类型」（整轮健康长期红着——**红着不等于备着**，磁盘上一份都没有）、手工下载回 200 但只有空壳（与 E41 的 mysql 同一形状）、恢复端点直接 400。根因是同一件事被判了三遍：周期备份 `backupKindOf`、下载端点 `detectKind`、暴露面自检 `detectInfraKind`，三份覆盖的类型各不相同，于是「自检认得出、备份跳过」（形状 3）。改法：判据收敛成一份（复用 `detectInfraKind`，还能用服务 id / 容器名兜底认出私有仓库镜像）；补 pg_dump 导出、psql 恢复、数表取证，与 mysql 同一套 fd3/fd4 退出码写法。**postgres 独有的坑**：psql 默认遇错继续、跑完照样 exit 0——连管道退出码都拦不住的假成功，必须 `-v ON_ERROR_STOP=1`。执行层改成穷尽分支 + `never`，新增备份类型忘了接线时由编译器当场报错（防形状 2）。**已知边界**：只导出 `POSTGRES_DB` 那**一个**库，不含角色、权限与同实例其它库——用 `pg_dump` 而不是 `pg_dumpall` 是有意的，后者的产物灌不回一个已存在的集群（CREATE ROLE 撞已有角色，加 --clean 又要 DROP 掉当前连接的角色），「导得出、灌不回」等于没有备份。其它库由导出脚本当场写进 stderr（`cds-backup-scope:`）并进到一轮结论那句话里，不是悄悄的取舍。**未验证**：脚本用假 psql/pg_dump 跑过退出码矩阵，但**没有对真 postgres 容器跑过一轮导出 + 恢复**（本机无 docker daemon）。真容器用例已写好（起库塞数据 → 导出 → gzip -t → 清库 → 灌回 → 比对行数，外加「有语法错的 dump 必须失败」这一条守 ON_ERROR_STOP、「不是 gz 就退 65 且不动库」、范围提示、连不上退 78）；没有 docker 时整体跳过并打印「本次未验证」。按 G4「没演练过的备份不算备份」，在有 docker 的机器上跑一次 `pnpm vitest run tests/services/infra-backup-postgres.docker.test.ts` 才算完 |
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
| G2 | 没有环境自动自查 | **部分补上**：暴露面自检已周期运行并纳入防火墙状态 | 自查要覆盖的不止端口：认证、备份新鲜度、证书到期、磁盘水位、防火墙规则是否还在，都该有一个「今天这台机器健康吗」的统一结论 |
| G3 | 操作日志可被删改 | **未做** | 现有事件流与审批记录都存在同一台机器、同一个库里。攻击者拿到宿主后第一件事就是抹痕迹；能被删的日志在事后取证时等于没有 |
| G4 | 无自愈、备份不离机 | **部分补上**：周期备份已上线，但**只落在同一台机器上** | 同机备份挡得住误删，挡不住整机沦陷或磁盘损坏。这次真正致命的不是被清空，是清空之后**没有任何一份可用副本** |

四条的共同点：**它们都是「平时看不出缺失」的东西**。缺一份离机备份、缺一条自检、
缺一份不可删日志，系统在 99% 的日子里表现完全正常——只有出事那天才发现它们不在。
所以不能靠「想起来再补」，必须变成常设机制。

### 不在范围内

「资源公网 TCP 访问」是**有意**的对外暴露，且已强制要求非空 IP allowlist + 防火墙
兜底——它自己拼发布参数，不走上面这条收窄路径，也不该被收窄。那是本仓库唯一做对了的
暴露路径，改它只会破坏功能而不提升安全。

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