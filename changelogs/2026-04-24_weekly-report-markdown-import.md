| feat | prd-api | 周报管理 Agent 新增 POST /reports/import-markdown 端点：上传 Markdown 周报后 LLM 按模板章节结构化，失败自动降级为 H2 标题匹配的规则兜底；issue-list 章节强制留空分类/状态；支持同周 draft 覆盖（带二次确认） |
| feat | prd-admin | 周报编辑器新增「从 Markdown 文件导入」次级入口与弹窗：拖拽/点击上传 .md（≤512KB）、基于当前模板下载推荐格式样本、阶段文案可见（读取→AI 映射→写入）、覆盖确认流程 |
| fix | prd-api | 修复 Markdown 导入周报弹"Serializer for User does not have a member named Id"——User.Id 是历史兼容字段已 UnmapMember，主键应查 UserId；顺手修复 GenerateAsync / GenerateForMemberV2Async 同根因潜在 bug |
