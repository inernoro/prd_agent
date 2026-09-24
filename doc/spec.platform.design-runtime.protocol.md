# 设计执行协议 map-design-executor-v1 · 规格

**一句话**：MAP 调用设计引擎的唯一接口，首个实现是 OpenDesign（开源的网页设计引擎）：查能力、提交任务、读事件、取消四个动作；别的引擎照这份协议实现就能作为可选执行器接入。
**谁该读**：实现 MAP 侧适配器的研发、实现新执行服务（例如 CloseDesign）的研发、排查「设计任务为什么失败」的人。
**读完能做什么**：知道 MAP 该往执行服务发什么、会收回什么、每种拒绝意味着什么、下一步该怎么做，并能照着写一个兼容的执行服务或调用方。

版本：1（2026-09-24）　上位设计：[design.platform.design-runtime.md](./design.platform.design-runtime.md)

---

## 一、为什么要有这份协议

OpenDesign 以前住在 CDS 里：MAP 先向 CDS 开一个会话，CDS 再替它起容器、转发指令、翻译事件。设计执行和「部署分支预览」是两件事，混在一起的后果是改一次提示词要动共享 CDS、换一个引擎要改 CDS 代码。

把执行逻辑搬成独立服务之后，MAP 和服务之间需要一份**不依赖 CDS 的**契约。这份协议就是它。它刻意沿用了 MAP 已经在用的三样东西，让第 2 阶段的适配器只换一个传输面：

- **任务包与结果提交**：还是 MAP 现有的工作区传输接口（`map-design-workspace-v1`），执行服务直接回调 MAP，不经过任何中转。
- **任务信封**：还是 MAP 冻结好的 `map-design-artifact-command-v2`，服务原样交给引擎。
- **事件形状**：还是 CDS 会话里的 `status` / `text_delta` / `done` / `error`，MAP 现有的进度解析不用重写。

## 二、一次任务怎么流动

1. MAP 查一次能力，确认服务健康、空闲、支持需要的设计系统。
2. MAP 提交任务：带上任务编号（等于 MAP 的 runId）、传输地址与短期票据、模型出口、超时和信封。服务立刻返回 202，任务在后台跑。
3. 服务自己去 MAP 取任务包、经 MAP 出口调模型、向 MAP 推实时预览、最后把结果包提交回 MAP。
4. MAP 按序号读事件（长连接或轮询都行，断线从上次序号续读），看到 `done` 就拿结果引用，看到 `error` 就拿原因。
5. 任务结束后（成功、失败、取消、超时一律如此），服务清空工作目录与引擎数据、换一组新令牌重启引擎，才接下一个任务。

## 三、四个动作

所有地址都挂在服务根下。除「查能力」和就绪探针外，每个请求都要带 `Authorization: Bearer <key>`，key 以环境变量 `DESIGN_RUNTIME_API_KEY` 同时发给服务与 MAP。它是两个服务之间的内部暗号，没有人需要知道它的值，所以不由人生成：CDS 部署清单把它声明为 `generate: secret`，部署前发现项目里没有就自动生成一把、写进项目 env，项目内所有分支共用且不再改动；显式填过的值优先。服务没配 key 时拒绝一切任务接口（503），查能力照常可用并说明原因。

| 动作 | 地址 | 鉴权 | 成功返回 |
|---|---|---|---|
| 查能力 | `GET /v1/capabilities` | 无 | 200 + 能力描述（见第四节） |
| 提交任务 | `POST /v1/tasks` | 要 | 202 + 任务视图；重复提交同一请求返回 200 并标 `replayed` |
| 查任务 | `GET /v1/tasks/{taskId}` | 要 | 200 + 任务视图 |
| 读事件 | `GET /v1/tasks/{taskId}/events?afterSeq=N` | 要 | 带 `Accept: text/event-stream`（或 `stream=1`）时是长连接，否则一次性返回 JSON |
| 取消 | `POST /v1/tasks/{taskId}/cancel` | 要 | 200 + 任务视图；已结束的任务原样返回 |
| 就绪探针 | `GET /healthz/ready` | 无 | 引擎就绪 200，否则 503。给部署平台用，MAP 不该依赖它 |

### 3.1 提交任务的请求体

| 字段 | 必填 | 含义 |
|---|---|---|
| `taskId` | 是 | 等于 MAP 的 runId。字母数字开头，只含字母数字、下划线、短横，最长 128 |
| `attempt` | 否 | 第几次尝试，默认 1，范围 1–100。上一次尝试以失败或取消结束后，才能用更大的值重新提交同一个 taskId |
| `transfer` | 是 | MAP 工作区传输参数：`schemaVersion`（`map-design-workspace-v1`）、`inputPackageUrl`、`inputSha256`、`resultCommitUrl`、`transferToken`、`baseRevision`、`maxInputBytes`、`maxOutputBytes`、`allowedOutputPaths`，可选 `previewUrl` |
| `transfer.previewUrl` | 否 | 实时预览推送地址。缺省时按结果提交地址推导（与经 CDS 时一致）；给了就必须与其它传输地址同源 |
| `model` | 是 | MAP 模型出口：`baseUrl`、`protocol`（只支持 `openai`）、`apiKey`（MAP 发的短期票据）、`model`。`baseUrl` 必须与传输地址同源 |
| `timeoutSeconds` | 否 | 整个任务的上限，默认 900，范围 30–7200 |
| `envelope` | 是 | `map-design-artifact-command-v2` 信封：`schemaVersion`、`runId`（必须等于 taskId）、`workspaceTask`（固定 `/workspace/brief/task.json`）、`command`，可选 `runtimeProtocol`。序列化后不超过 12000 字符 |

传输地址只接受 https，唯一例外是指向 `127.0.0.1` / `localhost` 的 http（本机测试用）。要让服务在内网里用 http 回调 MAP，必须显式设 `DESIGN_RUNTIME_ALLOW_HTTP_TRANSFER=1`；生产不要开。

### 3.2 同一个 taskId 再提交一次会怎样

幂等判断靠一枚**不含任何密钥**的请求指纹（票据会换，指纹不会跟着变）。

| 情况 | 结果 |
|---|---|
| 同一 attempt、内容相同 | 200，原样返回已有任务（`replayed: true`），不会再跑一次 |
| 同一 attempt、内容不同 | 409 `task_id_conflict` |
| 更大的 attempt，而上一次失败或取消了 | 202，重新跑；事件序号接着上一次往后排，每条事件带自己的 `attempt` |
| 更大的 attempt，但上一次还在跑 / 已成功 | 409 `task_attempt_in_progress` / `task_already_succeeded` |
| 更小的 attempt | 409 `task_attempt_stale` |

### 3.3 任务视图

`taskId`、`attempt`、`state`（`running` / `succeeded` / `failed` / `cancelled`）、`createdAt`、`updatedAt`、`lastSeq`、`cleanup`（`pending` / `completed` / `failed`，任务结束后的清空是否完成），成功时带 `result`，失败或取消时带 `error`。

服务只在内存里保留最近 20 个已结束任务；查不到的 taskId 返回 404 `task_not_found`，说明它从没提交到这个实例、或已被淘汰。服务重启后记录全部丢失，MAP 应以自己库里的 run 状态为准。

## 四、能力描述

| 字段 | 含义 |
|---|---|
| `protocol` | 固定 `map-design-executor-v1` |
| `engine` / `engineVersion` | 引擎名与**实时探测到**的版本（探不到为空）；另附本服务钉住的版本，两者不一致时不接任务 |
| `codexVersion` | 镜像里 Codex CLI 的实际版本 |
| `designSystems` | 引擎镜像里可用的设计系统编号清单 |
| `healthy` | 当前没有任何阻止接单的原因。**每次查询都真打一次引擎健康检查**，不是缓存值 |
| `engineReady` / `busy` / `acceptingTasks` | 引擎就绪 / 正在跑任务 / 此刻提交会被接受 |
| `maxConcurrentTasks` | 固定 1（隔离方案 A：一个实例同一时间只跑一个任务） |
| `state` | `starting` / `idle` / `running` / `resetting` / `blocked` |
| `reason` / `conditions` | 不健康时的原因，第一条放在 `reason`，全部列在 `conditions` |
| `engineProcess` | 引擎进程是否在运行、近十分钟意外退出几次、最后一次退出时间 |

引擎进程自己死掉时，`healthy` 立刻变成 false 并给出 `engine_restarting`，服务自动重新拉起；十分钟内反复退出会把「等一等」改成「去查容器日志」。不存在「进程死了但能力接口还说健康」的窗口。

## 五、事件

每条事件：`seq`（单调递增，跨 attempt 不回退）、`type`、`payload`、`createdAt`、`attempt`。长连接每条事件的 SSE `id` 就是 `seq`，空闲 15 秒发一次 `keepalive`；任务结束（发出 `done` 或 `error`）后服务主动关连接。一次性 JSON 另带 `state`、`terminal`、`lastSeq`，方便轮询方判断要不要再来。

| type | payload | 什么时候发 |
|---|---|---|
| `status` | `status`（`creating` / `running`）、`reason`（阶段名）、阶段细节 | 接单时一条 `task_accepted`；之后每进入一个阶段一条，阶段名与经 CDS 时相同（取任务包、导入、运行、自查、修复、推预览、打包、提交） |
| `text_delta` | `text` | 每个阶段附一句给人看的中文进度 |
| `thinking` | `text` | 协议保留。OpenDesign 引擎不向外暴露推理流，本实现不发；调用方要能接受它出现 |
| `done` | `artifactRef`、`resultSha256`、`files`、`openDesignRunId` | 结果已提交到 MAP 并被接受 |
| `error` | `code`、`message`、`retryable`、`details` | 任务以失败或取消结束 |

结果已经提交到 MAP 之后才到的取消请求不会把任务改成「已取消」：结果真的落库了，就如实报成功。

## 六、拒绝与失败：先说外因

服务所有拒绝与失败原因都由一个构造器渲染，第一句固定是「谁做了什么，于是怎样：要不要紧」，技术细节排在后面。「要不要紧」只有四种：无需处理、等某件事（写明等什么）、要动手（写明动什么）、要先查（写明查哪儿）。

| code | HTTP | 外因 | 调用方该做什么 |
|---|---|---|---|
| `api_key_not_configured` | 503 | 部署配置没给 key | 在 CDS 项目环境变量或生产配置里设 key |
| `unauthorized` | 401 | 调用方带的 key 不对 | 核对 MAP 与服务是否用同一把 key |
| `task_request_invalid` 等校验类 | 400 | 请求体不合约定 | 修 MAP 侧组包，不要重试 |
| `request_too_large` | 413 | 请求体超过 256KB | 同上 |
| `executor_busy` | 409 + `retryAfterSeconds` | 另一个任务正在跑（15 秒后再试）或上一个任务的清空还没完（5 秒后再试） | 按提示秒数再提交；也是显示排队位置的依据 |
| `engine_starting` | 503 | 服务刚启动，引擎还没就绪 | 等 |
| `engine_unhealthy` / `engine_resources_missing` / `engine_version_mismatch` | 503 | 引擎没通过健康检查 / 镜像缺 Codex 或技能资源 / 引擎版本与服务钉住的不一致（与能力接口同一份原因） | 前一种先等；后两种要重建镜像 |
| `engine_restarting` | 503 | 引擎进程意外退出，服务正在重拉 | 等；反复出现去查容器日志 |
| `workspace_reset_failed` | 503 | 上一个任务的文件没能清干净，服务暂停接单 | 查容器日志与磁盘；这是为了不让下一个任务读到上一个任务的文件 |
| `task_cancelled` | 事件 | 调用方取消了任务 | 无需处理 |
| `open_design_engine_exited` | 事件 | 引擎在任务中途退出 | 重试一次；反复出现去查日志 |

执行过程中的失败（取包失败、模型出口拒绝、质量闸不过、结果被 MAP 拒收等）沿用经 CDS 时的错误码与文案，MAP 现有的失败归因不用改。

## 七、安全边界

- **密钥不进引擎**。MAP 的短期票据只在服务进程里；引擎只拿到一个随机占位令牌，经服务内的出口中继调模型，中继校验占位令牌、只放行 MAP 出口路径下的 GET/POST、拒绝重定向与解析到内网或元数据地址的目标、剥掉凭据类请求头后才换上真票据。引擎以另一个系统用户运行，读不到服务进程的环境变量。
- **任务之间不共存**。一个实例同时只跑一个任务；任务结束后停引擎、清空四个目录（工作区、引擎数据、模板拷贝、导出目录）、核对确实为空、换一组新令牌重启。核对不通过就暂停接单，而不是带着残留继续。
- **产物出工作区之前逐字节核对**。符号链接、特殊文件、超深目录、超量文件、被改动的 MAP 输入、白名单外的路径，一律拒收，判据与经 CDS 时相同。
- **出网**。中继只管引擎调模型这一条路；容器本身的网络白名单交给部署配置（分支预览接受「能出网但不带任何密钥」，见债务台账）。

## 八、兼容与版本

- 协议名写在能力描述里。不兼容的改动发 `map-design-executor-v2`，同一个服务在过渡期可以两版都答。
- 新增可选字段、新增事件类型、新增错误码都算兼容改动；调用方必须忽略不认识的字段与事件。
- 第二种执行器（例如 CloseDesign）照这份协议实现即可接入：MAP 在执行器列表里登记它的地址与 key，不需要改 CDS。

## 九、验收标准

- 能力接口在引擎健康时返回 `healthy: true`、真实的引擎与 Codex 版本、非空的设计系统清单；杀掉引擎进程后下一次查询立刻变成 false 并给出原因，随后自动恢复。
- 同时提交两个任务，第二个得到 409 与重试秒数。
- 成功、失败、取消、超时四种结束方式之后，工作区与引擎数据目录都为空，下一个任务读不到上一个任务的任何文件。
- 服务没配 key 时，任务接口一律拒绝，能力接口说清楚缺什么、去哪配。
- 实现侧的自动化证据：`design-runtime/opendesign` 的 vitest（含一个假 OpenDesign 与假 MAP 的协议测试），CI 作业 `Design Runtime Test`。
