| feat | prd-api | 更新中心 POST `/api/changelog/ai-summary`：经 `ILlmGateway` + `prd-admin.changelog.aiSummary::chat` 生成摘要，`LlmRequestContext` 含 UserId |
| feat | prd-admin | 更新中心「AI 总结」改为调用上述接口，移除本地规则拼装与假延迟 |
