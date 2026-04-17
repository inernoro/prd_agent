| feat | prd-admin | 涌现探索器新增炫酷介绍入口页,首次进入展示三步流程+三维度样例+手势说明,可通过顶栏「关于涌现」再次查看 |
| fix | prd-admin | 修复涌现画布探索/涌现时新节点堆积在同一位置的 bug(原 `toFlowNodes` 在增量到达时只传入单个节点导致无法计算正确深度),改为整体重新布局 + 基于子树宽度的递归树布局算法 |
| feat | prd-admin | 涌现画布手势对齐视觉创作画布:两指拖动=平移、双指捏合或 ⌘/Ctrl+滚轮=缩放、Space+拖动=临时平移、禁止双击缩放 |
| rule | root | 新增 `.claude/rules/gesture-unification.md` 画布手势统一规则,强制所有 2D 画布遵守同一套 Apple 触控板优先的手势约定,并注册到 CLAUDE.md 规则索引 |
| feat | prd-admin | 涌现画布新增骨架占位卡片:点击「探索/涌现」瞬间下方立即出现 4 张 shimmer 扫光骨架 + 虚线 animated 边,SSE 每到达一个真实节点就消费一个占位槽位并带 0.55s 淡入放大的入场动效,彻底消除 LLM 空白等待 |
| feat | prd-admin | 涌现节点操作按钮拆分为两颗:左「增加灵感」(黄色·Lightbulb,打开对话框写方向)、右「探索」(蓝/紫/黄·Star,直接无提示词发散);灵感对话框带 6 个快速预设+⌘Enter 快捷提交,呼应零摩擦输入原则 |
| feat | prd-api | `POST /api/emergence/nodes/:nodeId/explore` 新增可选请求体 `{ userPrompt?: string }`,Service 层 `ExploreAsync` 接收 `userPrompt` 参数并在 userMessage 尾部追加「用户补充灵感方向」段,LLM 按方向优先发散但仍约束于现实锚点 |
| feat | prd-admin | 涌现树列表卡片重新设计:基于标题哈希派生确定性视觉指纹(色相/轨道粒子数/热度/旋转角),每棵树自带独特花蕾+轨道 SVG 动画(节点数→粒子数/亮度,更新时间→热度火苗)+ 渐变进度条,彻底告别"所有树长得一模一样"的单调感 |
| feat | prd-admin | 涌现画布顶栏新增「整理」按钮(Wand2 图标):调用 `reactFlow.fitView` + 重新递归布局,一键把杂乱节点恢复树状整齐视图,解决"人类微调太累"痛点 |
| feat | prd-admin | 涌现画布「二维涌现 / 三维幻想」两颗按钮合并为单颗「涌现 ▾」Popover:展开后展示两种发散方式的大白话解释(跨系统组合 vs 放飞想象),用户第一次见就知道选哪个,呼应 guided-exploration 的 3 秒规则 |
| feat | prd-admin | 涌现画布流式生成时顶栏增加「停止」按钮(StopCircle 红色):调用 `useSseStream.abort()` 中断当前 LLM 请求、清空占位骨架,用户不再被卡住几十秒空等 |
| feat | prd-admin | 涌现画布每到达一个新节点自动调用 `reactFlow.setCenter` 平滑居中,新节点不再跑到视口外需要手动找;缩放 0.85 + 600ms 过渡,兼顾全局感与聚焦感 |
| fix | prd-admin | 涌现画布左下角图例文字从白色改为与图标同色(维度色相),用户不再"分不清白字在说什么";底色加深+blur,提升对比度和可读性 |
