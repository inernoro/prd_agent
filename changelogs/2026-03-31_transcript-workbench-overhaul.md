| fix | prd-admin | 修复 surface-row 选中态被 hover !important 覆盖，新增 data-active CSS 选中态 |
| fix | prd-admin | 修复转录工作台预览/编辑切换按钮对比度不足，改为 pill toggle 高对比样式 |
| fix | prd-admin | 修复编辑模式 textarea 无边框无法辨识，增加 border + ring 视觉区分 |
| fix | prd-admin | 修复预览模式用 pre 标签渲染，改为 ReactMarkdown 渲染 |
| fix | prd-admin | 修复 SegmentRow 编辑入口无视觉提示，增加 hover 下划线和 cursor-text |
| fix | prd-admin | 修复侧边栏三级列表层级不清，增加工作区字重、图标色、树线可见度 |
| fix | prd-admin | 修复 GenerateDialog 模板选中态 inline style 冲突，迁移到 data-active |
| fix | prd-admin | 统一状态图标颜色从 green-500 到 emerald-400 语义 token |
| fix | prd-admin | 修复轮询死循环（items 在依赖数组导致无限 re-render），改用 useRef |
| fix | prd-admin | 修复 Segment 编辑无防抖每次击键触发 API，增加 500ms debounce |
| fix | prd-admin | 修复 selectedItem 状态冗余，改为 selectedItemId + useMemo 派生 |
| feat | prd-admin | 文案编辑支持保存，新增"保存"按钮和未保存提示 |
| feat | prd-api | 新增 PUT /api/transcript-agent/runs/{runId}/result 文案编辑保存接口 |
| feat | prd-api | 新增 TranscriptRunWatchdog，自动清理卡在 processing 超 30 分钟的任务 |
| fix | prd-api | SSE 进度流增加每 10 秒 keepalive 心跳，防止连接超时断开 |
| fix | prd-api | Worker 关闭时将处理中的 run 标记为 failed，防止孤儿任务 |
| fix | prd-api | RenameItem DB 写操作从 HttpContext.RequestAborted 改为 CancellationToken.None |
| fix | prd-api | SSE 轮询 DB 查询改用客户端 ct，客户端断开后立即停止轮询 |
