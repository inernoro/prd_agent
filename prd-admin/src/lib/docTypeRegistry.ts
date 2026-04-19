/**
 * 文档类型注册表
 *
 * 知识库中的 Markdown 文件遵循 `<type>.<desc>.md` 命名约定（详见 `.claude/rules/doc-types.md`）。
 * 本文件把 6 种类型统一到一处，提供：
 * - `extractDocType(title)`：从文件名/标题前缀识别类型
 * - `DOC_TYPE_REGISTRY`：类型 → { label, color, bg }
 * - `getDocTypeMeta(type)`：取配色元数据
 *
 * 用途：列表里作为"类型徽标"附在标题后（无论是文件名模式还是正文标题模式），
 * 保持类型信息在视觉上的一致暴露。参考 `.claude/rules/frontend-architecture.md` 的注册表模式规则。
 */

export type DocType = 'spec' | 'design' | 'plan' | 'rule' | 'guide' | 'report';

export interface DocTypeMeta {
  /** 中文标签，例如 "设计" "规则" */
  label: string;
  /** 前景色 */
  color: string;
  /** 背景色（半透明） */
  bg: string;
  /** 边框色 */
  border: string;
}

export const DOC_TYPE_REGISTRY: Record<DocType, DocTypeMeta> = {
  spec: {
    label: '规格',
    color: '#86efac',
    bg: 'rgba(34, 197, 94, 0.10)',
    border: 'rgba(34, 197, 94, 0.30)',
  },
  design: {
    label: '设计',
    color: '#c4b5fd',
    bg: 'rgba(139, 92, 246, 0.10)',
    border: 'rgba(139, 92, 246, 0.30)',
  },
  plan: {
    label: '计划',
    color: '#fcd34d',
    bg: 'rgba(251, 191, 36, 0.10)',
    border: 'rgba(251, 191, 36, 0.30)',
  },
  rule: {
    label: '规则',
    color: '#f0abfc',
    bg: 'rgba(232, 121, 249, 0.10)',
    border: 'rgba(232, 121, 249, 0.30)',
  },
  guide: {
    label: '指南',
    color: '#67e8f9',
    bg: 'rgba(6, 182, 212, 0.10)',
    border: 'rgba(6, 182, 212, 0.30)',
  },
  report: {
    label: '报告',
    color: '#fdba74',
    bg: 'rgba(251, 146, 60, 0.10)',
    border: 'rgba(251, 146, 60, 0.30)',
  },
};

const TYPE_PATTERN = /^(spec|design|plan|rule|guide|report)\b/i;

/**
 * 从文件名或标题中识别文档类型。
 * 支持:
 * - `design.cds-deploy-pipeline.md` → "design"
 * - `rule-xxx.md` → null（要求 `.` 或 `-` 后紧跟内容才算 prefix，这里只识别 `.`）
 * - `design·xxx` → "design"（兼容中文中点）
 * 返回 null 表示未识别到类型。
 */
export function extractDocType(title: string | undefined | null): DocType | null {
  if (!title) return null;
  const trimmed = title.trim();
  const match = TYPE_PATTERN.exec(trimmed);
  if (!match) return null;
  const key = match[1].toLowerCase() as DocType;
  return DOC_TYPE_REGISTRY[key] ? key : null;
}

export function getDocTypeMeta(type: DocType | null): DocTypeMeta | null {
  return type ? DOC_TYPE_REGISTRY[type] : null;
}
