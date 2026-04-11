| feat | prd-admin | 首页 /home 新增中英文切换器（仅首页，顶栏右上角 `中/EN` 胶囊 toggle） |
| feat | prd-admin | 新建 i18n/landing.ts 双语字典（涵盖 nav/hero/stats/features/cinema/how/agents/compat/pulse/download/cta/footer 全部可见文案），结构化 TranslationShape interface |
| feat | prd-admin | 新建 contexts/LanguageContext.tsx：LanguageProvider + useLanguage hook，sessionStorage 记忆语言选择，同步更新 `<html lang>` |
| feat | prd-admin | 新建 components/LanguageToggle.tsx：中英切换 pill，当前语言高亮 + 霓虹边框 |
| feat | prd-admin | 全部 9 个 section（Hero/Stats/FeatureDeepDive/Cinema/HowItWorks/AgentGrid/CompatibilityStack/CommunityPulse/DesktopDownload/FinalCta/MinimalFooter）接入 useLanguage，文案从字典读 |
| feat | prd-admin | FeatureDeepDive 段落感升级：每个 feature block 内部 7 级 stagger reveal（chapter 号 → eyebrow → title → desc → bullets 逐条 → learn-more → mockup），让页面"徐徐前进地拼凑出来" |
| feat | prd-admin | FeatureDeepDive 新增 chapter 编号分段符 `CHAPTER 01 / 06`（VT323 mono + 霓虹发光），每段开头出现，作为"新段落开始"的明确视觉信号 |
| refactor | prd-admin | FeatureDeepDive block 间距从 space-y-32/44 拉大到 space-y-44/56，header mb 从 32/40 拉大到 36/48，gap 从 md:gap-16 拉到 md:gap-20 —— 解决 "六个专业 Agent，一个工作台" 上下挤感 |
