# 第 13 章 找到第一条请求

## 你在做什么

你将用安全测试返回的 requestId 在“请求记录”中定位唯一一条请求，核对状态、协议、appCaller、ServiceKeyId、模型、Provider、耗时和费用状态。

## 为什么要做

请求记录是排查链路的第一站。它把用户看到的错误与租户身份、路由尝试和费用证据连在一起。列表为空不代表页面无用，通常只是当前租户或时间范围没有请求。requestId 比截图或“大概五分钟前”更能准确定位。

## 开始前检查

- 手里有[[第 11 章：点击安全测试|第 11 章]]分别标记的 chat 与 vision 两个 requestId，但没有完整 key。本章先查 chat，再查 vision。
- 当前租户是“教程咖啡店”，角色至少可以读取请求记录。
- 记住安全直测没有访问上游，因此模型与 Provider 结果可能显示为未执行，费用应为 unknown。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 点击左侧“工作区”下的“请求记录”，或从 Quickstart 结果点击“打开 requestId 请求记录”。

**图 069 从左侧导航点击“请求记录”，不用猜页面地址**

![图 069 从左侧导航点击“请求记录”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/bcffe7fff162cb6ee18877fa2443fbb7c03672c554934b984e3efde4a02de3f1.png)

2. 在顶部唯一的 `requestId` 搜索框粘贴标记为 chat 的完整编号，按 Enter 或点击“查找”。输入过程中不会反复请求；提交后如果当前租户只匹配一条记录，详情会直接打开，不需要再点表格行。

**图 070 Logs 首屏直接给 requestId 搜索、高频筛选和高密度请求表格**

![图 070 Logs 首屏直接给 requestId 搜索、高频筛选和高密度请求表格](https://cds.miduo.org/api/reports/assets/2c0565db3416c7b60a2bd11f212b1fa2a201a3df4b0a5d0e0c657b1046907709.jpg)

3. 在“概览”页签先核对时间、状态、入口协议、appCaller、实际模型和 Provider。上方六项指标回答 token、费用、速度和总耗时；下方“上游响应”逐次列出 Provider、模型、模型池、结果和回退原因。

**图 105 详情概览把模型、Provider、核心指标和每次上游响应放在同一屏**

![图 105 详情概览把模型、Provider、核心指标和每次上游响应放在同一屏](https://cds.miduo.org/api/reports/assets/461587f1666bbdd38fab1b2c96bbefbd1aa81576478f15d41497dc978070f199.jpg)

4. 切到“请求与响应”，核对请求身份中的 App、Key 前缀、Request ID、Generation ID、入口协议和流式状态，再按需查看请求、响应或原始数据。App 应显示为 `G-` 加 appCallerCode；这里只显示 key 前缀，不显示完整 key。

**图 106 请求与响应页签集中展示调用身份和脱敏后的原始证据**

![图 106 请求与响应页签集中展示调用身份和脱敏后的原始证据](https://cds.miduo.org/api/reports/assets/79a6b38e273abd3500a55b1f318d574d8cd799b34df06e9a4ee5a1de708dbc92.jpg)

5. 切到“路由”，按顺序看期望路由、实际模型、Provider、模型池、参数策略和 PromptPolicy。安全直测应显示未调用上游；真实请求则必须能解释实际走到哪个 Provider，以及前一次失败后为什么继续尝试。

**图 107 路由页签把期望、实际、参数处理和提示词策略串成一条轨迹**

![图 107 路由页签把期望、实际、参数处理和提示词策略串成一条轨迹](https://cds.miduo.org/api/reports/assets/c40bedc0d0d216462c49970ac257de3ff2f55fdf703097c35301206022120c34.jpg)

6. 切到“审计”，核对网关估算、供应商实际、价格快照、汇率凭证、对账状态和调用身份。unknown 必须显示为“未知”或破折号，不能显示成 0；CNY 与 USD 没有汇率凭证时必须分开显示。

**图 108 审计页签把费用可信度、身份和时间证据放在一起**

![图 108 审计页签把费用可信度、身份和时间证据放在一起](https://cds.miduo.org/api/reports/assets/38435bbbfdecaed01838c587b2b1aecf52a33bf2a6c4b7c94706d75997c0b013.jpg)

7. 关闭详情，在同一个搜索框换成标记为 vision 的 requestId 并再次提交。新的精确匹配会自动打开详情；核对 vision appCaller、另一条 Key 前缀、内容类型和路由。关闭详情后不会因为同一个筛选值反复弹开，只有提交新的 requestId 才自动打开。

**图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试**

![图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试](https://cds.miduo.org/api/reports/assets/c559463c5a6e0df620dda4560687de11cbbe0821170450ecb8ab0a116a561dd4.png)

8. 最后返回概览，确认“最近请求”和 Top appCaller 开始出现 chat 与 vision 两条测试数据；再点最近请求应回到同一详情。

**图 074 每条请求显示模型、Provider、App、token、费用、速度和 key 身份**

![图 074 每条请求显示模型、Provider、App、token、费用、速度和 key 身份](https://cds.miduo.org/api/reports/assets/6905aa13616c5bd2191b0971714064d307f8e9a5d9f543fd302d4c4b3989d1a4.png)

## 看到什么算成功

requestId 提交后精确命中一条当前租户日志并自动打开详情；请求、上游调用、会话三个列表视图都有真实数据来源，四个详情页签分别回答结果、内容、路由和审计问题。可见身份字段与 Quickstart 配置一致，日志不含 key 明文；安全直测明确显示未调用上游，unknown 费用保持未知。概览的最近请求也能回到这条详情。

## 失败怎么办

- 搜不到 requestId：先清除其他筛选并确认当前租户；仍为空时回 Quickstart 查看测试是否明确写入日志。
- 找到多条相同 requestId：这是严重唯一性问题，停止继续测试并把 requestId、租户和时间交给管理员。
- ServiceKeyId 或团队不一致：不要继续真实调用，核对是否选错租户或 key，并报告服务端身份解析问题。
- unknown 显示为 0：不要据此做费用结论，保留证据并让费用负责人修正展示口径。

## 本章小结

你已从租户配置全空状态走到第一条可审计请求。此时只证明租户、团队、appCaller、key、协议入口和日志能够彼此对应；dry-run 在模型解析前结束，所以还没有证明默认池、模型或 Provider 真正可用。[[第 14 章：理解 key、appCaller 和模型池|第 14 章]]先补预算与速率，[[第 18 章：看懂健康、优先级和回退|第 18 章]]看健康，[[第 20 章：配置 PromptPolicy|第 20 章]]用公开教程桩各验证一次 chat 与 vision 的真实应用链，[[第 27 章：四协议保真验收|第 27 章]]再完成四协议 dry-run 与合同保真验收。

## 下一章

点击 [[第 14 章：理解 key、appCaller 和模型池]]，用“谁、为什么、去哪里”彻底分清三者。
