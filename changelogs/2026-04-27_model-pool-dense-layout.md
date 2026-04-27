| refactor | prd-admin | 模型池展开区改为紧凑模式 — 每个模型池一行（名称 + 数量徽章 + 数+ 眼睛按钮），点击卡片/眼睛展开池内模型详情；徽章仅在 >1 模型时显示，模型数量超过 5 时不再被强制平铺，信息密度大幅提升 |
| refactor | prd-admin | 模型池布局再优化 — 改为响应式卡片网格（sm 2 列 / lg 3 列），充分利用横向空间；移除上方重复的 inline 池名标签（与下方卡片重复）；移除池行的 ⚠ 非健康摘要徽章（避免与"报错"误读，健康详情在展开后查看） |
| refactor | prd-admin | 模型池卡片改为「总览即详情」模式 — 移除眼睛/折叠交互，模型直接平铺在卡片体内，对齐 OpenRouter / OpenAI Platform / Anthropic Console 同类设计。卡片永不显示空白，卡片高度按池内模型数自然伸缩（CSS Grid 行高自适应） |
| fix | prd-admin | ModelListItem 模型名 `truncate` 单行省略改为 `line-clamp-2 break-all`，长模型 ID（如 `gpt-image-2-all`）允许跨行显示，hover 仍有完整 tooltip |
