| feat | prd-admin | TipCard 布局重排:`[icon] [title] [tag]` 一行(title 溢出截断),body 和 CTA 另起新行,不再挤在一列 |
| feat | prd-admin | TipCard 新增 `onDismissForever` prop + 🔕 BellOff 按钮:点击永久关闭该 tip(和 X 本 session 关闭并列);TipsDrawer 调用新的 `/dismiss-forever` API |
| feat | prd-api | DailyTipsController 新增 `POST /api/daily-tips/{id}/dismiss-forever`:幂等往 `User.DismissedTipIds` 追加 id;`/visible` 端点新增过滤逻辑,包括 seed-* 兜底时也按这个排除 |
| feat | prd-api | User 模型新增 `DismissedTipIds: List<string>?` 字段记录用户永久不再提示的 tip id |
| fix | prd-admin | 点 tip CTA 跳转后不再自动关闭抽屉:用户需要边跟 Spotlight 引导边对照步骤 / 决定是否「不再提示」,抽屉保留打开由 5s 无 hover 定时器自然 collapse |
| feat | .claude/skills | 新增 `create-tour-demo` 技能:用户说「创建缺陷管理演示」等自然语言时,自动套用内置 5 种模板(缺陷管理全链路 / Ctrl+B / Ctrl+K / 周报 / 知识库发布)生成完整 DailyTip JSON + 多步 Tour autoAction,输出 curl 让用户一键植入;也支持自然语言自定义 |
