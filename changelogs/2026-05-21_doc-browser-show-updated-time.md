| feat | prd-admin | 知识库左侧目录新增「显示设置」弹窗，可开启在每个条目右侧显示相对更新时间（hover 显示精确时间 + 作者），默认关闭、设置以 sessionStorage 持久化 |
| feat | prd-admin | 文档阅读器正文最大宽度由固定 860px 改为自适应 min(100%, 1180px)，宽屏下表格/正文获得 ~37% 更大阅读空间 |
| feat | prd-admin | 文档阅读器顶部「更新于」改用相对时间（刚刚/几分钟前/昨天/N 天前，hover 显示精确时间）；作者未知时不再显示「更新者 未知用户」减少噪音，new 徽标保留 |
| fix | prd-admin | 修复知识库左右分栏拖拽不跟手/跳动：宽度基准由写死的 20px 偏移改为拖拽开始时实测侧栏左边界（getBoundingClientRect），并移除导致每帧重挂监听的依赖 |
| fix | prd-admin | 修复保存后「更新于」显示陈旧时间：相对时间显示改回只用 updatedAt（保存会刷新），lastChangedAt 仅供 new 徽标；并给侧栏每行相对时间关闭独立 60s 定时器，避免大知识库累积大量 timer |
