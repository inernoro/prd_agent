| fix | prd-admin | 修复 StatsStrip 后方诡异"银色金属条"伪影：StaticBackdrop 的 synthwave 地平线/太阳/Tron 地板从 fixed 全屏搬到 HeroSection 本地，避免 fixed 42% 位置穿透后续 section |
| feat | prd-admin | 新增 useInView hook + Reveal 组件：Intersection Observer 驱动的 fade-up 滚动进场动效，prefers-reduced-motion 尊重，触发一次不重复 |
| feat | prd-admin | 新增 SectionHeader 共享组件：统一所有 section 头部版式（Lucide icon HUD chip + VT323 eyebrow + h2 + 可选 subtitle），内置 Reveal 分步进场 |
| feat | prd-admin | 全站 section chip 的 Unicode 符号 ✦ ► » ⚡ ★ 替换为真 Lucide 图标：Sparkles / Users / Workflow / Zap / Star / Radio / Download |
| fix | prd-admin | Hero CTA 重做对称两按钮：h-12 + rounded-full + icon 前置，消除之前一个实 pill 一个纯文字的视觉不平衡 |
| fix | prd-admin | FeatureDeepDive 头部间距：pt-10 + mb-32→40，六段之间 space-y-32→44，修复"六个专业 Agent"章节上下挤感 |
| fix | prd-admin | StatsStrip 去掉 border-y 金属条效果，改为纯留白 + 每数字独立 Reveal stagger |
| feat | prd-admin | Hero 主标题加 ambient neon pulse（5s 呼吸发光）+ 终端 HUD chip 同步 pulse |
| feat | prd-admin | 所有 section 内容接入 Reveal：Hero 分 5 级 delay（chip→title→subtitle→CTA→mockup），其他 section stagger 80-120ms |
