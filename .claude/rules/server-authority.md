---
globs: ["prd-api/src/**/*.cs"]
---

# 服务器权威性设计

客户端被动断开不得取消服务器任务。只有用户主动调用取消 API 才允许中断。

## 强制规则

1. LLM 调用、数据库写操作必须使用 `CancellationToken.None`，禁止传递 `HttpContext.RequestAborted`
2. SSE 写入必须捕获 `OperationCanceledException` + `ObjectDisposedException`，断开后跳过写入但继续处理
3. 长任务必须通过 Run/Worker 模式与 HTTP 连接解耦
4. SSE 流必须每 10 秒 keepalive 心跳，支持 `afterSeq` 断线续传
5. Worker 关闭时必须将未完成的 run 标记为失败（`CancellationToken.None`）

> 详细设计：`doc/design.server-authority.md`
