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

1. 从左侧“工作区”进入“请求记录”。页面首屏直接显示日志表格；在顶部唯一的 `requestId` 搜索框粘贴[[第 11 章：点击安全测试|第 11 章]]标为 chat 的 dry-run 编号，再按 Enter 或点击“查找”。

**图 069 从左侧导航点击“请求记录”，不用猜页面地址**

![图 069 从左侧导航点击“请求记录”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/33d053d5fd2df3ad9c30472774463e9bdc148d24ea765e0bf5776e179f2b93f0.png)

2. 粘贴完整 requestId 后，唯一匹配会在当前列表右侧打开“请求详情”抽屉，不会把列表上下文丢掉。在“概览”中确认 Provider 为 `gateway-dry-run`、模型为 `not-called` 或页面等义文案。这条记录只能证明地址、key、团队、appCaller 和协议形状。需要复制独立链接时，再点击抽屉右上角“独立页面”。

**图 070 Logs 用真实趋势、汇总指标和完整表格同时回答规模与单次请求问题**

![图 070 Logs 用真实趋势、汇总指标和完整表格同时回答规模与单次请求问题](https://cds.miduo.org/api/reports/assets/44b4bb30a046acdba3e8fbb76e9c5332f2d23630e1bacb1072be8b4f86b8b75a.png)

3. 关闭抽屉，再搜索[[第 20 章：配置 PromptPolicy|第 20 章]] chat 命令输出的 requestId。列表应连续显示时间、请求 ID、模型、Provider、App、输入、输出、费用、用途、速度、结束原因、客户端用户和状态；模型、Provider 和 App 前应有可辨识图标，列宽不应靠一列吞掉中间空白。点击表头最右侧的“表格设置”，可以显隐列、上下调整顺序，并在紧凑、均衡、舒适三档密度间切换；这些选择只保存在当前浏览器，不改服务端日志。

   文本请求的输入、输出和速度使用 token 与 token/s；图片生成使用 prompt、成功图片数和 image/min。费用优先显示上游逐请求返回值，其次使用模型价格快照估算；两者都没有时明确显示“未计价”，不能把未知写成 0。旧日志如果在元数据采集上线前产生，仍可能保持未知，不能用页面补造历史 token。

   把鼠标分别停在模型、Provider 和 App 名称上：名称应出现点状下划线，随后显示一张包含图标、名称、身份摘要和进入按钮的悬浮信息卡。点击带下划线的名称或卡片按钮，会分别进入模型、Provider 或 App 的独立详情页；从详情页可以继续查看真实上游、连接摘要、路由治理和最近请求，再点击“返回请求记录”回到当前工作流。触屏设备不依赖悬浮卡，直接点击名称进入详情页。点击日志行的其他区域仍打开请求详情抽屉，实体链接不能同时触发行抽屉。

**图 109 表格设置可显隐列、调整顺序和切换密度，并始终保持在当前视口内**

![图 109 表格设置可显隐列、调整顺序和切换密度，并始终保持在当前视口内](https://cds.miduo.org/api/reports/assets/eb876acd167499d34fd87de15c1e3e5c5993ec318746b461d9ce79a5226fd71d.png)

**图 110 App 悬浮信息卡提供身份摘要和独立详情页入口**

![图 110 App 悬浮信息卡提供身份摘要和独立详情页入口](https://cds.miduo.org/api/reports/assets/18989f235c76016c8c5b074d75a322412d09e33c16f176f331b0cb63962fe9ab.png)

**图 111 模型名称悬浮后出现下划线、模型摘要和“查看模型”按钮**

![图 111 模型名称悬浮后出现下划线、模型摘要和“查看模型”按钮](https://cds.miduo.org/api/reports/assets/b32bea3690e2c1daf4ae3e0fe63b2074000e0ee1e1eeb44ee8721926542982c1.png)

**图 112 模型独立详情页集中展示真实 Provider、能力、路由和最近活动**

![图 112 模型独立详情页集中展示真实 Provider、能力、路由和最近活动](https://cds.miduo.org/api/reports/assets/86ba6dfde76ed6625ac78c49922feb465aec92795acbe502cea1f623f7013a87.png)

**图 113 Provider 名称悬浮后出现连接摘要和“查看 Provider”按钮**

![图 113 Provider 名称悬浮后出现连接摘要和“查看 Provider”按钮](https://cds.miduo.org/api/reports/assets/a9f3a88b9780b4179764c8850ce40daf0206799b530621642f8d66496d62dc24.png)

**图 114 Provider 独立详情页分区展示连接、模型和最近活动**

![图 114 Provider 独立详情页分区展示连接、模型和最近活动](https://cds.miduo.org/api/reports/assets/88b5f4e9a8f611259a3b37231bebd3bc9e7abd018cf82fa49b50ebe834817f57.png)

**图 115 App 独立详情页分区展示身份、路由、治理和最近活动**

![图 115 App 独立详情页分区展示身份、路由、治理和最近活动](https://cds.miduo.org/api/reports/assets/e38e4a3e27ae158758766fa4a44da5efaa44ae25b3da11bee11ac6b4a7d5e58d.png)

**图 116 触控设备直接点击模型名称后进入单列详情页**

![图 116 触控设备直接点击模型名称后进入单列详情页](https://cds.miduo.org/api/reports/assets/c68d77303acb1ab2e9f785f4fcd33b8149310ca772ac323f4c018b8a1f686a51.png)

**图 105 详情概览先回答本次请求用了什么模型、哪个 Provider 和发生了几次上游尝试**

![图 105 详情概览先回答本次请求用了什么模型、哪个 Provider 和发生了几次上游尝试](https://cds.miduo.org/api/reports/assets/1498b2a4358d79ea1f455e0bc01711a41fec61aa44475f8911332b16cd782182.png)

4. 切到“请求与响应”，核对 Request ID、Generation ID、Key 前缀、流式状态和请求内容。需要交给同事排查时只复制 requestId；不要复制整页原始数据，也不要把可能包含业务内容的请求正文贴到公开群。

**图 106 请求与响应页签保留定位字段，同时把业务正文放在可控的查看区**

![图 106 请求与响应页签保留定位字段，同时把业务正文放在可控的查看区](https://cds.miduo.org/api/reports/assets/79a6b38e273abd3500a55b1f318d574d8cd799b34df06e9a4ee5a1de708dbc92.jpg)

5. 切到“路由”，读取模型池、实际模型、Provider、参数策略和每次上游尝试。只有非 dry-run 记录能证明真实路由；一次失败后继续尝试时，原因必须在这里能解释。

**图 107 路由页签说明从期望模型到实际 Provider 的完整选择过程**

![图 107 路由页签说明从期望模型到实际 Provider 的完整选择过程](https://cds.miduo.org/api/reports/assets/c40bedc0d0d216462c49970ac257de3ff2f55fdf703097c35301206022120c34.jpg)

6. 在同一“路由”页签查看 PromptPolicy 证据。只应出现 policy id、version 和 hash，不应出现策略正文；没有策略时应明确写未应用，不能猜测。

**图 107 路由页签只展示提示词策略的身份和版本证据**

![图 107 路由页签只展示提示词策略的身份和版本证据](https://cds.miduo.org/api/reports/assets/c40bedc0d0d216462c49970ac257de3ff2f55fdf703097c35301206022120c34.jpg)

7. 切到“审计”，查看费用状态和原币种。[[第 7 章：配置第一个模型|第 7 章]]没有为教程桩填写价格，因此这里应保持 unknown，不能读成 0；没有供应商逐请求账单时也不能写成 reconciled。

**图 108 审计页签把估算、实际、价格快照、汇率和身份时间分开说明**

![图 108 审计页签把估算、实际、价格快照、汇率和身份时间分开说明](https://cds.miduo.org/api/reports/assets/38435bbbfdecaed01838c587b2b1aecf52a33bf2a6c4b7c94706d75997c0b013.jpg)

8. 关闭右侧请求详情抽屉；如果已经从模型、Provider 或 App 进入独立详情页，则点击“返回请求记录”。如果记录本身带 session，再切页面上方的“会话”页签，或展开“更多筛选”使用“会话 ID”；这个“会话”是请求记录页面的同级视图，不是请求详情的第五个页签。没有 session 时明确写“本请求无会话 ID”，不要按相近时间强行合并。

**图 073 请求、上游调用和会话三个页面级页签均来自真实数据源**

![图 073 请求、上游调用和会话三个页面级页签均来自真实数据源](https://cds.miduo.org/api/reports/assets/44b4bb30a046acdba3e8fbb76e9c5332f2d23630e1bacb1072be8b4f86b8b75a.png)

9. 需要再次定位时，从“请求与响应”复制 requestId，而不是复制整页可能含业务内容的详情。

**图 106 请求身份区提供可安全传递的 Request ID 和 Generation ID**

![图 106 请求身份区提供可安全传递的 Request ID 和 Generation ID](https://cds.miduo.org/api/reports/assets/79a6b38e273abd3500a55b1f318d574d8cd799b34df06e9a4ee5a1de708dbc92.jpg)

## 看到什么算成功

两条 requestId 提交后各自定位一条当前租户记录并打开右侧请求详情；列表行打开请求详情抽屉，模型、Provider 和 App 名称都有点状下划线、悬浮信息卡和可点击的独立详情页。三个详情页均读取真实配置与最近请求，不根据名称杜撰信息；返回请求记录后仍能继续排查。表格设置能显隐列、调整顺序、切换密度并在刷新后保留。dry-run 明确显示未调用模型，非 dry-run 记录能用概览、请求与响应、路由、审计四页签说明 key、appCaller、模型池、Provider、策略和费用证据。请求、上游调用、会话三个列表视图不含占位数据；没有 session 时不虚构会话，敏感明文也没有泄露。

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
