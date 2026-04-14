| feat | cds | P4 Part 5 全屏拓扑画布：`setViewMode('topology')` 现在给 `<body>` 加 `cds-topology-fs` class，CSS 隐藏 dashboard 的 header / 搜索 / 分支栏 / tag bar 等所有 chrome，把 `#topologyView` 提升到 `position: fixed; inset: 0` 占满整个视口，`.topology-card` 失去边框 + radius 和 `topology-canvas-wrap` flex:1 撑满 |
| feat | cds | 全屏模式新增浮动顶栏 `topology-fs-topbar`：左侧 ← Projects 返回 + 项目名（从 `/api/projects/:id` 异步拉取）；右侧"列表视图"切换按钮 + 主题切换；浮动底部提示条 `topology-edit-hint`："点击节点直接编辑配置·拖拽空白处平移·滚轮缩放" |
| feat | cds | 节点点击交互重做：选中分支后**单击**应用节点直接打开 override modal（原本要双击），更直观；shift+click 仍是边高亮（escape hatch）；单击 infra 节点切回列表视图并自动打开基础设施面板（infra 编辑器目前在那里）|
| docs | cds | legend 提示文案动态化：未选分支时显示"先选择上方分支，再点击节点编辑"，已选分支时显示"点击节点直接编辑该分支配置" |
