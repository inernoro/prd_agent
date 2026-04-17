| feat | prd-admin | 涌现探索器新增炫酷介绍入口页,首次进入展示三步流程+三维度样例+手势说明,可通过顶栏「关于涌现」再次查看 |
| fix | prd-admin | 修复涌现画布探索/涌现时新节点堆积在同一位置的 bug(原 `toFlowNodes` 在增量到达时只传入单个节点导致无法计算正确深度),改为整体重新布局 + 基于子树宽度的递归树布局算法 |
| feat | prd-admin | 涌现画布手势对齐视觉创作画布:两指拖动=平移、双指捏合或 ⌘/Ctrl+滚轮=缩放、Space+拖动=临时平移、禁止双击缩放 |
| rule | root | 新增 `.claude/rules/gesture-unification.md` 画布手势统一规则,强制所有 2D 画布遵守同一套 Apple 触控板优先的手势约定,并注册到 CLAUDE.md 规则索引 |
