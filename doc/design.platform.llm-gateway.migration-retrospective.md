# LLM Gateway 全量迁移与生产发布复盘 · 设计

> **版本**：v1.1 | **日期**：2026-07-10 | **状态**：已落地
>
> **复盘范围**：从 GW 控制台账号与物理剥离交接，到协议路由、配置权威、生产 `full-http` 发布完成
> **生产环境**：`https://map.ebcone.net` | **最终发布提交**：`09a21f19611f9f4517ee4f8a73cd69c37fd3e6e1`

## 一、管理摘要

这次迁移已经完成了最重要的生产执行目标：MAP 的 AI 执行路径默认通过独立 `llmgw-serve`，生产运行在 `LLMGW_MODE=http`；GW 内部目录之外的直接上游客户端基线为空；active appCaller 使用 GW 自有模型池、平台、模型和 Exchange，MAP 配置 fallback 已关闭；GW 控制面、数据面、控制台和 MAP API 使用同一提交镜像发布。

本次成功不等于“全部配置权威已经迁移”或“所有网关旧代码都已删除”。`2026-07-10` 后续审计显示，生产 appCaller 为 `active=3`、`configured=15`、`disabled=1`；退场门只对 active caller 生效，configured/discovered caller 仍可能读取 MAP 路由配置。`inproc` 与 shadow 实现仍保留为回滚能力，最终 hotfix 没有再次执行高成本视频和 ASR canary。准确结论是：**生产 full-http 执行路径和 active appCaller 配置权威切换成功，可运行、可观测、可回滚；全部 caller 的配置权威、长期稳定性和若干协议治理债务尚未收口。**

最终 full-http 发布是在用户明确维护窗口下完成的快速切换。最终 release gate 将 `minCoverageHours`、`minPerApp`、`minTotal` 设为 `0`，全局 shadow 只有 5 条、覆盖约 `0.038h`。因此 gate 证明的是当次切换可运行和可回滚，不是原计划“长期窗口 + 每类样本”的稳定性证明。后续整改以 `plan.platform.llm-gateway-production-hardening.md` 为 SSOT。

任务持续时间过长是事实。对话中先后出现约 44 小时和 24 小时 8 分钟的连续目标运行记录，合计约 68 小时；用户将其概括为 60 小时。该数字混合了编码、CI、镜像构建、远程发布、上游等待、证据采样和反复修门禁，并不是 68 小时纯编码。更重要的是，本次没有从一开始维护逐事项计时台账，无法把每一分钟准确归属到子任务，这是执行管理缺陷。

## 二、四个直接结论

### 2.1 发布提交是否结束

**已结束。** 发布闭环证据如下：

| 证据 | 最终状态 |
|---|---|
| PR | [#1060](https://github.com/inernoro/prd_agent/pull/1060) 已合并 |
| `origin/main` 合并提交 | `09a21f19611f9f4517ee4f8a73cd69c37fd3e6e1` |
| 生产 health | `/gw/v1/healthz` 返回同一 commit，HTTP 200 |
| 生产镜像 | `api`、`llmgw`、`llmgw-serve`、`llmgw-web` 均为 `sha-09a21f196...` |
| 生产模式 | `LLMGW_MODE=http` |
| 配置退场门 | `LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS=true` |
| rollout ledger | `stage=http-full`、`status=success`，记录时间 `2026-07-10T08:37:36Z` |
| 回滚 | `rollback-rehearsal` 同 commit 成功；数据库无需回滚 |
| 数据备份 | `/root/backups/llmgw-prod-before-09a21f1-*` |

生产服务器的普通源码目录后来可能指向别的提交，不能用该目录的 `git rev-parse` 判断线上版本。线上版本的权威证据是运行容器 image tag、health commit 和 rollout ledger，三者当前一致。

### 2.2 生产出现了什么问题

生产问题不是一个单点故障，而是五类问题叠加：上游能力和凭据、生产发布基础设施、配置权威迁移、发布门禁设计、观测口径。

| 类别 | 生产现象 | 根因 | 最终处理 |
|---|---|---|---|
| 控制台账号 | `admin/admin` 一度失效或被未知口令覆盖 | 多环境共用账号集合，不同版本 seed 相互覆盖 | 账号、审计和 GW 日志迁入独立 `llm_gateway`；首登改密；环境变量只作 bootstrap/破玻璃 |
| 视频 | Seedance 404、`ModelNotOpen`、模型池无健康成员、渠道不可用 | 一度把火山 Ark OpenAI chat base URL 当成 OpenRouter `/videos` 协议；模型尚未开通 | 增加火山视频协议/Exchange 适配、平台协议 gate；用户开通后 submit、poll、download 曾实机通过 |
| ASR | `Invalid X-Api-Key`、WebSocket 401、502/503 | 凭据或资源绑定不完整，上游通道不可用 | 补 ASR pool、四个 appCaller 绑定和 multipart HTTP canary；后续四条 BigModel raw 路径曾返回 200 |
| 默认文本池 | smoke 命中额度耗尽的上游 | 默认 chat 池首选成员不可用 | 将已验证可用模型前置，保留其他候选作 fallback |
| 图片 vision | 一条 shadow `httpFail` | 历史参考图触发上游内容策略，不是文件 hash/rehydrate 故障 | 使用本轮生成的干净图片复验，vision allMatch；污染样本不冒充成功样本 |
| 生产 Git | 生产机无法稳定拉取 GitHub | 网络或上游访问限制 | 本地生成 Git bundle，上传后按不可变 commit 创建 release worktree |
| Compose | `mongodb` 被判断为未运行 | 命令使用了错误 compose project name | 固定 `COMPOSE_PROJECT_NAME=prd_agent`，与现有容器标签一致 |
| 源码树 | 生产脚本与 main 漂移，静态 audit 假失败 | 生产目录混合手工同步与旧源码 | 增加 tree precheck；最终使用独立 release worktree 和同 commit 脚本 |
| 发布顺序 | 新 commit 未部署，却要求 health 已等于新 commit | pre-deploy 与 post-deploy gate 顺序设计错误 | 拆分发布前证据门和发布后 health/smoke；修正 `full-http` gate 顺序 |
| 同提交证据 | hotfix commit 缺少自己的 shadow/config authority 记录 | gate 禁止旧 commit 证据搭车，但 hotfix 只改观测字段 | 在不扩大模型调用的前提下补同 commit 最小 shadow 和 no-op 配置权威证据 |
| 日志权威 | 控制台读到 MAP 库或旧日志 | GW 日志数据所有权尚未完全迁移 | 控制台日志改读 `llm_gateway` 权威库，MAP 日志继续归 MAP |
| smoke 污染 | 健康探针/兼容探针产生 `inproc` 行并阻塞业务 gate | gate 把探针日志当业务流量 | 增加 probe 标记并从业务覆盖 gate 排除 |
| Native transport | 请求实际经 HTTP，但日志显示 `inproc` | Native ingress 没在边界统一写 `GatewayTransport=http` | PR #1060 在 ingress 转换处强制标记 HTTP，并增加合同测试 |
| 控制台路径 | `/gw/logs` 被误当页面地址 | `/gw/*` 是受保护 API；SPA 实际挂在 `/llmgw/*` | 页面深链统一为 `/llmgw/logs`、`/llmgw/shadow` |

### 2.3 更改了哪些内容

最终变化覆盖六个层面：

| 层面 | 迁移前 | 当前生产状态 |
|---|---|---|
| AI 调用入口 | MAP 各服务可能直接构造上游 client | MAP 业务调用统一通过 `ILlmGateway`，直连 ratchet baseline 为空 |
| 网关执行 | 网关可作为 API 进程内 facade | 独立 `llmgw-serve` 接受跨进程 HTTP 请求 |
| 模型选择 | MAP 的 appCaller 与模型池配置参与长期权威 | active appCaller 由 `llm_gateway` 权威数据驱动；configured/discovered caller 仍可能读取 MAP 配置，尚待收口 |
| 协议入口 | 以 MAP 内部调用形态为主 | GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 统一转 Request IR |
| 多模态文件 | raw multipart 依赖同进程内联文件 | `MultipartFileRefs` 跨进程引用，serving rehydrate 并校验 size/hash |
| 实验语义 | ModelLab/Arena 可能直接调用指定上游 | 使用 pinned `platformId + modelId` 经过 GW，保留精确模型语义 |
| 日志与审计 | MAP/GW 数据边界混合 | MAP 保留业务日志；GW 在 `llm_gateway` 保存请求日志、shadow、登录和操作审计 |
| 控制台 | 主要是登录和基础日志 | Activity、详情、筛选、summary、shadow、appCaller、模型池、平台、模型、Exchange、审计、配置权威状态 |
| 发布 | 依赖人工命令和环境当前态 | 同 commit 镜像、备份、rollback rehearsal、release gate、protocol canary、smoke、rollout ledger |

### 2.4 架构变动了多少次

按“职责边界是否改变”统计，共发生 **4 次主要架构变动，形成 5 个状态**。页面样式、日志字段和门禁脚本修复不单独算架构变动。

| 状态 | 架构主线 | 关键变化 |
|---|---|---|
| V0 原始 MAP 内嵌 | MAP -> 上游 client | 模型池、密钥、调用、日志主要在 MAP 内部 |
| V1 统一 Gateway facade | MAP -> `ILlmGateway` -> 上游 | 先统一代码入口，但执行仍可在 API 进程内 |
| V2 物理剥离与 shadow | MAP -> HTTP/Shadow -> `llmgw-serve` | 控制面 `llmgw`、数据面 `llmgw-serve`、前端 `llmgw-web` 独立；可对比 inproc/http |
| V3 全量 HTTP 执行 | MAP -> `llmgw-serve` -> 上游 | 直连清零、pinned、multipart、所有主要业务类别进入跨进程网关 |
| V4 协议路由与部分配置权威 | 多系统 -> ingress adapters -> IR -> appCaller/router/GW pools -> provider adapters | 四协议统一入口；appCaller 被动注册；GW-owned 配置能力已具备；MAP fallback 对 active caller 关闭，其他状态尚待收口 |

这四次变化中，V1 到 V2、V3 到 V4 是最容易造成认知混乱的两次：前者把“统一代码入口”升级成“独立服务”，后者开始把“请求经过 GW”升级成“路由配置也归 GW”。用户后来明确提出模型池、appCaller 和四种协议必须由 GW 拥有，推动了 V4；V4 已改变 active caller 的数据权威和运行时路由，但还不是全部 caller 的最终目标态。

## 三、时间线与交付物

### 3.1 可核对的时间范围

| 指标 | 数值 | 说明 |
|---|---:|---|
| 代码活动窗口 | 2026-07-04 17:32 至 2026-07-10 15:56 CST | Git 可见的相关活动窗口，不代表持续工作时长 |
| 对话目标运行记录 | 约 44h + 24h08m | 合计约 68h，用户概括为 60h |
| 2026-07-07 至 07-10 搜索命中的合并 PR | 33 | 其中 #1004 是 changelog 熵减归档，剔除后约 32 个 GW 工作 PR |
| 首个大交付 PR #1011 | 125 个文件、12643 行新增 | 说明早期把实现、门禁、脚本和证据采集塞进了一个过大 PR |
| 最终 hotfix PR #1060 | 4 个文件、6 行新增、3 行删除 | 只修 Native transport 观测，不改变模型结果 |

仓库区间 diff 显示 321 个文件变化，但该区间混入了同期 main 的其他功能，不应拿它声称“本任务修改了 321 个文件”。本复盘只使用 PR、提交和生产证据可归属的范围。

两个长时间段只能按交付内容还原，不能精确拆成工时：

| 时间段 | 主要内容 | 为什么持续 |
|---|---|---|
| 前一目标约 44 小时 | 账号/数据域隔离、直连收口、pinned、multipart、多模态 shadow、视频/ASR/图片生产排障、发布 gate 建设 | 架构边界仍在变化；同时遇到模型未开通、协议误配、凭据和生产脚本漂移；门禁在执行中持续补建 |
| 最后一目标 24 小时 8 分钟 | 合入最新 main、四协议入口与配置权威收口、32 个相关 PR 的 CI/合并、生产备份与回滚演练、full-http 发布、Native transport hotfix | 生产 gate 串行暴露 false blocker；同 commit 证据、日志权威、探针污染、compose/Git 环境均需要逐项修正 |

因此“44 小时 + 24 小时”不是两个单独的编码功能，而是前半段建设能力与排查上游，后半段完成协议架构和生产闭环。由于没有逐事项计时器，无法再向下给出可信的分钟级分配。

### 3.2 阶段时间线

| 阶段 | 主要工作 | 代表 PR/证据 | 结果 |
|---|---|---|---|
| 账号与数据域 | admin 首登改密、独立 `llm_gateway`、GW 日志/审计分库 | 早期交接、full-cutover S0.5 | 解决跨环境账号覆盖和日志权威混乱 |
| 全量调用收口 | pinned model、Program/ModelDomain/ModelLab/Arena 走 GW、direct baseline 归零 | #1011 及 ratchet tests | MAP 业务代码无已知直接上游 client |
| 多模态跨进程 | 图片、图生图、多图、vision、视频、ASR raw/multipart HTTP 化 | #1011、生产 shadow/canary | 主要多模态具备跨进程能力 |
| 生产安全基座 | 备份、回滚、same-commit evidence、预算限制、状态板 | #1012、#1015、#1018-#1029 | 发布可审计，但 PR 数量过多 |
| 协议路由目标 | 四协议入口、Request IR、appCaller、GW pool authority | #1039-#1045 | 从“经过 GW”升级为“由 GW 治理” |
| 生产 gate 修正 | 顺序、日志库、探针污染、协议 coverage、nginx 路由、policy、metadata | #1047、#1049-#1059 | 清除生产 false blocker 和真实配置漂移 |
| 最终 full-http | Native transport 修复、备份、回滚演练、同 commit canary、发布 | #1060、rollout ledger | `http-full success` |

## 四、为什么耗时超过 60 小时

### 4.1 任务范围连续扩大

最初主线包含控制台对齐和全量迁移，随后又加入账号独立库、首登改密、OpenRouter 风格、生产发布、视频/ASR、模型池归 GW、四协议入口、配置权威和完整架构说明。这些要求彼此相关，但不是一个正常大小的单次改动。

正确做法应该是在架构裁决后冻结边界，再按 4 至 6 个可独立验收的里程碑推进。本次前半程边做边改变目标架构，导致旧文档、旧 gate 和旧实现反复失效。

### 4.2 发布门禁是在发布过程中补出来的

本次不是拿成熟发布系统执行迁移，而是在迁移期间同时建设：

1. same-commit 证据约束；
2. shadow coverage 和低成本 seed；
3. provider readiness；
4. 配置权威报告；
5. runtime gates；
6. protocol canary；
7. rollback rehearsal；
8. rollout ledger。

因此出现了“修好一个门，再暴露下一个门”的串行循环。门禁本身有价值，但不应在生产窗口内以 20 多个小 PR 的方式逐个发现和修正。

### 4.3 外部上游问题被误当成迁移问题反复追查

视频模型未开通、火山 Ark 与 OpenRouter 视频协议不一致、APIyi 渠道不可用、ASR key 无效、默认文本池额度耗尽、历史图片触发内容策略，这些问题有的属于上游配置，有的属于产品数据，不都属于 GW 代码。

早期没有先做一次“平台协议 + 模型开通 + 凭据 + 预算”的静态审计，导致同一视频链路被多次真实调用。用户看到高额费用但看不到进度，是因为调用次数和证据状态没有在一张持续更新的任务表里透明展示。

用户在对话中反馈模型费用或欠费接近 100 美元。本复盘没有供应商账单读取权限，不能把该金额当作已核验财务数据；但“重复付费 canary 缺少透明预算和停止条件”已经被生产操作记录证实，是必须承担并修正的执行问题。

### 4.4 生产环境存在多重漂移

生产源码树、运行容器、main、手工同步脚本和 compose project 曾经不是同一个权威来源。每次诊断前都要先回答“现在究竟运行哪份代码”，耗费大量时间，也制造了假失败。

最终采用不可变 commit release worktree、同 commit image tag、health commit 和 ledger 三重校验后，这个问题才收敛。

### 4.5 证据策略过度保守，后来又被要求快速全切

计划原定 7 天或每类 30 样本，再按 allowlist 观察；用户后来明确要求维护窗口内先全量切换并立即验证。两种策略都合理，但目标中途切换后，旧的 24 小时/30 样本 gate 与新的快速发布目标冲突，产生了 waiver、out-of-order 和最小同 commit 补证据流程。

这类策略改变应该形成一次明确的变更裁决，统一修改 gate，而不是保留旧 gate 后逐项绕开。

### 4.6 缺少持续可见的事项与计时台账

本次没有从第一小时开始维护“事项、状态、耗时、模型调用次数、费用、下一动作、停止条件”表。虽然文档中后来增加状态板和预算 planner，但用户侧看到的是长时间运行和大量请求，而不是稳定的完成百分比。

这是最直接的过程问题。以后超过 2 小时或涉及生产的任务，必须持续维护下表：

| 事项 | 状态 | 已用时 | 外部调用次数/预算 | 当前阻塞 | 下一步 | 停止条件 |
|---|---|---:|---:|---|---|---|
| 示例：协议 canary | 进行中 | 20m | 2/4，预算上限 4 | Claude 入口 500 | 查一次日志后修复 | 4 协议各 1 次成功即停止 |

## 五、为什么这次算成功

“成功”不是因为页面能打开，也不是因为代码合并，而是以下独立证据同时成立。

### 5.1 代码与路由

| 验收项 | 证据 | 结论 |
|---|---|---|
| MAP 网关外直连 | `GatewayDirectClientRatchetTests` 三类 baseline 均为空 | 通过 |
| pinned model | 精确 platform/model 经 GW，不被默认池覆盖 | 通过 |
| multipart | file refs 跨进程 rehydrate，size/hash 校验 | 通过 |
| 四协议入口 | GW Native、OpenAI、Claude、Gemini canary 各 HTTP 200 | 4/4 通过 |
| Native transport | ingress 强制写 `GatewayTransport=http` | PR #1060 修复并有合同测试 |

### 5.2 配置权威

最终 config-authority 证据：

| 指标 | 值 |
|---|---:|
| `status` | `ready` |
| `mapFallbackObjectsRemaining` | 0 |
| `activeAppCallerMapFallbackReady` | true |
| `activeMissingGatewayPool` | 0 |
| `activeBoundPoolWithoutUsableMember` | 0 |
| `LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS` | true |

这组数据证明 active appCaller 不再依赖 MAP 模型池配置兜底。MAP 仍携带业务上下文和生命周期，但不再是 active AI 路由配置的权威。

后续只读审计补充：生产 appCaller 状态为 `active=3`、`configured=15`、`disabled=1`。上述 readiness 指标只覆盖 active caller，不能外推为所有 configured/discovered caller 已经退出 MAP。切换后 `report-agent.generate::chat` 至少有 35 条 HTTP succeeded，但它当时仍为 configured；这证明执行 transport 已经切换，不能单独证明模型池权威已经迁移。

### 5.3 生产运行态

| 验收项 | 结果 |
|---|---|
| health commit | `09a21f196...`，连续 3 次稳定 200 |
| 生产 mode | `http` |
| 四个应用镜像 | 同一 `sha-09a21f196...` |
| GW smoke | 7/7 通过 |
| release gate | `verdict=pass`、`failures=[]` |
| protocol canary | `verdict=pass`，最多 4 次真实调用，实际四协议各一次 |
| rollout ledger | `http-full success` |
| 回滚演练 | 同 commit `rollback-rehearsal success` |

release gate 的长期证据门在最终维护窗口被显式豁免：`minCoverageHours=0`、`minPerApp=0`、`minTotal=0`。因此本节只能证明发布时点的运行、同提交和回滚闭环，不能证明 24 小时或 7 天稳定性已经完成。

### 5.4 数据安全与可回滚

发布前备份了 `prdagent` 和 `llm_gateway`。回滚只需要把 API 的 mode 改回 `inproc` 并重启，不需要回滚数据库；因此运行路径回滚不会丢失已经迁移的 GW 配置和日志。

## 六、当前架构与目标架构

### 6.1 当前生产架构

```text
MAP 业务生命周期
        |
        v
   ILlmGateway
        |
        v
 llmgw-serve HTTP
        |
        +--> active caller ----------> GW-owned router/pool
        |
        +--> configured/discovered --> 仍可能读取 MAP 路由配置
        |
        v
 provider adapter -> 上游模型
```

当前已经完成执行路径独立化，但配置权威按 appCaller 状态分叉。`transport=http` 只能证明请求经过 GW，不能证明最终模型池一定来自 GW。

### 6.2 目标架构

```text
MAP 前端 / MAP Agent / 外部系统
                |
                | MAP 业务协议或兼容协议
                v
        LLM Gateway ingress adapters
        - GW Native
        - OpenAI-compatible
        - Claude-compatible
        - Gemini-compatible
                |
                v
          Gateway Request IR
                |
                v
  appCaller registry + parameter policy
                |
                v
       GW router: auto / pool / pinned
                |
                v
 GW-owned pools / models / platforms / exchanges / keys
                |
                v
          provider adapters
                |
                v
              上游模型
```

数据所有权：

| MAP 保留 | LLM Gateway 拥有 |
|---|---|
| 会话、业务 run、画布、素材、报告、工作流、用户状态 | appCaller registry、路由策略、模型池、平台、模型、Exchange、key |
| MAP 业务日志和业务状态机 | GW 请求日志、shadow、登录审计、操作审计、provider attempts |
| `requestId/sessionId/runId/appCallerCode` 关联字段 | 同一组关联字段，用于跨系统追踪 |

目标态要求 discovered、configured、active 的正常路由全部只读 GW 配置；MAP fallback 仅允许存在于迁移工具或破玻璃回滚流程。

## 七、仍然存在的边界

| 边界 | 当前事实 | 风险 | 后续动作 |
|---|---|---|---|
| 配置权威只覆盖 active caller | 审计快照为 `active=3`、`configured=15`、`disabled=1` | HTTP 日志可能掩盖 MAP 模型池仍参与路由 | 按 `plan.platform.llm-gateway-production-hardening.md` 完成全 caller GW-owned 绑池和 MAP 读取退场 |
| 长期证据门被维护窗口豁免 | 最终 gate 的覆盖时长和样本阈值均为 0 | 发布成功可能被误读成长期稳定性已证明 | 保留发布结论，但另建稳定性观测，不重复高成本全量 canary |
| 模式缺失默认 inproc | 启动配置和 compose 仍有 inproc 默认值 | 后续发布漏配时静默回退旧架构 | 生产缺少显式 http 时 fail-closed，回滚使用独立破玻璃动作 |
| GW 数据与 serving 运维能力不足 | 关键集合索引少、日志无限保留、health 浅、serving 单实例 | 数据增长、依赖故障和单点故障可能晚发现 | 按生产加固计划补索引、保留期、readiness 和冗余 |
| `inproc`/shadow 源码仍存在 | 作为生产回滚通道保留 | 未来开发可能误用 | 稳定至少 7 天后另开清理任务；删除前保留版本级回滚 |
| 最终 hotfix 未重跑视频/ASR canary | 为避免重复费用，`09a21f1` 阶段显式跳过 | 不能声称视频/ASR 在最终 commit 做了同提交重新取证 | 没有相关代码变化时不重复烧钱；下次改适配器时每 provider 最多一次受控复验 |
| 视频/ASR 早期证据 | 2026-07-07 曾完成 Seedance submit/status/download 和四条 ASR raw 200 | 上游开通和余额会随时间变化 | 生产监控发现真实失败时再定向复验 |
| 高级协议保真 | OpenAI Responses、Claude/Gemini 更完整原生事件仍有边界 | 外部系统使用高级字段时可能降级 | 继续跟踪 `debt.llm-gateway-protocol-fidelity.md` |
| 探针 `inproc` 日志 | client-stream 兼容探针可产生非业务 `inproc` 行 | 容易被误读为 MAP 业务回退 | 控制台默认按 probe 标记排除，保留诊断筛选 |
| shadow 采样 | 生产当前 `ShadowFullSamplePercent=0` | 不再持续产生成本翻倍的 shadow 数据 | 仅在受控诊断窗口按 appCaller 开启 |

因此不得使用以下夸大表述：

- “所有 inproc 代码已经删除”；
- “所有 appCaller 的模型池配置都已经归 GW”；
- “最终 release gate 已经证明 24 小时或 7 天稳定性”；
- “最终提交重新测试了所有视频和 ASR provider”；
- “所有 OpenAI/Claude/Gemini 高级字段都与原生 API 完全等价”。

可以使用的准确表述是：

> LLM Gateway 已完成生产 full-http 执行路径和 active appCaller 配置权威切换；MAP 业务调用无已知直连，四协议基础入口与核心发布闭环通过，系统具备备份、观测和回滚能力。全部 caller 配置权威与长期稳定性仍按生产加固计划收口。

## 八、经验与以后必须改变的做法

### 8.1 架构先冻结

实现前一次性确认四个边界：谁拥有业务生命周期、谁拥有 appCaller、谁拥有模型池、谁拥有日志。未冻结前只写 SSOT 和验证原型，不进入生产脚本开发。

### 8.2 门禁先离线自测

发布 gate 必须先在本地 fixture 和预览环境证明：成功路径能通过、失败路径会拦截、hotfix 同 commit 场景不会形成先有鸡还是先有蛋。生产只消费成熟 gate，不在维护窗口现场发明 gate。

### 8.3 每种付费能力设置硬预算

视频、图片、ASR 的 canary 默认每 provider 一次；失败后先诊断日志和配置，不自动重复。再次调用必须说明“上一次失败原因已改变什么”，否则停止。

### 8.4 生产只有一个发布权威

禁止在长期工作树内混合手工同步脚本。每次发布使用：不可变 commit、独立 release worktree、同 commit images、health commit、ledger。四者任何一个不一致都停止。

### 8.5 进度表必须持续更新

超过 30 分钟的任务每 30 至 60 分钟更新一次；超过 2 小时必须显示事项百分比、累计用时、外部调用次数和下一停止条件。遇到连续 3 次同类失败，应暂停执行并汇总根因，而不是继续试。

### 8.6 PR 数量要有上限

同一生产目标建议控制为：协议核心、配置权威、控制台、发布 gate、生产 hotfix，最多 5 至 6 个主 PR。小修先在分支内收敛并通过测试，再合成一个可审查 PR；避免 30 个 PR 让状态和依赖关系失去可读性。

## 九、验收入口与证据位置

生产控制台正确入口：

- Activity：`https://map.ebcone.net/llmgw/logs`
- Shadow：`https://map.ebcone.net/llmgw/shadow`
- Health：`https://map.ebcone.net/gw/v1/healthz`

注意：`https://map.ebcone.net/gw/logs` 是控制台后端 API，未登录返回 401 是正确行为；它不是页面深链。

生产机发布证据：

- release worktree：`/root/inernoro/prd_agent_release_09a21f1`
- 最终证据目录：`.llmgw-release-evidence/20260710T083403Z_http-full_09a21f19611f.*`
- rollout ledger：`.llmgw-release-evidence/rollout-ledger.jsonl`
- 发布前备份：`/root/backups/llmgw-prod-before-09a21f1-*`

## 十、行业实践对照

| 维度 | 行业成熟做法 | 当前状态 | 差距 |
|---|---|---|---|
| 控制面与数据面 | 配置治理和热请求执行隔离 | `llmgw` 与 `llmgw-serve` 独立 | 已达到核心要求 |
| 不可变发布 | commit、镜像、health、ledger 可相互追溯 | 四项同 commit，另有 release worktree | 已达到核心要求 |
| 统一协议入口 | 多协议适配为内部 IR，再由 router/provider adapter 处理 | 四入口和统一 IR 已落地 | 高级原生事件仍需补齐 |
| 配置权威 | 网关拥有 caller、pool、provider、key 和审计 | active caller 已退出 MAP fallback | configured/discovered caller 仍可能读取 MAP，尚未达到全量目标态 |
| 渐进发布 | shadow、allowlist、按风险逐批切换 | 工具齐全，但本次因维护窗口改为全量切后验证 | 流程执行与原计划存在偏离 |
| 成本治理 | canary 有调用上限、预算、去重和停止条件 | 最终协议 canary 限制为 4 次；早期视频测试控制不足 | 需要把预算护栏前置为默认规则 |
| 进度治理 | 每个工作项有 owner、耗时、状态和阻塞 | 后期有状态板，早期缺逐项计时 | 需要固定任务台账和熔断机制 |

优先补齐项以 `plan.platform.llm-gateway-production-hardening.md` 为执行 SSOT：

1. **P0 - 运维止血**：先处理磁盘与备份保留，再扩大任何生产变更。
2. **P0 - 路由权威收口**：清理重复 appCaller，所有正式 caller 只读 GW-owned 路由。
3. **P1 - 正确性与可用性**：修复健康写库、生产 mode fail-open、readiness、索引和对象生命周期。
4. **P1 - 成本与安全**：补原子预算、取消、非幂等保护和接入方独立 key。
5. **P2 - 协议保真**：按真实需求受控验证高级能力，不用重复付费请求追求表面覆盖。

## 十一、关联文档

- `doc/plan.llm-gateway.full-cutover.md`：全量迁移发布 gate、测试矩阵和生产取证原始记录
- `doc/plan.platform.llm-gateway-protocol-router.md`：四协议入口、Request IR、appCaller 和 GW 模型池目标态
- `doc/plan.platform.llm-gateway-production-hardening.md`：生产隐性风险、架构收口顺序、完成 gate 和进度 SSOT
- `doc/design.llm-gateway-physical-isolation.md`：控制面、数据面和跨进程 serving 物理剥离
- `doc/debt.llm-gateway.md`：保留的运行和清理债务
- `doc/debt.llm-gateway-protocol-fidelity.md`：协议高级字段保真边界
