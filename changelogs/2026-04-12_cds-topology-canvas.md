| feat | cds | 拓扑视图（画板模式）：列表/拓扑切换按钮 + 分层 DAG 图（SVG） + 分支选择器 + 依赖线（弯曲贝塞尔 + 箭头） |
| feat | cds | 画板节点自动布局：Kahn 算法按 depends_on 分层，infra 在最左侧 / app 按依赖链向右 |
| feat | cds | 分支级覆盖徽章：选中一个分支后，所有被该分支自定义的 profile 节点显示 🌿 + 绿色高亮边框，hover 显示被覆盖的字段列表 |
| feat | cds | 节点点击直达：点击 app 节点 → 自动打开容器配置 modal 并定位到对应 profile tab（`openOverrideModal` 新增 `preferredProfileId` 参数） |
| feat | cds | 基础设施节点 = 圆角胶囊形（rx=22），应用节点 = 矩形（rx=8），视觉差异化 |
| feat | cds | 拓扑视图与列表视图共享同一数据源（已有的 polling）——切换到拓扑不需额外 fetch，依赖分支覆盖的 override 集合按需懒加载并缓存 |
| feat | cds | View mode 持久化到 sessionStorage（`cds_view_mode`），遵守 CDS "禁止 localStorage" 规则 |
