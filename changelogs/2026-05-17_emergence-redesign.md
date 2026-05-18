| refactor | prd-admin | 涌现画布布局重构：位置权威 positionsRef + 全量布局仅初始/手动整理触发，流式生成不再全树重排 |
| fix | prd-admin | 涌现生成体验：删除顶部流式横幅，反馈下沉到父节点下单一固定尺寸生成槽，子节点按 ~170ms 节流逐个落位 |
| fix | prd-admin | 涌现父子完整性：孤儿子节点暂存待父出现回收，后端节点只增不删，拖动位置写回权威 |
| refactor | prd-admin | 涌现列表卡片改为极简排版流：固定高度，去轨道粒子 SVG，悬停改为绝对定位淡入（修复悬停撑高挤动整行） |
| refactor | prd-admin | 涌现介绍页推倒重做为 claude-code 式克制排版：去旋转轨道/浮动粒子/玻璃 bento，单焦点 hero + 极简三步 |
| chore | prd-admin | 删除弃用 EmergenceStreamingBar 组件并清理 emergence.css 死动效 |
