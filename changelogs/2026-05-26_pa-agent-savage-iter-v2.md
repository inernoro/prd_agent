| feat | prd-api | 毒舌秘书 v2：新增 `pa_user_profile` 集合（跨会话画像）+ Prompt 顶部注入 `__PA_PROFILE_BLOCK__` |
| feat | prd-api | 毒舌秘书 v2：chat 流增加 `update_profile` JSON 块异步抽取（auto 直入注入，suggest 待用户确认） |
| feat | prd-api | 毒舌秘书 v2：新增 `POST /api/pa-agent/review/run` 复盘 SSE 流（pa-agent.review::chat），完成后落 PaSession.Type='review' |
| feat | prd-api | 新增 4 个 profile endpoint：GET/PUT/POST/DELETE 画像与 memories |
| feat | prd-api | AppCallerRegistry.PaAgent 新增 `pa-agent.review::chat`（毒舌秘书-复盘） |
| feat | prd-admin | 新增 PaAgentCardArt 内联 SVG 插画（MBB 金字塔 + 四象限 + 琥珀/青色），无 CDN 也能展示 |
| feat | prd-admin | 首页 FeaturedCard 与百宝箱 ToolCard 接入 pa-agent 插画兜底 + 资源上传覆盖（与视觉创作智能体同级） |
| feat | prd-admin | 百宝箱 ToolCard 接入 `useAgentImageUrl`/`useAgentVideoUrl`，与首页一致支持运维上传覆盖 |
| feat | prd-admin | toolboxStore 给 builtin-pa-agent 补 `kind:'agent'` + `permission:'pa-agent.use'`（移动端首页也能显示） |
| feat | prd-admin | homepageAssetSlots 加 pa-agent 槽位，运维可在「资源管理」上传 `agent.pa-agent.image/video` |
| feat | prd-admin | 新增 PaProfilePanel 我的画像面板（编辑节奏/偏好/memories，三档来源徽章） |
| feat | prd-admin | 新增 PaReviewDrawer 复盘抽屉（SSE 阶段提示 + StreamingText 流式渲染） |
| feat | prd-admin | PaAgentPage 侧栏底部新增"我的画像"入口；PaTaskBoard 顶部新增【复盘】按钮 |
| feat | prd-admin | PaAssistantChat 解析 SSE `profile` 事件，显示"秘书记住了 / 建议记下"轻量徽章 |
| docs | doc | 新增 doc/spec.pa-agent-savage-iter-v2.md（v2 落地版） |
| docs | doc | doc/guide.mongodb-indexes.md 登记 `pa_user_profile` 新索引 |
