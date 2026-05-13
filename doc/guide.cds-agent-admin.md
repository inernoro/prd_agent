# CDS Agent 管理员 · 指南

> **版本**：v1.0 | **日期**：2026-05-14 | **状态**：开发中

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

必填字段：

| 字段 | 说明 |
|------|------|
| 名称 | 用户可识别的配置名，例如 `公司 Claude 网关` |
| runtime | `claude-sdk`、`codex-sdk` 或 `fake` |
| baseUrl | 任意 OpenAI-compatible 或内部网关地址 |
| model | 真实模型名，不写死 demo |
| API key | 加密保存，页面只显示是否已配置 |
| 默认配置 | 没有显式选择时使用的 profile |

`fake` 只用于冒烟链路，不允许作为最终验收 runtime。

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
| 模型配置 | 至少一个默认 profile，baseUrl/model/API key 完整 |
| 新建会话 | 用户页面能创建 running 会话 |
| 发送消息 | 页面有流式输出和事件 |
| 工具审批 | 危险工具卡片可允许或拒绝 |
| 停止释放 | 会话停止后资源释放，日志可查 |
| PR 验收 | 远程 runtime 可巡检 `prd_agent` 并提交 PR |
