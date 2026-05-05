# debt.claude-sdk-executor

| 字段 | 内容 |
|---|---|
| 模块 | claude-sdk 执行器 / Python sidecar |
| 状态 | 活跃 |
| 关联 | `doc/design.claude-sdk-executor.md` |

---

## 已知工程债务

| ID | 说明 | 优先级 | 触发条件 |
|---|---|---|---|
| D-1 | 未实现 `/api/agent-tools/invoke` callback controller。sidecar 收到 `tool_use` 时只能拿到 stub，无法真正访问主服务工具集。 | P1 | 任何想让 Claude 自主调工具的 Agent 落地前必须补 |
| D-2 | `ExecuteCliAgent_ClaudeSdkAsync` 退出时未写 `llmrequestlogs`，token 用量只在结构化日志里。账单页看不到 claude-sdk 调用。 | P1 | 上线前必须补 |
| D-3 | admin 前端 `WorkflowNodeEditor` 没有 claude-sdk 专属配置面板（`model / systemPrompt / sidecarTag / maxTurns / tools`）。当前只能通过 raw JSON 编辑节点配置。 | P2 | 给 PM/QA 用之前必须做 |
| D-4 | 没有 Polly 重试 / 熔断器保护对 sidecar 的 HTTP 调用，依赖 `IHttpClientFactory` 默认行为。HostedService 健康检查能避开宕机实例，但无法处理瞬时 5xx 抖动。 | P2 | 多实例高并发场景 |
| D-5 | sidecar 的 callback 调用仅支持 X-Agent-Api-Key 单一鉴权方式，未与现有 `RequireScopeAttribute` 验证链打通。新 controller 创建时需明确 scope（如 `agent.tools:invoke`）。 | P2 | 与 D-1 一起做 |
| D-6 | `claude-sdk` 执行器返回的 artifact 格式硬编码为 HTML 页面（与 `builtin-llm` 看齐）。如果 Agent 输出是 JSON / Markdown / 代码 patch，artifact 类型需要根据 prompt 推断。 | P3 | 多场景 Agent 落地后 |
| D-7 | sidecar Dockerfile 没做多阶段构建 + 非 root 用户。镜像略大且以 root 运行。 | P3 | 上生产前 |
| D-8 | 未做端到端集成测试。`ClaudeSidecarRouter` 的 SSE 解析、`InstanceStateRegistry` 的并发行为、健康检查的失败计数都只有 code review，没有 xunit 覆盖。 | P2 | 推到主分支前 |
| D-9 | `appsettings.json` 中的 `ClaudeSdkExecutor` 段对开发者可见，可能误以为已启用。需要在 admin UI 加 "claude-sdk 状态" 卡片提示当前是否真的有 sidecar 配置。 | P3 | 与 D-3 一起做 |

---

## 偿还顺序建议

```
D-1 + D-2 同时做（一个 PR）：补 callback controller + llmrequestlogs 写入
  ↓
D-3 + D-9 同时做：admin UI 配置面板 + 状态卡片
  ↓
D-5 + D-8：scope 验证 + xunit 集成测试
  ↓
D-4 D-6 D-7：按需补
```

---

## 历史背景

2026-05-05 v0.1 落地时为了"先把骨架跑通让用户看到形态"，主动延迟了上述 9 条。本文件即"延迟清单"，避免下一次 session 不知道这些坑。
