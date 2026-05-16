# CDS Agent 下一代测试与涌现建议 · 指南

> **版本**：v1.1 | **日期**：2026-05-17 | **状态**：active（MVP 测试基线，生产级限制已标注）

## 目标

这份文档给“下一个智能体”使用：如何测试 CDS Agent 工作台，如何判断不是假通过，下一代该做什么，哪些建议来自涌现分析。

## 测试哲学

CDS Agent 的测试不能只问“接口通了吗”。它至少要同时回答五个问题：

1. 用户能不能从真实入口找到它。
2. 远程 runtime 是否真的启动并执行。
3. 危险工具是否真的暂停等待审批。
4. 页面是否能持续展示过程、日志、产物和错误。
5. 最终是否能产生一个可审查的外部结果，例如 PR。

第 6 个问题也必须回答：文档和页面有没有夸大官方 SDK 接入程度。当前 `claude-sdk` 是历史 runtime 名，实际是官方 `anthropic` Python SDK + 自研 sidecar loop；测试报告必须按这个边界表述。

## 分层测试矩阵

| 层 | 测什么 | 必须断言 | 失败时说明 |
|----|--------|----------|------------|
| L0 编译类型 | 后端 build、前端 tsc/lint、CDS build | 无新增编译错误 | 语法层失败，不进入部署 |
| L1 API 冒烟 | create/start/send/events/logs/stop | 状态流转、事件 seq、错误码 | 业务链路未成形 |
| L2 Runtime 冒烟 | 模型测试、sidecar health、工具列表 | 真 provider key、真 sidecar | fake 不能算最终验收 |
| L3 工具审批 | repo_run_command/write/create PR | waiting -> allow/deny -> result | 权限链路不可信 |
| L4 真实页面 | 首页/百宝箱/设置入口 | 页面可见过程和结果 | 不能交给用户 |
| L5 外部产物 | GitHub PR、工作流产物、浏览器快照 | 可打开、可追踪、可复现 | Agent 没真正干活 |
| L6 恢复与释放 | 刷新恢复、停止释放、日志回看 | stopped 后仍可回放 | 长任务不可运维 |
| L7 SDK 边界 | 官方包、自研 loop、取消/分页限制 | 文档没有把自研封装写成官方完整能力 | 后续维护方向会错 |

## 最小自动化套件

下一个智能体应该把 A10 固化成自动化验收：

| 用例 | 入口 | 断言 |
|------|------|------|
| `cds-agent-real-entry.spec` | `https://main-prd-agent.miduo.org/ -> 百宝箱 -> CDS Agent` | 页面标题、连接、模型、会话列表、事件区存在 |
| `cds-agent-model-profile.spec` | CDS Agent 页面 | 任意 baseUrl/model 配置可测试，API key 不明文展示 |
| `cds-agent-approval-recovery.spec` | CDS Agent 页面 | dangerous 工具审批卡刷新后仍在 |
| `cds-agent-artifact-panel.spec` | CDS Agent 页面 | repo_git_status/repo_git_diff 产物可见 |
| `cds-agent-bridge.spec` | CDS Agent 页面 | browser snapshot/action 事件可见 |
| `cds-agent-workflow.spec` | 工作流页面 | CDS Agent 节点输出能映射给下游 |
| `cds-agent-toolbox.spec` | AI 百宝箱 | toolbox run 能生成 CDS session 和 artifacts |
| `cds-agent-pr-e2e.spec` | AI 百宝箱或 CDS Agent | 远程 Agent 创建 PR 并停止会话 |
| `cds-agent-sdk-boundary.spec` | 文档/页面文案 | `claude-sdk` 历史名旁边有官方/自研边界说明 |

## 手工视觉测试标准

每次声称视觉通过，至少记录：

- 入口路径：必须是用户路径，例如 `首页 -> 百宝箱 -> CDS Agent`。
- 用户身份：会话 owner 是谁，当前浏览器是否切到该用户。
- 预览 commit：CDS 分支状态里的 `commitSha`。
- 页面证据：截图路径或可访问性树摘录。
- 业务断言：不能只写“页面打开了”，要写看到了哪些结果。

推荐断言句式：

```text
真实入口视觉：从 https://main-prd-agent.miduo.org/ 进入，点击百宝箱，再点击 CDS Agent。切换到会话 owner 后，选中 A10 已停止会话。页面可见 trace、OpenRouter 模型、500 条事件、65 个工具事件、PR #617、测试 55 通过、会话已停止。
```

## 涌现分析：CDS Agent 下一代

### 目标模块能力基线

| 类型 | 名称 | 状态 |
|------|------|------|
| Model | `InfraAgentSession` / `InfraAgentMessage` / `InfraAgentEvent` | 已有 |
| Model | `InfraAgentRuntimeProfile` / `InfraAgentHookProfile` | 已有 |
| API | `InfraAgentSessionsController` | 已有 |
| API | `InfraAgentRuntimeProfilesController` / `InfraAgentHookProfilesController` | 已有 |
| API | `AgentToolsController` | 已有 |
| Tool | `repo_read_file` / `repo_search` / `repo_write_file` / `repo_run_command` / `repo_create_pull_request` | 已有 |
| Tool | `cds_bridge_snapshot` / `cds_bridge_action` | 已有 |
| UI | `CdsAgentPage.tsx` | 已有 |
| Workflow | 工作流 CDS Agent 节点 | 已有 |
| Toolbox | `CdsAgentAdapter` | 已有 |
| Runtime | CDS shared sidecar pool | 已有 |

### 可用的全局横向能力

| 横向能力 | 可组合方向 |
|----------|------------|
| LLM Gateway / 模型池 | 统一模型选择、成本、fallback 和健康检查 |
| Run-Worker / SSE | 长任务排队、断线续传、后台继续执行 |
| Bridge | 远程浏览器观察和操作 |
| Attachment / ExtractedText | 把文件、日志、截图、PR diff 变成可检索上下文 |
| ShareLink | 生成外部可访问的验收报告 |
| Workflow Engine | 把远程 Agent 变成自动化节点 |
| AI Toolbox | 把远程 Agent 变成普通用户可调度智能体 |
| 权限系统 | 工具级、项目级、团队级审批策略 |
| Webhook | 把 PR、失败、审批请求推到外部系统 |
| Marketplace / IForkable | runtime profile、hook profile、验收模板可复用 |

### 发散池

#### 基线层

| ID | 想法 | 复用砖块 |
|----|------|----------|
| E1 | 会话批量清理和归档，把旧 running 会话一键停止 | InfraAgentSession + stop API + CdsAgentPage |
| E2 | 会话搜索按 trace、PR、model、状态、用户过滤 | InfraAgentEvent + session list |
| E3 | 长命令内网 callback，规避公网 524 | ClaudeSidecarRouter + CDS runtime metadata |
| E4 | PR 从 draft 到 ready 的策略开关 | repo_create_pull_request + runtime profile |

#### 差异化层

| ID | 想法 | 复用砖块 |
|----|------|----------|
| E5 | 验收回放播放器，按事件时间线重播 Agent 干活过程 | InfraAgentEvent + UI timeline |
| E6 | “证据包”一键导出，包含 prompt、事件、日志、diff、PR、截图 | artifacts + ShareLink |
| E7 | 工具审批策略模板，团队可共享 “只读自动、写入人工、PR 二次确认” | HookProfile + 权限系统 + Marketplace |
| E8 | 会话成本和风险仪表盘，按模型、工具、运行时长统计 | RuntimeProfile + Event + LLM usage |

#### 智力层

| ID | 想法 | 复用砖块 |
|----|------|----------|
| E9 | Agent 自评审：创建 PR 后自动用另一个 Agent 做 review | repo_create_pull_request + PR Review + Toolbox |
| E10 | 失败根因解释器：把 error/log/event 合并成可执行排障建议 | ILlmGateway + logs + events |
| E11 | 自动生成最小验收脚本：从一次人工视觉验收反推 Playwright/Bridge 脚本 | Bridge + event schema + LLM |
| E12 | 任务分解器：把大任务拆成多个 CDS sessions 并汇总产物 | Workflow Engine + Toolbox + InfraAgentSession |

#### 激进层

| ID | 想法 | 复用砖块 |
|----|------|----------|
| E13 | 远程双人协作模式：人类接管浏览器，Agent 继续写代码 | manual takeover + Bridge |
| E14 | Agent 评测联赛：多个 runtime profile 对同一任务竞争，按 PR 质量评分 | AI Arena + CDS Agent |
| E15 | 生产事故演练：Agent 在隔离分支重放事故、提出修复 PR | CDS branch + Workflow + Agent tools |
| E16 | 可销售的 sandbox Agent 模板市场 | Marketplace + runtime/hook profile + ShareLink |

### 收敛评分

| ID | 独特性 | 可落地性 | 推荐波次 |
|----|--------|----------|----------|
| E3 | 高 | 高 | 第一波 |
| E1 | 中 | 高 | 第一波 |
| E5 | 高 | 中 | 第一波 |
| E6 | 高 | 中 | 第二波 |
| E7 | 高 | 中 | 第二波 |
| E9 | 高 | 中 | 第二波 |
| E11 | 很高 | 中 | 第三波 |
| E14 | 很高 | 低 | 第三波 |

## 推荐落地顺序

### 第一波：把“可用”变“稳”

1. 后台 run + 真 SSE / afterSeq 增量订阅。
2. 停止动作代理到 sidecar cancel。
3. 长命令内网 callback和 stdout/stderr 增量事件。
4. 批量停止和归档旧会话。
5. A10 验收回放自动化。

### 第二波：把“能用”变“好交付”

1. 证据包导出。
2. PR ready/draft 策略。
3. 工具审批策略模板。
4. Agent 自评审。

### 第三波：把“工作台”变“平台”

1. 从人工视觉验收自动生成回归脚本。
2. 多 runtime 竞争评测。
3. sandbox Agent 模板市场。

## 下一代测试提示词

```text
你是接手 CDS Agent 工作台的下一代智能体。请先读 doc/report.cds-agent-workbench-2026-05-15.md、doc/guide.cds-agent-workbench-reproduce.md、doc/guide.cds-agent-next-agent-testing.md。你的目标不是证明 API 能通，而是证明真实用户能用。请从 https://main-prd-agent.miduo.org/ 真实入口进入，经百宝箱打开 CDS Agent，复现 active connection、runtime profile、远程会话、流式事件、危险工具审批、产物面板、停止释放和 PR 创建。不要使用直达路由替代视觉测试。完成后把测试路径、traceId、PR 链接、截图证据、失败和修复全部写入文档。
```
