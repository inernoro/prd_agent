import {
  Timer, Webhook, Hand, Upload, Zap,
  Database, Globe, Brain, Code2, Filter, Merge, Repeat, BarChart3,
  Clock, GitBranch,
  FileText, Download, Send, Bell, Box, AppWindow, GlobeLock, Mail,
  Video, PenTool, Terminal, Image,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// 舱分类
// ═══════════════════════════════════════════════════════════════

export type CapsuleCategory = 'trigger' | 'processor' | 'control' | 'output';

export interface CapsuleCategoryMeta {
  key: CapsuleCategory;
  label: string;
  description: string;
  emoji: string;
}

export const CAPSULE_CATEGORIES: CapsuleCategoryMeta[] = [
  { key: 'trigger', label: '触发', description: '流水线的起点，负责产生触发信号', emoji: '⚡' },
  { key: 'processor', label: '处理', description: '数据采集、分析、转换', emoji: '⚙️' },
  { key: 'control', label: '流程控制', description: '延时、条件分支等流程控制', emoji: '🔀' },
  { key: 'output', label: '输出', description: '结果输出、通知、导出', emoji: '📤' },
];

// ═══════════════════════════════════════════════════════════════
// 舱类型定义
// ═══════════════════════════════════════════════════════════════

export interface CapsuleTypeDef {
  typeKey: string;
  name: string;
  description: string;
  Icon: LucideIcon;
  emoji: string;
  category: CapsuleCategory;
  accentHue: number;
  testable: boolean;
  /** 非空时表示该舱不可用，内容为不可用原因 */
  disabledReason?: string;
}

// ═══════════════════════════════════════════════════════════════
// 舱类型注册表（前端侧，与后端 CapsuleTypeRegistry 对应）
// ═══════════════════════════════════════════════════════════════

export const CAPSULE_TYPE_REGISTRY: Record<string, CapsuleTypeDef> = {
  // ──────── 触发类 ────────
  'timer': {
    typeKey: 'timer',
    name: '定时器',
    description: '按 Cron 表达式定时触发流水线',
    Icon: Timer,
    emoji: '⏰',
    category: 'trigger',
    accentHue: 30,
    testable: false,
    disabledReason: '🚧 需要后端 Cron 调度器支持，开发中',
  },
  'webhook-receiver': {
    typeKey: 'webhook-receiver',
    name: 'Webhook 接收',
    description: '外部系统 POST 触发流水线',
    Icon: Webhook,
    emoji: '🔗',
    category: 'trigger',
    accentHue: 200,
    testable: true,
    disabledReason: '🚧 需要后端 Webhook 接收入口，开发中',
  },
  'manual-trigger': {
    typeKey: 'manual-trigger',
    name: '手动触发',
    description: '点击按钮手动执行，适合调试',
    Icon: Hand,
    emoji: '👆',
    category: 'trigger',
    accentHue: 280,
    testable: false,
  },
  'file-upload': {
    typeKey: 'file-upload',
    name: '文件上传',
    description: '上传文件作为数据源',
    Icon: Upload,
    emoji: '📂',
    category: 'trigger',
    accentHue: 170,
    testable: true,
    disabledReason: '🚧 需要执行时文件选择器支持，开发中',
  },
  'event-trigger': {
    typeKey: 'event-trigger',
    name: '事件触发',
    description: '监听系统事件自动触发流水线',
    Icon: Zap,
    emoji: '⚡',
    category: 'trigger',
    accentHue: 45,
    testable: true,
  },

  // ──────── 处理类 ────────
  'tapd-collector': {
    typeKey: 'tapd-collector',
    name: 'TAPD 数据采集',
    description: '拉取 TAPD Bug、Story 等项目数据',
    Icon: Database,
    emoji: '🐛',
    category: 'processor',
    accentHue: 30,
    testable: true,
  },
  'http-request': {
    typeKey: 'http-request',
    name: 'HTTP 请求',
    description: '发送通用 REST API 请求',
    Icon: Globe,
    emoji: '🌐',
    category: 'processor',
    accentHue: 210,
    testable: true,
  },
  'smart-http': {
    typeKey: 'smart-http',
    name: '智能 HTTP',
    description: '粘贴 cURL，AI 识别分页并拉取全量数据',
    Icon: Globe,
    emoji: '🤖',
    category: 'processor',
    accentHue: 250,
    testable: true,
  },
  'llm-analyzer': {
    typeKey: 'llm-analyzer',
    name: 'LLM 分析',
    description: '大语言模型智能分析与总结',
    Icon: Brain,
    emoji: '🧠',
    category: 'processor',
    accentHue: 270,
    testable: true,
  },
  'script-executor': {
    typeKey: 'script-executor',
    name: '代码脚本',
    description: '运行 JavaScript 脚本处理数据（Jint 沙箱引擎）',
    Icon: Code2,
    emoji: '💻',
    category: 'processor',
    accentHue: 150,
    testable: true,
  },
  'data-extractor': {
    typeKey: 'data-extractor',
    name: '数据提取',
    description: 'JSONPath 表达式提取数据子集',
    Icon: Filter,
    emoji: '🔍',
    category: 'processor',
    accentHue: 180,
    testable: true,
  },
  'data-merger': {
    typeKey: 'data-merger',
    name: '数据合并',
    description: '合并多个上游舱的输出',
    Icon: Merge,
    emoji: '🔀',
    category: 'processor',
    accentHue: 60,
    testable: true,
  },

  'format-converter': {
    typeKey: 'format-converter',
    name: '格式转换',
    description: 'JSON / XML / CSV / YAML 相互转换',
    Icon: Repeat,
    emoji: '🔄',
    category: 'processor',
    accentHue: 45,
    testable: true,
  },
  'data-aggregator': {
    typeKey: 'data-aggregator',
    name: '数据统计',
    description: '对数据进行分组统计，输出结构化摘要',
    Icon: BarChart3,
    emoji: '📊',
    category: 'processor',
    accentHue: 120,
    testable: true,
  },

  // ──────── 短视频工作流类 ────────
  'tiktok-creator-fetch': {
    typeKey: 'tiktok-creator-fetch',
    name: 'TikTok 博主视频列表',
    description: '调用 TikHub API 拉取指定博主最新视频列表，输出标准化条目数组',
    Icon: Video,
    emoji: 'TT',
    category: 'processor',
    accentHue: 340,
    testable: true,
  },
  'homepage-publisher': {
    typeKey: 'homepage-publisher',
    name: '发布到首页快捷卡',
    description: '把上游图片/视频 URL 下载并写入「首页资源」槽位，登录后首页快捷卡 / Agent 封面即时更新',
    Icon: Image,
    emoji: 'HP',
    category: 'output',
    accentHue: 200,
    testable: true,
  },
  'weekly-poster-publisher': {
    typeKey: 'weekly-poster-publisher',
    name: '发布到首页弹窗海报',
    description: '把上游内容（含图片/视频 URL + 文案）作为「周报小报」发布——登录后首页轮播弹窗即时显示',
    Icon: Image,
    emoji: 'WP',
    category: 'output',
    accentHue: 320,
    testable: true,
  },
  'douyin-parser': {
    typeKey: 'douyin-parser',
    name: '短视频解析',
    description: '解析抖音/TikTok 分享链接，提取无水印视频地址和元数据',
    Icon: Video,
    emoji: '🎬',
    category: 'processor',
    accentHue: 350,
    testable: true,
  },
  'video-downloader': {
    typeKey: 'video-downloader',
    name: '视频下载到 COS',
    description: '将视频 URL 下载到 COS 对象存储，返回稳定地址',
    Icon: Download,
    emoji: '📥',
    category: 'processor',
    accentHue: 190,
    testable: true,
  },
  'video-to-text': {
    typeKey: 'video-to-text',
    name: '视频内容转文本',
    description: '将视频标题/描述/字幕提取为结构化文本',
    Icon: FileText,
    emoji: '📝',
    category: 'processor',
    accentHue: 260,
    testable: true,
  },
  'text-to-copywriting': {
    typeKey: 'text-to-copywriting',
    name: '文本转文案',
    description: 'LLM 将视频内容改写为指定风格的营销/分享文案',
    Icon: PenTool,
    emoji: '✍️',
    category: 'processor',
    accentHue: 320,
    testable: true,
  },

  // ──────── CLI Agent 执行器 ────────
  'cli-agent-executor': {
    typeKey: 'cli-agent-executor',
    name: 'CLI Agent 执行器',
    description: '调度 Docker 容器中的 CLI 编码工具生成页面/项目，支持多轮迭代',
    Icon: Terminal,
    emoji: '🐳',
    category: 'processor',
    accentHue: 280,
    testable: true,
  },

  // ──────── 流程控制类 ────────
  'delay': {
    typeKey: 'delay',
    name: '延时',
    description: '等待指定秒数后继续',
    Icon: Clock,
    emoji: '⏳',
    category: 'control',
    accentHue: 200,
    testable: true,
  },
  'condition': {
    typeKey: 'condition',
    name: '条件判断',
    description: '根据条件选择执行分支（if/else）',
    Icon: GitBranch,
    emoji: '🔀',
    category: 'control',
    accentHue: 45,
    testable: true,
  },

  // ──────── 输出类 ────────
  'report-generator': {
    typeKey: 'report-generator',
    name: '报告生成',
    description: '结构数据渲染为可读报告',
    Icon: FileText,
    emoji: '📝',
    category: 'output',
    accentHue: 150,
    testable: true,
  },
  'webpage-generator': {
    typeKey: 'webpage-generator',
    name: '网页报告',
    description: 'LLM 生成精美可下载 HTML 网页',
    Icon: AppWindow,
    emoji: '🌐',
    category: 'output',
    accentHue: 220,
    testable: true,
  },
  'file-exporter': {
    typeKey: 'file-exporter',
    name: '文件导出',
    description: '数据打包为可下载文件',
    Icon: Download,
    emoji: '💾',
    category: 'output',
    accentHue: 100,
    testable: true,
  },
  'webhook-sender': {
    typeKey: 'webhook-sender',
    name: 'Webhook 发送',
    description: '推送数据到外部系统',
    Icon: Send,
    emoji: '📡',
    category: 'output',
    accentHue: 200,
    testable: true,
  },
  'notification-sender': {
    typeKey: 'notification-sender',
    name: '站内通知',
    description: '发送管理后台通知',
    Icon: Bell,
    emoji: '🔔',
    category: 'output',
    accentHue: 340,
    testable: true,
  },
  'site-publisher': {
    typeKey: 'site-publisher',
    name: '站点发布',
    description: '发布 HTML 到网页托管，生成公开链接',
    Icon: GlobeLock,
    emoji: '🌐',
    category: 'output',
    accentHue: 160,
    testable: true,
  },
  'email-sender': {
    typeKey: 'email-sender',
    name: '邮件发送',
    description: '使用系统 SMTP 发送邮件，无需配置邮箱参数',
    Icon: Mail,
    emoji: '📧',
    category: 'output',
    accentHue: 210,
    testable: true,
  },
};

// ──────── 兼容旧 NodeType ────────

const LEGACY_TYPE_MAP: Record<string, string> = {
  'data-collector': 'tapd-collector',
  'llm-code-executor': 'llm-analyzer',
  'renderer': 'report-generator',
};

/** 根据 typeKey 获取舱类型定义（兼容旧类型） */
export function getCapsuleType(typeKey: string): CapsuleTypeDef | undefined {
  return CAPSULE_TYPE_REGISTRY[typeKey]
    ?? CAPSULE_TYPE_REGISTRY[LEGACY_TYPE_MAP[typeKey]];
}

/** 按分类分组的舱类型列表 */
export function getCapsuleTypesByCategory(): Record<CapsuleCategory, CapsuleTypeDef[]> {
  const grouped: Record<CapsuleCategory, CapsuleTypeDef[]> = {
    trigger: [],
    processor: [],
    control: [],
    output: [],
  };
  for (const def of Object.values(CAPSULE_TYPE_REGISTRY)) {
    grouped[def.category].push(def);
  }
  return grouped;
}

/** 全部舱类型（按分类排序：触发 → 处理 → 输出） */
export function getAllCapsuleTypes(): CapsuleTypeDef[] {
  const order: CapsuleCategory[] = ['trigger', 'processor', 'control', 'output'];
  return Object.values(CAPSULE_TYPE_REGISTRY).sort(
    (a, b) => order.indexOf(a.category) - order.indexOf(b.category)
  );
}

// ═══════════════════════════════════════════════════════════════
// 后端 icon 字符串 → Lucide 组件映射（UI 层职责）
// ═══════════════════════════════════════════════════════════════

const ICON_MAP: Record<string, LucideIcon> = {
  'timer': Timer,
  'webhook': Webhook,
  'hand': Hand,
  'upload': Upload,
  'database': Database,
  'globe': Globe,
  'brain': Brain,
  'code': Code2,
  'filter': Filter,
  'merge': Merge,
  'repeat': Repeat,
  'clock': Clock,
  'git-branch': GitBranch,
  'file-text': FileText,
  'download': Download,
  'send': Send,
  'bell': Bell,
  'bar-chart': BarChart3,
  'app-window': AppWindow,
  'globe-lock': GlobeLock,
  'zap': Zap,
  'mail': Mail,
  'video': Video,
  'pen-tool': PenTool,
  'terminal': Terminal,
};

const EMOJI_MAP: Record<string, string> = {
  'timer': '⏰',
  'webhook-receiver': '🔗',
  'manual-trigger': '👆',
  'file-upload': '📂',
  'tapd-collector': '🐛',
  'http-request': '🌐',
  'smart-http': '🤖',
  'llm-analyzer': '🧠',
  'script-executor': '💻',
  'data-extractor': '🔍',
  'data-merger': '🔀',
  'format-converter': '🔄',
  'data-aggregator': '📊',
  'delay': '⏳',
  'condition': '🔀',
  'report-generator': '📝',
  'webpage-generator': '🌐',
  'file-exporter': '💾',
  'webhook-sender': '📡',
  'notification-sender': '🔔',
  'event-trigger': '⚡',
  'site-publisher': '🌐',
  'email-sender': '📧',
  'douyin-parser': '🎬',
  'video-downloader': '📥',
  'video-to-text': '📝',
  'text-to-copywriting': '✍️',
  'cli-agent-executor': '🐳',
};

const CATEGORY_EMOJI: Record<string, string> = {
  'trigger': '⚡',
  'processor': '⚙️',
  'control': '🔀',
  'output': '📤',
};

/** 根据后端 icon 字符串获取 Lucide 图标组件 */
export function getIconForCapsule(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Box;
}

/** 根据 typeKey 获取 emoji */
export function getEmojiForCapsule(typeKey: string): string {
  return EMOJI_MAP[typeKey] || '📦';
}

/** 根据 category 获取 emoji */
export function getCategoryEmoji(category: string): string {
  return CATEGORY_EMOJI[category] || '📦';
}
