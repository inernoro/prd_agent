# 第 9 章 创建第一个 appCaller

## 你在做什么

你将先为客服文字对话准备 `tutorial.gateway-book::chat`，再为内容图片理解准备 `tutorial.gateway-book::vision`。Quickstart 会让两者使用 `auto` 路由：chat 进入默认对话用途，vision 进入默认视觉用途；它不会写入一个专属 ModelPoolId。

## 为什么要做

appCaller 不是人，也不是密钥。它是业务用途的稳定身份证，用于路由、提示词策略、预算、限流和统计。OpenRouter 的 App 列可显示为 `G-{appCallerCode}`，其中 `G-` 只是对外显示前缀，不属于 Gateway 内部 code。chat 与 vision 分开后，提示词和费用不会混在一起。

## 开始前检查

- “客服组”“内容组”和两个默认池均已存在。
- 当前角色是 Owner、Admin，或属于相应团队的 Developer。
- code 只使用稳定业务含义，chat 必须以 `::chat` 结尾，vision 必须以 `::vision` 结尾。

## 跟我做

1. 最简单的入口是左侧“开发者”下的“Quickstart”。在“调用类型”选择“文字对话”。
2. 团队选“客服组”，appCallerCode 填 `tutorial.gateway-book::chat`，Client code 填教程专用客户端短名，环境选“测试”。
3. 暂时不要点击生成，先核对页面自动显示的 Gateway 地址、四协议选项，以及页面内“密钥回答谁、appCaller 回答为什么、模型池回答去哪里”的说明。
4. 不要在此时跳到 appCaller 注册表；Quickstart 表单尚未提交，离开页面会丢失刚填的内容。注册表留到第 10 章创建完成后再看。
5. 第 10 章的一键操作会同时创建当前 appCaller 和第一把 key；保持控制台标签停留在本页，并保留本章填写内容。
6. 第 10 章创建 chat 后，必须回到本页把调用类型改为“图片理解”、团队改为“内容组”、code 改为 `tutorial.gateway-book::vision`，再执行第二次一键生成。不要让后缀与类型不一致。

## 看到什么算成功

Quickstart 不再提示 code 后缀错误，团队、调用类型和环境清晰可见。两次创建后，appCaller 注册表分别出现 chat 与 vision，路由方式显示 `auto`；`auto` 表示按请求用途进入相应默认池，不表示显式绑定某个池。对外日志的 App 名可以是 `G-tutorial.gateway-book::chat`，但内部 code 仍没有 `G-`。

## 失败怎么办

- 提示后缀不匹配：chat 改为 `::chat`，vision 改为 `::vision`，不要绕过页面校验。
- 团队下拉为空：先回“团队与成员”创建活动团队；Developer 还要确认自己属于该团队。
- 同 code 已属于其他团队：不要重复占用；在 appCaller 注册表查清归属，必要时使用不同业务 code。
- 看不到写操作：Viewer 只能阅读示例，Developer 只能在所属团队创建，由 Owner 或 Admin 调整范围。

## 本章小结

appCaller 让每次调用有可解释的业务原因。chat 与 vision 使用不同 code 和团队，后续 key、策略、日志与费用都能分别追溯。

## 下一章

点击 [[第 10 章：一键生成第一把 key]]，在 Quickstart 一键创建当前 appCaller 并签发第一把 test key。
