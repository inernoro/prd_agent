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

2. 粘贴完整 requestId 后，唯一匹配会自动打开详情。在“概览”中确认 Provider 为 `gateway-dry-run`、模型为 `not-called` 或页面等义文案。这条记录只能证明地址、key、团队、appCaller 和协议形状。

**图 070 Activity 是当前租户请求活动记录，顶部先给趋势、状态和费用可信度**

![图 070 Activity 是当前租户请求活动记录，顶部先给趋势、状态和费用可信度](https://cds.miduo.org/api/reports/assets/77109e68f951f9787a9c1c3d1394562bd9688ddd32c02f2628f61b9d41af5a99.png)

3. 再搜索[[第 20 章：配置 PromptPolicy|第 20 章]] chat 命令输出的 requestId。先在“概览”核对时间、状态、协议、App `G-tutorial.gateway-book::chat`、模型、Provider、token、速度和总耗时；密钥这里只显示前缀或遮盖信息。

**图 105 详情概览先回答本次请求用了什么模型、哪个 Provider 和发生了几次上游尝试**

![图 105 详情概览先回答本次请求用了什么模型、哪个 Provider 和发生了几次上游尝试](https://cds.miduo.org/api/reports/assets/1074b176d0aec40e050455586b52a21904877e77835702a0474b668be151ecd0.png)

4. 切到“请求与响应”，核对 Request ID、Generation ID、Key 前缀、流式状态和请求内容。需要交给同事排查时只复制 requestId；不要复制整页原始数据，也不要把可能包含业务内容的请求正文贴到公开群。

**图 106 请求与响应页签保留定位字段，同时把业务正文放在可控的查看区**

![图 106 请求与响应页签保留定位字段，同时把业务正文放在可控的查看区](https://cds.miduo.org/api/reports/assets/ceb8dc2af38d5ac805469ce974916357407bf6e12edeefe4a22baf9d91afbaf9.png)

5. 切到“路由”，读取模型池、实际模型、Provider、参数策略和每次上游尝试。只有非 dry-run 记录能证明真实路由；一次失败后继续尝试时，原因必须在这里能解释。

**图 107 路由页签说明从期望模型到实际 Provider 的完整选择过程**

![图 107 路由页签说明从期望模型到实际 Provider 的完整选择过程](https://cds.miduo.org/api/reports/assets/6cc6a319556a216b005450d17a349fa82e6a502ffcabfb59260a34a1befb3004.png)

6. 在同一“路由”页签查看 PromptPolicy 证据。只应出现 policy id、version 和 hash，不应出现策略正文；没有策略时应明确写未应用，不能猜测。

**图 107 路由页签只展示提示词策略的身份和版本证据**

![图 107 路由页签只展示提示词策略的身份和版本证据](https://cds.miduo.org/api/reports/assets/6cc6a319556a216b005450d17a349fa82e6a502ffcabfb59260a34a1befb3004.png)

7. 切到“审计”，查看费用状态和原币种。[[第 7 章：配置第一个模型|第 7 章]]没有为教程桩填写价格，因此这里应保持 unknown，不能读成 0；没有供应商逐请求账单时也不能写成 reconciled。

**图 108 审计页签把估算、实际、价格快照、汇率和身份时间分开说明**

![图 108 审计页签把估算、实际、价格快照、汇率和身份时间分开说明](https://cds.miduo.org/api/reports/assets/688f6882390ff9b8daf9204532c2c43019e0c4435b6ccc4e9e5d4b2f9f7f36a0.png)

8. 关闭详情。如果记录本身带 session，再切页面上方的“会话”页签或使用“会话 ID”筛选；这个“会话”是请求记录页面的同级视图，不是详情抽屉的第五个页签。没有 session 时明确写“本请求无会话 ID”，不要按相近时间强行合并。

**图 073 请求、上游调用、会话和后台任务四个页面级页签回答不同问题**

![图 073 请求、上游调用、会话和后台任务四个页面级页签回答不同问题](https://cds.miduo.org/api/reports/assets/381b0bb85f777a44ed90be5ef4298f323f2839c12decf45b96e011a3d4d1d9c9.png)

9. 需要再次定位时，从“请求与响应”复制 requestId，而不是复制整页可能含业务内容的详情。

**图 106 请求身份区提供可安全传递的 Request ID 和 Generation ID**

![图 106 请求身份区提供可安全传递的 Request ID 和 Generation ID](https://cds.miduo.org/api/reports/assets/ceb8dc2af38d5ac805469ce974916357407bf6e12edeefe4a22baf9d91afbaf9.png)

## 看到什么算成功

两条 requestId 各自定位一条当前租户记录并自动打开详情：dry-run 明确显示未调用模型，非 dry-run 记录能用概览、请求与响应、路由、审计四页签说明 key、appCaller、模型池、Provider、策略和费用证据。没有 session 时不虚构会话，敏感明文也没有泄露。

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
