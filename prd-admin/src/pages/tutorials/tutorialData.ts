export interface TutorialStep {
  title: string;
  content: string;
}

export interface TutorialFeature {
  title: string;
  description: string;
}

export interface TutorialSubsection {
  title: string;
  content?: string;
  steps?: TutorialStep[];
  features?: TutorialFeature[];
}

export interface TutorialSection {
  id: string;
  title: string;
  intro?: string;
  steps?: TutorialStep[];
  subsections?: TutorialSubsection[];
  features?: TutorialFeature[];
  tips?: { type: 'tip' | 'warning' | 'info'; content: string }[];
  faq?: { q: string; a: string }[];
}

export interface TutorialContent {
  title: string;
  subtitle: string;
  overview: string;
  accentColor: string;
  accentColorEnd: string;
  tryPath?: string;
  sections: TutorialSection[];
}

export const tutorialContents: Record<string, TutorialContent> = {
  'prd-agent': {
    title: 'PRD Agent',
    subtitle: '智能需求文档解读',
    overview: '上传 PRD 文档，AI 自动解读内容、提取关键需求、生成摘要，并支持针对文档内容的智能问答。',
    accentColor: '#3B82F6',
    accentColorEnd: '#6366F1',
    tryPath: '/prd-agent',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        intro: '只需三步即可开始使用 PRD Agent。',
        steps: [
          { title: '创建项目组', content: '在左侧导航栏点击"新建项目组"，输入项目名称。' },
          { title: '上传文档', content: '支持 PDF、Word、Markdown 格式的需求文档。' },
          { title: '开始对话', content: '上传完成后，即可向 AI 提问关于文档的任何问题。' },
        ],
      },
      {
        id: 'features',
        title: '核心功能',
        features: [
          { title: '文档解读', description: 'AI 自动分析文档结构，提取关键需求点和业务规则。' },
          { title: '智能问答', description: '基于文档内容进行精准问答，支持多轮对话。' },
          { title: '内容缺失检测', description: '自动识别需求文档中可能遗漏的关键信息。' },
        ],
      },
    ],
  },
  'visual-agent': {
    title: '视觉创作 Agent',
    subtitle: '专业级 AI 图像生成',
    overview: '通过自然语言描述生成高质量图片，支持多种风格和参数调节。',
    accentColor: '#A855F7',
    accentColorEnd: '#EC4899',
    tryPath: '/visual-agent',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        steps: [
          { title: '进入工作区', content: '从左侧导航栏进入视觉创作工作区。' },
          { title: '输入描述', content: '用自然语言描述你想要生成的图片内容和风格。' },
          { title: '生成图片', content: '点击生成按钮，等待 AI 创作完成。' },
        ],
      },
    ],
  },
  'literary-agent': {
    title: '文学创作 Agent',
    subtitle: '智能配图与文学润色',
    overview: '为文学作品提供 AI 配图和内容润色服务。',
    accentColor: '#F59E0B',
    accentColorEnd: '#F97316',
    tryPath: '/literary-agent',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        steps: [
          { title: '选择模式', content: '选择配图模式或润色模式。' },
          { title: '输入内容', content: '粘贴或输入需要处理的文学内容。' },
          { title: '获取结果', content: 'AI 将根据内容生成配图或润色建议。' },
        ],
      },
    ],
  },
  'defect-agent': {
    title: '缺陷管理 Agent',
    subtitle: 'AI 驱动的缺陷管理',
    overview: '智能缺陷提交、分类、分析和修复建议，提升团队缺陷处理效率。',
    accentColor: '#10B981',
    accentColorEnd: '#14B8A6',
    tryPath: '/defect-agent',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        steps: [
          { title: '创建项目', content: '在缺陷管理中创建项目，配置基本信息。' },
          { title: '提交缺陷', content: '描述缺陷现象，AI 自动分类和分析。' },
          { title: '查看报告', content: 'AI 生成修复建议和分析报告。' },
        ],
      },
    ],
  },
  'video-agent': {
    title: '视频创作 Agent',
    subtitle: '文章一键转视频',
    overview: '将文章内容自动转换为讲解视频，支持自定义风格和配音。',
    accentColor: '#F43F5E',
    accentColorEnd: '#E11D48',
    tryPath: '/video-agent',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        steps: [
          { title: '输入文章', content: '粘贴或上传需要转换的文章内容。' },
          { title: '选择风格', content: '选择视频风格、配音语言等参数。' },
          { title: '生成视频', content: '点击生成，等待视频合成完成后下载。' },
        ],
      },
    ],
  },
  'report-agent': {
    title: '周报管理 Agent',
    subtitle: 'AI 辅助周报生成',
    overview: '基于团队日志和代码提交记录，自动生成结构化周报。',
    accentColor: '#6366F1',
    accentColorEnd: '#818CF8',
    tryPath: '/report-agent',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        steps: [
          { title: '创建团队', content: '设置团队信息和成员。' },
          { title: '配置数据源', content: '关联代码仓库或手动记录日志。' },
          { title: '生成周报', content: 'AI 自动汇总本周工作内容并生成周报。' },
        ],
      },
    ],
  },
  'arena': {
    title: 'AI 竞技场',
    subtitle: '多模型盲测对比',
    overview: '在竞技场中对多个 AI 模型进行盲测对比，找出最适合你的模型。',
    accentColor: '#F59E0B',
    accentColorEnd: '#D97706',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        steps: [
          { title: '选择模式', content: '选择单次对比或批量测试模式。' },
          { title: '输入提示', content: '输入测试提示词，系统自动分配给多个模型。' },
          { title: '投票评选', content: '查看匿名结果，投票选出最优回答。' },
        ],
      },
    ],
  },
  'workflow-agent': {
    title: '工作流引擎',
    subtitle: '可视化流程编排',
    overview: '通过拖拽方式创建自动化工作流，连接多个 AI Agent 和工具。',
    accentColor: '#14B8A6',
    accentColorEnd: '#0D9488',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        steps: [
          { title: '创建工作流', content: '点击新建工作流，进入可视化编辑器。' },
          { title: '添加节点', content: '从节点库中拖拽 AI 节点、工具节点到画布。' },
          { title: '连接与运行', content: '用连线连接节点，配置参数后运行工作流。' },
        ],
      },
    ],
  },
  'shortcuts-agent': {
    title: '快捷指令',
    subtitle: 'iOS 一键调用 AI',
    overview: '通过 iOS 快捷指令一键调用平台 AI 能力，随时随地使用。',
    accentColor: '#F59E0B',
    accentColorEnd: '#EAB308',
    sections: [
      {
        id: 'getting-started',
        title: '快速开始',
        steps: [
          { title: '获取指令', content: '从教程页面下载快捷指令到 iOS 设备。' },
          { title: '配置密钥', content: '输入你的 API 密钥完成授权。' },
          { title: '开始使用', content: '通过 Siri 或快捷指令 App 一键调用。' },
        ],
      },
    ],
  },
};
