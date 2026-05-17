# CDS Agent 运行手册 · 指南

> **版本**：v1.2 | **日期**：2026-05-17 | **状态**：active（MVP 可用，生产级限制已标注）

## 服务组成

| 服务 | 职责 |
|------|------|
| `prd-admin` | CDS Agent 页面、基础设施服务配置、工具审批 |
| `prd-api` | long token 保存、会话持久化、事件代理、runtime profile 加密 |
| `cds` | 创建远程 runtime、执行消息、输出事件和日志 |
| MongoDB | 保存连接、profile、session、event、hook |
| runtime 容器或 worker | 执行 Claude sidecar、Codex-like 或 fake runtime |

命名边界：

- `claude-sdk` 是历史配置名，当前实现不是完整官方 Claude Code SDK / Claude Agent SDK。
- sidecar 使用官方 `anthropic` Python SDK；agent loop、审批、repo/PR/Bridge 工具和 MAP/CDS 事件转译由本仓库维护。
- `claude-agent-sdk` adapter seam 已存在，但真实远程 official SDK run 依赖 MAP 能发现 healthy CDS sidecar runtime pool；恢复步骤见 `doc/guide.cds-agent-runtime-pool-recovery.md`。

## 部署后检查

1. `prd-api` 编译无 CS error。
2. `prd-admin` `tsc --noEmit` 通过。
3. `cds` build 通过。
4. 主分支预览域名可打开。
5. 从真实路径进入：登录 -> 左侧设置 -> 基础设施服务。
6. 授权 CDS 后状态为 `active`。
7. 新建模型运行配置。
8. 从左侧导航进入 `CDS Agent`，新建会话并发送消息。

## 401 或对端不可达

症状：

- 探活显示 401。
- 页面提示对端不可达。
- 连接列表显示 `revoked`。

诊断：

1. 检查连接状态是否为 `active`。
2. 检查 MAP 保存的 long token 是否存在。
3. 检查 CDS 是否把 token 标记为 revoked。
4. 检查 MAP baseUrl 是否为 CDS 地址，不是 MAP 回跳地址。
5. 检查 CDS 授权页回跳地址是否指向 MAP。

处理：

1. 如果 token 被撤销，重新授权。
2. 如果地址错误，删除错误连接后重新配置。
3. 如果能通但显示 revoked，优先检查 MAP 状态刷新逻辑和 CDS token 状态映射。

## 模型配置失败

症状：

- 创建会话失败，提示没有模型运行配置。
- runtime 启动失败。
- 只有 fake 输出。

诊断：

1. 确认至少存在一个默认 runtime profile。
2. 确认 `baseUrl` 是 http 或 https。
3. 确认 API key 已保存且后端可解密。
4. 确认 runtime 类型与 CDS 支持的 adapter 一致。
5. 确认 fake runtime 没有被误当成最终验收。

处理：

1. 新建或修复 runtime profile。
2. 使用只读任务测试真实 runtime。
3. 在日志里确认请求进入真实 adapter。

## 会话无法恢复

症状：

- 刷新后消息丢失。
- 事件重复或乱序。
- stream 断开后无法续读。

诊断：

1. 查询 session 是否存在。
2. 查询 events 是否按 `seq` 递增。
3. 使用 `GET /events?afterSeq=` 验证续读。
4. 检查前端是否按最后一个 seq 恢复，而不是重新覆盖全部消息。

处理：

1. 修复事件写入顺序。
2. 修复前端去重。
3. 对异常 session 保留日志，不要直接删除。

## 页面看起来卡住

症状：

- 用户点击发送后按钮长时间 busy。
- 页面不是逐字实时变化，或 SSE 断开后只靠兜底刷新。
- 后端已经返回，但运行状态长时间停在 queued/running。

诊断：

1. 当前 CDS Agent 页面是 SSE 优先，失败时按 `afterSeq` JSON 分页兜底。
2. `SendMessageAsync` 只负责写入消息并入队后台 runtime job，不应同步等待完整 Agent 执行。
3. 检查 `/events?afterSeq=` 是否仍在增长；如果事件增长，说明任务还在执行，不是页面完全失效。
4. 如果一直没有 runtime 事件，先查 `/api/infra-agent-sessions/runtime-status?refreshDiscovery=true`，确认 runtime pool 是否 healthy。

处理：

1. 让用户把大任务拆成“只读巡检 -> 最小修复 -> 创建 PR”三段。
2. 如果任务超过预期，先查看 sidecar 日志、runtime profile timeout 和 runtime-status blockers。
3. 如果 SSE 断开但分页正常，优先修前端订阅/代理超时；如果分页也没有事件，优先修后台 job 或 runtime pool。

## 停止后仍疑似运行

症状：

- 用户点击停止后，页面显示 stopped，但 sidecar 日志仍有输出。
- 模型 provider 仍有 token 消耗。

诊断：

1. 当前 `Stop` 会停止 MAP session，并通过 adapter best-effort 调 sidecar cancel。
2. session 已持久化 `CurrentRuntimeRunId`，但真实 official SDK 路径仍必须验证是否调用到 `ClaudeSDKClient.interrupt()`。

处理：

1. 记录 sessionId、traceId、sidecar 名称和时间窗口。
2. 必要时在 sidecar 侧按 runId 或日志排查。
3. 如果 MAP 状态停止但 sidecar 仍输出，按 `doc/guide.cds-agent-runtime-pool-recovery.md` 的 S3 cancel smoke 定位。

## 工具审批卡住

症状：

- 会话一直 running，但没有后续输出。
- 工具调用显示 waiting。

诊断：

1. 查看最新事件是否为 `tool_call`。
2. 检查工具风险等级。
3. 检查前端审批 API 是否成功返回。

处理：

1. 用户在页面允许或拒绝工具。
2. 如果审批失败，重试审批 API。
3. 如果 runtime 没有收到审批结果，检查 MAP 到 CDS 的审批代理。

## PR 验收失败

症状：

- Agent 只给建议，没有提交 PR。
- 远程仓库没有分支。
- PR 链接为空。

诊断：

1. 检查 runtime 是否具备 GitHub token。
2. 检查 sandbox 是否能 clone 或访问 `prd_agent`。
3. 检查 git 用户名、邮箱、remote 权限。
4. 检查分支是否推送成功。
5. 检查 PR 创建命令或 GitHub API 调用结果。

处理：

1. 补齐 CDS 项目级 GitHub 凭据。
2. 使用只读 git 命令确认访问权限。
3. 让 Agent 先提交一个最小文档或测试修复 PR 验证链路。

## 审查其他仓库失败

症状：

- Agent 明明要求审查其他 repo，但事件里仍读取 `prd_agent`。
- PR 创建到错误仓库。

诊断：

1. 检查 runtime 环境变量：`AGENT_WORKSPACE_ROOT`、`AGENT_WORKSPACE_GITHUB_REPOSITORY`、`AGENT_WORKSPACE_GIT_REF`。
2. 检查 sandbox 里实际 `git remote get-url origin` 和当前分支。
3. 检查 runtime profile 是否复用了默认 workspace。

处理：

1. 先用只读 prompt 要求 Agent 输出 `git status --short`、`git remote get-url origin`、`git branch --show-current`。
2. 确认仓库和分支正确后，再允许写文件、跑测试、创建 PR。

## 回滚

如果发布后 CDS Agent 页面不可用：

1. 暂停 `CDS Agent` 导航入口或保留 `wip` 标记。
2. 保留 `设置 -> 基础设施服务` 探活和授权功能。
3. 回滚 prd-api 会话代理改动前，先导出 `infra_agent_sessions` 和事件集合。
4. CDS runtime adapter 可独立回滚到 fake，但页面必须显示 fake 状态。
