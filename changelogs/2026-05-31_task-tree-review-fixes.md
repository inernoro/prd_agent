| fix | prd-admin | 任务树修复 4 处竞态：loadTree/卡点墙加 fetchIdRef 防陈旧响应、wheel 缩放 effect 依赖修正确保 svg 挂载后绑定、对话摘取 node 事件加树归属校验 |
| fix | prd-api | 任务树 UpdateNode 防护：根节点不可改父节点（避免整树失去根渲染空白）、新父节点不能是自身子孙（防环） |
| fix | prd-api | 任务树 CreateNode parentId 为空时挂到既有根，避免产生第二个根导致节点在画布消失 |
| fix | prd-api | 任务树 AddDependency 加边前做可达性检测，拒绝形成循环依赖（DependsOn 保持 DAG） |
| fix | prd-api | 任务树 ListBlockers 对 DependsOn 做 null 防护，避免卡点墙聚合时空引用崩溃（High） |
| fix | prd-api | 任务树 UpdateNode 禁止把非根节点清空父节点（防止产生第二个根导致节点消失） |
| fix | prd-admin | 对话摘取切树后节点落到原树时弹 toast 反馈（遵循 server-authority 不中断服务端任务） |
| fix | prd-api | 任务树重命名根节点时同步 TaskTree.Title，避免树下拉/列表仍显示旧名（Codex P2） |
| fix | prd-admin | 任务树切树加载失败时清空画布并提示，避免残留上一棵树；仅首次加载播放整树生长动画（不再切树重放） |
| fix | prd-admin | 对话摘取切树后同步更新底部对话行，避免卡在"正在分析…" |
| fix | prd-api | CreateNode 不再接受裸 DependsOn（依赖一律经 AddDependency 校验+防环） |
| fix | prd-api | UpdateNode 点"卡点"pill（不带 blocker）时保留已有卡点描述，不再清空 |
| fix | prd-admin | 对话摘取 extract 走 VITE_API_BASE_URL 前缀，分离部署时 SSE 不再 404 |
| fix | prd-admin | 切树后 thinking/typing/error 流式事件一并丢弃，不再覆盖新树对话行 |
| fix | prd-admin | 摘取失败替换"正在分析…"占位行而非新增，避免重复消息 |
| fix | prd-admin | removeNode/addDep/removeDep 对 dependsOn 加 null 兜底 |
| fix | prd-admin | 重命名根节点时同步刷新本地 trees 列表（头部下拉即时更新） |
| fix | prd-api | DeleteTree 清理其它树对被删节点的跨树依赖引用，避免悬空依赖边 |
| fix | prd-admin | 创建任务树直接采用返回的树+根节点，不依赖二次 list/detail；失败不弹成功 toast |
| fix | prd-admin | loadTrees/卡点墙 scope 加载失败时报错兜底，不残留旧数据/不误显空状态 |
| fix | prd-admin | 侧栏标题清空失焦时还原为原标题，不留空白编辑框 |
| fix | prd-admin | extract SSE base URL 去尾部斜杠，避免双斜杠路由不匹配 |
| fix | prd-api | CreateNode 在树缺根节点时拒绝挂载，不再产生孤儿节点 |
