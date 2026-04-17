| fix | cds | 替换所有 emoji 为 SVG 图标（topology 面板、infra 选择器、分支列表、提示文本等 40+ 处） |
| fix | cds | 修复项目卡片 READY 徽章与删除按钮重叠：删除按钮移入 flex header，去除绝对定位 |
| fix | cds | 孤儿分支清理由串行 for-of 改为 Promise.all 并行，缩短多分支清理耗时 |
| fix | cds | build-profiles 接口不再要求 command 字段非空（auto-detect 场景 command 可为空字符串） |
| fix | cds | topology 拓扑图：节点布局改为上下方向（入口在上，数据库在下），新增应用虚线分组框，左侧导航新增视图切换图标，右侧面板添加/关闭按钮不再重叠 |
| fix | cds | 新增 .topology-app-group 和 .topology-fs-leftnav-label CSS 类，修复未定义样式导致渲染异常 |
| fix | cds | 修复 topology 布局：admin(app)被错放底部 infra 行，改用强制 2 层布局确保所有 app 节点在顶部 |
| feat | cds | topology 节点可拖拽：鼠标拖动单个节点，边线实时跟随；复位按钮清除拖拽偏移 |
| feat | cds | topology 分组框增加 GitHub+Apps 标签；初始缩放从 1.5x 降为 0.75x，加大 margin |
| feat | cds | topology 左侧设置图标改为打开系统设置菜单（含导出/自动更新/清理），不再跳转 settings.html |
| fix | cds | 隐藏 topology 全屏模式下面板标签栏的原生横向滚动条（scrollbar-width: none） |
| feat | cds | Activity Monitor 整合入右侧面板：全屏模式隐藏浮动 Activity，左侧导航新增「活动」入口，右侧面板新增「活动」标签展示 CDS/Web 实时日志，新事件自动推送到面板 |
| refactor | cds | topology 左侧导航重构：弃用单一「设置」弹出菜单，改为分段 icon 按钮（导航 / 项目级工具 / 系统级工具），每个功能直接可点 |
| fix | cds | 右侧面板关闭按钮（X）：图标扩大为 18px，边框改为 text-muted 颜色，字色改为 text-primary，确保在任何背景下清晰可见 |
| fix | cds | topology 画布添加 touch-action:none 防止系统触控惯性干扰自定义拖拽；左侧导航添加分段分隔线 |
| feat | cds | topology 聚合视图新增每分支独立虚线框：每列（每个分支）用带分支名 label 的虚线圆角框圈出 api+admin，移除冗余的卡片内 @branchLabel 标签，TOPO_SECTION_GAP_Y 调大至 84 以容纳 label pill |
| fix | cds | 修复 topology/列表 4 处 onclick 静默失效：JSON.stringify 产生未转义双引号破坏 HTML 属性解析（topology 可添加/手动添加/Enter 键、列表手动添加、提交日志 checkoutCommit），统一改为 .replace(/"/g,'&quot;') |
| fix | cds | topology 点击"可添加"分支后新增 _topoAddAndSelect：关闭下拉 + addBranch + 自动切换视图到新分支（原来 addBranch 成功后仍停在共享视图） |
| feat | cds | topology 聚合视图（共享 B 型）改为分组换行布局：超过 4 个分支时自动折行（MAX_AGG_COLS=4），最大画布宽度固定为 4 列，_layoutTopologyAggregated 返回预计算 positions/svgW/svgH，_renderTopologySvg 双路支持；_topologyFit 自动适应视口 |
| perf | cds | topology 拖拽丝滑度对齐 VisualAgent：mousemove/pointermove 写 transform 改为 requestAnimationFrame 合帧（`_scheduleTopologyTransform`），一帧最多一次 DOM 写入；画布 `will-change:transform + contain:layout style` 上 compositor 层；mouse 事件全量迁移 pointer 事件 + `setPointerCapture` 修复 1cm→5cm 漂移 + 指针离窗后失联 |
| fix | cds | 面板关闭按钮 SVG 改为 ✕ 文字字符，彻底消除 fill:currentColor 继承透明的顽疾 |
| refactor | cds | topology 左侧导航主次分离：刷新（最高频）移入项目级区段，导入/更新/清理/项目列表折入「设置」系统级 popover；移除 topbar 多余刷新按钮 |
| fix | cds | CSS 强制 `.topology-fs-leftnav-icon svg { width:20px; height:20px }` 覆盖任意 HTML 属性，彻底根治 icon 偏小反复出现问题 |
| fix | cds | topology window 级 pointer 监听改为一次性绑定（`_topologyWindowListenersBound` 防止每次 renderTopologyView 叠加句柄），长会话无句柄泄漏 |
| fix | cds | topology 状态点动画去掉 `transform:scale(1.25)` — SVG `<circle>` 不遵守 CSS `transform-origin:center`，scale 导致橙色圆点溢出卡片边界抖动；改为纯 opacity 呼吸动画 |
| feat | cds | 共享视图（B 型聚合）：无分支选中 + 有已追踪分支时，展示所有分支 × 所有 BuildProfile 实例，共享同一套基础设施；每张卡片右上角显示 @branchId 标签；点击任一实例自动切换至对应分支并打开服务面板 |
| fix | cds | 宿主机 CPU/MEM 浮动气泡在拓扑全屏模式下隐藏，改为嵌入顶部 topbar 的内联 pill（`topology-fs-hoststats`），不再遮挡画布内容 |
| fix | cds | topology 单分支 DAG 视图的 Apps 框改为显示当前分支名 `@branchId`，与聚合视图保持一致 |
| fix | cds | 刷新页面进入共享视图后打开分支下拉不再自动切换到主分支（删除 _topologyAutoSelectPending 逻辑） |
| fix | cds | topology 部署日志 tab 不再被 updateInlineLog 强制跳回详情 tab（仅在已处于 details tab 时才重渲染） |
| fix | cds | modal z-index 从 100 提升至 500，彻底解决 topo-sys-popover（z-index:200）遮盖弹窗的重叠问题 |
| fix | cds | CDS 系统更新弹窗简化：默认直接更新当前分支，移除分支切换下拉（改为 <details> 折叠的高级选项），清理误导性"更新所有"按钮 |
| fix | cds | 移除"网络流"tab（eBPF/tcpdump 未实现的占位符），避免用户看到无内容页面以为功能异常 |
