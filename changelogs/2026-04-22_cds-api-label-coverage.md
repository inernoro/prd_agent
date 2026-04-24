| fix | cds | agent-key-modal reminder borderTop 删除暗色 fallback（遵守 cds-theme-tokens.md 规则 #1：fallback 必须主题中性色） |
| perf | cds | renderHostStats 不再每 5 秒 innerHTML 重建 6 个 DOM 节点，改为首次建结构后仅更新 textContent + data-tier（消除 DOM churn + 屏幕阅读器反复重读） |
| feat | cds | `resolveApiLabel()` 补全 60+ 条中文 label（/me /status /tab-title /scheduler/* /storage-mode/* /data-migrations/* /workspaces/* 等），Activity Monitor 不再显示裸 URL |
| feat | cds | 新增 `auditApiLabels()` 启动时扫 Express 路由表，对缺失 label 的 /api/* 打 `[api-label]` warning，开发 + 生产日志均可见 |
| docs | cds | cds/CLAUDE.md 新增规则 0.1「API label 全量覆盖」：新增路由必须同步补 label，命名风格动词开头中文≤6 字 |
