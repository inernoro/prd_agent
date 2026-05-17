# CDS Agent 管理员 · 指南

> **版本**：v1.2 | **日期**：2026-05-17 | **状态**：active（官方 SDK adapter 迁移中，商业级门禁已标注）

## 适用对象

本指南面向 MAP 系统管理员。目标是把 CDS Agent 配到“普通用户打开页面即可使用”的程度，而不是每次测试都让用户重新授权或临时填写密钥。

## 授权原则

CDS 授权是系统级长期授权：

- 一次授权后长期有效，直到管理员主动撤销或删除连接。
- 10 分钟只允许用于一次性配对 code 或临时握手，不允许作为 long token 的有效期。
- MAP 保存 CDS long token，用于后续创建项目、创建会话、启动 runtime、发送消息、停止资源和读取日志。
- 页面必须明确区分 `active`、`revoked`、`failed`，不能“能探活却显示已撤销”。

## 配置 CDS 连接

1. 打开 `设置 -> 基础设施服务`。
2. 新增 CDS 服务地址。
3. 跳转到 CDS 授权页。
4. 在 CDS 确认 MAP 名称、回跳地址和 scope。
5. 授权后回到 MAP。
6. 在 MAP 点击探活，确认状态为 `active`。

scope 至少需要：

```text
shared-service:deploy
instance:read
deployment:stream
```

后续若要让 Agent 提交 PR，还需要对应 GitHub 凭据或 CDS 项目级凭据由 runtime 安全注入。

## 配置模型运行配置

模型运行配置是系统级资源，用户会话只选择 profile，不直接暴露 API key。

命名边界：

- `runtime=claude-sdk` 是历史配置名；新代码审查路径的目标 adapter 是 `claude-agent-sdk`。
- `claude-agent-sdk` 指官方 Claude Agent SDK，由 sidecar 调用；本仓库只维护 MAP/CDS 控制面、profile、审批、事件、日志和 cancel/stream 映射。
- `legacy-sidecar` 只作为显式 fallback，不能作为新的代码审查默认路径。
- `fake` 只用于冒烟链路，不允许作为最终验收 runtime。

必填字段：

| 字段 | 说明 |
|------|------|
| 名称 | 用户可识别的配置名，例如 `公司 Claude 网关` |
| runtime | 历史字段值为 `claude-sdk`、`codex`、`custom` 或 `fake`；代码审查默认必须能映射到 `claude-agent-sdk` |
| protocol/baseUrl | 代码审查默认使用 Anthropic/Claude-compatible profile；OpenAI-compatible profile 不能直接喂给 `claude-agent-sdk` |
| model | 真实 Claude 模型名，不写死 demo |
| API key | 加密保存，页面只显示是否已配置 |
| 默认配置 | 没有显式选择时使用的 profile |

推荐配置顺序：

1. 打开 `/cds-agent` 的 Runtime 调试区域。
2. 使用后端提供的 Anthropic 官方模板创建 profile。
3. 填入 API key，并设为默认 profile。
4. 确认 runtime-status 显示 `compatibleWithDesiredRuntimeAdapter=true`。
5. 再运行 S1/S2/S3 provider smoke；不要用 OpenRouter/OpenAI-compatible 默认 profile 作为商业级验收。

## 生产级限制

当前 CDS Agent MVP 已能完成远程巡检和 PR 验收，但管理员必须知道这些限制：

| 限制 | 管理动作 |
|------|----------|
| 页面靠轮询刷新事件 | 验收时记录延迟，不把“页面能刷新”写成“真 SSE 已完成” |
| provider profile 不兼容 | 先修默认 Anthropic/Claude-compatible profile；看到 `runtime_profile_incompatible` 是正确阻断 |
| S1/S2/S3 尚未真实跑 provider | 只有配置真实 API key 后才允许宣称“能审代码、能审批、能停止” |
| 事件默认最多 500 条 | 大任务验收必须用 afterSeq 补拉或导出证据 |
| `repo_run_command` 180 秒上限 | 长测试需要拆分，后续补长命令后台化 |
| 其他仓库依赖 workspace | 审其他 repo 前配置 `AGENT_WORKSPACE_ROOT`、`AGENT_WORKSPACE_GITHUB_REPOSITORY`、`AGENT_WORKSPACE_GIT_REF` |

## Hook Profile

Hook 用于在会话生命周期中执行固定动作：

- `beforeStart`：启动前检查环境或注入项目。
- `afterStart`：启动后初始化仓库、打印版本、写入上下文。
- `beforeStop`：停止前收集摘要。
- `afterStop`：停止后清理资源或归档日志。

默认失败策略：

- 启动前 Hook 失败阻断启动。
- 启动后 Hook 失败标记会话失败。
- 停止 Hook 失败只记录错误，不阻断资源释放。

## 安全边界

- API key 只能在后端加密保存，前端不回显明文。
- long token 不写入日志。
- 危险工具默认需要人工审批。
- runtime 必须隔离工作目录、环境变量、网络和资源限制。
- PR 任务必须使用专门的 GitHub token 或 CDS 项目凭据，不能借用个人浏览器会话。

## 管理员验收清单

| 项 | 预期 |
|----|------|
| CDS 授权 | active，刷新后仍 active |
| 模型配置 | 至少一个默认 Anthropic/Claude-compatible profile，model/API key 完整 |
| 官方 SDK adapter | runtime-status 显示 `desiredRuntimeAdapter=claude-agent-sdk`、`loopOwner=claude-agent-sdk` |
| 新建会话 | 用户页面能创建 running 会话 |
| 发送消息 | S1 只读 provider run 真实返回 assistant 消息 |
| 工具审批 | 危险工具卡片可允许或拒绝 |
| 停止释放 | S3 Stop 后有 cancel/interrupt 证据，日志可查 |
| PR 验收 | 远程 runtime 可巡检 `prd_agent` 并提交 PR |
