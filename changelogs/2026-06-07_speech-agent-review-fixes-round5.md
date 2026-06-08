| fix | prd-api | 演讲智能体发布 HTML：节点图片 URL 走 escapeHtml,堵住属性逃逸 XSS（Bugbot Medium "Published image URL unescaped"） |
| fix | prd-admin | 演讲创建页「填入示例」按钮：同时清空 kbSelectedEntryId / sourceFileName,避免示例文本却跑 createFromDocument（Bugbot Medium "Sample fill keeps KB binding"） |
| fix | prd-admin | 演讲播放页加载错误区分：deck 加载失败/无权/不存在不再误显「无节点」,新增 loadError 状态 + 区分文案（Bugbot Medium "Play load errors show empty"） |
| perf | prd-api | 演讲列表接口 Project 掉 sourceText 字段：每条上限 1MB 的原始文本不再随列表返回（Codex P2 "Exclude source text from deck lists"） |
