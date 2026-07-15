# 第 13 章 找到第一条请求

## 你在做什么

你将用安全测试返回的 requestId 在“请求记录”中定位唯一一条请求，核对状态、协议、appCaller、ServiceKeyId、模型、Provider、耗时和费用状态。

## 为什么要做

请求记录是排查链路的第一站。它把用户看到的错误与租户身份、路由尝试和费用证据连在一起。列表为空不代表页面无用，通常只是当前租户或时间范围没有请求。requestId 比截图或“大概五分钟前”更能准确定位。

## 开始前检查

- 手里有第 11 章分别标记的 chat 与 vision 两个 requestId，但没有完整 key。本章先查 chat，再查 vision。
- 当前租户是“教程咖啡店”，角色至少可以读取请求记录。
- 记住安全直测没有访问上游，因此模型与 Provider 结果可能显示为未执行，费用应为 unknown。

## 跟我做

1. 点击左侧“工作区”下的“请求记录”，或从 Quickstart 结果点击“打开 requestId 请求记录”。
2. 先粘贴标记为 chat 的完整 requestId。筛选会自动生效，不需要寻找“执行查找”按钮。
3. 打开唯一匹配记录，先核对时间、成功状态、入口协议和 appCaller `tutorial.gateway-book::chat`。
4. 核对可见身份字段：团队为客服组，ServiceKeyId 对应刚创建的 key，环境为 test。页面不展示 TenantId；当前租户由会话确定，不能靠详情里的客户端字段证明。
5. 打开详情的“Request”标签，在请求正文中找到 `upstreamCalled=false`；它说明 dry-run 在上游前结束，而不是伪造一个实际模型成功结果。
6. 查看费用：unknown 应显示为未知或破折号，不应变成 0；没有实际账单时也不应显示 reconciled。
7. 返回列表，换成标记为 vision 的 requestId，核对内容组、vision appCaller 和另一条 ServiceKeyId。最后返回概览，确认“最近请求”和 Top appCaller 开始出现这两条测试数据。

## 看到什么算成功

requestId 精确命中一条当前租户日志，可见身份字段与 Quickstart 配置一致；日志不含 key 明文。“Request”标签明确出现 `upstreamCalled=false`，费用保持未知。概览的最近请求也能回到这条详情。

## 失败怎么办

- 搜不到 requestId：先清除其他筛选并确认当前租户；仍为空时回 Quickstart 查看测试是否明确写入日志。
- 找到多条相同 requestId：这是严重唯一性问题，停止继续测试并把 requestId、租户和时间交给管理员。
- ServiceKeyId 或团队不一致：不要继续真实调用，核对是否选错租户或 key，并报告服务端身份解析问题。
- unknown 显示为 0：不要据此做费用结论，保留证据并让费用负责人修正展示口径。

## 本章小结

你已从全空状态走到第一条可审计请求。基础链路完成：租户、团队、Provider、模型、默认池、appCaller、key、安全测试和日志能够彼此对应。

## 下一章

点击 [[第 14 章：理解 key、appCaller 和模型池]]，用“谁、为什么、去哪里”彻底分清三者。
