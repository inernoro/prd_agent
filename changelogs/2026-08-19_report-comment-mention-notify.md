| feat | prd-api | 周报评论 @ 成员：服务端按正文解析被 @ 的团队成员，发站内通知并按 Webhook 配置推送到群（新增 comment_mention 事件，正文含引用原文 + 评论内容） |
| feat | prd-api | 周报 Webhook 企微渠道支持真 @：成员身份映射填了企微 userid 时 markdown 带 <@userid>，未填则退化为 @显示名 文本，钉钉/飞书不受影响 |
| feat | prd-admin | 周报评论输入框支持 @ 唤出成员下拉（方向键选择、Enter 选中、Esc 关闭），保留粘贴截图与 Enter 发送 |
| feat | prd-admin | 团队成员身份映射新增「企业微信」项；Webhook 通知设置页新增「评论@提醒」事件与配置说明 |
| test | prd-api | 新增 mention 解析单测（长名优先/去重/无 @ 不命中）与企微推送 payload 守卫（真 @ 语法不外泄到钉钉飞书） |
| test | prd-admin | 新增周报 @ 候选与检索词识别单测 |
