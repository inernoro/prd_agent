| feat | prd-admin | 个人公开页 `/u/:username` 新增「装修」面板：访问自己的公开页可编辑自我介绍（最多 500 字）与切换 8 种背景主题（极光/日落/森林/深海/紫罗兰/樱粉/极简/墨黑） |
| feat | prd-admin | 公开页各领域卡片新增内容预览：文档显示主条目标题+摘要；提示词显示前 240 字；工作空间显示封面图；涌现显示种子预览；工作流显示节点数+前 5 个节点类型链 |
| feat | prd-admin | 公开页自助撤回：访问自己公开页时每张卡片悬浮「取消公开」按钮，二次确认后调用对应 unpublish/visibility 端点，即时从列表移除 |
| feat | prd-api | User 模型新增 `Bio` + `ProfileBackground` 字段，支持 `PATCH /api/profile/public-page` 更新 |
| feat | prd-api | 公开页聚合接口双批次交叉查询：主 Task.WhenAll 后再批量解析 ImageAsset 封面 + DocumentEntry 主条目，避免 N+1 |
| feat | prd-api | 新增 3 个自助撤回端点：`POST /api/visual-agent/image-master/workspaces/{id}/unpublish`、`POST /api/emergence/trees/{id}/unpublish`、`POST /api/workflow-agent/workflows/{id}/unpublish` |
| feat | prd-admin | 公开页卡片重构为"首页作品广场"风格：统一的 `PlazaCard` 瀑布流 + 哈希渐变兜底 + NotebookLM 底部叠加文字，应用于视觉/文学/文档三域 |
| fix | prd-api | 视觉创作 workspace 封面兜底：当 `CoverAssetId` 未设置时，自动取该 workspace 最近创建的 ImageAsset 作为封面；并返回 `coverWidth/coverHeight` 驱动瀑布流自然比例 |
| fix | prd-admin | 公开页背景主题修复：从仅头部 40% 不透明扩展到全页固定环境光层（55% 不透明），让所有主题色（极光/日落/森林等）实际可见 |
