| feat | cds | F9: 新增 GET /api/branches/:id 端点返回单分支详情（带 ProjectKey 越权 403 守卫），修复 React 分支面板因端点缺失导致的 HTML fallback 空白页 |
| feat | cds | F10: GET /api/branches/:id/logs 返回值新增 liveStreamHint 字段指向 /api/branches/stream SSE 通道，告诉 UI / cdscli 在部署进行中如何订阅实时步骤事件（旧 logs 字段保持兼容，仅在 deploy 完成后填充） |
| fix | cds | F15 (HIGH severity): /api/branches/:id/container-exec 与 container-logs 输出现在默认 mask 敏感 env（GITHUB_PAT/MYSQL_PASSWORD/JWT_SECRET/Authorization Bearer 等）；admin 可用 ?unmask=1 显式取消（响应体 masked 字段标记当前模式） |
| feat | cds | F17: 预览按钮过渡页从纯文本「CDS is preparing the preview」升级为 CDS 品牌动画（双圈旋转 + CDS 字样 + 进度条 + 主题感知），符合「非文字 / CDS 专属动画」用户契约第 31 条 |
