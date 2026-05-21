| feat | prd-admin | 海鲜市场上传弹窗精简：核心 3 字段置顶、封面/图标/预览/标签折叠进进阶；标题/详情 hint 压缩到 1 行 |
| feat | prd-admin | 上传支持单文件（.md / .markdown / .txt），前端用 JSZip 实时包装成 SKILL.md zip 走原通道，零后端改动 |
| feat | prd-api | 新增 POST /api/marketplace/skills/draft-description SSE 端点，拖入文件后流式起草 30 字详情，避免空白等待 |
| feat | prd-admin | 详情输入框新增 AI 起草徽标 + 流式预填；用户开始输入立刻让步并中断 SSE |
| fix | prd-api | AppCallerRegistry 新增 marketplace-skill 注册项，修复 AI 起草 APP_CALLER_INVALID |
| fix | prd-api | SSE JSON 编码用 UnsafeRelaxedJsonEscaping，中文不再被转成 \uXXXX |
| fix | prd-admin | SSE 区分 event:error，错误不再被拼进详情框，改走 error 状态 |
| fix | prd-admin | 技能详情弹窗改用 surface-popover（panel-solid 0.92 不透明），不再透出底层市场卡片 |
| fix | prd-api | CI 守卫 default-deny：删 IsKnownPrefix 白名单，所有 caller-code 字面量必须在 Registry，杜绝新前缀（marketplace-skill / page-agent 等）静默漏检 |
| fix | prd-api | 补登注册 page-agent.generate::chat（CapsuleExecutor 3 处旧裸字符串），同步替换为常量引用 |
| feat | prd-api | 新增 GET /api/marketplace/skills/{id}/zip-content + public/skill-share/{token}/zip-content 同源代理，解决浏览器对 COS/R2 直链 CORS 拒绝 |
| fix | prd-admin | 技能详情弹窗 + 分享页 zip 预览改走同源代理 URL，不再 Failed to fetch；fetch 携带 Bearer token |
