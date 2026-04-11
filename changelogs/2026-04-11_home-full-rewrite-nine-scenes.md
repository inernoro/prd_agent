| refactor | prd-admin | 首页 /home 全面重构为九幕 Linear.app 风结构：Hero → StatsStrip → FeatureDeepDive → Cinema → HowItWorks → AgentGrid → CompatibilityStack → FinalCta → Footer |
| feat | prd-admin | 新增 StatsStrip 幕：极简大数字横条（15+/14/98/99.9%），无卡片无图标 |
| feat | prd-admin | 新增 FeatureDeepDive 幕：六大核心 Agent（视觉/文学/PRD/视频/缺陷/周报）左右交替深度展示，每段配专属几何 mockup（2×2 生成图网格 / 润色文本 / PRD 缺口标注 / 视频分镜时间线 / 缺陷 triage 卡片 / 周报对比条形图） |
| feat | prd-admin | 新增 HowItWorks 幕：三步流程（提问 → Agent 选型 → 流式输出），带步骤间连接渐变线 |
| feat | prd-admin | 新增 AgentGrid 幕：从 toolboxStore.BUILTIN_TOOLS 真实驱动 15 个 Agent 卡片，4 列网格，每卡独立 accent color + hover 光晕，Dedicated/Assistant 分类徽章 |
| feat | prd-admin | 新增 CompatibilityStack 幕：12 家 LLM Provider 文字 logo 矩阵（OpenAI/Anthropic/Gemini/DeepSeek/Kimi/通义/GLM/文心/豆包 等），区域标签 |
| feat | prd-admin | 新增 FinalCta 幕："现在，轮到你了" 收束 CTA，稀缺渐变第二次也是最后一次出现 |
| feat | prd-admin | 新增 MinimalFooter 幕：极简单行页脚（logo + GitHub + 版权） |
| refactor | prd-admin | LandingPage 重写：九幕 SCENE_COLORS 场景色编排，Starfield 降到 18% 不透明度作材质，顶栏导航改为 产品/Agent/片花/流程/兼容/文档 |
| fix | prd-admin | 删除六个旧 section（LibrarySection 克莱风空壳 / FeatureBento / SocialProof / AgentShowcase / DownloadSection / CtaFooter）+ 三个孤儿组件（CountUpNumber / GlowOrb / ParticleField），首页目录从 10 个 section 精简到 9 个全新 section |
