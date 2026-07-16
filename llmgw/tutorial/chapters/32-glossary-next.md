# 第 32 章 术语表与下一步

## 你在做什么

最后一章把整本书出现的词语翻成日常语言，并给“教程咖啡店”安排一条每周检查路线。以后遇到陌生页面，你可以从词语找到对应证据和责任人。

## 为什么要做

功能多并不可怕，可怕的是每个页面像孤岛。术语表不是考试题，而是一张地图：谁调用、为什么调用、去哪里调用、花了多少、谁改过，都能顺着固定关系找到答案。

## 开始前检查

- 第 0 至 31 章中的租户、团队、Provider、模型、模型池、appCaller、key、请求和审计都已经实际走过一次。
- 手边保留的是对象 id、requestId 和遮盖证据，不是密码或 key 明文。
- 尚未通过的步骤应回到原章修复，不用在最后一章假装完成。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 记住“租户”：它是数据边界，由服务端会话或 key 解析，不能在请求中自报 tenantId。

**图 096 从左侧导航点击“学习中心”，不用猜页面地址**

![图 096 从左侧导航点击“学习中心”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/b290dbb389a1e2b1fa7bda53a89ba37a157bd8726029ec6e5ddea3fa9a6ab2e3.png)

2. 记住“团队与角色”：它们决定人能管理什么；Owner、Admin、Developer、Viewer、Billing 各有最小权限。

**图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语**

![图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语](https://cds.miduo.org/api/reports/assets/5b663dc659eb61f03554e6147a1f6b08de72fde553f14100520a9785236155e6.png)

3. 记住“Provider、模型、模型池”：Provider 是上游平台，模型是能力，模型池按用途和策略选成员；有匹配则追加，无匹配不变。

**图 098 完整链路把租户、key、appCaller、池、模型和 Provider 连起来**

![图 098 完整链路把租户、key、appCaller、池、模型和 Provider 连起来](https://cds.miduo.org/api/reports/assets/ddac98c28e33de05568b35661348a0d8f75883d77179341e2a756a113d44a3d7.png)

4. 记住“appCaller 与 service key”：appCaller 说明哪项业务为何调用，key 说明哪个接入方被允许进入。OpenRouter App 显示 `G-{appCallerCode}`。

**图 099 术语索引可以直接跳到对应解释和操作入口**

![图 099 术语索引可以直接跳到对应解释和操作入口](https://cds.miduo.org/api/reports/assets/b0688567037291c40d696a6fe3776dee9353cf57821b8cfd6f76ba5970b09b33.png)

5. 记住“Exchange”：它把非标准上游地址、认证和模型标识翻译成可调度配置，通讯密钥只写不读。

**图 100 排错入口要求拿 requestId 定位，不让用户只说“调用失败”**

![图 100 排错入口要求拿 requestId 定位，不让用户只说“调用失败”](https://cds.miduo.org/api/reports/assets/aa7b3bdf62d175bdfb8ecd5e46123481257154f1365173fa3fef87ffbfe14b9e.png)

6. 记住“PromptPolicy”：它只在首版应用于 chat 和 vision，按版本预览、保存和回滚；日志只记 id、version、hash。

**图 101 从左侧导航点击“控制台设置”，不用猜页面地址**

![图 101 从左侧导航点击“控制台设置”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/0021d15f354a77cdb249a8bccc665a19882e2bafc7b3c354eee47a026caf6042.png)

7. 记住“requestId 与 session”：前者定位一次请求，后者串起一段会话。排错先找 requestId。

**图 102 设置页提供跟随系统、浅色和深色三种外观**

![图 102 设置页提供跟随系统、浅色和深色三种外观](https://cds.miduo.org/api/reports/assets/4411a36e69ac087c5dceba500f7cbed509d66d31a85860057c1ae6a652280579.png)

8. 记住“estimated、actual、unknown、reconciled”：它们表示费用证据阶段；unknown 不为 0，无审计 FX 的 CNY 与 USD 不相加。

**图 103 浅色主题下导航、卡片、输入框和说明文字仍清晰可读**

![图 103 浅色主题下导航、卡片、输入框和说明文字仍清晰可读](https://cds.miduo.org/api/reports/assets/87cef701e468c39566bf1ef13616d21c735e6bd4b8897e498a959e2f03d42e97.png)

9. 建立每周例行检查：健康与回退、即将过期 key、成员权限、预算与 unknown、账单差额、关键审计、治理发布状态。

**图 104 移动端左侧导航变成可打开的抽屉，六组入口仍可达**

![图 104 移动端左侧导航变成可打开的抽屉，六组入口仍可达](https://cds.miduo.org/api/reports/assets/8c4cc8d51b41870c0d34376a5aaf2223955e84e6c0d545c4d851f3c728877a42.png)

## 看到什么算成功

你能不用猜测回答五个问题：当前属于哪个租户，谁和哪把 key 发起请求，哪个 appCaller 与模型池负责路由，费用证据处于哪一阶段，谁修改过配置。遇到故障时知道回到哪一章。

## 失败怎么办

- 分不清 appCaller 和 key：回第 14 至 16 章；一个表示业务身份，一个表示接入凭证，不能混用。
- 不知道实际模型为何变化：回第 18、19、21 章，按池健康、Exchange 和 requestId 查证。
- 费用数字看不懂：回第 22、23、28 章，先看状态、原币种和对账来源。
- 权限或数据边界不确定：回第 24 至 26 章，用审计、跨租户负例和会话失效验证。
- 准备接入新平台：从第 9 章重新创建独立 appCaller，再按第 10、11、12、31 章生成 key、安全测试和小流量切换。

## 本章小结

你已经从空租户走到可运营、可审计、可回滚的模型网关。最重要的不是记住每个按钮，而是坚持身份有来源、路由有证据、费用不伪算、变更可追溯。

## 下一章

全书到这里完成。下一步回到模型网关首页，按“健康状态、Quickstart、最近请求、费用可信度”的顺序完成一次周检；新增接入方时，从第 9 章重新走独立身份链路。
