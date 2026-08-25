/**
 * landing.ts — 首页 /home 的双语字典（中 / 英）
 *
 * 原则：
 *  · 翻译所有用户可见的文案（标题、副标题、bullet、eyebrow、按钮、mockup 示意文案）
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



/** 文学创作那一幕的四个配图风格（对应墨系色带的钢青 / 陶土 / 松绿 / 钢蓝）。 */
export type LiteraryStyleKey = 'calm' | 'warm' | 'forest' | 'night';

/**
 * 四幕「真实面板」场景的文案。
 *
 * 这些不是营销辞令，是**照真实产品面板抄下来的界面文字**——面板里写什么，
 * 这里就写什么。改产品面板的措辞时，这里要跟着改，否则首页会开始说假话。
 */
export interface ScenesTranslation {
  visual: {
    eyebrow: string;
    title: string;
    description: string;
    tiles: { a: string; b: string; c: string };
    genRunning: { label: string; status: string };
    genOvertime: { label: string; status: string };
    generator: { title: string; body: string };
    actions: string[];
    gesture: { before: string; after: string };
    chat: {
      title: string;
      subtitle: string;
      submit: string;
      user: string;
      thinking: string;
      reply: string;
      landed: string;
      streaming: string;
      model: string;
      pool: string;
      placeholder: string;
      send: string;
    };
  };
  literary: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    styleLabel: string;
    styleHint: string;
    styles: Record<LiteraryStyleKey, string>;
    fileName: string;
    model: string;
    pool: string;
    body: { p1: string; p2: string; p3: string; p4: string; fig1: string; fig2: string; slot: string };
    summary: { words: string; paragraphs: string; figures: string; currentStyle: string };
    steps: string[];
    primaryAction: string;
    configPills: string[];
    tools: { generate: string; size: string; pack: string };
    streaming: string;
    runningLabel: string;
    status: { done: string; running: string; idle: string };
    cards: Array<{ size: string; prompt: string }>;
    cardActions: string[];
  };
  knowledge: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    search: string;
    badges: { shared: string; redo: string; pass: string; tag: string };
    tree: Array<{ name: string; time: string }>;
    doc: {
      title: string;
      meta: string;
      p1: string;
      p2before: string;
      selected: string;
      p2after: string;
      p3: string;
      p4: string;
    };
    readerTools: string[];
    selectionActions: string[];
    rewrite: {
      status: string;
      before: string;
      after: string;
      replace: string;
      insert: string;
      guard: string;
    };
    tocTitle: string;
    toc: Array<{ label: string; depth: number }>;
    galaxy: {
      hovered: string;
      legendTitle: string;
      legend: string[];
      hint: string;
      stats: string;
    };
  };
  layers: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    map: {
      role: string;
      meta: string;
      lead: string;
      statusLine: string;
      command: string;
      usage: string;
      frequentLabel: string;
      frequent: string[];
      activeLabel: string;
      active: Array<{ title: string; at: string }>;
    };
    gateway: {
      role: string;
      meta: string;
      lead: string;
      counts: Array<{ value: string; label: string }>;
      gatesLabel: string;
      gates: Array<{ title: string; state: string }>;
      topology: string;
    };
    cds: {
      role: string;
      meta: string;
      lead: string;
      branches: Array<{ name: string; status: string; meta1: string; meta2: string }>;
      branchActions: string[];
      footnote: string;
    };
  };
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
    techBarLabel: string;
    techItems: string[];
  };
  stats: StatItem[];
  /** 四幕「真实面板」场景（视觉创作 / 文学创作 / 知识库 / 三层一体） */
  scenes: ScenesTranslation;
  features: {
    eyebrow: string;
    title: string;
    subtitle: string;
    learnMore: string;
    chapterLabel: string;
    items: FeatureItem[];
  };
  workflow: {
    eyebrow: string;
    title: string;
    description: string;
    chapterMarker: string;
    canvasTitle: string;
    runLabel: string;
    nodes: Array<{ title: string; subtitle: string }>;
    status: {
      running: string;
      elapsed: string;
      eta: string;
      trace: string;
    };
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
    action: string;
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
  /** FeatureDeepDive 内各 mockup 的示意文案 */
  mockups: {
    visual: {
      header: string;
      status: string;
    };
    literary: {
      header: string;
      progress: string;
      added: string;
      deleted: string;
      diffView: string;
    };
    prd: {
      header: string;
      sections: Array<{ title: string; note?: string }>;
    };
    video: {
      header: string;
      status: string;
    };
    defect: {
      header: string;
      items: Array<{ sev: string; title: string }>;
      assigned: string;
      newThisWeek: string;
      fixed: string;
      fixRate: string;
    };
    report: {
      header: string;
      plan: string;
      actual: string;
      days: string[];
    };
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
    brand: 'MAP · 米多智能体生态平台',
    title: '让创造，自由呼吸',
    subtitle:
      'MAP（Midoo Agentic Platform）· 米多智能体生态平台是企业级数字劳动力平台，致力于将 AI 从辅助工具升级为具备端到端作业能力的数字劳动力，强调碳硅共生的深度融合、人机共治、价值共创、共同进化，赋能企业进化为碳硅共生的智能型组织。',
    primaryCta: '进入 MAP',
    secondaryCta: '观看片花',
    techBarLabel: 'POWERED BY',
    techItems: [
      'GPT-5',
      'Claude 4.6',
      'Gemini 2.5',
      'Grok 4',
      'Llama',
      'DeepSeek V3',
      'Kimi K2',
      'Qwen 3',
      'GLM 4.6',
      'Wenxin',
    ],
  },
  stats: [
    { value: '15+', label: '专业 Agent' },
    { value: '14', label: '集成大模型' },
    { value: '98', label: 'MongoDB 集合' },
    { value: '99.9%', label: '服务可用性' },
  ],
  scenes: {
    visual: {
      eyebrow: '视觉创作智能体 · 画布与对话同屏',
      title: '涂涂改改，又是一天',
      description:
        '左边是无限画布，图散在上面；右边是设计师，一直在。说一句话，新图落回画布；点一张图，动作条浮出来。',
      tiles: { a: '主视觉 · 初稿', b: '暖调变体', c: '雾天版本' },
      genRunning: { label: 'HD 放大', status: '4.2s / 预计 ~6s' },
      genOvertime: { label: 'AI 分层', status: '即将完成 · 8.4s' },
      generator: { title: '图像生成器', body: '选中它，画布上就出现快捷输入。参考图拖进来即可。' },
      actions: ['HD 放大', '移除背景', '扩展', '局部重绘', 'AI 分层', '下载'],
      gesture: { before: '两指拖动平移 ·', after: '+滚轮缩放 · Space 临时平移 · 双击空白不缩放' },
      chat: {
        title: 'Hi，我是你的 AI 设计师',
        subtitle: '点画板图片即可选中，可作为图生图的首帧。',
        submit: '投稿当前',
        user: '把主视觉改成雾天，山脊线保留',
        thinking: '思考 · 2.1s',
        reply: '只动天气层，山脊线的路径不变。给你出一张。',
        landed: '雾天版本已落在画布 · 未压住已有图',
        streaming: '要不要我把前景主体单独拆一层',
        model: 'seedream-4',
        pool: '模型池 vision-default',
        placeholder: '描述你想要的画面，或把参考图拖进画布…',
        send: '发送',
      },
    },
    literary: {
      eyebrow: '文学创作智能体 · 左文右图',
      title: '上传一个文档，回来时它已经配好了一篮子图',
      description:
        '左边是你的文章，逐段成稿；右边是配图工作台，一张张竖着落位。整篇读完，按段落语义一次配齐，换个风格整列重配，正文不动。',
      note: '换风格只换图，正文一个字都不动——风格是 AI 生成时的参照，不是事后给图套一层滤镜。',
      styleLabel: '风格',
      styleHint: '切一下试试：整列配图连同正文内联图一起换色，文字不动。',
      styles: { calm: '沉静', warm: '暖光', forest: '林间', night: '夜航' },
      fileName: '秋日随笔.docx',
      model: 'gemini-2.5-flash',
      pool: '模型池 literary-default',
      body: {
        p1: '十月的第一个清晨，山谷里还压着一层没散的雾。我沿着旧路往上走，脚下的碎石被露水浸得发暗，每一步都能听见细小的塌陷声。',
        p2: '雾在坡顶忽然薄了。远处那排落叶松站得笔直，针叶已经黄透，风一过就簌簌地掉，落在肩上像有人轻轻拍了一下。',
        p3: '我在半山腰的石头上坐了很久。太阳一点点把雾推下去，谷底的屋顶先露出来，然后是那条被水泡得发白的木桥。',
        p4: '回程时天已经很亮了。同一条路，来时看不清的东西，这会儿全都在了——原来不是路变了，是雾散了。',
        fig1: '配图 1 · 雾压山谷的清晨旧路',
        fig2: '配图 4 · 谷底被水泡得发白的木桥',
        slot: '[插图 2] · 右侧正在生成，出图后自动落进这里',
      },
      summary: { words: '正文 1,284 字', paragraphs: '段落 12', figures: '配图 6', currentStyle: '当前风格' },
      steps: ['上传', '标记', '配图'],
      primaryAction: '生成全部配图',
      configPills: ['自动风格', '风格', '水印开'],
      tools: { generate: '生成', size: '批量尺寸 1024×1024', pack: '打包' },
      streaming: 'AI 正在分析文章并生成配图标记…已识别 6 个位置',
      runningLabel: '生成中 · 12.4s / 预计 ~20s',
      status: { done: '已完成', running: '生成中', idle: '待生成' },
      cards: [
        { size: '1024×1024', prompt: '雾压山谷的清晨旧路，碎石被露水浸暗' },
        { size: '1024×768', prompt: '坡顶雾薄，一排落叶松针叶黄透' },
        { size: '1024×1024', prompt: '半山腰石上远望，谷底屋顶与发白木桥' },
      ],
      cardActions: ['改这句', '重新生成'],
    },
    knowledge: {
      eyebrow: '知识库 · 三栏阅读器',
      title: '划一句话，就能让它改一句话',
      description:
        '左边是文件树，中间是正文，右边是本页章节。选中任意一段，浮层就在选区上方——评论、AI 改写、配图，三件事，就地做完。',
      note: 'AI 改写走流式 + diff 预览，确认才落库、原文不动。下半段是知识星系：根到分类到文档的层级弧线，拱得更高的那几条是文档之间的横向引用。',
      search: '搜索文档…',
      badges: { shared: '已分享', redo: '再加工中', pass: '通过 L1', tag: '规则' },
      tree: [
        { name: '架构规则', time: '今天' },
        { name: '规则 · 验收必须闭环', time: '2h' },
        { name: '规则 · 判据与接线纪律', time: '昨天' },
        { name: '规则 · 跨项目隔离', time: '昨天' },
        { name: '验收报告', time: '3d' },
        { name: '报告 · MD 转 PPT', time: '3d' },
        { name: '报告 · 网关剥离波 2.5', time: '5d' },
        { name: '设计文档', time: '1w' },
        { name: '设计 · 首页重构', time: '1w' },
      ],
      doc: {
        title: '规则 · 验收必须闭环',
        meta: '陈默 更新于 2 小时前 · 1,902 字 · 引用 7',
        p1: '验收的终点是「用户的最终产物可见且正确」，不是「流程走了一半截图收工」。',
        p2before: '任何',
        selected: '流程跑完、产物还没出来就判 pass 的验收，都是断头验收',
        p2after: '，直接不合格。',
        p3: '判定口诀：截图上能看到最终产物吗？不能，就是断头，返工。',
        p4: '等待超时必须基于功能的实际 P95 耗时，不是一个随便写的数字。LLM 生成类最少 300s，图片生成最少 60s。',
      },
      readerTools: ['评论', 'AI 改写', '配图', '分享', '订阅'],
      selectionActions: ['评论', 'AI 改写', '配图'],
      rewrite: {
        status: 'AI 改写 · 流式生成中 3.1s',
        before: '流程跑完、产物还没出来就判 pass 的验收，都是断头验收',
        after: '凡是流程跑完、产物尚未出现即判定通过的验收，均属断头验收',
        replace: '替换原文',
        insert: '插到下方',
        guard: '确认才落库，原文不动',
      },
      tocTitle: '本页章节',
      toc: [
        { label: '什么是断头验收', depth: 0 },
        { label: '强制规则', depth: 0 },
        { label: '产物可见截图', depth: 1 },
        { label: 'timeout 不等于通过', depth: 1 },
        { label: '等待时间必须足够', depth: 1 },
        { label: '对存量报告的影响', depth: 0 },
      ],
      galaxy: {
        hovered: 'rule.doc.readability',
        legendTitle: '类型筛选',
        legend: ['规则', '设计', '报告', '计划'],
        hint: '点任意一颗，右侧就地打开正文',
        stats: '128 篇 · 双链 214 条',
      },
    },
    layers: {
      eyebrow: '三层一体',
      title: '上面三块能成立，是因为下面这三层',
      description: '每一层都是能打开的真实界面，不是三句口号。下面三块画的就是各自那一屏的样子。',
      note: '三层各自独立可用，合在一起才是一条完整的链路：在 MAP 里干活，算力从 LLMGW 调度，做完的东西由 CDS 变成一个能打开的地址。',
      map: {
        role: '工位与团队',
        meta: '/home',
        lead: '十几个智能体在同一个空间接活、共享上下文、互相调用。',
        statusLine: '周五 15:20 · 陈默 · 产品',
        command: '说一句话，或按 ⌘K',
        usage: '近 7 日 128 次',
        frequentLabel: '常去',
        frequent: ['视觉创作', '文学创作', '知识库', '缺陷管理'],
        activeLabel: '在办',
        active: [
          { title: '首页重构 · 等你验收', at: '2h' },
          { title: '缺陷 #1274 · 已修待复测', at: '昨天' },
        ],
      },
      gateway: {
        role: '人事与算力',
        meta: '系统运维',
        lead: '判断网关能否按预期承接流量：谁能用哪个模型、按任务怎么选、坏了换谁。',
        counts: [
          { value: '3', label: '平台' },
          { value: '17', label: '模型' },
          { value: '6', label: '模型池' },
        ],
        gatesLabel: '运行闸门',
        gates: [
          { title: '默认模式已切 http', state: '就绪' },
          { title: '影子比对 diff 率 0.4%', state: '就绪' },
          { title: '17 个模型缺价格', state: '待补' },
        ],
        topology: '容器拓扑（4 个容器）',
      },
      cds: {
        role: '交付与验收',
        meta: '8 分支 · 8 运行',
        lead: '推一个分支就有一个能打开的地址，改坏了回滚到上一版。',
        branches: [
          {
            name: 'claude/homepage-redesign',
            status: '构建中',
            meta1: 'a3f19c2 · 2 分钟前 · prd-admin',
            meta2: '容器 3/4 · 拉取 → 构建 → 启动',
          },
          {
            name: 'main',
            status: '就绪',
            meta1: '7e04b18 · 1 小时前 · 全部 4 端',
            meta2: '容器 4/4 · 双出口 HTTPS',
          },
        ],
        branchActions: ['打开预览', '详情', '回滚'],
        footnote: '预览地址由 CDS 下发，不由前端拼。',
      },
    },
  },
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
  workflow: {
    eyebrow: 'Workflow · 编排',
    title: '把 Agent 串成一条工作流',
    description:
      '工作流引擎把重复的多步骤操作串成可视化节点图：一个触发器、多个 Agent 协作、条件分支、错误回退与定时调度，重复的流程变成一次配置终身受益。',
    chapterMarker: '2.0 Orchestrate →',
    canvasTitle: 'daily-content-pipeline.workflow',
    runLabel: 'Run',
    nodes: [
      { title: '触发器', subtitle: '定时 · 每日 09:00' },
      { title: 'PRD 分析师', subtitle: '读需求' },
      { title: '视觉设计师', subtitle: '出海报' },
      { title: '文学创作者', subtitle: '写文案' },
      { title: '发布', subtitle: '多平台' },
    ],
    status: {
      running: '执行中 · step 3 / 5',
      elapsed: '已用时 · 00:12',
      eta: '预计剩余 · 00:28',
      trace: 'trace · wf-4e9ed6f',
    },
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
      { id: 'visual', name: '视觉创作智能体', description: '文生图 · 图生图 · 多图组合 · 局部重绘' },
      { id: 'literary', name: '文学创作智能体', description: '命题写作 · 段落润色 · 自动配图' },
      { id: 'prd', name: 'PRD 解读智能体', description: '需求缺口识别 · 对话答疑 · AI 预审' },
      { id: 'video', name: '视频创作智能体', description: '文章 → 分镜 → 预览 → 时间线' },
      { id: 'defect', name: '缺陷管理智能体', description: '信息提取 · 严重度分类 · 修复闭环' },
      { id: 'report', name: '周报智能体', description: 'Git 合成 · 计划对比 · 团队汇总' },
      { id: 'arena', name: 'AI 竞技场智能体', description: '多模型盲测 PK · 揭晓真实身份' },
      { id: 'workflow', name: '工作流引擎', description: '可视化编排 · 多步骤串联' },
      { id: 'shortcuts', name: '快捷指令', description: '一键执行 · 自定义 · 可分享' },
      { id: 'review', name: '产品评审智能体', description: '方案多维度打分 · 问题清单' },
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
    action: '打开模型网关控制台',
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
    brand: '米多智能体生态平台',
    github: 'GitHub',
    backToTop: '回到顶部',
    copyright: '© 2026 MAP',
  },
  mockups: {
    visual: {
      header: 'visual-agent · 4 张候选',
      status: '生成中 · 2 / 4 已完成',
    },
    literary: {
      header: 'literary-agent · 润色中',
      progress: '段 3 / 7',
      added: '+ 12 字',
      deleted: '删除 3 字',
      diffView: '差异视图',
    },
    prd: {
      header: 'prd-agent · v3.0 需求分析',
      sections: [
        { title: '§ 用户故事' },
        { title: '§ 核心流程', note: '缺少异常分支' },
        { title: '§ 数据模型' },
        { title: '§ 权限矩阵', note: '未定义角色边界' },
        { title: '§ 测试用例', note: '缺少失败场景' },
      ],
    },
    video: {
      header: 'video-agent · 6 分镜',
      status: '渲染中 · 72%',
    },
    defect: {
      header: 'defect-agent · 3 个待处理',
      items: [
        { sev: 'P0', title: '对话消息在刷新后丢失' },
        { sev: 'P1', title: '图像生成超时未释放' },
        { sev: 'P2', title: '深色模式下描边消失' },
      ],
      assigned: '已分派',
      newThisWeek: '本周新增 · 27',
      fixed: '已修复 · 19',
      fixRate: '修复率 · 70%',
    },
    report: {
      header: 'report-agent · W15',
      plan: '计划',
      actual: '实际',
      days: ['周一', '周二', '周三', '周四', '周五'],
    },
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
    brand: 'MAP · MIDOO AGENTIC PLATFORM',
    title: 'Create, freely.',
    subtitle:
      'MAP (Midoo Agentic Platform) is an enterprise-grade digital workforce platform — upgrading AI from an assistant into a workforce with end-to-end execution, built on deep carbon-silicon symbiosis, human-AI co-governance, shared value creation, and continuous co-evolution.',
    primaryCta: 'Enter MAP',
    secondaryCta: 'Watch Trailer',
    techBarLabel: 'POWERED BY',
    techItems: [
      'GPT-5',
      'Claude 4.6',
      'Gemini 2.5',
      'Grok 4',
      'Llama',
      'DeepSeek V3',
      'Kimi K2',
      'Qwen 3',
      'GLM 4.6',
      'Wenxin',
    ],
  },
  stats: [
    { value: '15+', label: 'Dedicated Agents' },
    { value: '14', label: 'LLM Providers' },
    { value: '98', label: 'Mongo Collections' },
    { value: '99.9%', label: 'Uptime' },
  ],
  scenes: {
    visual: {
      eyebrow: 'Visual agent · canvas and chat on one screen',
      title: 'Tweak, redraw, and another day is gone',
      description:
        'An infinite canvas on the left with your images spread across it; a designer on the right who never leaves. Say a sentence and a new image lands on the canvas; click an image and the action bar floats up.',
      tiles: { a: 'Key visual · draft', b: 'Warm variant', c: 'Foggy version' },
      genRunning: { label: 'HD upscale', status: '4.2s / est. ~6s' },
      genOvertime: { label: 'AI layers', status: 'Almost done · 8.4s' },
      generator: { title: 'Image generator', body: 'Select it and a quick prompt appears on the canvas. Drop reference images in.' },
      actions: ['HD upscale', 'Remove bg', 'Expand', 'Inpaint', 'AI layers', 'Download'],
      gesture: { before: 'Two-finger drag to pan ·', after: '+wheel to zoom · Space to pan · double-click never zooms' },
      chat: {
        title: 'Hi, I am your AI designer',
        subtitle: 'Click any image on the canvas to select it, then use it as the first frame.',
        submit: 'Publish',
        user: 'Make the key visual foggy, keep the ridgeline',
        thinking: 'Thinking · 2.1s',
        reply: 'Only the weather layer changes; the ridgeline path stays. Here is one.',
        landed: 'Foggy version landed on the canvas · nothing covered',
        streaming: 'Want me to split the foreground into its own layer',
        model: 'seedream-4',
        pool: 'Pool vision-default',
        placeholder: 'Describe the image you want, or drop a reference onto the canvas…',
        send: 'Send',
      },
    },
    literary: {
      eyebrow: 'Writing agent · text left, images right',
      title: 'Upload a document; come back to a basket of illustrations',
      description:
        'Your article on the left, drafted paragraph by paragraph. The illustration bench on the right, one image per slot. It reads the whole piece, then fills every slot by paragraph meaning.',
      note: 'Switching style repaints the images only — not one word of the text moves. Style is what the model draws from, not a filter applied afterwards.',
      styleLabel: 'Style',
      styleHint: 'Try it: every illustration recolours, inline ones included. The text stays put.',
      styles: { calm: 'Calm', warm: 'Warm', forest: 'Forest', night: 'Night' },
      fileName: 'autumn-notes.docx',
      model: 'gemini-2.5-flash',
      pool: 'Pool literary-default',
      body: {
        p1: 'On the first morning of October a layer of fog still sat in the valley. I walked up the old path; the gravel underfoot was dark with dew, and each step gave a small collapsing sound.',
        p2: 'The fog thinned suddenly at the crest. The larches stood straight in the distance, needles gone fully yellow, dropping at every gust like a hand on your shoulder.',
        p3: 'I sat a long while on a rock halfway up. The sun pushed the fog down bit by bit: first the valley roofs, then the wooden bridge bleached pale by water.',
        p4: 'It was bright by the time I walked back. Same path — everything I could not see on the way up was simply there. The path had not changed; the fog had lifted.',
        fig1: 'Figure 1 · the old path under valley fog',
        fig2: 'Figure 4 · the water-bleached wooden bridge',
        slot: '[Figure 2] · generating on the right, it will drop in here',
      },
      summary: { words: '1,284 words', paragraphs: '12 paragraphs', figures: '6 figures', currentStyle: 'Style' },
      steps: ['Upload', 'Mark', 'Illustrate'],
      primaryAction: 'Generate every illustration',
      configPills: ['Auto style', 'Style', 'Watermark on'],
      tools: { generate: 'Generate', size: 'Batch 1024×1024', pack: 'Export' },
      streaming: 'Reading the article and marking illustration points… 6 found so far',
      runningLabel: 'Generating · 12.4s / est. ~20s',
      status: { done: 'Done', running: 'Running', idle: 'Queued' },
      cards: [
        { size: '1024×1024', prompt: 'Old path at dawn under valley fog, gravel dark with dew' },
        { size: '1024×768', prompt: 'Thin fog at the crest, a row of larches gone yellow' },
        { size: '1024×1024', prompt: 'From a rock halfway up: valley roofs and the pale bridge' },
      ],
      cardActions: ['Edit prompt', 'Regenerate'],
    },
    knowledge: {
      eyebrow: 'Knowledge base · three-pane reader',
      title: 'Select one sentence, rewrite that one sentence',
      description:
        'File tree on the left, the document in the middle, this page’s outline on the right. Select any passage and the popover appears right above it — comment, AI rewrite, illustrate. Three things, done in place.',
      note: 'The rewrite streams in with a diff preview, and nothing is written until you confirm. Below is the knowledge galaxy: root to category to document, with the higher arcs being cross-references between documents.',
      search: 'Search documents…',
      badges: { shared: 'Shared', redo: 'Reworking', pass: 'Passed L1', tag: 'Rule' },
      tree: [
        { name: 'Architecture rules', time: 'today' },
        { name: 'Rule · acceptance must close the loop', time: '2h' },
        { name: 'Rule · predicate & wiring discipline', time: 'yest.' },
        { name: 'Rule · cross-project isolation', time: 'yest.' },
        { name: 'Acceptance reports', time: '3d' },
        { name: 'Report · Markdown to slides', time: '3d' },
        { name: 'Report · gateway split wave 2.5', time: '5d' },
        { name: 'Design docs', time: '1w' },
        { name: 'Design · homepage rebuild', time: '1w' },
      ],
      doc: {
        title: 'Rule · acceptance must close the loop',
        meta: 'Chen Mo updated 2 hours ago · 1,902 words · 7 references',
        p1: 'Acceptance ends when the user’s final artifact is visible and correct — not when the flow is halfway through and someone takes a screenshot.',
        p2before: 'Any ',
        selected: 'acceptance that passes while the artifact has not appeared yet is a beheaded acceptance',
        p2after: ', and fails outright.',
        p3: 'The test is one question: can you see the finished artifact in the screenshot? If not, it is beheaded. Redo it.',
        p4: 'Timeouts must be based on the feature’s real P95, not a number someone picked. At least 300s for LLM generation, at least 60s for images.',
      },
      readerTools: ['Comment', 'AI rewrite', 'Illustrate', 'Share', 'Subscribe'],
      selectionActions: ['Comment', 'AI rewrite', 'Illustrate'],
      rewrite: {
        status: 'AI rewrite · streaming 3.1s',
        before: 'acceptance that passes while the artifact has not appeared yet is a beheaded acceptance',
        after: 'any acceptance marked as passing before the artifact appears counts as beheaded',
        replace: 'Replace',
        insert: 'Insert below',
        guard: 'Nothing is saved until you confirm',
      },
      tocTitle: 'On this page',
      toc: [
        { label: 'What beheaded acceptance is', depth: 0 },
        { label: 'Hard rules', depth: 0 },
        { label: 'Artifact-visible screenshot', depth: 1 },
        { label: 'Timeout is not a pass', depth: 1 },
        { label: 'Waits must be long enough', depth: 1 },
        { label: 'Effect on existing reports', depth: 0 },
      ],
      galaxy: {
        hovered: 'rule.doc.readability',
        legendTitle: 'Filter by type',
        legend: ['Rule', 'Design', 'Report', 'Plan'],
        hint: 'Click any star to open the document in place',
        stats: '128 docs · 214 backlinks',
      },
    },
    layers: {
      eyebrow: 'Three layers, one system',
      title: 'The three above work because of the three below',
      description: 'Every layer is a real screen you can open, not a slogan. Each card below is a slice of that screen.',
      note: 'Each layer stands on its own; together they are one chain: you work in MAP, LLMGW schedules the compute, and CDS turns what you built into an address you can open.',
      map: {
        role: 'Desk & team',
        meta: '/home',
        lead: 'A dozen agents take work in one space, share context, and call each other.',
        statusLine: 'Fri 15:20 · Chen Mo · Product',
        command: 'Say something, or press ⌘K',
        usage: '128 runs in 7 days',
        frequentLabel: 'Frequent',
        frequent: ['Visual', 'Writing', 'Knowledge', 'Defects'],
        activeLabel: 'In flight',
        active: [
          { title: 'Homepage rebuild · awaiting you', at: '2h' },
          { title: 'Defect #1274 · fixed, needs retest', at: 'yest.' },
        ],
      },
      gateway: {
        role: 'Staffing & compute',
        meta: 'Operations',
        lead: 'Whether the gateway can carry the traffic: who may use which model, how one is picked per task, who takes over when it breaks.',
        counts: [
          { value: '3', label: 'Providers' },
          { value: '17', label: 'Models' },
          { value: '6', label: 'Pools' },
        ],
        gatesLabel: 'Release gates',
        gates: [
          { title: 'Default mode switched to http', state: 'Ready' },
          { title: 'Shadow diff rate 0.4%', state: 'Ready' },
          { title: '17 models missing pricing', state: 'Open' },
        ],
        topology: 'Container topology (4 containers)',
      },
      cds: {
        role: 'Delivery & acceptance',
        meta: '8 branches · 8 running',
        lead: 'Push a branch and you get an address you can open; break something and roll back a version.',
        branches: [
          {
            name: 'claude/homepage-redesign',
            status: 'Building',
            meta1: 'a3f19c2 · 2 min ago · prd-admin',
            meta2: 'Containers 3/4 · pull → build → start',
          },
          {
            name: 'main',
            status: 'Ready',
            meta1: '7e04b18 · 1 hour ago · all 4 apps',
            meta2: 'Containers 4/4 · dual HTTPS exits',
          },
        ],
        branchActions: ['Open preview', 'Details', 'Roll back'],
        footnote: 'Preview URLs come from CDS. The frontend never builds them.',
      },
    },
  },
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
  workflow: {
    eyebrow: 'Workflow · Orchestration',
    title: 'Chain Agents into a workflow',
    description:
      'The Workflow Engine turns repeated multi-step operations into a visual node graph: one trigger, multiple Agents collaborating, conditional branches, error fallbacks, and scheduled runs. Configure once, benefit forever.',
    chapterMarker: '2.0 Orchestrate →',
    canvasTitle: 'daily-content-pipeline.workflow',
    runLabel: 'Run',
    nodes: [
      { title: 'Trigger', subtitle: 'Scheduled · 09:00 daily' },
      { title: 'Spec Analyst', subtitle: 'reads spec' },
      { title: 'Visual Designer', subtitle: 'makes poster' },
      { title: 'Writing Studio', subtitle: 'drafts copy' },
      { title: 'Publish', subtitle: 'multi-channel' },
    ],
    status: {
      running: 'Running · step 3 / 5',
      elapsed: 'Elapsed · 00:12',
      eta: 'ETA · 00:28',
      trace: 'trace · wf-4e9ed6f',
    },
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
    action: 'Open LLM Gateway Console',
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
    brand: 'Midoo Agentic Platform',
    github: 'GitHub',
    backToTop: 'Back to top',
    copyright: '© 2026 MAP',
  },
  mockups: {
    visual: {
      header: 'visual-agent · 4 candidates',
      status: 'Generating · 2 / 4 done',
    },
    literary: {
      header: 'literary-agent · polishing',
      progress: 'Para 3 / 7',
      added: '+12 chars',
      deleted: '-3 chars',
      diffView: 'Diff view',
    },
    prd: {
      header: 'prd-agent · v3.0 spec analysis',
      sections: [
        { title: '§ User Stories' },
        { title: '§ Core Flow', note: 'Missing edge cases' },
        { title: '§ Data Model' },
        { title: '§ Permission Matrix', note: 'Undefined role boundaries' },
        { title: '§ Test Cases', note: 'Missing failure scenarios' },
      ],
    },
    video: {
      header: 'video-agent · 6 shots',
      status: 'Rendering · 72%',
    },
    defect: {
      header: 'defect-agent · 3 open',
      items: [
        { sev: 'P0', title: 'Messages lost on refresh' },
        { sev: 'P1', title: 'Image gen timeout unreleased' },
        { sev: 'P2', title: 'Strokes disappear in dark mode' },
      ],
      assigned: 'Assigned',
      newThisWeek: 'New this week · 27',
      fixed: 'Fixed · 19',
      fixRate: 'Fix rate · 70%',
    },
    report: {
      header: 'report-agent · W15',
      plan: 'Plan',
      actual: 'Actual',
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    },
  },
};

export const translations: Record<Lang, TranslationShape> = { zh, en };
