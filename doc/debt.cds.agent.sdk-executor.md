# CDS Agent SDK 执行器 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-09 | **状态**：开发中

**一句话**：执行器这块的已知工程债务与建议偿还顺序。
**谁该读**：接手执行器的工程师。
**读完能做什么**：按建议顺序挑下一项来还。

---

| 字段 | 内容 |
|---|---|
| 模块 | claude-sdk 执行器 / Python sidecar |
| 状态 | 活跃 |
| 关联 | [doc/design.cds.agent.sdk-executor.md](./design.cds.agent.sdk-executor.md) |


## 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| D-1 | `/api/agent-tools/invoke` callback controller + 内置工具注册表 | P1 | 任何想让 Claude 自主调工具的 Agent | DONE (v0.2) |
| D-2 | `ExecuteCliAgent_ClaudeSdkAsync` 写入 `llmrequestlogs`（StartAsync / MarkFirstByte / MarkDone / MarkError） | P1 | 上线前 | DONE (v0.2) |
| D-3 | admin 前端 `WorkflowNodeEditor` 没有 claude-sdk 专属配置面板（`model / systemPrompt / sidecarTag / maxTurns / tools`）。当前只能通过 raw JSON 编辑节点配置。 | P2 | 给 PM/QA 用之前必须做 | open |
| D-4 | 没有 Polly 重试 / 熔断器保护对 sidecar 的 HTTP 调用，依赖 `IHttpClientFactory` 默认行为。HostedService 健康检查能避开宕机实例，但无法处理瞬时 5xx 抖动。 | P2 | 多实例高并发场景 | open |
| D-5 | sidecar 的 callback 用 `X-Sidecar-Token` 对称鉴权（双向同 token），未走 `RequireScopeAttribute`。生产场景如果想限定哪些工具被调，需要在工具层做 scope 检查（节点配置的 tools 白名单已经形成第一道防线）。 | P3 | 高安全敏感场景 | partially done（历史 mitigated；2026-11-17 安全复核见下文） |
| D-6 | `claude-sdk` 执行器返回的 artifact 格式硬编码为 HTML 页面（与 `builtin-llm` 看齐）。如果 Agent 输出是 JSON / Markdown / 代码 patch，artifact 类型需要根据 prompt 推断。 | P3 | 多场景 Agent 落地后 | open |
| D-7 | sidecar Dockerfile 没做多阶段构建 + 非 root 用户。镜像略大且以 root 运行。 | P3 | 上生产前 | open |
| D-8 | 未做端到端集成测试。`ClaudeSidecarRouter` 的 SSE 解析、`InstanceStateRegistry` 的并发行为、健康检查的失败计数都只有 code review，没有 xunit 覆盖。 | P2 | 推到主分支前 | open |
| D-9 | `appsettings.json` 中的 `ClaudeSdkExecutor` 段对开发者可见，可能误以为已启用。需要在 admin UI 加 "claude-sdk 状态" 卡片提示当前是否真的有 sidecar 配置。 | P3 | 与 D-3 一起做 | open |
| D-10 | 历史备注：v0.2 早期内置工具极简。当前已经扩展 repo / PR / Bridge 工具，但缺陷查询、文档读取、PR diff 结构化审查等业务工具仍需按"一个工具一个 PR"节奏扩充。 | P2 | 实际 Agent 上线前 | partially done |
| D-11 | `CDS Agent` 页面发送消息曾同步 HTTP 等待后端跑完 sidecar，再靠 3 秒轮询刷新事件；长任务可观察性不足。 | P1 | 任务超过几十秒或需要实时观察时 | partially done: SendMessage 已改为入队 runtime job，`InfraAgentRuntimeWorker` 后台执行；页面已接 `/stream?afterSeq=` SSE 续读并保留轮询兜底；真实远程 run 验证待做 |
| D-12 | `Stop` 只停止 CDS session，没有持久化 sidecar runId 并调用 `/v1/agent/cancel/{runId}`，长模型调用可能继续跑。 | P1 | 长任务、卡住任务、用户主动停止 | partially done: session 已持久化 `CurrentRuntimeRunId`，Stop 已 best-effort 调 sidecar cancel；官方 SDK 精确 interrupt 仍待 `ClaudeSDKClient` |
| D-13 | 事件列表和页面详情默认最多 500 条，长审查会话会截断后续事件；需要 afterSeq 分页、增量订阅和前端去重。 | P1 | 大型代码审查、PR 创建链路 | partially done: 后端已有 afterSeq；`/stream` 已改为长连接 SSE + keepalive；`/cds-agent` 页面已通过 JSON 分页和 SSE 双路径增量合并事件，Toolbox `cds-agent` 已游标批量读取；远程视觉/真实长会话待验证 |
| D-14 | `repo_run_command` 单次命令上限 180 秒，不适合大型测试套件；需要长命令后台化、stdout/stderr 增量事件和取消。 | P1 | dotnet test / npm build / 集成测试较慢 | open |
| D-15 | `repo_create_pull_request` 默认创建 draft PR；应改为 runtime profile 或任务级策略，低风险测试/文档修复默认 ready PR。 | P2 | 自动修复和 PR 闭环稳定后 | open |
| D-16 | 历史名 `claude-sdk` 容易让人误以为完整接入官方 Claude Code SDK / Claude Agent SDK；需要逐步把产品文案改成 `Claude sidecar runtime` 或 `CDS Agent runtime`。 | P1 | 文档、UI、对外沟通 | done (2026-07-09): prd-admin 用户可见文案 6 处（navRegistry / InfraServicesPage / CdsAgentPage）统一改为「Claude sidecar runtime（自研 sidecar，Anthropic 协议；runtime 标识 claude-sdk）」；机器值 `claude-sdk` 不动（executorType/配置键兼容） |
| D-17 | 官方 Claude Agent SDK adapter 仍是 spike：虽然 adapter 已改用 `ClaudeSDKClient.interrupt()` 结构，但还没跑真实 SDK 包、provider key、workspace 和远程 CDS sidecar pool 的 smoke；外部 PATH 上的 `claude` 命令只做诊断观测，不是默认 ready gate。 | P1 | 想达到商业级取消、续跑、真实远程 smoke 时 | open |
| D-18 | 官方 Claude Code 内置 `Bash/Edit/Write` 工具还没接 MAP permission callback / approval bridge；当前默认只读，写入/命令需显式 opt-in。 | P1 | 想让 official adapter 执行修改、测试、PR 前 | partially done: 已接 `can_use_tool` -> MAP approval request/wait 骨架；真实 UI 审批和远程 official SDK run 未验证 |
| D-19 | Toolbox `cds-agent` 已能产出远程运行句柄并重新附着远程会话事件流，但真实远程 official SDK run 的审批闭环还没验证。 | P1 | 从 AI 百宝箱发起长代码任务时 | partially done: adapter 已返回 `sessionId/workbenchPath/eventStreamPath/logsPath` 句柄，Toolbox 运行页已渲染句柄卡片、“打开工作台”和“停止”按钮，并订阅远程 SSE/轮询兜底展示最近事件；等待审批的工具调用会在 Toolbox 内联显示允许/拒绝 |

---

## 偿还顺序建议

```
D-1 + D-2 同时做（一个 PR）：补 callback controller + llmrequestlogs 写入
  ↓
D-11 + D-12 + D-13 先做：后台 run、真 SSE/分页、停止取消
  ↓
D-3 + D-9 同时做：admin UI 配置面板 + 状态卡片
  ↓
D-5 + D-8：scope 验证 + xunit 集成测试
  ↓
D-4 D-6 D-7 D-14 D-15 D-16：按需补
```

---

## 历史背景

2026-05-05 v0.1 落地时为了"先把骨架跑通让用户看到形态"，主动延迟了上述 9 条。本文件即"延迟清单"，避免下一次 session 不知道这些坑。

## D-5 安全复核补记（2026-11-17）

历史 D-5 的 `mitigated` 只表示当时的局部缓解，不能证明本组三项已解决。
本轮保留 D-5、既有历史及扫描原 ID；不把扫描编号当作 GitHub issue。

原扫描基线为 `2eb2995bb6171e4741ba180c85854ddf212883e9`，仅静态审查，
未执行运行时利用。后续复核参考 `9afc39db4`；本轮本地基线为
`843d92057`。提供方说明 findings.json 哈希与清单吻合，但 22 份保留来源中
10 份哈希不符，原因未知；本轮结论依据当前源码和本地测试，不据此宣称生产可利用。

| 原报告 ID | 原发现 | 本轮状态与证据范围 | 仍未验证或待完成 |
|---|---|---|---|
| #5 | 调用者扩大工具并自选审批服务 | 部分解决：固定服务端核验地址；短期任务凭据冻结工具与上游配置；请求只取子集；SDK 执行前强制检查；审批绑定 run、工具、参数并单次消费。fake provider/approval 验证批准、拒绝、超时、取消和重放。 | 真实 SDK/远程 UI 审批未验收；Bash 暂拒绝，恢复需独立沙箱。 |
| #15 | 任意工作区和越界读取 | 部分解决：工作区绑定任务及部署根；文件路径检查拒绝绝对越界、父目录和符号链接；递归搜索遇链接拒绝；Git 工作区按主体和 run 隔离。临时目录正反向断言通过。 | 非 OS 沙箱；不可信本地进程竞争替换路径、硬链接及 SDK 自身隐式文件访问不在本轮保证内。禁止作为不可信共享目录的多租户安全边界。 |
| #27 | 共享 bearer 可跨主体运行与取消 | 部分解决：共享凭据不再授权运行、取消或工具；任务凭据绑定主体、run、用途、工具、工作区、profile、期限并验证存活租约；SSE 返回前占位；取消须同一凭据；运行与审批转为共享 Mongo 持久登记，按数据库时间拒绝过期；消费前原子转换并确认 majority/journal 写入。双主体、并发占位、合法流式状态和取消通过本地断言。 | 跨副本取消通过共享状态与执行副本轮询实现；仅确认停止后记 cancelled。后台会话停止在验证持久归属并取得停止租约后，传递已验证的会话主体；无主体或任务权威的后台取消拒绝。真实副本集故障转移、备份回退及 Data Protection 密钥分发未验证。 |

兼容性：需 MAP 与 Sidecar 同步升级并配置可信核验地址；旧共享 token、dev-skip
及未绑定 runtime scope 的任务凭据均被拒绝。旧 smoke 脚本不能代表新合同验收。
本轮只进行本地实现与验证，未部署、未执行真实模型或生产攻击，也未关闭上述三项。

本地验证补充：Python 66 项、C# 审批/工具 19 项及路由 23 项定向测试通过；
solution 编译零错误，文档可读性守卫通过。全套非 Integration/Manual 测试因缺少
独立 MongoDB（本地 27018 拒绝连接）未完成，不记通过。旧工具测试继承 GitHub
环境凭据时曾进入失败的 push 路径；移除测试进程凭据后重跑通过，远端测试分支
仍指向 2026-08-05 的既有提交，未产生本轮提交。后续必须隔离测试环境凭据。

### D-5 持久防重放续接（2026-11-17）

此前候选以进程内登记限制单次消费，该历史证据保留于原交接包，不能证明重启安全。
本次候选改用已有可信 Mongo 数据域，唯一键绑定 run/审批 ID；状态转换同时核对主体、
凭据摘要、工具、原始参数摘要与期限。过期记录不自动清除，存储故障或写确认不明时
拒绝分派。崩溃后已消费批准不会补发，保证至多一次分派，不保证副作用恰好一次。
多副本必须共用数据库与既有密钥环；不得通过清库或备份回滚恢复旧批准。
本地隔离数据库验证结果以续接交接包为准；OS 沙箱、真实远程 SDK 和生产拓扑仍未验收。

本次隔离验证：真实 MongoDB 7.0.48 下 9 项授权/持久化测试通过；两个独立测试进程
共 60 次消费同一批准仅 1 次成功。重启 Mongo 并另启测试进程后，已消费批准和 run
仍拒绝重放，未消费批准可成功一次。另有工具 16 项、路由 23 项、Python 66 项通过，
solution 构建零错误。此证据未包含真实多节点 Mongo 选主或备份恢复。

### D-5 跨副本取消续接（2026-11-17）

前一候选的持久防重放与哈希保留，原跨副本取消缺口在本候选补齐控制面状态链。
取消意图绑定主体/run，Sidecar 凭据另绑定原运行凭据摘要及期限。完成和取消通过
原子状态转换决定终态，终态不回退；成功流式终态须先获持久确认。失联时停止继续
执行但报告状态未确认，不能伪称已取消。过期活动记录在查询时转为 expired。
任意 MAP 副本的可信认证用户可以取消自己的运行，后台调用必须具备任务权威。
同步升级 MAP/Sidecar 的控制协议是新增兼容性要求；无新增队列或凭据广播。
OS 沙箱、真实远程 SDK 强制退出、多节点 Mongo 故障转移/备份回退仍不在已验收范围。
取消不能回滚已经开始的副作用；没有授权上下文的跨副本后台调度取消仍需调用方接入。

本地分层验证：Python 67 项包含独立 Sidecar 进程间取消、异主体拒绝和控制面故障；
真实 Mongo 14 项授权/持久状态测试通过，独立 testhost 分别发起/取消/确认，数据库
重启后新进程仍观察 cancelled，旧运行不可重放。路由 Cancelled 仅在确认停止时为 true，
pending 通过 Reason=cancel_requested 返回；旧调用方需适配这一更严格的终态语义。
上述测试使用 fake provider/control-plane 与真实 Mongo 的分层组合，不冒充完整远程 SDK
或生产多副本 HTTP 部署验收；记录和补丁保存在本轮本地交接包。
