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
| perf | cds | topology 拖拽丝滑度对齐 VisualAgent：mousemove/pointermove 写 transform 改为 requestAnimationFrame 合帧（`_scheduleTopologyTransform`），一帧最多一次 DOM 写入；画布 `will-change:transform + contain:layout style` 上 compositor 层；mouse 事件全量迁移 pointer 事件 + `setPointerCapture` 修复 1cm→5cm 漂移 + 指针离窗后失联 |
| fix | cds | topology window 级 pointer 监听改为一次性绑定（`_topologyWindowListenersBound` 防止每次 renderTopologyView 叠加句柄），长会话无句柄泄漏 |
