| feat | prd-admin | 文学创作页编辑区大幅重构：textarea 用 `h-full flex-1` 撑满容器，不再猥琐在半屏高度 |
| feat | prd-admin | 工具条改为粘性顶部 pill 分段按钮（编辑正文 / 预览），带圆角分隔，主色统一 |
| feat | prd-admin | "在光标处插入配图位"按钮下放到 Phase 1 编辑模式（无需先生成标记也可手动插 [插图]:） |
| feat | prd-admin | 拖拽接收逻辑抽为共享 handler：Phase 1 / Phase 2 编辑 textarea 都能接收右侧卡片拖入 |
| feat | prd-admin | Phase 2 工具条把图片尺寸控制从"悬浮右上角"整合到工具条右侧，预览模式可见 |
| feat | prd-admin | 文学创作页生成标记完成后自动切到"编辑正文 & 提示词"模式 |
| feat | prd-admin | 预览模式每张配图改为内嵌卡片（图片 + prompt textarea + 重新生成/删除按钮），在文章流里原地改 prompt |
| feat | prd-admin | 右侧 markerRunItems 卡片支持 draggable + onDragStart（mime: `application/x-literary-marker-prompt`） |
| feat | prd-admin | 文学创作页正文自动保存扩展到 phase 2，编辑模式的文字变更可被后端持久化 |
| fix | prd-admin | 文学创作页"编辑提示词"弹窗去掉 `disabled={status==='running'}`，生图中也能改提示词文字 |
| chore | prd-admin | 清理未使用的 `glassFloatingButton` 导入 |
