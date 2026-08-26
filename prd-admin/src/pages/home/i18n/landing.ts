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
    /** 每一拍的旁白：告诉观众此刻在发生什么 */
    beats: string[];
    mixAction: string;
    tiles: { a: string; b: string; c: string; mix: string };
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
      user2: string;
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
    beats: string[];
    /** 打锚点那一拍的模板，{n} 会被替换成已识别的位置数 */
    marking: string;
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
    beats: string[];
    more: string;
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

/** 尾部四幕的一个 Agent 条目（名字与一句话都取自 toolboxStore 的真实注册表）。 */
export interface RosterItem {
  name: string;
  desc: string;
  /** ICON 注册表里的图标名 */
  icon: string;
  /** 未转正的标记（真实注册表里的 wip） */
  preview?: boolean;
}

/** 工作流舱的四种分类，与 `pages/workflow-agent/capsuleRegistry.tsx` 的 CapsuleCategory 同名。 */
export type CapsuleKind = 'trigger' | 'processor' | 'control' | 'output';

/** 体验地图的一块：面积按 weight 分，颜色按健康。与 ExperienceMapLeaf 的 status 同枚举。 */
export interface VocLeaf {
  label: string;
  weight: number;
  status: 'ok' | 'slow' | 'error';
}

/**
 * 尾部五幕：百宝箱 / 工作流 / 体验地图 / 模型池 / 从这里开始。
 *
 * 每一幕都照一张**真实存在的页面**画缩微版，页面在哪写在各自组件的注释里。
 * 上一版这几幕是「样式对、内容编」——卡片网格、自造的四列表，看着像产品截图
 * 其实系统里没有那个界面。用户的原话是「不够真实，首先得需要我们的真实页面」。
 */
export interface TailTranslation {
  /** 百宝箱，照 `/ai-toolbox`（AiToolboxPage）——权属 tab + 类型 tab + 搜索 + 计数 + 最近使用 + 网格 */
  toolbox: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    /** 权属维度 tab，取自 AiToolboxPage 的 CATEGORY_TABS */
    tabs: string[];
    /** 功能类型 tab，取自同页的 KIND_TABS */
    kindTabs: string[];
    /** 真实 placeholder，与那一页逐字一致 */
    searchPlaceholder: string;
    /** 演到「搜一下」那一拍时，输入框里逐字打出来的词 */
    searchWord: string;
    countSuffix: string;
    recentLabel: string;
    recent: string[];
    emptyHint: string;
    previewTag: string;
    beats: string[];
    groups: Array<{ label: string; items: RosterItem[] }>;
    footer: string;
  };
  /** 工作流画布，照 `/workflow-agent/:id/canvas`——左舱库 + 画布上的舱链 + 执行态 */
  workflow: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    /** 真实模板名，取自 workflowTemplates.ts */
    templateName: string;
    libraryLabel: string;
    /** 舱库四类与真实舱数，取自 capsuleRegistry 的 CAPSULE_CATEGORIES */
    categories: Array<{ label: string; kind: CapsuleKind; count: number }>;
    runLabel: string;
    runningLabel: string;
    doneLabel: string;
    waitingLabel: string;
    runPanelLabel: string;
    /** 执行日志的两条模板，措辞照 ExecutionDetailPanel 里真实打出来的那行 */
    logStart: string;
    logDone: string;
    /** 这条链上的舱，逐个取自那份模板；secs/artifacts 喂给右侧执行日志 */
    nodes: Array<{ name: string; kind: CapsuleKind; detail: string; secs: string; artifacts: number }>;
    beats: string[];
  };
  /** 体验地图，照 `/team-activity` 的体验全景热力图（ExperienceMap 的 squarified treemap） */
  voc: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    windowLabel: string;
    legend: { ok: string; slow: string; error: string };
    /** 分区名取自后端 ModuleLabels，块名取自 SegmentLabels */
    groups: Array<{ label: string; leaves: VocLeaf[] }>;
    painTitle: string;
    pains: Array<{ label: string; metric: string; note: string; status: 'slow' | 'error' }>;
    beats: string[];
  };
  /**
   * CDS —— 这一幕不摆日志、不摆表，只讲一天：早上说一句话，下午能打开看，
   * 中间那段人不在。上一版把真实部署日志十三行全端上来，用户的原话是
   * 「太复杂了，可以抽象一点」——证据不是故事，日志留在部署页就好。
   */
  cds: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    dayLabel: string;
    /** 一天里的五个时刻。两头是人，中间全是机器——这个形状本身就是结论 */
    moments: Array<{ time: string; actor: 'you' | 'it'; text: string }>;
    actorLabels: { you: string; it: string };
    /** 中间那段人不在，横在轨道下面 */
    awayLabel: string;
    previewLabel: string;
    /** 预览地址只给形状不给域名——每个人的 CDS 域名不一样，编一个就是假的 */
    previewShape: string;
    approve: string;
    reject: string;
    /** 一天下来的账：人碰了几次，机器跑了多久 */
    tally: Array<{ label: string; value: string }>;
    footer: string;
    beats: string[];
  };
  /** 模型池，照 LLMGW 控制台的 `/pools` 列表——列名与 ModelPoolsPage 的表头逐字一致 */
  models: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    counts: Array<{ value: string; label: string }>;
    windowText: string;
    countSuffix: string;
    columns: { status: string; pool: string; evidence: string; members: string; success: string; duration: string; requests: string };
    statusLabels: { ok: string; watch: string };
    /** 演出只动第一池：它的第二顺位成员挂掉、第三顺位顶上 */
    pools: Array<{
      name: string;
      type: string;
      evidence: string;
      members: string[];
      success: string;
      successDegraded?: string;
      duration: string;
      requests: string;
      /** 该池是否参与演出（挂人 → 顶上） */
      acting?: boolean;
    }>;
    downTag: string;
    promotedTag: string;
    beats: string[];
  };
  start: {
    eyebrow: string;
    title: string;
    description: string;
    note: string;
    steps: Array<{ title: string; desc: string }>;
    surfaces: Array<{ name: string; desc: string; state: string }>;
  };
  closing: {
    eyebrow: string;
    title: string;
    description: string;
    primary: string;
    secondary: string;
    footnote: string;
  };
}

export interface TranslationShape {
  nav: {
    products: string;
    agents: string;
    workflow: string;
    models: string;
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
  /** 尾部四幕（Agent 全家福 / 模型这一层 / 从这里开始 / 收口） */
  tail: TailTranslation;
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
    workflow: '工作流',
    models: '模型',
    download: '开始',
    docs: '文档',
    login: '登录 / 注册',
  },
  hero: {
    status: 'SYSTEM ONLINE',
    brand: 'MAP · 米多智能体生态平台',
    title: '让创造，自由呼吸',
    // 原文是一百字企业话术（"碳硅共生的深度融合、人机共治、价值共创、共同进化"）。
    // 这种句子放到任何一家公司的首页都成立，等于没说；居中三行排下来也是首屏最难看的一块。
    // 换成这一页接下来真的会演给你看的东西。
    subtitle:
      '三十几个 Agent 在同一个台面上干活，模型调度和交付环境都在下面接着。你说一句话，产物落在画布或文档里，不是聊天记录里。',
    primaryCta: '进入 MAP',
    // 原来是「观看片花」，指向的 #cinema 那一幕早就撤了 —— 一颗点下去什么也不发生的按钮
    secondaryCta: '看它怎么干活',
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
      beats: [
        '空画布 · 只有一张初稿',
        '正在输入…',
        '已发送',
        '模型在想 · 2.1s',
        '正在回话',
        '开始渲染 · 产物就在画布上长出来',
        '雾天版本已落回画布 · 没压住已有图',
        '顺手再出一张暖调变体',
        '点一张图，动作条就浮出来',
        '选中两张 · 混合计算中',
        '混合结果已落回画布',
      ],
      mixAction: '混合计算',
      tiles: { a: '主视觉 · 初稿', b: '暖调变体', c: '雾天版本', mix: '混合结果' },
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
        user2: '把这两张混一下，取雾天的天、暖调的光',
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
      beats: [
        '只有文字 · 还没有一张图',
        '文档已就位',
        'AI 正在通读全文并打配图锚点',
        '一次生成全部配图',
        '配图 1 完成 · 落进正文对应段落',
        '配图 2 完成 · 继续往下落',
        '配图 3 还在跑 · 给的是已耗时与预计',
        '换个风格 · 整列重配，正文一个字不动',
      ],
      marking: 'AI 正在分析文章并生成配图标记…已识别 {n} 个位置',
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
        slot: '[插图 {n}] · 右侧出图后自动落进这里',
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
      beats: [
        '安静地读一篇文档',
        '划中一句话',
        '浮层出现 · 评论 / AI 改写 / 配图',
        '点了 AI 改写',
        '流式生成 · 红绿 diff 当场可比',
        '替换原文 · 确认才落库，浮层退场',
      ],
      more: '更多',
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
        lead: '一条分支就是一整套环境：自己的域名、自己的容器。推上去就有，删掉就没。',
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
  tail: {
    toolbox: {
      eyebrow: '百宝箱 · /ai-toolbox',
      title: '不是六个 Agent，是三十几个，都在同一个台面上',
      description:
        '这就是登录后「百宝箱」那一页：权属、类型、搜索、最近使用，一个不少。名字、一句话、图标都取自同一份注册表——加一个新 Agent，这里自动多一个。',
      note: '带「预览」标的是还没通过完整验收的，摆在这里而不是藏起来：能用到什么程度就说到什么程度。',
      tabs: ['全部', '我的', '别人的', '收藏'],
      kindTabs: ['全部类型', '智能体', '工具'],
      searchPlaceholder: '搜索工具名称、描述或标签...',
      searchWord: '配图',
      countSuffix: '个工具',
      recentLabel: '最近使用',
      recent: ['视觉创作智能体', '周报智能体', 'CDS Agent'],
      emptyHint: '搜「配图」，跟配图相关的都浮上来',
      previewTag: '预览',
      beats: [
        '三十几个 Agent，按干的活分四组',
        '想干什么就搜什么',
        '跟「配图」相关的浮上来，其余淡下去',
        '选一个，直接开工',
      ],
      groups: [
        {
          label: '创作',
          items: [
            { name: '视觉创作智能体', desc: '文生图、图生图、多图组合，画布与对话同屏', icon: 'Palette' },
            { name: '文学创作智能体', desc: '写作、润色，整篇读完按段落语义一次配图', icon: 'PenTool' },
            { name: '视觉分镜台', desc: '一句话拆成电影分镜，关键帧实时生长、逐镜精修', icon: 'Clapperboard', preview: true },
            { name: '视频创作智能体', desc: '文章转视频教程，AI 驱动分镜脚本与预览图', icon: 'Video' },
          ],
        },
        {
          label: '交付',
          items: [
            { name: '缺陷管理智能体', desc: '缺陷提交与跟踪，信息提取、分类、生成报告', icon: 'Bug' },
            { name: 'PR 审查智能体', desc: '用你自己的 GitHub 账号审查任意有权访问的 PR', icon: 'GitPullRequest' },
            { name: '前端搭档智能体', desc: '给后端同事用：接 API、写组件、修报错、看截图现象', icon: 'FolderKanban', preview: true },
            { name: 'CDS Agent', desc: '远程跑 Claude Code / Codex 类沙箱任务，流式对话', icon: 'Terminal' },
          ],
        },
        {
          label: '沉淀',
          items: [
            { name: '知识库', desc: '划词就能让 AI 改一句话，确认才落库', icon: 'BookOpen' },
            { name: '周报智能体', desc: '创建、提交、审阅，AI 生成、团队汇总、计划比对', icon: 'FileBarChart' },
            { name: 'MD 转网页 PPT', desc: '粘一段 Markdown，出一份 reveal.js 网页演示', icon: 'FileText' },
            { name: '转录工作台', desc: '多模型 ASR 转写、时间戳编辑、模板转文案', icon: 'AudioLines' },
          ],
        },
        {
          label: '协同',
          items: [
            { name: '项目管理', desc: '立项、看板、甘特图，AI 自动把需求拆成任务', icon: 'FolderKanban', preview: true },
            { name: '产品管理', desc: '产品到缺陷全链路串联，版本化管理与分级追溯', icon: 'Blocks', preview: true },
            { name: 'AI 竞技场智能体', desc: '多模型盲测对战，匿名 PK 后揭晓真实身份', icon: 'Swords' },
            { name: '毒舌秘书', desc: '把模糊想法转成 MECE 执行清单', icon: 'PaSecretary', preview: true },
          ],
        },
      ],
      footer: '这里列了 16 个，注册表里还有十几个——搜索框比翻页快。',
    },
    workflow: {
      eyebrow: '工作流 · /workflow-agent',
      title: '把这些 Agent 串成一条自己跑的流水线',
      description:
        '画布上一个「舱」就是一步。三十几种舱分触发、处理、流程控制、输出四类，连起来就是一条能定时跑、能被 Webhook 叫醒的流水线。下面这条是模板库里现成的一条。',
      note: '每个舱单独可测：不必跑完整条链，点一下就能只试这一步，拿到真实输入输出再往下接。',
      templateName: 'TAPD 缺陷采集与分析',
      libraryLabel: '舱库',
      categories: [
        { label: '触发', kind: 'trigger', count: 5 },
        { label: '处理', kind: 'processor', count: 19 },
        { label: '流程控制', kind: 'control', count: 2 },
        { label: '输出', kind: 'output', count: 7 },
      ],
      runLabel: '运行',
      runningLabel: '运行中...',
      doneLabel: '完成',
      waitingLabel: '等待',
      runPanelLabel: '本次执行',
      logStart: '开始执行',
      logDone: '完成 ({d})，产出 {n} 个产物',
      nodes: [
        { name: '手动触发', kind: 'trigger', detail: '点一下就跑，也可以换成定时器或 Webhook', secs: '0.1s', artifacts: 1 },
        { name: 'TAPD 数据采集', kind: 'processor', detail: '按项目与时间窗拉缺陷', secs: '4.7s', artifacts: 1 },
        { name: '缺陷统计报告生成', kind: 'processor', detail: 'JS 脚本，确定性统计', secs: '0.3s', artifacts: 1 },
        { name: 'HTML 网页渲染', kind: 'processor', detail: '确定性排版，不让模型画版式', secs: '0.2s', artifacts: 1 },
        { name: '导出 HTML 网页', kind: 'output', detail: '产物落成可分享的文件', secs: '0.6s', artifacts: 1 },
        { name: '完成通知', kind: 'output', detail: '站内通知，带产物直达链接', secs: '0.2s', artifacts: 1 },
      ],
      beats: [
        '一条现成的流水线：六个舱，从触发到通知',
        '点运行 —— 逐舱往下走，每一步的产物喂给下一步',
        '统计与排版都走确定性脚本，模型只在需要判断的那一步进来',
        '跑完了：产物导出、通知发出，全程没人守着',
      ],
    },
    voc: {
      eyebrow: '体验地图 · /team-activity',
      title: '整个系统哪里在被用、哪里在硌人，摊成一张图',
      description:
        '每一块是一个接口，面积是被调用的次数，颜色是健康。绝大多数时候它是一片安静的冷色海；报错和变慢会自己从平静里跳出来，点一下直接下钻到那条痛点。',
      note: '数据来自真实的请求日志，不是埋点问卷——没人填表，图自己就画出来了。',
      windowLabel: '近 7 天 · 共 41.2 万次请求',
      legend: { ok: '正常', slow: '偏慢', error: '报错' },
      groups: [
        {
          label: '视觉创作',
          leaves: [
            { label: '工作区', weight: 30, status: 'ok' },
            { label: '生成', weight: 22, status: 'ok' },
            { label: '附件上传', weight: 14, status: 'slow' },
            { label: '预览', weight: 9, status: 'ok' },
            { label: '收藏', weight: 5, status: 'ok' },
          ],
        },
        {
          label: '知识库',
          leaves: [
            { label: '条目', weight: 20, status: 'ok' },
            { label: '空间', weight: 12, status: 'ok' },
            { label: '行内评论', weight: 7, status: 'ok' },
            { label: '发布', weight: 4, status: 'ok' },
          ],
        },
        {
          label: '缺陷管理',
          leaves: [
            { label: '列表', weight: 16, status: 'ok' },
            { label: '详情', weight: 9, status: 'ok' },
            { label: '批量导出', weight: 6, status: 'error' },
          ],
        },
        {
          label: '周报管理',
          leaves: [
            { label: '本周', weight: 11, status: 'ok' },
            { label: '汇总', weight: 6, status: 'ok' },
          ],
        },
        {
          label: 'LLM 网关',
          leaves: [
            { label: '流式', weight: 13, status: 'ok' },
            { label: '模型池', weight: 5, status: 'ok' },
          ],
        },
      ],
      painTitle: '痛点榜',
      pains: [
        { label: '缺陷管理 · 批量导出', metric: '报错 4.7%', note: '超过 500 条时网关超时，环比突增 3.1 倍', status: 'error' },
        { label: '视觉创作 · 附件上传', metric: 'P95 6.2s', note: '大图直传没走分片，移动端尤其慢', status: 'slow' },
      ],
      beats: [
        '扫一遍：每块一个接口，面积就是它被用了多少',
        '大部分是安静的冷色 —— 这一片没人喊疼',
        '两块跳出来了：一块在报错，一块在变慢',
        '点进去，直接落到痛点榜对应那一行',
      ],
    },
    cds: {
      eyebrow: 'CDS · 分支即环境',
      title: '早上说一句话，下午就能打开看',
      description:
        '每一句话都长成一条自己的分支，而一条分支就是一整套自己的环境：自己的地址、自己的容器、自己的数据。你不用管它建在哪、什么时候回收——说完就有，合并或者丢掉就没。',
      note: '中间那几个小时你不在也没关系。它不需要你盯着，只需要你最后点一下。',
      dayLabel: '同一天',
      moments: [
        { time: '09:12', actor: 'you', text: '说一句话：首页尾部太长，砍掉一半' },
        { time: '10:30', actor: 'it', text: '开一条分支，照着改' },
        { time: '12:40', actor: 'it', text: '改完推上去，环境自己起来' },
        { time: '15:05', actor: 'it', text: '地址就位，自己先跑了一遍' },
        { time: '15:40', actor: 'you', text: '打开看一眼，点「通过」' },
      ],
      actorLabels: { you: '你', it: '它' },
      awayLabel: '这段时间你在忙别的',
      previewLabel: '可以看了',
      previewShape: '<分支>-<项目>.<你自己的域名>',
      approve: '通过',
      reject: '打回',
      tally: [
        { label: '你动手', value: '两次' },
        { label: '它在跑', value: '6 小时' },
        { label: '你要配的', value: '零' },
      ],
      footer: '人类需要做的只有两件事：把想要什么说清楚，以及点一下审核。',
      beats: [
        '早上，你只说了一句话',
        '它开了一条属于这句话的分支，开始改',
        '中午改完推上去 —— 环境跟着分支自己起来了',
        '下午地址就位，它自己先跑过一遍',
        '你打开看一眼，点「通过」。这一天你动了两次手',
      ],
    },
    models: {
      eyebrow: 'LLMGW · /pools',
      title: '一套配置连上所有模型，坏了自动换下一个',
      description:
        '不是一排 logo。网关控制台里真实的那张表：每一行是一个模型池，池里成员按顺位排队，谁挂了后面的自动顶上——业务代码只认池名，看不见这些。',
      note: '池内成员换人由网关决定，跨池代选默认禁止；单个成员坏了只更新它自己的健康，不会把整个目录清空。',
      counts: [
        { value: '3', label: '接入平台' },
        { value: '17', label: '可调用模型' },
        { value: '6', label: '模型池' },
      ],
      windowText: '近 24h',
      countSuffix: '个池',
      columns: {
        status: '状态', pool: '池 / 类型', evidence: '证据', members: '成员顺位',
        success: '成功率', duration: '平均耗时', requests: '请求',
      },
      statusLabels: { ok: '正常', watch: '观察' },
      pools: [
        {
          name: 'chat-default', type: '对话', evidence: '真实请求',
          members: ['Claude 4.6', 'Kimi K2', 'GPT-5'],
          success: '99.4%', successDegraded: '96.1%', duration: '1.1s', requests: '18.3k',
          acting: true,
        },
        { name: 'vision-main', type: '视觉', evidence: '真实请求', members: ['GPT-5', 'Qwen3-VL'], success: '99.8%', duration: '2.3s', requests: '4.1k' },
        { name: 'image-gen', type: '生图', evidence: '真实请求', members: ['Seedream 4', 'FLUX.1'], success: '98.9%', duration: '9.7s', requests: '2.6k' },
        { name: 'intent-fast', type: '意图', evidence: '真实请求', members: ['Qwen3-Turbo', 'DeepSeek V3'], success: '99.9%', duration: '0.4s', requests: '31.7k' },
      ],
      downTag: '已隔离',
      promotedTag: '顶上',
      beats: [
        '六个池，每池成员按顺位排队 —— 第一顺位优先，往后依次兜底',
        'chat-default 的第二顺位挂了：成功率掉到 96.1%，池转「观察」',
        '第三顺位自动顶上，成功率回到 99.4% —— 调用方全程没改一行代码',
      ],
    },
    start: {
      eyebrow: '从这里开始',
      title: '登录，挑一个，说一句话',
      description: '没有安装、没有配置向导、不用先建项目。三步之内你会拿到第一个产物。',
      note: '桌面端与移动端和网页版是同一套账号、同一份数据，换个地方接着干。',
      steps: [
        { title: '登录', desc: '一个账号进整个台面，权限跟着角色走' },
        { title: '挑一个 Agent', desc: '不知道挑哪个就搜你要干的事' },
        { title: '说一句话', desc: '产物落在画布或文档里，不是聊天记录里' },
      ],
      surfaces: [
        { name: '网页', desc: '打开就用，主力形态', state: '可用' },
        { name: '桌面端', desc: 'Tauri 打包，本地文件直连', state: '可用' },
        { name: '移动端', desc: '看进度、审阅、回一句', state: '可用' },
      ],
    },
    closing: {
      eyebrow: '轮到你了',
      title: '先挑一个 Agent，干成一件小事',
      description: '不用整套流程都跑一遍。挑一个离你今天工作最近的，让它替你做完一件事——好不好用，一次就知道。',
      primary: '进入 MAP',
      secondary: '看看有哪些 Agent',
      footnote: '需要私有部署或想聊聊怎么接进你们的流程，也可以直接找我们。',
    },
  },
  footer: {
    brand: '米多智能体生态平台',
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
    workflow: 'Workflows',
    models: 'Models',
    download: 'Start',
    docs: 'Docs',
    login: 'Sign In',
  },
  hero: {
    status: 'SYSTEM ONLINE',
    brand: 'MAP · MIDOO AGENTIC PLATFORM',
    title: 'Create, freely.',
    subtitle:
      'Thirty-odd agents working on one desk, with model routing and delivery environments underneath. Say a sentence — the artifact lands on a canvas or in a document, not in a chat log.',
    primaryCta: 'Enter MAP',
    secondaryCta: 'See it work',
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
      beats: [
        'Empty canvas · one draft only',
        'Typing…',
        'Sent',
        'Thinking · 2.1s',
        'Replying',
        'Rendering · the artifact grows on the canvas itself',
        'Foggy version landed · nothing covered',
        'One warm variant while we are here',
        'Click an image and the action bar floats up',
        'Two selected · blending',
        'Blended result landed on the canvas',
      ],
      mixAction: 'Blend',
      tiles: { a: 'Key visual · draft', b: 'Warm variant', c: 'Foggy version', mix: 'Blended result' },
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
        user2: 'Blend these two — fog from one, light from the other',
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
      beats: [
        'Text only · not one image yet',
        'Document in place',
        'Reading the whole piece and marking illustration points',
        'Generating every illustration at once',
        'Figure 1 done · dropped into its paragraph',
        'Figure 2 done · next one lands',
        'Figure 3 still running · elapsed and estimate, not a fake percentage',
        'Switch style · the column repaints, the text stays put',
      ],
      marking: 'Reading the article and marking illustration points… {n} found so far',
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
        slot: '[Figure {n}] · it will drop in here once the right side finishes',
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
      beats: [
        'Reading a document, quietly',
        'One sentence selected',
        'Popover appears · comment / AI rewrite / illustrate',
        'AI rewrite tapped',
        'Streaming · red-green diff you can compare on the spot',
        'Replaced · saved only on confirm, popovers dismissed',
      ],
      more: 'More',
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
  tail: {
    toolbox: {
      eyebrow: 'Toolbox · /ai-toolbox',
      title: 'Not six agents. Thirty-odd, all on the same desk',
      description:
        'This is the Toolbox page you land on after logging in — ownership tabs, kind tabs, search, count, recents, all of it. Names, one-liners and icons come from the same registry: add an agent and one more appears here.',
      note: 'The ones tagged Preview have not passed full acceptance yet. They sit here rather than being hidden: we say exactly how far each one goes.',
      tabs: ['All', 'Mine', 'Shared', 'Starred'],
      kindTabs: ['All kinds', 'Agents', 'Tools'],
      searchPlaceholder: 'Search by name, description or tag...',
      searchWord: 'illustrate',
      countSuffix: 'tools',
      recentLabel: 'Recent',
      recent: ['Visual agent', 'Weekly report agent', 'CDS agent'],
      emptyHint: 'Search "illustrate" and everything related floats up',
      previewTag: 'Preview',
      beats: [
        'Thirty-odd agents, grouped by the work they do',
        'Search for whatever you need to do',
        'Anything about illustration floats up; the rest fades back',
        'Pick one and start',
      ],
      groups: [
        {
          label: 'Create',
          items: [
            { name: 'Visual agent', desc: 'Text-to-image, image-to-image, composites — canvas and chat on one screen', icon: 'Palette' },
            { name: 'Writing agent', desc: 'Draft and polish, then illustrate every paragraph by meaning', icon: 'PenTool' },
            { name: 'Storyboard bench', desc: 'One sentence becomes film shots; keyframes grow live, refined shot by shot', icon: 'Clapperboard', preview: true },
            { name: 'Video agent', desc: 'Turns an article into a tutorial video with AI-driven shots and previews', icon: 'Video' },
          ],
        },
        {
          label: 'Deliver',
          items: [
            { name: 'Defect agent', desc: 'File and track defects, with extraction, triage and generated reports', icon: 'Bug' },
            { name: 'PR review agent', desc: 'Reviews any PR you can access, using your own GitHub account', icon: 'GitPullRequest' },
            { name: 'Frontend partner', desc: 'For backend folks: wire APIs, write components, fix errors, read screenshots', icon: 'FolderKanban', preview: true },
            { name: 'CDS agent', desc: 'Runs Claude Code / Codex sandbox tasks remotely, streaming', icon: 'Terminal' },
          ],
        },
        {
          label: 'Retain',
          items: [
            { name: 'Knowledge base', desc: 'Select a sentence and let AI rewrite it; saved only on confirm', icon: 'BookOpen' },
            { name: 'Weekly report agent', desc: 'Create, submit, review — AI drafts, the team rolls up, plans compare', icon: 'FileBarChart' },
            { name: 'Markdown to slides', desc: 'Paste Markdown, get a reveal.js deck', icon: 'FileText' },
            { name: 'Transcription bench', desc: 'Multi-model ASR, timestamp editing, templates into copy', icon: 'AudioLines' },
          ],
        },
        {
          label: 'Coordinate',
          items: [
            { name: 'Project management', desc: 'Kickoff, boards, Gantt — AI breaks requirements into tasks', icon: 'FolderKanban', preview: true },
            { name: 'Product management', desc: 'Product to defect end to end, versioned and traceable by tier', icon: 'Blocks', preview: true },
            { name: 'AI arena', desc: 'Blind multi-model duels; identities revealed after the vote', icon: 'Swords' },
            { name: 'Blunt secretary', desc: 'Turns a vague idea into a MECE action list', icon: 'PaSecretary', preview: true },
          ],
        },
      ],
      footer: 'Sixteen shown here; the registry holds a dozen more — search beats paging.',
    },
    workflow: {
      eyebrow: 'Workflows · /workflow-agent',
      title: 'Chain those agents into a pipeline that runs itself',
      description:
        'One "capsule" on the canvas is one step. Thirty-odd capsule types split across trigger, process, control and output — wire them up and you have a pipeline that can run on a timer or wake on a webhook. Below is one straight from the template library.',
      note: 'Every capsule is testable on its own: no need to run the whole chain — fire one step, see its real input and output, then wire the next.',
      templateName: 'TAPD defect collection and analysis',
      libraryLabel: 'Capsules',
      categories: [
        { label: 'Trigger', kind: 'trigger', count: 5 },
        { label: 'Process', kind: 'processor', count: 19 },
        { label: 'Control', kind: 'control', count: 2 },
        { label: 'Output', kind: 'output', count: 7 },
      ],
      runLabel: 'Run',
      runningLabel: 'Running...',
      doneLabel: 'Done',
      waitingLabel: 'Waiting',
      runPanelLabel: 'This run',
      logStart: 'Started',
      logDone: 'Done ({d}), {n} artifact(s)',
      nodes: [
        { name: 'Manual trigger', kind: 'trigger', detail: 'Click to run; swap for a timer or webhook any time', secs: '0.1s', artifacts: 1 },
        { name: 'TAPD collector', kind: 'processor', detail: 'Pulls defects by project and time window', secs: '4.7s', artifacts: 1 },
        { name: 'Defect stats report', kind: 'processor', detail: 'JS script, deterministic aggregation', secs: '0.3s', artifacts: 1 },
        { name: 'HTML render', kind: 'processor', detail: 'Deterministic layout — the model never draws the page', secs: '0.2s', artifacts: 1 },
        { name: 'Export HTML', kind: 'output', detail: 'The artifact becomes a shareable file', secs: '0.6s', artifacts: 1 },
        { name: 'Completion notice', kind: 'output', detail: 'In-app notice with a direct link to the artifact', secs: '0.2s', artifacts: 1 },
      ],
      beats: [
        'One ready-made pipeline: six capsules, trigger to notice',
        'Hit Run — each capsule hands its artifact to the next',
        'Stats and layout are deterministic scripts; the model only enters where judgement is needed',
        'Done: artifact exported, notice sent, nobody watching',
      ],
    },
    voc: {
      eyebrow: 'Experience map · /team-activity',
      title: 'Where the system gets used, and where it hurts — on one map',
      description:
        'Every block is one endpoint, its area is how often it was called, its colour is health. Most of the time this is a quiet cold-coloured sea; errors and slowdowns push themselves out of the calm, and one click drills into that pain point.',
      note: 'This comes from real request logs, not a survey — nobody fills anything in, the map draws itself.',
      windowLabel: 'Last 7 days · 412k requests',
      legend: { ok: 'Healthy', slow: 'Slow', error: 'Errors' },
      groups: [
        {
          label: 'Visual',
          leaves: [
            { label: 'Workspace', weight: 30, status: 'ok' },
            { label: 'Generate', weight: 22, status: 'ok' },
            { label: 'Upload', weight: 14, status: 'slow' },
            { label: 'Preview', weight: 9, status: 'ok' },
            { label: 'Favorites', weight: 5, status: 'ok' },
          ],
        },
        {
          label: 'Knowledge',
          leaves: [
            { label: 'Entries', weight: 20, status: 'ok' },
            { label: 'Spaces', weight: 12, status: 'ok' },
            { label: 'Comments', weight: 7, status: 'ok' },
            { label: 'Publish', weight: 4, status: 'ok' },
          ],
        },
        {
          label: 'Defects',
          leaves: [
            { label: 'List', weight: 16, status: 'ok' },
            { label: 'Detail', weight: 9, status: 'ok' },
            { label: 'Bulk export', weight: 6, status: 'error' },
          ],
        },
        {
          label: 'Weekly',
          leaves: [
            { label: 'This week', weight: 11, status: 'ok' },
            { label: 'Roll-up', weight: 6, status: 'ok' },
          ],
        },
        {
          label: 'Gateway',
          leaves: [
            { label: 'Stream', weight: 13, status: 'ok' },
            { label: 'Pools', weight: 5, status: 'ok' },
          ],
        },
      ],
      painTitle: 'Pain points',
      pains: [
        { label: 'Defects · Bulk export', metric: '4.7% errors', note: 'Gateway times out past 500 rows, 3.1× week over week', status: 'error' },
        { label: 'Visual · Upload', metric: 'P95 6.2s', note: 'Large images skip chunking — worst on mobile', status: 'slow' },
      ],
      beats: [
        'One sweep: each block an endpoint, its area how much it gets used',
        'Most of it is quiet cold colour — nothing hurting over here',
        'Two blocks push out: one throwing errors, one going slow',
        'Click through and you land on that row in the pain list',
      ],
    },
    cds: {
      eyebrow: 'CDS · a branch is an environment',
      title: 'Say it in the morning, open it in the afternoon',
      description:
        'Every request grows its own branch, and a branch is a whole environment: its own URL, its own containers, its own data. You never think about where it lives or when to reclaim it — say the word and it exists, merge or drop it and it is gone.',
      note: 'It does not matter that you were away for those hours. It does not need you watching; it needs you once, at the end.',
      dayLabel: 'One day',
      moments: [
        { time: '09:12', actor: 'you', text: 'One sentence: the homepage tail is too long, cut it in half' },
        { time: '10:30', actor: 'it', text: 'Opens a branch and starts working' },
        { time: '12:40', actor: 'it', text: 'Pushes the change — the environment comes up on its own' },
        { time: '15:05', actor: 'it', text: 'URL is live; it walks through the page itself first' },
        { time: '15:40', actor: 'you', text: 'You take a look and hit Approve' },
      ],
      actorLabels: { you: 'You', it: 'It' },
      awayLabel: 'You were busy with something else',
      previewLabel: 'Ready to look at',
      previewShape: '<branch>-<project>.<your own domain>',
      approve: 'Approve',
      reject: 'Send back',
      tally: [
        { label: 'Your moves', value: 'Two' },
        { label: 'It ran for', value: '6 hours' },
        { label: 'You configured', value: 'Nothing' },
      ],
      footer: 'A human does exactly two things: say clearly what they want, and click approve.',
      beats: [
        'In the morning, you said one sentence',
        'It opened a branch for that sentence and got to work',
        'By noon it pushed — and the environment came up with the branch',
        'By afternoon the URL was live; it had already walked the page itself',
        'You look once and hit Approve. Two moves, all day',
      ],
    },
    models: {
      eyebrow: 'LLMGW · /pools',
      title: 'One config reaches every model, and failover is automatic',
      description:
        'Not a row of logos. This is the real table in the gateway console: one row per model pool, members queued by priority, and whoever is next takes over when one breaks — product code only ever names the pool.',
      note: 'Swapping members inside a pool is the gateway’s call; picking across pools is off by default. One member failing updates only its own health — it never wipes the catalogue.',
      counts: [
        { value: '3', label: 'Providers' },
        { value: '17', label: 'Callable models' },
        { value: '6', label: 'Pools' },
      ],
      windowText: '24h',
      countSuffix: 'pools',
      columns: {
        status: 'State', pool: 'Pool / type', evidence: 'Evidence', members: 'Member order',
        success: 'Success', duration: 'Avg', requests: 'Requests',
      },
      statusLabels: { ok: 'Healthy', watch: 'Watching' },
      pools: [
        {
          name: 'chat-default', type: 'Chat', evidence: 'Real traffic',
          members: ['Claude 4.6', 'Kimi K2', 'GPT-5'],
          success: '99.4%', successDegraded: '96.1%', duration: '1.1s', requests: '18.3k',
          acting: true,
        },
        { name: 'vision-main', type: 'Vision', evidence: 'Real traffic', members: ['GPT-5', 'Qwen3-VL'], success: '99.8%', duration: '2.3s', requests: '4.1k' },
        { name: 'image-gen', type: 'Image', evidence: 'Real traffic', members: ['Seedream 4', 'FLUX.1'], success: '98.9%', duration: '9.7s', requests: '2.6k' },
        { name: 'intent-fast', type: 'Intent', evidence: 'Real traffic', members: ['Qwen3-Turbo', 'DeepSeek V3'], success: '99.9%', duration: '0.4s', requests: '31.7k' },
      ],
      downTag: 'Isolated',
      promotedTag: 'Took over',
      beats: [
        'Six pools, members queued by priority — first choice, then the fallbacks in order',
        'chat-default loses its second: success drops to 96.1%, the pool goes to Watching',
        'The third takes over, success back to 99.4% — callers never changed a line',
      ],
    },
    start: {
      eyebrow: 'Start here',
      title: 'Log in, pick one, say a sentence',
      description: 'No install, no setup wizard, no project to create first. You will have your first artifact within three steps.',
      note: 'Desktop and mobile share the same account and the same data as the web — pick up where you left off.',
      steps: [
        { title: 'Log in', desc: 'One account for the whole desk; permissions follow your role' },
        { title: 'Pick an agent', desc: 'Not sure which? Search for the thing you need done' },
        { title: 'Say a sentence', desc: 'The artifact lands on a canvas or in a document, not in a chat log' },
      ],
      surfaces: [
        { name: 'Web', desc: 'Open and go — the primary surface', state: 'Available' },
        { name: 'Desktop', desc: 'Packaged with Tauri, direct access to local files', state: 'Available' },
        { name: 'Mobile', desc: 'Check progress, review, reply in a line', state: 'Available' },
      ],
    },
    closing: {
      eyebrow: 'Your turn',
      title: 'Pick one agent and finish one small thing',
      description: 'You do not need to run the whole pipeline. Pick whichever agent sits closest to today’s work and let it finish one thing — one round tells you whether this is for you.',
      primary: 'Enter MAP',
      secondary: 'See the agents',
      footnote: 'Want it self-hosted, or want to talk about fitting it into your workflow? Just reach out.',
    },
  },
  footer: {
    brand: 'Midoo Agentic Platform',
    github: 'GitHub',
    backToTop: 'Back to top',
    copyright: '© 2026 MAP',
  },
};

export const translations: Record<Lang, TranslationShape> = { zh, en };
