# 第 21 章 看懂请求记录和会话

## 你在做什么

这一章先查看[[第 11 章：点击安全测试|第 11 章]]的 chat dry-run，再查看[[第 20 章：配置 PromptPolicy|第 20 章]]的 chat 教程桩请求。前者证明接入，后者才经过策略、模型池和 Provider；vision 的两条 requestId 保留给图片理解专项核对，不与本章 chat 证据混用。

## 为什么要做

用户说“刚才变慢了”时，时间和模型名往往不够准确。requestId 是每次请求的独立编号，session 则把同一段业务会话连接起来。先找到证据再判断，才能避免把别的租户、别的 key 或别的模型问题混在一起。

## 开始前检查

- 手边有[[第 11 章：点击安全测试|第 11 章]]标为 chat 的 dry-run requestId，以及[[第 20 章：配置 PromptPolicy|第 20 章]] chat 非 dry-run 教程桩 requestId。没有后者时，本章不能声称 chat 路由已经验证。
- 当前角色能查看请求记录；租户来自登录会话，不由筛选框或 URL 参数决定。
- 至少有一条 Quickstart dry-run 记录。它能验证接入链路，但不会证明真实上游已被调用。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 从左侧“工作区”进入“请求记录”，先搜索[[第 11 章：点击安全测试|第 11 章]]标为 chat 的 dry-run requestId。

**图 069 从左侧导航点击“请求记录”，不用猜页面地址**

![图 069 从左侧导航点击“请求记录”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/bcffe7fff162cb6ee18877fa2443fbb7c03672c554934b984e3efde4a02de3f1.png)

2. 打开详情，确认 Provider 为 `gateway-dry-run`、模型为 `not-called` 或页面等义文案。这条记录只能证明地址、key、团队、appCaller 和协议形状。

**图 070 Activity 是当前租户请求活动记录，顶部先给趋势、状态和费用可信度**

![图 070 Activity 是当前租户请求活动记录，顶部先给趋势、状态和费用可信度](https://cds.miduo.org/api/reports/assets/77109e68f951f9787a9c1c3d1394562bd9688ddd32c02f2628f61b9d41af5a99.png)

3. 再搜索[[第 20 章：配置 PromptPolicy|第 20 章]] chat 命令输出的 requestId，核对时间、状态、协议、appCaller `tutorial.gateway-book::chat`、ServiceKeyId 和客服组。密钥这里只显示身份或遮盖信息。

**图 071 请求趋势和状态分布让用户先看有没有流量与失败**

![图 071 请求趋势和状态分布让用户先看有没有流量与失败](https://cds.miduo.org/api/reports/assets/af4fb1eb6028d571e6923c337b807fab3c0872eff1a16817fa744082a486bb37.png)

4. 在这条非 dry-run 详情中读取模型池、实际模型 `stub-chat`、Provider 和耗时；只有这条记录能证明真实路由经过教程桩。

**图 072 费用可信度条区分价格覆盖、unknown 与原币种金额**

![图 072 费用可信度条区分价格覆盖、unknown 与原币种金额](https://cds.miduo.org/api/reports/assets/d6875f1f274fb6106f00336d5889877e1911c7077c9b98980bf25bd69e19fb0e.png)

5. 查看 PromptPolicy 证据。应显示 policy id、version、hash，不应出现策略正文。

**图 073 请求、上游调用、会话和后台任务四个页签回答不同问题**

![图 073 请求、上游调用、会话和后台任务四个页签回答不同问题](https://cds.miduo.org/api/reports/assets/381b0bb85f777a44ed90be5ef4298f323f2839c12decf45b96e011a3d4d1d9c9.png)

6. 查看费用状态和原币种。[[第 7 章：配置第一个模型|第 7 章]]没有为教程桩填写价格，因此这里应保持 unknown，不能读成 0。

**图 074 每条请求显示模型、Provider、App、token、费用、速度和 key 身份**

![图 074 每条请求显示模型、Provider、App、token、费用、速度和 key 身份](https://cds.miduo.org/api/reports/assets/6905aa13616c5bd2191b0971714064d307f8e9a5d9f543fd302d4c4b3989d1a4.png)

7. 如果记录本身带 session，再切到“会话”或使用“会话 ID”筛选。没有 session 时明确写“本请求无会话 ID”，不要按相近时间强行合并。

**图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试**

![图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试](https://cds.miduo.org/api/reports/assets/c559463c5a6e0df620dda4560687de11cbbe0821170450ecb8ab0a116a561dd4.png)

8. 复制定位所需的 requestId，而不是复制整页可能含业务内容的详情。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试](https://cds.miduo.org/api/reports/assets/c559463c5a6e0df620dda4560687de11cbbe0821170450ecb8ab0a116a561dd4.png)

## 看到什么算成功

两条 requestId 各自定位一条当前租户记录：dry-run 明确显示未调用模型，教程桩记录能说明 key、appCaller、模型池、Provider 和策略证据。没有 session 时不虚构会话，敏感明文也没有泄露。

## 失败怎么办

- 搜索不到记录：检查 requestId 是否完整、时间范围是否包含测试时刻，以及当前是否仍在“教程咖啡店”。
- 详情返回不存在：不要切换 tenantId 或猜其他 id；跨租户详情应当像不存在一样被拒绝。
- 只有 dry-run 而没有实际模型：这是正常结果；回[[第 20 章：配置 PromptPolicy|第 20 章]]按无回显 key 步骤调用公开教程桩一次，不能拿 dry-run 冒充路由证据。
- session 中混入无关记录：按 appCaller、ServiceKeyId 和时间核对，确认调用方是否错误复用了 session 标识。
- 页面显示敏感正文或完整 key：停止分享页面，记录 requestId 并报告安全问题。

## 本章小结

requestId 回答“一次调用发生了什么”，session 回答“一段连续业务发生了什么”。先核对租户、key 和 appCaller，再看路由、策略、费用，排查就不会走偏。

## 下一章

点击 [[第 22 章：看懂用量、预算和费用]]，学习四种费用状态以及预算该如何阅读。
