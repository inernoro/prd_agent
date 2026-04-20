| fix | prd-admin | 更新中心 + 周报 tab 底部留白修复：根容器 `h-full min-h-0 flex flex-col`，去掉 `calc(100vh - 160px)` 魔数，走 flex 链撑满视口 |
| rule | doc | 新增 `.claude/rules/full-height-layout.md`：宽屏页面必须撑满视口可用高度，禁止魔数高度，滚动发生在最近内容层（5 条硬约束 + 5 类反面案例）|
