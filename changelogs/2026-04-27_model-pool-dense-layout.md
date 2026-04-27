| refactor | prd-admin | 模型池展开区改为紧凑模式 — 每个模型池一行（名称 + 数量徽章 + 数+ 眼睛按钮），点击卡片/眼睛展开池内模型详情；徽章仅在 >1 模型时显示，模型数量超过 5 时不再被强制平铺，信息密度大幅提升 |
| refactor | prd-admin | 模型池布局再优化 — 改为响应式卡片网格（sm 2 列 / lg 3 列），充分利用横向空间；移除上方重复的 inline 池名标签（与下方卡片重复）；移除池行的 ⚠ 非健康摘要徽章（避免与"报错"误读，健康详情在展开后查看） |
| refactor | prd-admin | 模型池卡片改为「总览即详情」模式 — 移除眼睛/折叠交互，模型直接平铺在卡片体内，对齐 OpenRouter / OpenAI Platform / Anthropic Console 同类设计。卡片永不显示空白，卡片高度按池内模型数自然伸缩（CSS Grid 行高自适应） |
| fix | prd-admin | ModelListItem 模型名 `truncate` 单行省略改为 `line-clamp-2 break-all`，长模型 ID（如 `gpt-image-2-all`）允许跨行显示，hover 仍有完整 tooltip |
| refactor | prd-admin | 模型池卡片体改为自有两行布局，不再复用 ModelListItem（避免 mid-word 折叠"牛皮癣"现象）：第 1 行模型名占满整行（无截断、无 break-all 强行断字），第 2 行小字展示「平台名 · 统计」。Healthy 状态不再展示"健康"chip，无统计时不再展示"暂无统计"占位，显著降噪。同时撤销 ModelListItem 的 line-clamp 改动（不影响其他调用方） |
| feat | prd-admin | 模型池卡片复用 LegacySingle "模型池降级"警示条的视觉语言：池内任一 Unavailable → 卡片整体换黄色虚线边框 + 池名前置 ⚠ 图标；全部 Unavailable → 红色虚线边框；模型行 Unavailable → 红色文字 + 删除线 + 红底；模型行 Degraded → 黄色文字 + 黄底（不删除线，仍可用）。状态信息无需阅读即可在视觉边缘看到 |
