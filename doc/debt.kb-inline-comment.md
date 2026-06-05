# 知识库划词评论 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-05 | **状态**：维护中

## 总览

模块范围：`prd-admin/src/components/doc-browser/`（DocBrowser + InlineCommentOverlay/Margin/Composer + inlineCommentShared）、
`prd-admin/src/stores/docReaderPrefsStore.ts`、
`prd-api/.../DocumentStoreController.cs`（recent-comments 接口）、
`.claude/skills/create-visual-test-to-kb/scripts/read_comments.py`（回读闭环）。

本次落地了「边读边看」批注栏 + 批注栏/内联布局切换 + 划词就地输入 + 批注头像/名字显示 +
后端最近批注聚合接口 + 验收技能回读脚本。以下为主动声明的已知边界。

## 已知边界（待后续偿还）

| # | 边界 | 现状 | 后续方向 |
|---|------|------|----------|
| 1 | 图片批注 | 仅文字锚点 + 全文评论；右键图片/框选图片区域批注未实现 | 新增 image-anchor 数据模型（坐标框）+ 前端图片框选交互 |
| 2 | inline 布局展开卡片定位 | 绝对定位在高亮末行下方，可能与下方正文视觉重叠（MVP） | 改为 in-flow 占位插入，或碰撞规避 |
| 3 | margin 批注栏卡片排序 | 按 createdAt 排序，非按锚点在正文中的垂直位置对齐（无 Docs 式连线） | 计算每组锚点 top，按位置排序 + 可选连线 |
| 4 | 批注栏 ↔ TOC | 有评论时默认批注栏取代 TOC，「收起」临时切回；未做并存 | 评估窄屏并存 / 可拖拽分栏 |
| 5 | 回读闭环 | read_comments.py 为按需轮询（GET recent-comments） | 监听式 webhook/SSE 主动推送 |
| 6 | 布局偏好存储 | localStorage（设备本地，符合 no-localstorage 例外清单） | 如需跨设备同步，迁移到 user_preferences |

## 相关

- 设计：本次为增量交付，无独立 design 文档；交互 mock 见会话记录
- 接口：`GET /api/document-store/stores/{storeId}/recent-comments?since=&limit=`
- 鉴权：AgentApiKey `document-store:read`（write 蕴含 read），与归档脚本同一把 MAP_DOC_STORE_KEY
