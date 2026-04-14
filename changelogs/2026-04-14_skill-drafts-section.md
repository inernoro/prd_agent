| feat | prd-api | 新增 `GET /api/skill-agent/sessions/drafts` 列出当前用户未保存（SavedSkillKey 空）的会话；响应裁剪，不下发 Messages 全量 |
| feat | prd-api | ISkillAgentSessionStore 新增 ListDraftsAsync，按 LastActiveAt 倒序，利用 `UserId + LastActiveAt` 复合索引 |
| feat | prd-admin | 「我的技能」Tab 顶部新增"未完成的草稿"区；点"继续"复用 sessionStorage + CreateTab.initSession 恢复整条会话；点"删"走既有删除端点；0 条不渲染 |
