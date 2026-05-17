# CDS Agent 代码审查上手指南

> 版本：v1.0 | 日期：2026-05-17 | 状态：面向使用者的 quickstart

## 目标

这份文档回答两个问题：

- 我想让 CDS Agent 审查当前仓库或其他仓库，会经历哪些步骤。
- 当前官方 SDK、自研控制面、其他智能体分别负责什么，出问题时该看哪里。

结论先写清楚：CDS Agent 的产品目标不是继续自研 agent loop，而是保留 MAP/CDS 控制面，把代码任务的循环、上下文、Claude Code 工具和权限回调交给官方 `claude-agent-sdk` adapter。MAP/CDS 继续负责登录、仓库/分支、runtime profile、审批、事件、日志、产物和可视化调试。

## 一次代码审查会发生什么

| 阶段 | 用户动作 | 系统动作 | 你应该看到 |
| --- | --- | --- | --- |
| 1. 选择入口 | 打开 `/cds-agent` 或从 AI 百宝箱委托 `cds-agent` | MAP 创建或复用 infra agent session | sessionId、traceId、runtime adapter |
| 2. 选择目标 | 填 `gitRepository/gitRef`，或使用当前 CDS workspace | CDS/sidecar 准备 workspace；私有 GitHub 需要授权 token | workspace source、repo/ref、commit |
| 3. 选择模型 | 选择 runtime profile | MAP 解析 provider/baseUrl/model/key；key 不进入日志 | provider key gate 通过，或显示 `provider_key_missing` |
| 4. 启动 run | 发送只读审查 prompt | MAP 入队后台 job，sidecar 选择 `claude-agent-sdk` | `runtime_init`、`loopOwner=claude-agent-sdk` |
| 5. 读取/分析 | 等 Agent 审查代码 | 官方 SDK 负责上下文、工具循环和流式输出 | text delta、tool event、usage/result |
| 6. 危险动作 | 如果要运行命令、写文件、开 PR | SDK permission callback 转 MAP approval | 页面出现允许/拒绝，刷新后仍可操作 |
| 7. 结束/停止 | 等完成或点击 Stop | MAP 写 done/cancel 事件；adapter 调 SDK interrupt | done/error/cancel 结构化事件 |
| 8. 复盘 | 导出 run bundle | 页面导出 session、events、logs、diagnostics，自动脱敏 | 可提交给维护者排障 |

## 推荐使用顺序

第一次使用不要直接要求改代码和发 PR。按下面顺序验证，每一步都看 Runtime 调试面板：

1. 只读仓库摘要：只输出目录、分支、最近提交，不修改文件。
2. 只读代码审查：指出一个风险，要求给文件路径和原因。
3. 命令审批：让它尝试 `git status --short`，确认页面出现审批卡。
4. 取消测试：让它循环输出状态 2 分钟，点击 Stop，确认底层 run 停止。
5. 修改任务：只允许改一个小文件，要求运行最小测试。
6. PR 任务：确认 GitHub 权限后再让它创建分支和 PR。

## 审查当前仓库

在本仓库或已准备好的 CDS workspace 中，prompt 可以这样写：

```text
请只读审查当前仓库中 CDS Agent runtime 相关代码，指出 3 个最可能影响稳定性的风险。
要求：
1. 不修改文件；
2. 不运行危险命令；
3. 每个风险给出文件路径、触发条件、建议验证方式。
```

通过标准：

- Runtime 调试显示 `runtimeAdapter=claude-agent-sdk`。
- Loop owner 显示 `claude-agent-sdk`，不是 `sidecar-legacy-loop`。
- 事件里有 `runtime_init/text_delta/done`。
- 没有文件变更，也没有未审批的危险工具。

## 审查其他仓库

填写：

- `gitRepository`: `owner/repo` 或 `https://github.com/owner/repo`
- `gitRef`: 分支、tag 或 commit，例如 `main`

公开仓库可直接准备 workspace。私有仓库需要 sidecar 环境有 `SIDECAR_GITHUB_TOKEN` 或 `GITHUB_TOKEN`，或者后续接入 GitHub App 授权选择器。

常见 workspace 错误：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `unsupported_git_repository` | 仓库格式不支持 | 改成 `owner/repo` 或 GitHub HTTPS URL |
| `unsupported_git_ref` | ref 含不安全字符 | 使用普通 branch/tag/commit |
| `github_repository_auth_or_not_found` | 仓库不存在或私有仓库无授权 | 检查仓库名和 GitHub token/App 授权 |
| `git_ref_not_found` | 分支/tag/commit 不存在 | 更换 `gitRef` |
| `workspace_target_conflict` | workspace 目录冲突 | 清理或更换 workspace root |

## 官方 SDK 与自研边界

| 部分 | 归属 | 当前策略 |
| --- | --- | --- |
| Agent turn loop、上下文管理、Claude Code 内置工具 | 官方 `claude-agent-sdk` | 默认目标路径 |
| MAP session、审计、审批、事件、日志、run bundle | 本仓库 | 必须保留 |
| CDS workspace、分支、容器、preview、secret | 本仓库 CDS 控制面 | 必须保留 |
| `SidecarRuntimeAdapter` | 本仓库薄传输层 | 只做 MAP 到 sidecar 的路由/SSE/cancel 映射 |
| `legacy-sidecar` | 兼容 fallback | 只在显式配置时使用 |
| PRD/缺陷/文学/视觉智能体 | 非代码 agent | 先不迁到 Claude Agent SDK，避免被代码 runtime pool 影响 |

`claude-agent-sdk` 不是本仓库自研。当前 adapter 代码是本仓库写的接入层，用来把官方 SDK 的事件、权限、取消和结果映射进 MAP/CDS。

模型配置里的 “Anthropic 官方模板” 来自 MAP 后端 `GET /api/infra-agent-runtime-profiles/templates`，不是页面硬编码。它会预填 Anthropic Messages 协议、官方 baseUrl、Claude Sonnet 模型和资源默认值；用户仍需手动填入自己的 API key 并保存为 runtime profile。

## 失败先看哪里

| 现象 | 优先查看 |
| --- | --- |
| 页面打开但不能跑 | Runtime 调试面板的 blockers/nextActions |
| `instanceCount=0` | CDS sidecar runtime pool 发现，参考 `doc/guide.cds-agent-runtime-pool-recovery.md` |
| `provider_key_missing` | runtime profile 或 sidecar `ANTHROPIC_API_KEY` |
| `claude_agent_sdk_not_available` | sidecar 镜像依赖和 `claude-agent-sdk` 安装 |
| workspace 失败 | error content 的 `workspaceErrorCode` |
| 审批不出现 | MAP approval bridge 和 `/api/agent-tools/approvals/...` |
| Stop 后还输出 | `CurrentRuntimeRunId`、sidecar cancel、SDK interrupt 事件 |
| Toolbox 看似完成但远程还在跑 | 这是正常异步委托；打开 run handle 对应的 `/cds-agent?sessionId=...` |

## 当前未完成的商业级验收

截至 2026-05-17，代码已具备官方 SDK adapter seam、结构化诊断、事件游标、异步 Toolbox 句柄、run bundle 导出、runtime pool smoke 和 profile preflight gate。但仍不能宣称完全完成，原因是远程 preview 的真实 official SDK run 还缺这些证据：

- 配置真实 Claude/Anthropic-compatible runtime profile 和 API key。
- 远程 S1 只读 run 用该 profile 真实通过。
- 远程 S2 MAP 审批真实通过。
- 远程 S3 Stop 能真实 interrupt SDK run。
- `/cds-agent` 截图显示真实运行态字段，而不是静态或空态。

完成这些后，才可以把“上手即用”从诊断可用推进到商业级可用。
