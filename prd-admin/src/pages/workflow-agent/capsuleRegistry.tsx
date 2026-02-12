import {
  Timer, Webhook, Hand, Upload,
  Database, Globe, Brain, Code2, Filter, Merge,
  FileText, Download, Send, Bell,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// 舱分类
// ═══════════════════════════════════════════════════════════════

export type CapsuleCategory = 'trigger' | 'processor' | 'output';

export interface CapsuleCategoryMeta {
  key: CapsuleCategory;
  label: string;
  description: string;
  emoji: string;
}

export const CAPSULE_CATEGORIES: CapsuleCategoryMeta[] = [
  { key: 'trigger', label: '触发', description: '流水线的起点，负责产生触发信号', emoji: '⚡' },
  { key: 'processor', label: '处理', description: '数据采集、分析、转换', emoji: '⚙️' },
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
    description: '运行 JavaScript / Python 脚本',
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
    output: [],
  };
  for (const def of Object.values(CAPSULE_TYPE_REGISTRY)) {
    grouped[def.category].push(def);
  }
  return grouped;
}

/** 全部舱类型（按分类排序：触发 → 处理 → 输出） */
export function getAllCapsuleTypes(): CapsuleTypeDef[] {
  const order: CapsuleCategory[] = ['trigger', 'processor', 'output'];
  return Object.values(CAPSULE_TYPE_REGISTRY).sort(
    (a, b) => order.indexOf(a.category) - order.indexOf(b.category)
  );
}
