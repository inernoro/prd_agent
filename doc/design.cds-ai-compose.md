# CDS AI 起草 cds-compose · 设计

| 字段 | 内容 |
|---|---|
| 类型 | design（How / 技术设计） |
| 版本 | v1.0 |
| 日期 | 2026-06-01 |
| 状态 | draft |
| 模块 | CDS（mini-PaaS）/ 项目接入（onboarding）/ cds-compose 契约 |
| 关联 | `doc/spec.cds-compose-contract.md`、`doc/design.cds-agent-runtime-architecture.md`、`doc/design.cds-agent-api.md`、`doc/debt.cds-agent.md` |

---

## 1. 管理摘要（30 秒）

**要解决什么问题**：用户把一个新仓库接入 CDS 时，需要一份 `cds-compose.yml` 来描述「这个项目怎么跑」（用哪个镜像、监听哪个端口、装/构建/启动命令、依赖哪些基础设施）。今天这一步由确定性的栈探测器（stack-detector）自动生成，覆盖 8 种主流技术栈；但遇到非标准目录结构、自定义构建链、混合多服务的仓库时，探测结果可能不完整，用户要手动补全 YAML，门槛偏高。

**提出什么方案**：在「确定性探测」之外，**增加一条可选的 AI 起草路径**。用户可以选择让 AI 阅读仓库的文件树与清单信号（package.json、Dockerfile、go.mod 等），起草一份 `cds-compose.yml` **草稿** + 每个字段的理由 + 置信度，呈现在可视化编辑器里供用户确认或修改，**确认后才应用**。AI 起草是「锦上添花」，不是「另起炉灶」。

**业务价值**：把「看不懂 YAML、不知道怎么写」的用户也接进来；对老手则是省去手敲样板的草稿起点。它降低接入门槛，但不改变 CDS 的部署契约与安全边界。

**范围与定位**：本能力是**次要的、可选的、用户可开关的**。可视化编辑与基础设施编排才是接入体验的主线（本文不展开，见相关文档）；AI 起草是这条主线上的一个「自动填稿」按钮。**默认关闭**，**确定性探测器始终是默认路径，也是 AI 不可用 / 用户不开启时的兜底**。

**风险一句话**：AI 可能编造不存在的镜像、端口或命令——所以草稿在应用前**强制过 `cdscli verify`**，有 ERROR 一律拦截；仓库内容外发给模型属敏感操作，所以**必须用户显式授权 + 内容脱敏**。

---

## 2. 产品定位

### 2.1 它在 CDS 里的位置

CDS 是一个分支预览部署工具（mini-PaaS）。接入一个项目的核心链路是：

> 选 GitHub 仓库 → 创建项目 → clone → **detect stack** → 自动生成 BuildProfile / compose → 分支预览。

本设计只增强其中的「生成 compose」一环，给它加一条可选支线。三种生成方式按优先级排列：

| 路径 | 触发 | 角色 | 何时用 |
|---|---|---|---|
| 确定性探测（stack-detector） | 默认，自动 | **主路径 / 兜底** | 仓库结构标准，能高置信识别 |
| 用户手写 / 编辑 | 任意时刻 | 最终裁决 | 用户最懂自己的项目 |
| **AI 起草草稿（本设计）** | **用户显式开启** | **可选辅助** | 结构非标、探测不全、想要一个起点 |

### 2.2 一句话边界

> AI 不替代探测器，AI 起一份「初稿」；探测器永远在，既是默认也是 AI 缺席时的兜底；用户永远是最后按下「应用」的人。

这条边界呼应仓库的「无根之木禁令 & 借用法则」（`.claude/rules/no-rootless-tree.md`）：CDS **不自建一套 LLM 能力栈**，而是借用系统里已经存在的 CDS Agent 运行时；AI 起草这棵树的「根」是「确定性探测 + 用户确认 + cdscli 校验」，AI 只负责在这三者之间填一段可被推翻的稿子。

---

## 3. 用户场景

### 场景 A：标准仓库（AI 不参与，今天的体验）

用户接入一个标准 Vite + React 仓库。探测器高置信识别，自动生成 compose，分支预览跑起来。用户从未看到 AI 入口，行为与今天**完全一致**。这是默认路径，必须保持零回归。

### 场景 B：非标仓库，用户主动求助 AI

用户接入一个「前端在 `web/`、后端在 `api/`、还带一个自定义 entrypoint 脚本」的混合仓库。探测器只识别出前端，后端标记为 `manualSetupRequired`。用户在编辑器里看到一个「让 AI 帮我起草」按钮（仅在已开启该能力时出现），点击后：

1. 界面流式显示阶段：「扫描仓库 → 询问模型 → 生成草稿 → 校验」；
2. AI 产出完整 compose 草稿，每个 service / 端口 / 命令旁标注「理由」和「置信度」；
3. 草稿先在本地过一遍 `cdscli verify`，预览里直接显示 ERROR / WARNING / 评分；
4. 用户逐字段核对，改掉 AI 猜错的端口，删掉多余的 infra，然后点「应用」；
5. 应用时**再次** `cdscli verify`，无 ERROR 才落库。

### 场景 C：AI 不可用 / 用户没开启

AI 起草开关关闭，或系统侧 CDS Agent 运行时不健康。界面**不显示** AI 入口（或显示为灰态 + 一句「未启用 / 运行时不可用」说明），用户照常走探测器 + 手动编辑。**任何时候 AI 失败都不阻断接入**——这是「兜底」的硬要求。

---

## 4. 核心能力

1. **可选起草，不改默认**：探测器的输出始终先生成；AI 起草是叠加在其上的「重写建议」，用户可接受、可丢弃、可逐字段合并。
2. **用户可配（开关 + 选模型）**：项目级开关决定「这个项目能不能用 AI 起草」；系统级开关 + 模型选择决定「整个 CDS 实例有没有这个能力、用哪个模型」。两级关闭时，行为精确等于今天的确定性探测。
3. **人在回路（Human-in-the-loop）**：AI 只产出**草稿 + 理由 + 逐字段置信度**，永不自动应用。草稿强制经过可视化 compose 编辑器由人确认/编辑。
4. **算/发两阶段分离**：「生成草稿」（compute）与「应用到项目」（send）是两个独立步骤；应用步骤重新跑 `cdscli verify`，遇 ERROR 阻断。
5. **强制契约对齐**：草稿必须符合 `spec.cds-compose-contract.md` 的字段契约，并通过 `cdscli verify` 的评分门禁，杜绝「AI 写了 CDS 跑不了的 YAML」。
6. **全程可视、禁止空白等待**：起草过程通过流式事件推送四个阶段进度（对齐 CLAUDE.md 规则 #6）。

---

## 5. 架构

### 5.1 关键事实：CDS 今天怎么调 LLM（Phase 1 调研结论）

这是本设计的地基，必须说清楚，否则会画出一棵无根之木。调研结论如下：

**CDS 自身（`cds/src`）没有任何原生 LLM 客户端。** 全量 grep `openrouter|anthropic|sk-ant|llm|gateway|model` 后确认：`cds/src` 里与「模型」相关的代码只有 `cds/src/routes/remote-hosts.ts` 的 Agent 会话端点，它**接收** `runtime` / `modelBaseUrl` / `modelApiKey` / `model` 等参数（`remote-hosts.ts:606-636`），把它们连同会话一起转交给一个**远程 sidecar 容器**去执行，CDS 进程本身从不发起对模型 API 的 HTTP 调用（`grep "fetch('https://api.openai|anthropic|openrouter'"` 在 `cds/src` 命中 0 条）。

**那个出现在测试里的 `https://openrouter.ai/api` 是什么？** 它只是 `cds/tests/routes/remote-hosts-instances.test.ts`（如 `:635`、`:756`、`:1019`）里给 Agent 会话造的一个 **runtime profile 夹具值**——一个会被原样转发给 sidecar 的 `modelBaseUrl` 字符串。CDS 并不在自己进程里「配置 OpenRouter」，也不直接调它。OpenRouter 作为 baseUrl，是由 **MAP / prd-api 侧的 runtime profile** 决定并下发的（profile 模型见 `doc/design.cds-agent-api.md` 的 `POST /api/infra-agent-runtime-profiles`）。

**真正能发起 LLM 调用的能力在哪里？** 在 prd-api 侧的 CDS Agent 运行时，有两条真实路径：

- **Lite 只读模式（现成、最稳）**：`GatewayReviewRuntimeAdapter` 走 prd-api 的 `ILlmGateway` 默认 chat 池，做有界只读分析，无需任何 Anthropic key 即可跑（见 `doc/debt.cds-agent.md` D1/D2、`prd-api/.../AgentRuntime/GatewayReviewRuntimeAdapter.cs`）。
- **官方 `claude-agent-sdk` 模式（商业级、有门禁）**：sidecar 内用官方 `claude-agent-sdk`（解析版本 `0.2.82`，见 `doc/design.cds-agent-official-sdk-adapter.md` §8）跑带工具/审批的 agent loop，但需要有效的 Anthropic / Claude-compatible runtime profile 才放行（债务 D1，未闭合）。

**结论（诚实版）**：CDS **现在不能在自己进程里直接调一个 LLM**。它要触达模型，只能经由「CDS Agent 运行时」这条链路；这条链路的真正模型客户端运行在 prd-api 侧（Lite 用 `ILlmGateway`）或 sidecar 内（官方 SDK）。因此本设计**面向 Lite / ILlmGateway 这条已经可用、零外部 key 依赖的路径来设计**，把官方 SDK 模式列为可选升级。

### 5.2 借用而非重建（数据流）

基于上述事实，AI 起草的执行链路**借用**现有 CDS Agent 运行时，CDS 只新增一层薄薄的「编排 + 校验」胶水，绝不新写模型客户端：

```text
用户（CDS Web 编辑器）
  -> CDS: POST /api/projects/:id/ai-compose-draft        [CDS 控制面：本设计新增]
       1) 扫描仓库：复用 stack-detector 的探测结果 + 采集文件树/清单信号（确定性，无 LLM）
       2) 组装 prompt（含契约约束 + 脱敏后的信号）
       3) 询问模型：通过 CDS Agent 运行时发起一次「文本生成」任务
            -> CDS Agent 控制面（prd-api / MAP 侧）
                 -> Lite: ILlmGateway 默认 chat 池          [真正的模型客户端，借用]
                 -> 或官方 claude-agent-sdk sidecar（可选升级）
       4) 解析模型输出为 compose 草稿对象
       5) 校验：本地跑 cdscli verify（确定性，无 LLM）
  <- 流式返回：阶段进度 / 草稿 yaml / 理由 / 逐字段置信度 / verify 预览
```

「CDS 只做编排 + 校验」是关键：第 1 步（扫描）和第 5 步（校验）都是 CDS 已有的确定性能力，第 3 步（模型调用）整段委托出去。万一委托失败，CDS 手里还攥着第 1 步的确定性探测结果，可以无缝退回主路径——这就是「根」。

### 5.3 官方 / 自研边界（按 `.claude/rules/agent-runtime-sdk-boundary.md`）

不得把任何环节夸大为「官方 SDK 集成」。精确边界如下：

| 层 | 归属 | 是官方还是自研 |
|---|---|---|
| 模型客户端 / 一次文本生成调用 | Lite 走 prd-api `ILlmGateway`；升级走 sidecar 内官方 `claude-agent-sdk@0.2.82` | **借用既有能力**；Lite 是自研 Gateway，官方 SDK 仅在升级路径出现 |
| Agent turn loop / 上下文 | Lite 为单次短调用（无多轮 loop）；官方路径由 `claude-agent-sdk` 负责 | 自研侧不再写第二套 loop |
| 仓库扫描 / 文件树 / 清单信号 | CDS `stack-detector` + 文件遍历 | **CDS 自研，确定性** |
| 草稿契约校验 | `cdscli verify`（`.claude/skills/cds/cli/cdscli.py`） | **CDS 自研，确定性** |
| 起草编排 / 流式进度 / 应用落库 | 本设计新增的 CDS 控制面端点 | **CDS 自研胶水** |
| runtime profile / 模型选择 / 凭据 | MAP / prd-api 侧 runtime profile | 既有控制面 |

一句话：**本设计不提供新的「模型 API 客户端」，它提供的是「扫描 → 委托既有运行时 → 校验」的胶水**。涉及模型的部分一律借用，措辞上只称「通过 CDS Agent 运行时发起一次文本生成」，不称「集成了官方 SDK」。

### 5.4 与 compute-then-send 的对应（按 `.claude/rules/compute-then-send.md`）

虽然该规则的强制 glob 面向 prd-api 的 C# 代码，但其「算/发分离」思想在本设计里同样成立，且映射到产品层面的两个动作：

- **算（compute）= 生成草稿**：`POST /api/projects/:id/ai-compose-draft` 只计算出一份草稿对象 + 校验预览，**不写任何项目状态**。它是纯产出，可重试、可丢弃。
- **发（send）= 应用草稿**：用户确认后调用既有的 compose 应用入口（写 `cds-compose.yml` / 触发 detect-profile）。应用阶段**不再重新询问模型**，只接收已确认的草稿，并**重跑一次 `cdscli verify`**，有 ERROR 则拒绝落库。

这样就避免了「发送阶段又算一次、把用户改过的草稿覆盖掉」这一类反模式：应用阶段拿到的就是用户最终确认的 YAML，模型不再有第二次插手机会。

---

## 6. 数据设计

### 6.1 配置项（用户可配，区分系统级 / 项目级，按 `cds/.claude/rules/scope-naming.md`）

作用域判定遵循 CDS 命名规范：「换个项目还有没有意义」决定它放系统级还是项目级。

| 配置 | 作用域 | 默认 | 含义 |
|---|---|---|---|
| AI 起草能力总开关 | **系统级**（CDS 系统设置） | 关 | 整个 CDS 实例是否启用 AI 起草。关闭时所有项目都看不到入口 |
| 起草使用的模型 / runtime profile | **系统级**（CDS 系统设置） | 系统默认 chat 池 | 选择哪个模型，沿用现有 runtime profile 概念，不新建模型管理 |
| 仓库内容外发授权 | **项目级**（项目设置） | 未授权 | 该项目是否允许把（脱敏后的）仓库信号发给模型 |
| 本项目允许 AI 起草 | **项目级**（项目设置） | 跟随系统默认 | 单项目可关闭，即使系统级开启 |

系统级开关存于 CDS 顶层状态（与自更新、集群同级），项目级开关存于 `Project`（多租户友好）。**任一开关为关，行为精确等于今天的确定性探测器**，不产生任何 LLM 调用、不外发任何仓库内容。

### 6.2 草稿对象（不落业务库，临时产物）

草稿是一次性计算产物，随响应返回，不写持久化业务集合（落库的是用户确认后的 `cds-compose.yml` 本身）。其形态围绕「契约 + 可解释 + 可校验」：

- `yaml`：符合 `spec.cds-compose-contract.md` 的 compose 文本；
- `rationale`：整体起草思路（为何这样拆 service、为何选这些 infra）；
- `fieldConfidence`：逐字段置信度数组，每项含字段路径、置信度、依据信号、是否猜测；
- `verifyPreview`：本地 `cdscli verify` 的结构化结果（issues 分级 + score + grade）；
- `detectorBaseline`：本次起草所基于的确定性探测结果（让 UI 能 diff「探测器 vs AI 草稿」）。

`fieldConfidence` 是 human-in-the-loop 的核心：低置信字段（如 AI 猜的端口）在编辑器里高亮提示用户重点核对。

---

## 7. 接口设计

### 7.1 起草端点（compute 阶段）

新增项目级端点，遵循 CDS API 作用域规范（项目级走 `/api/projects/:id/*`）。它只计算草稿，不改项目状态。

```
POST /api/projects/:id/ai-compose-draft
```

请求体（关键字段）：

- `fileTree`：仓库文件树（路径列表 + 关键清单文件内容，脱敏后）；
- `manifestSignals`：探测器已采集的清单信号（package.json deps、go.mod、Dockerfile 存在性等）；
- `userHint`（可选）：用户一句话提示，如「后端在 api/，用 8080 端口」。

该端点**必须流式返回**（SSE），对齐 CLAUDE.md 规则 #6「禁止空白等待」。事件按四个阶段推进，让用户在等待时屏幕持续有变化：

| 阶段事件 | 含义 |
|---|---|
| `stage: scanning` | 扫描仓库 / 复用探测结果（确定性，无模型，秒级） |
| `stage: asking-model` | 询问模型（带所选模型名，明确「是这个模型在想」） |
| `stage: drafting` | 逐块产出草稿（模型文本增量，打字效果） |
| `stage: verifying` | 跑 cdscli verify，回填 issues + score |
| `done` | 完整草稿对象 + verify 预览 |
| `error` | 结构化错误（运行时不可用 / 未授权 / 模型失败），并提示「已退回确定性探测」 |

`asking-model` 与 `drafting` 两个阶段直接复用 CDS Agent 运行时已有的流式事件（`text_delta` 等，见 `doc/design.cds-agent-api.md` 事件 schema），CDS 只做阶段归类与转译。

### 7.2 应用（send 阶段，复用既有入口）

应用**不新增 AI 专用写接口**，直接复用 CDS 既有的 compose 落库 / detect-profile 流程（`POST /api/projects/:id/clone` 链路已负责 clone 后 detect/profile；compose 写入走既有项目设置入口）。应用前置条件：

1. 入参是**用户在编辑器里最终确认的 YAML**（可能已手改），不是 AI 原始草稿；
2. 落库前**重跑 `cdscli verify`**，有 ERROR 一律拒绝（与 `--apply-to-cds` 的现有门禁一致，见 `spec.cds-compose-contract.md` §4）；
3. 应用阶段**不调用模型**。

---

## 8. 关联文档

- `doc/spec.cds-compose-contract.md`：cds-compose 字段契约与 `cdscli verify` 规则（评分 / 自愈），草稿必须符合此契约——本设计的「校验」环节即引用它。
- `doc/design.cds-agent-runtime-architecture.md`：CDS Agent 运行时架构（控制面 vs sidecar vs runtime pool），本设计借用其运行时。
- `doc/design.cds-agent-api.md`：CDS Agent / runtime profile / 会话事件 API 契约，本设计的「询问模型」复用其事件流。
- `doc/debt.cds-agent.md`：Lite 模式能力边界（D1/D2/D4），本设计默认依赖 Lite 这条已可用路径。
- `cds/src/services/stack-detector.ts`：确定性探测器（`detectStack` / `detectModules` / `StackDetection`），始终是默认路径与兜底。
- `.claude/rules/no-rootless-tree.md`、`.claude/rules/compute-then-send.md`、`.claude/rules/agent-runtime-sdk-boundary.md`、`cds/.claude/rules/scope-naming.md`：本设计遵循的四条规则。

---

## 9. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **模型幻觉**：编造不存在的镜像 / 端口 / 命令 | 草稿应用后部署直接挂 | 应用前**强制** `cdscli verify`，ERROR 一律拦截；端口等关键字段标注「AI 猜测」高亮，逼用户核对；确定性探测结果作 baseline 可一键回退 |
| **成本 / 延迟**：起草是一次额外的模型调用 | 用户等待、token 花费 | 全程流式（四阶段进度，无空白等待）；按 `(repoHash + detectorBaseline)` 缓存草稿，仓库未变不重复调用；默认走 Lite 较廉价路径 |
| **安全 / 隐私**：仓库内容外发给模型 | 敏感代码 / 密钥泄露 | **用户显式 opt-in**（项目级授权开关，默认关）；只发文件树 + 清单信号，不发全量源码；发送前脱敏（剔除 `.env`、密钥样式串、`secrets/` 等）；Lite 走系统内 `ILlmGateway`，不引入新外部出口 |
| **契约漂移**：AI 输出不符合 cds-compose 契约 | 草稿无法被 CDS 解析 | prompt 内置契约约束；草稿过 `cdscli verify` 评分门禁（`--min-score`）；不达标的草稿在编辑器里标红，不允许直接应用 |
| **能力夸大 / 边界误判**：把借用说成「官方 SDK 集成」 | 误导后续维护者，违反 SDK 边界规则 | §5.3 明确官方/自研边界；文案统一称「通过 CDS Agent 运行时发起文本生成」，默认 Lite，官方 SDK 仅列为可选升级 |
| **运行时不可用**：CDS Agent 运行时不健康（债务 D1/D4） | AI 起草发不出去 | 入口在运行时不健康时灰态 + 文案说明；失败事件明确「已退回确定性探测」；**任何失败都不阻断接入**，主路径恒可用 |
| **回归默认体验**：AI 入口干扰标准用户 | 标准仓库接入变复杂 | 系统级默认**关闭**；关闭时 UI 完全不出现 AI 入口，行为零回归 |

---

## 10. 未来

本设计刻意只做「起草 compose」一件事，把更大的想象空间留给后续，但方向已经清晰：

1. **从 compose 扩展到启动脚本 / 安装步骤**：同一条「扫描 → 委托运行时 → 校验」胶水，可复用于起草 `exec_*.sh init` 的依赖安装步骤、自定义 entrypoint，乃至 Dockerfile 片段——前提同样是确定性校验 + 人确认。
2. **反哺 CDS 技能（cds-project-scan / cds skill）**：把 AI 起草的产物与用户最终采纳的差异沉淀回 `.claude/skills/cds/`，让 cdscli 的 `scan` 在确定性探测不足时也能调用同一条 AI 起草通道，形成「CLI 与 Web 共用一套起草能力」。
3. **官方 SDK 模式升级**：当 CDS Agent 债务 D1 闭合（配置有效 Claude-compatible profile）后，起草可从 Lite 升级到带工具的官方 `claude-agent-sdk` 路径，让模型能真正 `Read/Grep` 仓库而非只看文件树摘要——但这属于运行时能力升级，不改变本设计「人在回路 + 强制校验」的产品契约。

以上均为远景，不在本期范围；本期只交付：可选开关 + 起草端点（compute）+ 可视化确认 + 应用前强制 verify（send）。
