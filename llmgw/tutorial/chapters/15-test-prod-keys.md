# 第 15 章 为测试和正式环境分 key

## 你在做什么

你将为同一 chat 业务建立独立的 test 与 production 身份，并为 vision 使用另一组身份。每个接入方、环境和用途都获得可以单独撤销、限流和审计的 key。

## 为什么要做

共享一把 key 会让日志无法回答“哪个系统调用”，也让一次泄露影响所有环境。环境是 key 的服务端属性，不应由客户端随意 header 伪装。测试与生产分开后，可以先观察 test，再受控签发 production，不需要修改 appCaller 或模型池。

## 开始前检查

- 已有客服组 chat 与内容组 vision 两个 test appCaller 和 key，并确认它们都能完成安全测试。
- production key 只在接入负责人批准后创建；本章在隔离环境演练，不启用真实付费上游。
- 准备清晰命名：包含 client、环境、用途，但不含密码或人员隐私。

## 跟我做

1. 点击“开发者”下的“Quickstart”。本章不使用“接入密钥”页的自由文本 Team ID，因为团队页不展示可复制 ID，新手不应猜 ID。
2. 如果页面还保留上一把配置，点击“修改身份”并确认。调用类型选“文字对话”，团队从下拉框选“客服组”，appCallerCode 填 `tutorial.gateway-book::chat`。
3. 环境选择“生产”，Client code 使用客服应用的稳定短名，Gateway 地址保持页面自动值，协议按业务实际选择。
4. 点击“一键生成 appCaller 与 key”。页面会把下拉框所选团队的真实 ID 直接提交给服务器，不需要你查看或手抄 ID。
5. 一次性把 chat production key 保存到生产 Secret 管理系统。可以点击“点击测试”做固定 dry-run，但不要删除安全 header，也不要执行真实模型调用。
6. 点击“修改身份”并确认，调用类型改为“图片理解”，团队从下拉框选“内容组”，code 确认是 `tutorial.gateway-book::vision`，环境仍为“生产”，再一键生成独立 key。
7. 保存 vision production Secret。最后打开“接入密钥”，核对 chat 与 vision 的 test、production 共四个身份都有明确环境、团队和 appCaller。

## 看到什么算成功

列表中 test 与 production 是不同 key id，完整明文均不可回显。chat 与 vision 分别归属客服组和内容组；请求日志可通过 ServiceKeyId、clientCode 和 environment 区分来源。任何一把 key 撤销都不会直接停掉另一环境。

## 失败怎么办

- 一键生成按钮不可用：确认从团队下拉框选中了活动团队、Client code 有效、appCaller 后缀与调用类型一致；不要转去自由文本 Team ID 猜值。
- 页面要求确认通配风险：返回字段去掉 `*`，不要为了省事扩大授权。
- production key 被误用于测试：立即停止客户端，轮换该 key 并检查请求记录；不要继续沿用已扩散明文。
- 不知道 CIDR 或限流：先采用组织批准的明确值；不要猜测会中断业务的限制，也不要无审批留无限权限。

## 本章小结

接入身份按平台、client、环境和用途拆分，才能精确撤销和审计。Quickstart 的团队下拉框替用户传递真实 ID；production key 的创建不等于允许真实调用，放行还要经过第 31 章清单。

## 下一章

点击 [[第 16 章：轮换、切换和撤销 key]]，用新旧 key 双轨观察完成一次安全轮换。
