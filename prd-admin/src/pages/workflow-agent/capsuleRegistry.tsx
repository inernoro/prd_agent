import {
  Timer, Webhook, Hand, Upload,
  Database, Globe, Brain, Code2, Filter, Merge, Repeat, BarChart3,
  Clock, GitBranch,
  FileText, Download, Send, Bell, Box, AppWindow,
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
