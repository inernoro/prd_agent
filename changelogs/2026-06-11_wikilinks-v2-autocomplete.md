| feat | prd-admin | 编辑器双链自动补全：输入 `[[` 或 `@` 弹下拉框，上下键选 + Enter 确认 + Esc/Tab 取消 |
| feat | prd-admin | 双链悬停预览卡：鼠标停在 `[[xxx]]` 上浮出标题 + 摘要；目标不存在时变橙色虚线 + 提示「文档不存在」 |
| feat | prd-admin | 新增 `lib/wikilinkCache.ts` 客户端缓存（标题 → 条目摘要）；DocumentStorePage 在 entries 变化时同步喂 |
| test | prd-api | 新增 WikiLinkParserTests（13 个场景：空输入/单链/带别名/多链/中文/嵌套/换行/上下文/去重防御等） |
| docs | doc | 数据字典补 `mentions` 集合段；`.claude/rules/codebase-snapshot.md` 集合数 118→119 + 引用网络功能进"已完成"清单 |
