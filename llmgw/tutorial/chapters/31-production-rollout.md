# 第 31 章 生产接入与回滚清单

## 你在做什么

这一章把“教程咖啡店”的接入经验整理成可实行的切换清单。本书没有“流量百分比”按钮；教程所说的小流量，就是只让第 10 章保存的 chat cURL 或 Agent Skill 用新 key 发一次教程桩请求，而不是把所有业务一次切过去。

## 为什么要做

测试环境能用，不等于可以把测试 key 直接带进生产。正式接入需要独立身份、最小 scope、明确负责人和可撤销路径。先让新旧 key 短暂双轨观察，再停旧 key，比原地覆盖更容易判断问题来自哪里。

## 开始前检查

- Provider、模型、默认池、appCaller、PromptPolicy 和 Exchange 已在隔离环境按前章验收。
- 为每个接入方、环境和用途分别建立 key 计划；不能让多个平台共用一把无法审计的 key。
- 已确定生产 appCallerCode、团队 scope、预算、速率、有效期、负责人和回滚窗口。
- 第 15 章已创建 chat production key，它是这条连续故事的旧 key；其明文只在安全 Secret 中，文档只记旧 ServiceKeyId。
- 第 10 章保存的 chat cURL 或 Agent Skill 就是可切换的最小客户端，不需要额外创建流量平台。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 先保持第 15 章的旧 chat production key 有效，不点撤销。在 `Quickstart` 选“文字对话”、“客服组”、“生产”，appCallerCode 仍为 `tutorial.gateway-book::chat`，Client code 填 `tutorial-production-canary`，一键生成新 key。

**图 055 test 与 production 使用不同 key，任一方可独立撤销**

![图 055 test 与 production 使用不同 key，任一方可独立撤销](https://cds.miduo.org/api/reports/assets/238d20abfe7ff8a19a887d906f8fc51a728dacadf19fab9f79799c271a1d0410.png)

2. 明文只显示一次，保存到独立的 canary Secret。先在页面点击安全测试，必须看到 requestId 与 `upstreamCalled=false`。

**图 065 生成结果只在当前时刻展示完整 key，并提示立即保存**

![图 065 生成结果只在当前时刻展示完整 key，并提示立即保存](https://cds.miduo.org/api/reports/assets/6dc1b657df8a373550e7064b1b4b904e41a954ff39ae624d06f7f67878d9648b.png)

3. 在终端运行 `read -s LLMGW_API_KEY`，粘贴新 key 并回车。使用第 10 章保存的 chat cURL，仅删除 `X-Gateway-Dry-Run` 这一行，向第 6 章公开教程桩发一次请求；完成后立即运行 `unset LLMGW_API_KEY`。

**图 067 点击测试固定使用安全 dry-run，结果必须带 requestId 且未访问上游**

![图 067 点击测试固定使用安全 dry-run，结果必须带 requestId 且未访问上游](https://cds.miduo.org/api/reports/assets/27a28b5293ff82a1ad6e82c6bd75abc592a3e7e6e6e4ecf89592f7318d8db2f1.png)

4. 在请求记录按新 ServiceKeyId 定位这唯一一次 canary，确认 appCaller、实际模型、Provider、耗时、费用状态和 PromptPolicy 证据。OpenRouter App 展示应为 `G-tutorial.gateway-book::chat`。

**图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试**

![图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试](https://cds.miduo.org/api/reports/assets/c559463c5a6e0df620dda4560687de11cbbe0821170450ecb8ab0a116a561dd4.png)

5. 本书的“小流量”到此结束：只有一个本地客户端、一次假上游请求。不存在需要猜测的比例控件，也不扩大到真实业务或付费模型。

**图 077 用量页按当前租户展示请求、token、价格覆盖和分币种金额**

![图 077 用量页按当前租户展示请求、token、价格覆盖和分币种金额](https://cds.miduo.org/api/reports/assets/52b6ba639eb5acd9d6e71aa922b8169892322096b315988b958019f6c2a964be.png)

6. 如果第 2 至 4 步任一异常，不撤销第 15 章旧 key；把本地 cURL 的隐藏输入切回旧 key，撤销新 canary key，这就是可执行的回滚。

**图 085 审计页按当前租户列出谁在什么时候改了什么**

![图 085 审计页按当前租户列出谁在什么时候改了什么](https://cds.miduo.org/api/reports/assets/7bf4e3d80e3ba99d57d77ed5f87ad70292d3e533beba21f903d0c7c51ce301b1.png)

7. 若唯一 canary 请求与观察全部正常，先确认没有其他客户端仍使用第 15 章旧 key，再在“接入密钥”撤销旧 key。用第 16 章的无回显方法确认旧 key 返回 401，新 key 仍能完成 dry-run。

**图 090 Exchange 首屏用三步说明创建映射、加入池和用 requestId 验证**

![图 090 Exchange 首屏用三步说明创建映射、加入池和用 requestId 验证](https://cds.miduo.org/api/reports/assets/7de827d0a2445a72180471bfa9da7691a1ffe65cec8857a3cc196c0f0fc33dd3.png)

8. 旧 key 撤销后不再声称能“切回旧 key”。此时的回滚是停止新客户端、撤销异常 key，并按已审批范围签发新的后继 key；不删除或裁剪共享池。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 090 Exchange 首屏用三步说明创建映射、加入池和用 requestId 验证](https://cds.miduo.org/api/reports/assets/7de827d0a2445a72180471bfa9da7691a1ffe65cec8857a3cc196c0f0fc33dd3.png)

## 看到什么算成功

新 key 的 ServiceKeyId 能唯一识别 `tutorial-production-canary`，安全测试未调用上游，唯一一次非 dry-run 只到公开教程桩。撤销旧 key 前能实际切回；撤销后旧 key 返回 401，回滚转为停止新客户端、撤销异常 key 和签发后继 key。

## 失败怎么办

- 新 key 没有明文可复制：明文只显示一次是安全设计，应撤销未妥善保存的 key 并重新生成，不能要求后台读回。
- 新旧流量无法区分：说明接入方复用了 key 或 appCaller，先恢复独立身份再继续切流。
- 小流量出现大量 429 或回退：暂停扩大，检查速率、预算、池健康和客户端重试。
- 撤销旧 key 后仍有成功请求：按 ServiceKeyId 确认是否实际用了别的 key；确认复现则停止切流并升级处理。
- 回滚需要修改共享池：优先切 key、appCaller 绑定或版本，不删除既有共享成员。

## 本章小结

生产切换的安全感来自独立 key、一次安全测试、小流量、可观察身份和明确回滚。不是来自一次性把所有流量推上去。

## 下一章

点击 [[第 32 章：术语表与下一步]]，用一张词语地图回顾整本教程并安排日常运营。
