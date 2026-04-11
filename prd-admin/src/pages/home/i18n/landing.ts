/**
 * landing.ts — 首页 /home 的双语字典（中 / 英）
 *
 * 原则：
 *  · 只翻译"用户可见的文案"（标题、副标题、bullet、eyebrow、按钮）
 *  · ProductMockup 和 FeatureDeepDive 内各个 mockup 里的"伪数据"保持中文
 *    （它们是示意产物而不是 UI chrome，翻译了反而突兀）
 *  · 所有 key 使用扁平结构，便于 `t.hero.title` 直接访问
 *  · 多行文案用 `\n` 分隔，由组件决定是否转换为 <br>
 */

export type Lang = 'zh' | 'en';

export interface StatItem {
  value: string;
  label: string;
}

export interface FeatureItem {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
}

export interface HowStep {
  n: string;
  title: string;
  description: string;
  demo: string;
}

export interface AgentItem {
  id: string;
  name: string;
  description: string;
}

export interface PulseStat {
  id: string;
  label: string;
  trend: string;
}

export interface LeaderboardRow {
  id: string;
  name: string;
  delta: string;
}

export interface PlatformItem {
  id: string;
  name: string;
  arch: string;
}

export interface TranslationShape {
  nav: {
    products: string;
    agents: string;
    cinema: string;
    community: string;
    download: string;
    docs: string;
    login: string;
  };
  hero: {
    status: string;
    brand: string;
    title: string;
    subtitle: string;
    primaryCta: string;
    secondaryCta: string;
  };
  stats: StatItem[];
  features: {
    eyebrow: string;
    title: string;
    subtitle: string;
    learnMore: string;
    chapterLabel: string;
    items: FeatureItem[];
  };
  cinema: {
    eyebrow: string;
    title: string;
    tail: string;
    caption: string;
    comingSoon: string;
  };
  how: {
    eyebrow: string;
    title: string;
    steps: HowStep[];
  };
  agents: {
    eyebrow: string;
    title: string;
    subtitle: string;
    dedicated: string;
    assistant: string;
    items: AgentItem[];
  };
  compat: {
    eyebrow: string;
    title: string;
    subtitle: string;
    footer: string;
  };
  pulse: {
    eyebrow: string;
    title: string;
    subtitle: string;
    leaderboard: string;
    stats: PulseStat[];
    rows: LeaderboardRow[];
  };
  download: {
    eyebrow: string;
    title: string;
    subtitle: string;
    bullets: string[];
    platforms: PlatformItem[];
  };
  cta: {
    eyebrow: string;
    title: string;
    subtitle: string;
    primary: string;
    secondary: string;
  };
  footer: {
    brand: string;
    github: string;
    backToTop: string;
    copyright: string;
  };
}

// ── 中文字典 ──────────────────────────────────────────────────

const zh: TranslationShape = {
  nav: {
    products: '产品',
    agents: 'Agent',
    cinema: '片花',
    community: '社区',
    download: '下载',
    docs: '文档',
    login: '登录 / 注册',
  },
  hero: {
    status: 'SYSTEM ONLINE',
    brand: 'MAP · 米多 AGENT 平台',
    title: '让创造，自由呼吸',
    subtitle:
      '融合大模型与多模态能力的 AI 工作台 —— 视觉、文学、产品、视频、缺陷，十余个专业 Agent 在同一个空间协同。',
    primaryCta: '进入 MAP',
    secondaryCta: '观看片花',
  },
  stats: [
    { value: '15+', label: '专业 Agent' },
    { value: '14', label: '集成大模型' },
    { value: '98', label: 'MongoDB 集合' },
    { value: '99.9%', label: '服务可用性' },
  ],
  features: {
    eyebrow: 'Core Capabilities',
    title: '六个专业 Agent，\n一个工作台',
    subtitle:
      '每一个 Agent 都是一个独立的领域专家，在 MAP 里它们共享上下文、互相调用，像一个真正的团队。',
    learnMore: '了解更多',
    chapterLabel: 'CHAPTER',
    items: [
      {
        id: 'visual',
        eyebrow: 'VISUAL · 视觉设计师',
        title: '从一句话到一组完整视觉',
        description:
          '文生图、图生图、多图组合、局部重绘、风格迁移。配合参考图池与水印预设，让品牌视觉在一次对话中成型。',
        bullets: [
          '文生图 / 图生图 / 多图组合',
          '参考图池 + 风格迁移 + 局部重绘',
          '可绑定水印配置，一键导出品牌成图',
        ],
      },
      {
        id: 'literary',
        eyebrow: 'LITERARY · 文学创作者',
        title: '让文字在工作台里流淌',
        description:
          '从命题写作、段落润色到自动配图，文学创作者把写作流程拆成可感知的阶段。每一次调整都能看到上一版的差异。',
        bullets: [
          '多风格命题写作与续写',
          '按段润色 + 差异对比视图',
          '自动为段落生成配图',
        ],
      },
      {
        id: 'prd',
        eyebrow: 'PRD · 产品分析师',
        title: '读懂 PRD 的第二双眼睛',
        description:
          '把 PRD 文档丢进来，PRD 分析师会识别需求缺口、回答产品问题、生成评审意见，在方案落地前就找到那些被忽略的角落。',
        bullets: [
          '需求缺口自动识别',
          '对话式产品答疑',
          '正式评审前的 AI 预审',
        ],
      },
      {
        id: 'video',
        eyebrow: 'VIDEO · 视频创作者',
        title: '文章直接生成分镜与预览',
        description:
          '上传一篇文章，视频创作者会拆出分镜脚本、逐帧预览图，甚至帮你拼好草稿时间线。适合教程、产品讲解、短视频场景。',
        bullets: [
          '文章 → 分镜脚本自动拆解',
          '每一镜生成预览图',
          '草稿时间线可以直接导入 Remotion',
        ],
      },
      {
        id: 'defect',
        eyebrow: 'DEFECT · 缺陷管理员',
        title: '让每一个 Bug 都能被看见',
        description:
          '从截图、录屏、用户反馈里自动提取关键信息，分类、指派、跟进。外部 Agent 还能接入，做复现 + 根因分析 + 修复报告。',
        bullets: [
          '截图 / 录屏自动提取信息',
          '严重度分类 + 优先级指派',
          '外部 Agent 复现 + 修复报告闭环',
        ],
      },
      {
        id: 'report',
        eyebrow: 'REPORT · 周报管理员',
        title: '周五不再凑字数',
        description:
          '从 Git 提交、任务流水、日报碎片自动汇总一份结构化周报，团队 Leader 还能用"计划 vs 实际"的比对视图审阅。',
        bullets: [
          '从 Git / 任务 / 日报自动合成',
          '团队汇总 + 计划对比视图',
          '一键导出 Markdown / PDF',
        ],
      },
    ],
  },
  cinema: {
    eyebrow: 'Signature · 一镜到底',
    title: '看 AI 如何成为',
    tail: ' 你的第二颗大脑',
    caption: 'MAP · 产品片花',
    comingSoon: 'Coming soon · 即将上线',
  },
  how: {
    eyebrow: 'How It Works',
    title: '三步，从想法到产物',
    steps: [
      {
        n: '01',
        title: '提出需求',
        description:
          '用自然语言描述你想做的事 —— 不用选模型，不用挑 Agent，直接说。',
        demo: '帮我生成一张"未来科技城市"的海报',
      },
      {
        n: '02',
        title: 'Agent 自动选型',
        description:
          'MAP 会根据意图路由到最合适的 Agent + 模型组合，必要时多个 Agent 协作。',
        demo: '→ 视觉设计师 · GPT-image-1 · 16:9',
      },
      {
        n: '03',
        title: '流式输出',
        description:
          '实时看到思考过程、中间产物、进度，随时可以打断、分支、继续。',
        demo: '生成中 · 2 / 4 已完成 · 预计 12s',
      },
    ],
  },
  agents: {
    eyebrow: 'The Roster',
    title: '十五位 Agent，\n随时可以派工',
    subtitle:
      '11 位深度定制 + 4 位通用对话助手。每一位都能独立上岗，也能被别的 Agent 调用。',
    dedicated: 'Dedicated',
    assistant: 'Assistant',
    items: [
      { id: 'visual', name: '视觉设计师', description: '文生图 · 图生图 · 多图组合 · 局部重绘' },
      { id: 'literary', name: '文学创作者', description: '命题写作 · 段落润色 · 自动配图' },
      { id: 'prd', name: 'PRD 分析师', description: '需求缺口识别 · 对话答疑 · AI 预审' },
      { id: 'video', name: '视频创作者', description: '文章 → 分镜 → 预览 → 时间线' },
      { id: 'defect', name: '缺陷管理员', description: '信息提取 · 严重度分类 · 修复闭环' },
      { id: 'report', name: '周报管理员', description: 'Git 合成 · 计划对比 · 团队汇总' },
      { id: 'arena', name: 'AI 竞技场', description: '多模型盲测 PK · 揭晓真实身份' },
      { id: 'workflow', name: '工作流引擎', description: '可视化编排 · 多步骤串联' },
      { id: 'shortcuts', name: '快捷指令', description: '一键执行 · 自定义 · 可分享' },
      { id: 'review', name: '产品评审员', description: '方案多维度打分 · 问题清单' },
      { id: 'transcript', name: '转录工作台', description: '多模型 ASR · 时间戳编辑 · 转文案' },
      { id: 'code-review', name: '代码审查员', description: '代码质量审查 · Bug · 性能' },
      { id: 'translator', name: '多语言翻译', description: '专业级翻译 · 中英日韩' },
      { id: 'summarizer', name: '内容摘要师', description: '长文本要点提取 · 关键数据' },
      { id: 'data-analyst', name: '数据分析师', description: '趋势分析 · 图表建议 · 洞察' },
    ],
  },
  compat: {
    eyebrow: 'Compatible With',
    title: '一套配置，\n连接你用过的所有大模型',
    subtitle:
      '通过统一的 ILlmGateway 接入 12 家主流平台，按任务类型动态路由，支持健康度监控、配额管理、失败回退。',
    footer: '以及任何兼容 OpenAI 接口规范的自建 / 第三方服务',
  },
  pulse: {
    eyebrow: 'Live · Pulse',
    title: '整个平台，\n此时此刻在做什么',
    subtitle: '实时数据脉搏 + 本周 Agent 使用排行。参与越多，你的 Agent 越聪明。',
    leaderboard: 'Weekly Leaderboard',
    stats: [
      { id: 'active', label: 'ACTIVE AGENTS', trend: 'all online' },
      { id: 'convos', label: 'CONVERSATIONS · 24H', trend: '+18% ↑' },
      { id: 'tokens', label: 'TOKENS PROCESSED', trend: 'p95 · 62ms' },
      { id: 'media', label: 'MEDIA GENERATED', trend: 'last 7d' },
    ],
    rows: [
      { id: 'visual', name: '视觉设计师', delta: '+32%' },
      { id: 'prd', name: 'PRD 分析师', delta: '+14%' },
      { id: 'literary', name: '文学创作者', delta: '+8%' },
      { id: 'defect', name: '缺陷管理员', delta: '+22%' },
      { id: 'report', name: '周报管理员', delta: '+5%' },
    ],
  },
  download: {
    eyebrow: 'Desktop Client',
    title: '把整个 Agent 平台\n带到你的桌面',
    subtitle:
      '基于 Tauri 2.0 的原生桌面客户端，系统托盘常驻、快捷键唤醒、离线缓存、全局剪贴板注入。和 Web 端共享同一套账号体系。',
    bullets: [
      '系统托盘常驻 · 快捷键 Cmd+Shift+M 唤醒',
      '自动更新 · Tauri updater 签名校验',
      '所有平台共 134 MB · 零 Node runtime',
    ],
    platforms: [
      { id: 'macos', name: 'macOS', arch: 'Apple Silicon · Intel' },
      { id: 'windows', name: 'Windows', arch: 'x64 · ARM64' },
      { id: 'linux', name: 'Linux', arch: 'AppImage · .deb' },
    ],
  },
  cta: {
    eyebrow: 'Ready Player One',
    title: '现在，轮到你了。',
    subtitle: '十五位 Agent 已经就位。你的第一个任务是什么？',
    primary: '进入 MAP',
    secondary: '联系我们',
  },
  footer: {
    brand: '米多 Agent 平台',
    github: 'GitHub',
    backToTop: '回到顶部',
    copyright: '© 2026 MAP',
  },
};

// ── 英文字典 ──────────────────────────────────────────────────

const en: TranslationShape = {
  nav: {
    products: 'Product',
    agents: 'Agents',
    cinema: 'Showcase',
    community: 'Community',
    download: 'Download',
    docs: 'Docs',
    login: 'Sign In',
  },
  hero: {
    status: 'SYSTEM ONLINE',
    brand: 'MAP · MIDOR AGENT PLATFORM',
    title: 'Create, freely.',
    subtitle:
      'A multimodal AI workbench where 15+ specialized Agents — visual, literary, product, video, QA — collaborate in one shared space.',
    primaryCta: 'Enter MAP',
    secondaryCta: 'Watch Trailer',
  },
  stats: [
    { value: '15+', label: 'Dedicated Agents' },
    { value: '14', label: 'LLM Providers' },
    { value: '98', label: 'Mongo Collections' },
    { value: '99.9%', label: 'Uptime' },
  ],
  features: {
    eyebrow: 'Core Capabilities',
    title: 'Six specialized Agents,\none workbench.',
    subtitle:
      'Each Agent is an independent domain expert. Inside MAP they share context and call each other, like a real team.',
    learnMore: 'Learn more',
    chapterLabel: 'CHAPTER',
    items: [
      {
        id: 'visual',
        eyebrow: 'VISUAL · Visual Designer',
        title: 'From one sentence to a full visual set',
        description:
          'Text-to-image, image-to-image, compositions, inpainting, style transfer. Paired with reference pools and watermark presets — shape a brand look in a single conversation.',
        bullets: [
          'Text-to-image / image-to-image / compositions',
          'Reference pool + style transfer + inpainting',
          'Bind watermark presets, export branded output in one click',
        ],
      },
      {
        id: 'literary',
        eyebrow: 'LITERARY · Writing Studio',
        title: 'Make text flow through the workbench',
        description:
          'From prompted writing to paragraph polishing to auto-illustration, the Writing Agent breaks the drafting loop into perceivable stages. Every revision shows a diff from the last.',
        bullets: [
          'Multi-style prompted writing and continuation',
          'Per-paragraph polish + side-by-side diff view',
          'Auto-generate artwork for each paragraph',
        ],
      },
      {
        id: 'prd',
        eyebrow: 'PRD · Spec Analyst',
        title: 'A second pair of eyes for your spec',
        description:
          'Drop a PRD in. The Spec Agent finds requirement gaps, answers product questions, drafts review notes — catching the corners that always get skipped before ship time.',
        bullets: [
          'Automatic gap detection',
          'Conversational product Q&A',
          'AI pre-review before the stakeholder meeting',
        ],
      },
      {
        id: 'video',
        eyebrow: 'VIDEO · Video Studio',
        title: 'Article → storyboard → preview in one pass',
        description:
          'Upload an article. The Video Agent splits it into shots, renders a preview frame per shot, and assembles a draft timeline ready for teaching, product walkthroughs, and shorts.',
        bullets: [
          'Article → shot list auto-decomposition',
          'Preview frame generated per shot',
          'Draft timeline exports straight to Remotion',
        ],
      },
      {
        id: 'defect',
        eyebrow: 'DEFECT · Defect Manager',
        title: 'Every bug, seen and triaged',
        description:
          'Pull signals out of screenshots, screen recordings, and user feedback. Classify, assign, follow up. External Agents can even reproduce, diagnose, and write the fix report.',
        bullets: [
          'Auto-extract info from screenshots / recordings',
          'Severity classification + owner assignment',
          'External Agent repro + fix-report closed loop',
        ],
      },
      {
        id: 'report',
        eyebrow: 'REPORT · Weekly Report',
        title: 'No more Friday word-padding',
        description:
          'Auto-compose a structured weekly report from Git commits, task activity, and daily notes. Leaders get a plan-vs-actual review view with a click.',
        bullets: [
          'Synthesize from Git / tasks / daily notes',
          'Team roll-up + plan-vs-actual comparison',
          'One-click export to Markdown / PDF',
        ],
      },
    ],
  },
  cinema: {
    eyebrow: 'Signature · One Take',
    title: 'See how AI becomes',
    tail: ' your second brain',
    caption: 'MAP · Trailer',
    comingSoon: 'Coming soon',
  },
  how: {
    eyebrow: 'How It Works',
    title: 'Three steps, from idea to artifact',
    steps: [
      {
        n: '01',
        title: 'Describe',
        description:
          'Say what you want in plain language. No model picking, no Agent picking — just talk.',
        demo: 'Make me a "future city" poster',
      },
      {
        n: '02',
        title: 'Agent picks itself',
        description:
          'MAP routes intent to the best Agent + model combination. Multiple Agents collaborate when needed.',
        demo: '→ Visual Designer · GPT-image-1 · 16:9',
      },
      {
        n: '03',
        title: 'Streaming output',
        description:
          'Watch thinking, interim artifacts, and progress live. Interrupt, branch, or resume at any moment.',
        demo: 'Generating · 2 / 4 done · ETA 12s',
      },
    ],
  },
  agents: {
    eyebrow: 'The Roster',
    title: 'Fifteen Agents,\nready on demand',
    subtitle:
      '11 dedicated domain experts + 4 general assistants. Each can operate solo or be invoked by another.',
    dedicated: 'Dedicated',
    assistant: 'Assistant',
    items: [
      { id: 'visual', name: 'Visual Designer', description: 'T2I · I2I · compositions · inpainting' },
      { id: 'literary', name: 'Writing Studio', description: 'Prompted writing · polish · auto-illustration' },
      { id: 'prd', name: 'Spec Analyst', description: 'Gap detection · Q&A · AI pre-review' },
      { id: 'video', name: 'Video Studio', description: 'Article → storyboard → preview → timeline' },
      { id: 'defect', name: 'Defect Manager', description: 'Signal extraction · triage · fix loop' },
      { id: 'report', name: 'Weekly Report', description: 'Git synthesis · plan-vs-actual · team roll-up' },
      { id: 'arena', name: 'AI Arena', description: 'Blind multi-model duels · reveal after' },
      { id: 'workflow', name: 'Workflow Engine', description: 'Visual orchestration · multi-step chains' },
      { id: 'shortcuts', name: 'Shortcuts', description: 'One-tap ops · custom · shareable' },
      { id: 'review', name: 'Plan Reviewer', description: 'Multi-axis scoring · issue checklist' },
      { id: 'transcript', name: 'Transcript Studio', description: 'Multi-model ASR · timestamp edit · templating' },
      { id: 'code-review', name: 'Code Reviewer', description: 'Quality audit · bugs · performance' },
      { id: 'translator', name: 'Translator', description: 'Pro CN/EN/JA/KO translation' },
      { id: 'summarizer', name: 'Summarizer', description: 'Long-text key points · data extract' },
      { id: 'data-analyst', name: 'Data Analyst', description: 'Trends · chart advice · insights' },
    ],
  },
  compat: {
    eyebrow: 'Compatible With',
    title: 'One config,\nall the LLMs you have ever used',
    subtitle:
      'Through a unified ILlmGateway, MAP connects 12 major platforms with task-type routing, health monitoring, quota management, and automatic fallback.',
    footer: 'Plus any OpenAI-compatible self-hosted or third-party service',
  },
  pulse: {
    eyebrow: 'Live · Pulse',
    title: 'The platform,\nat this very moment',
    subtitle:
      'Live data pulse + weekly Agent usage leaderboard. The more you use them, the smarter they get.',
    leaderboard: 'Weekly Leaderboard',
    stats: [
      { id: 'active', label: 'ACTIVE AGENTS', trend: 'all online' },
      { id: 'convos', label: 'CONVERSATIONS · 24H', trend: '+18% ↑' },
      { id: 'tokens', label: 'TOKENS PROCESSED', trend: 'p95 · 62ms' },
      { id: 'media', label: 'MEDIA GENERATED', trend: 'last 7d' },
    ],
    rows: [
      { id: 'visual', name: 'Visual Designer', delta: '+32%' },
      { id: 'prd', name: 'Spec Analyst', delta: '+14%' },
      { id: 'literary', name: 'Writing Studio', delta: '+8%' },
      { id: 'defect', name: 'Defect Manager', delta: '+22%' },
      { id: 'report', name: 'Weekly Report', delta: '+5%' },
    ],
  },
  download: {
    eyebrow: 'Desktop Client',
    title: 'Bring the whole platform\nto your desktop',
    subtitle:
      'Native desktop client built on Tauri 2.0. System tray, keyboard wake, offline cache, global clipboard injection. Shares the same account with the Web app.',
    bullets: [
      'Tray-resident · Cmd+Shift+M to summon',
      'Auto-update · Tauri signed updater',
      '134 MB total across platforms · zero Node runtime',
    ],
    platforms: [
      { id: 'macos', name: 'macOS', arch: 'Apple Silicon · Intel' },
      { id: 'windows', name: 'Windows', arch: 'x64 · ARM64' },
      { id: 'linux', name: 'Linux', arch: 'AppImage · .deb' },
    ],
  },
  cta: {
    eyebrow: 'Ready Player One',
    title: "Now it's your turn.",
    subtitle: 'Fifteen Agents are standing by. What is your first task?',
    primary: 'Enter MAP',
    secondary: 'Contact us',
  },
  footer: {
    brand: 'Midor Agent Platform',
    github: 'GitHub',
    backToTop: 'Back to top',
    copyright: '© 2026 MAP',
  },
};

export const translations: Record<Lang, TranslationShape> = { zh, en };
