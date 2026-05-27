| fix | prd-api | 安全：GitRepoCacheService 缓存复用前用当前用户凭据 ls-remote 校验访问权，防跨用户缓存绕权（P1 / Codex review） |
| fix | prd-api | 安全：GitRepoCacheService fetch 路径用 try/finally 把 origin set-url 还原成不带 token 的 URL，防 OAuth token 落盘 `.git/config`（P1 / Codex review） |
| fix | prd-api | 安全：CreatePlan 在 Attachment 查询里增加 UploaderId 过滤，防 attachmentId 泄漏后被其他用户拷贝出 ExtractedText（P2 / Codex review） |
