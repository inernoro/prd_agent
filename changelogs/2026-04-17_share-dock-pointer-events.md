| refactor | prd-admin | ShareDock 通用化：提取到 `components/share-dock/`，支持自定义 MIME + 槽位配置，头部可拖动位置 + 可收起成 36px 竖条，位置/折叠状态持久化到 sessionStorage |
| fix | prd-admin | 投放面板从右上角移到右侧垂直居中，不再遮挡筛选栏 / 视图切换按钮 |
| perf | prd-admin | 卡片拖拽从 HTML5 DnD 改为 Pointer Events（新增 `useDockDrag` hook），解决鼠标漂移/不跟手问题，支持触屏 |
| feat | prd-admin | `GlassCard` 新增 `onPointerDown` 道具支持 Pointer Events 自定义拖拽 |
| fix | prd-admin | ShareDock 槽位 hover 反馈加强：外发光 + 内发光 + 2px 高亮边框 + 1.06 缩放 + 呼吸光晕提示，ghost 缩小并偏移避免挡住 slot 光晕 |
| feat | prd-api | `/api/public/u/:username` 响应结构升级为多领域聚合：新增 skills / documents / prompts / workspaces / emergences / workflows 6 个公开资源列表，并行查询 |
| feat | prd-admin | 个人公开页 `/u/:username` 重写为多 Tab 布局：网页 / 技能 / 文档 / 文学提示词 / 视觉创作 / 涌现 / 工作流，每类独立卡片渲染 |
| feat | prd-admin | 公开技能卡片支持"下载"按钮：导出技能元信息为 JSON 文件（含 skillKey/title/description/tags + fork 导入提示） |
