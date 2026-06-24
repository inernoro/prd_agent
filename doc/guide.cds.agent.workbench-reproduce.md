# CDS Agent 工作台复现操作 · 指南

> **版本**：v1.1 | **日期**：2026-05-17 | **状态**：MVP 复现指南，生产级限制已标注

## 目标

这份教程让另一个人或下一个智能体复现 CDS Agent 工作台的完整操作：从系统配置、进入页面、创建会话、发送任务、审批工具、查看产物，到让远程 Agent 创建 PR。

不要把接口直连当作最终复现。最终复现必须从 MAP 真实入口进入。

命名校准：

- 页面和 API 里仍有历史 runtime 名 `claude-sdk`。
- `claude-agent-sdk` 是官方 Claude Agent SDK，不是本仓库自研；本仓库只写 adapter，把官方 SDK 事件、权限、取消和结果映射到 MAP/CDS。
- 当前默认目标路径是 `runtimeAdapter=claude-agent-sdk`；`legacy-sidecar` 只作为显式 fallback，仍使用官方 `anthropic` Python SDK + 本仓库自研 loop。
- 复现通过只证明 CDS Agent 工作台链路可用；要证明完整官方 SDK 迁移，必须额外通过 `doc/guide.cds.agent.runtime-pool-recovery.md` 里的 official SDK smoke。

## 前置条件

| 条件 | 要求 |
|------|------|
| MAP 预览 | `https://main-prd-agent.miduo.org/` 可打开 |
| CDS 部署 | `prd-agent-main` 的 `api-prd-agent` 与 `admin-prd-agent` 均为 running |
| CDS 连接 | MAP 内存在 active CDS connection，长期 token 未撤销 |
| 模型配置 | 系统级 runtime profile 可用，支持任意 compatible `baseUrl` 和 `model` |
| GitHub 凭据 | release 容器可推送分支并创建 PR |
| 用户权限 | 当前用户能使用 AI 百宝箱、CDS Agent、基础设施服务、工具审批 |

## 一、确认 CDS 主分支部署

在本地仓库执行：

```bash
CDS_HOST=https://cds.miduo.org AI_ACCESS_KEY=$AI_ACCESS_KEY \
python3 .agents/skills/cds/cli/cdscli.py branch status prd-agent-main
```

预期：

- `status=running`
- `services.api-prd-agent.status=running`
- `services.admin-prd-agent.status=running`
- `commitSha` 等于当前要验收的主分支短提交

## 二、从真实入口进入 CDS Agent

1. 打开 `https://main-prd-agent.miduo.org/`。
2. 登录 MAP。
3. 点击左侧 `百宝箱`。
4. 点击 `CDS Agent`。
5. 确认页面标题为 `CDS Agent`。
6. 确认左侧可见 CDS 连接、模型配置、会话列表。
7. 确认右侧可见对话、事件时间线、产物、运行日志。

不允许：

- 直接访问 `/cds-agent` 后声称视觉通过。
- 只调 `/api/infra-agent-sessions` 后声称页面通过。
- 只在容器内 curl 成功后声称用户可用。

## 三、配置或选择模型

在页面左侧选择模型配置。

必须确认：

- 当前模型显示协议，例如 `OpenAI-compatible`。
- 当前模型显示 `model`，例如 `deepseek/deepseek-v4-pro`。
- 当前模型显示 `baseUrl`，例如 `https://openrouter.ai/api/v1`。
- 页面不展示 API key 明文。

如果要新增配置：

1. 展开 `保存新模型配置`。
2. 填 runtime、协议、baseUrl、model、API key、资源边界。
3. 保存。
4. 点击 `测试模型`。
5. 只在测试成功后进入远程会话验收。

注意：`AI_ACCESS_KEY` 只用于 MAP/CDS 管理 API，不是模型 provider key。

## 四、新建远程会话

1. 输入标题，例如 `A10 自巡检复现`。
2. 点击 `新建远程会话`。
3. 选中新会话。
4. 点击启动或发送任务触发启动。
5. 观察事件时间线。

预期事件：

- `status session_created`
- `status cds_session_started`
- `log session created runtime=...`
- `status message_received`
- 如果进入真实 sidecar，应出现 `sidecar_runtime_started`

## 五、发送一次只读任务

建议先发送低风险 prompt：

```text
请在远程仓库中只读检查当前分支和最近提交，使用 repo_git_status 或 repo_list_files，最后用一句话说明你看到了什么。不要修改文件。
```

预期：

- 页面出现 user message。
- 页面逐步出现 Agent 输出。
- 工具事件出现 `repo_git_status` 或 `repo_list_files`。
- 只读工具可自动允许。
- 产物面板出现仓库状态或文件树。

## 六、复现危险工具审批

发送：

```text
请运行一个只读命令 git status --short。这个命令需要走 repo_run_command 工具，并等待我在 MAP 页面审批。
```

预期：

1. 事件时间线出现 `tool_call repo_run_command dangerous waiting`。
2. 页面展示 `允许` 和 `拒绝`。
3. 刷新页面后审批卡仍存在。
4. 点击 `允许`。
5. 事件时间线新增 `tool_result`，包含 `decision=allow`。

如果刷新后审批丢失，说明审批恢复链路回归。

## 七、复现远程浏览器操作

在右侧产物区域使用远程页面工具：

1. 输入 CDS 分支 ID，例如 `prd-agent-main`。
2. 点击 `读取页面快照`。
3. 确认出现 browser 事件或页面快照产物。
4. 选择 `SPA 跳转`，填 `/cds-agent`。
5. 点击 `执行动作`。

预期：

- `cds_bridge_snapshot` 返回只读 DOM 或截图摘要。
- `cds_bridge_action` 需要危险工具审批。
- 内网、localhost、metadata 地址应被拦截。

## 八、复现 PR 闭环

发送 A10 类任务：

```text
请作为远程 CDS Agent 在 prd_agent 仓库中做一次最小自巡检。先只读检查最近与 CDS Agent 或 toolbox queue 相关的代码；如果发现一个低风险测试覆盖缺口，请补一个最小回归测试，运行相关 dotnet test，提交到新分支，并创建指向 main 的 PR。必须使用 repo_* 工具完成读取、修改、测试和 repo_create_pull_request。最终回复 PR 链接、修改文件、测试命令和结果。
```

预期：

- 读文件、搜索代码、写文件、跑命令、创建 PR 都出现在事件中。
- 写文件、跑命令、创建 PR 都必须经过危险工具审批。
- 远程测试输出可见。
- 最终 Agent 回复包含 PR 链接。
- 会话停止后状态为 `已停止`。

## 九、A10 已验证样例

| 项 | 值 |
|----|----|
| PR | `https://github.com/inernoro/prd_agent/pull/617` |
| runId | `6a0618190b1a85ccd3e2e429` |
| traceId | `toolbox-run-6a0618190b1a85ccd3e2e429` |
| MAP session | `5767a03899ba47d08bfb5ff629de9e5e` |
| 测试结果 | `Failed: 0, Passed: 55, Skipped: 0, Total: 55` |
| 视觉路径 | `首页 -> 百宝箱 -> CDS Agent -> 选中 A10 已停止会话` |

## 十、失败排查

| 现象 | 常见原因 | 排查 |
|------|----------|------|
| 连接显示已撤销 | 真 revoked 或旧 connectionId | 重新授权 active connection，不要复用旧会话判断 |
| 401 invalid api key | 模型 provider key 错，不是 CDS key | 在 runtime profile 重新保存模型 API key |
| sidecar 不健康 | CDS shared sidecar pool 未发现或未 running | 查 CDS 系统 sidecar pool health |
| 工具回调失败 | callback URL 推导错误或公网 524 | 检查 `ClaudeSidecarRouter` callback base 与长命令内网 callback |
| 页面看不到会话 | 用户隔离生效，当前浏览器不是会话 owner | 切换到会话创建用户再看 |
| 事件不完整 | API 分页或 SSE 续读未用 `afterSeq` | 逐页拉取事件，并检查 cursor 状态 |
| PR 创建失败 | GitHub token/App 权限不足 | 检查 release 容器 GitHub 凭据 |

## 十一、验收清单

| 项 | 通过标准 |
|----|----------|
| 真实入口 | 从首页或百宝箱进入，不直达 |
| 长期授权 | active CDS connection 可复用 |
| 模型配置 | 任意 baseUrl/model 可保存并测试 |
| 会话生命周期 | create/start/send/stop 全通 |
| 事件刷新 | 页面能持续看到事件和日志变化；当前 MVP 允许轮询刷新，但需记录延迟 |
| 工具审批 | dangerous 工具等待人工确认 |
| 审批恢复 | 刷新后审批卡仍可操作 |
| 产物日志 | 文件、diff、命令、浏览器、日志可见 |
| 工作流 | workflow node 可调用 CDS Agent |
| 智能体 | AI 百宝箱可委托 CDS Agent |
| PR | 远程 Agent 可创建真实 PR |
| 停止释放 | 完成后 status 为 stopped |
| 官方 SDK | `runtime_init` 显示 `runtimeAdapter=claude-agent-sdk` 且 `loopOwner=claude-agent-sdk` |

## 十二、交接提示词

```text
请按照 doc/guide.cds.agent.workbench-reproduce.md 复现 CDS Agent 工作台。必须从 https://main-prd-agent.miduo.org/ 真实入口进入，经百宝箱打开 CDS Agent。不要直达路由替代视觉测试。先验证 active CDS connection、OpenAI-compatible runtime profile、事件时间线、工具审批和产物面板，再发送一次远程仓库自巡检任务，让 Agent 使用 repo_* 工具读取、修改、测试并创建 PR。完成后输出 PR 链接、测试命令、事件 trace、截图路径和停止状态。
```

## 十三、复现时必须额外记录的限制

每次复现报告必须写清楚这些限制是否触发：

| 限制 | 需要记录什么 |
|------|--------------|
| 页面轮询刷新 | 是否看到 3 秒级延迟，是否误判为卡住 |
| 同步发送消息 | `send message` 是否等到 runtime 完成才返回 |
| 停止取消 | 点击停止后 sidecar run 是否仍有日志或 token 消耗 |
| 事件上限 | 本次会话事件数是否超过 500，是否需要 afterSeq 补拉 |
| 命令上限 | 是否有超过 180 秒的测试/build，是否被截断 |
| PR draft 策略 | 创建的是 draft 还是 ready PR，是否符合任务要求 |
| 工作区来源 | 审查的是哪个 repo/branch，workspace 是否确认为目标仓库 |
