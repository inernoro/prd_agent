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

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 点击左侧“工作区”下的“请求记录”，或从 Quickstart 结果点击“打开 requestId 请求记录”。

**图 069 从左侧导航点击“请求记录”，不用猜页面地址**

![图 069 从左侧导航点击“请求记录”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/bcffe7fff162cb6ee18877fa2443fbb7c03672c554934b984e3efde4a02de3f1.png)

2. 先粘贴标记为 chat 的完整 requestId。筛选会自动生效，不需要寻找“执行查找”按钮。

**图 070 Activity 是当前租户请求活动记录，顶部先给趋势、状态和费用可信度**

![图 070 Activity 是当前租户请求活动记录，顶部先给趋势、状态和费用可信度](https://cds.miduo.org/api/reports/assets/77109e68f951f9787a9c1c3d1394562bd9688ddd32c02f2628f61b9d41af5a99.png)

3. 打开唯一匹配记录，先核对时间、成功状态、入口协议和 appCaller `tutorial.gateway-book::chat`。

**图 071 请求趋势和状态分布让用户先看有没有流量与失败**

![图 071 请求趋势和状态分布让用户先看有没有流量与失败](https://cds.miduo.org/api/reports/assets/af4fb1eb6028d571e6923c337b807fab3c0872eff1a16817fa744082a486bb37.png)

4. 核对可见身份字段：团队为客服组，ServiceKeyId 对应刚创建的 key，环境为 test。页面不展示 TenantId；当前租户由会话确定，不能靠详情里的客户端字段证明。

**图 072 费用可信度条区分价格覆盖、unknown 与原币种金额**

![图 072 费用可信度条区分价格覆盖、unknown 与原币种金额](https://cds.miduo.org/api/reports/assets/d6875f1f274fb6106f00336d5889877e1911c7077c9b98980bf25bd69e19fb0e.png)

5. 打开详情的“Request”标签，在请求正文中找到 `upstreamCalled=false`；它说明 dry-run 在上游前结束，而不是伪造一个实际模型成功结果。

**图 073 请求、上游调用、会话和后台任务四个页签回答不同问题**

![图 073 请求、上游调用、会话和后台任务四个页签回答不同问题](https://cds.miduo.org/api/reports/assets/381b0bb85f777a44ed90be5ef4298f323f2839c12decf45b96e011a3d4d1d9c9.png)

6. 查看费用：unknown 应显示为未知或破折号，不应变成 0；没有实际账单时也不应显示 reconciled。

**图 074 每条请求显示模型、Provider、App、token、费用、速度和 key 身份**

![图 074 每条请求显示模型、Provider、App、token、费用、速度和 key 身份](https://cds.miduo.org/api/reports/assets/6905aa13616c5bd2191b0971714064d307f8e9a5d9f543fd302d4c4b3989d1a4.png)

7. 返回列表，换成标记为 vision 的 requestId，核对内容组、vision appCaller 和另一条 ServiceKeyId。最后返回概览，确认“最近请求”和 Top appCaller 开始出现这两条测试数据。

**图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试**

![图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试](https://cds.miduo.org/api/reports/assets/c559463c5a6e0df620dda4560687de11cbbe0821170450ecb8ab0a116a561dd4.png)

## 看到什么算成功

requestId 精确命中一条当前租户日志，可见身份字段与 Quickstart 配置一致；日志不含 key 明文。“Request”标签明确出现 `upstreamCalled=false`，费用保持未知。概览的最近请求也能回到这条详情。

## 失败怎么办

- 搜不到 requestId：先清除其他筛选并确认当前租户；仍为空时回 Quickstart 查看测试是否明确写入日志。
- 找到多条相同 requestId：这是严重唯一性问题，停止继续测试并把 requestId、租户和时间交给管理员。
- ServiceKeyId 或团队不一致：不要继续真实调用，核对是否选错租户或 key，并报告服务端身份解析问题。
- unknown 显示为 0：不要据此做费用结论，保留证据并让费用负责人修正展示口径。

## 本章小结

你已从租户配置全空状态走到第一条可审计请求。此时只证明租户、团队、appCaller、key、协议入口和日志能够彼此对应；dry-run 在模型解析前结束，所以还没有证明默认池、模型或 Provider 真正可用。第 14 章先补预算与速率，第 18 章看健康，第 20 章用公开教程桩各验证一次 chat 与 vision 的真实应用链，第 27 章再完成四协议 dry-run 与合同保真验收。

## 下一章

点击 [[第 14 章：理解 key、appCaller 和模型池]]，用“谁、为什么、去哪里”彻底分清三者。
