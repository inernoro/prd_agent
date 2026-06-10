// 「AI 文档对话」写回预览的纯逻辑：根据写回模式，决定确认弹窗给用户看什么。
//
// 设计目标（呼应 CLAUDE.md「让用户感知改动」）：
//   - replace（破坏性覆盖）→ 逐行 diff，用户看清原文哪几行被改/删/增
//   - append（改了原文件、追加到末尾）→ 展示「将追加的正文」+ 这是末尾追加
//   - new（非破坏，另存为新文档）→ 轻确认：可改标题 + 提示落在同一目录 + 预览正文
//
// 抽成纯函数便于单测，组件只负责渲染。

import { computeLineDiff, diffStats, type DiffLine } from '@/lib/lineDiff';

export type ApplyMode = 'replace' | 'append' | 'new';
export type ApplyPreviewKind = 'diff' | 'append' | 'new';

export interface ApplyPreview {
  kind: ApplyPreviewKind;
  /** replace 模式的逐行 diff */
  diff?: DiffLine[];
  /** append / new 模式要展示的正文 */
  body?: string;
  /** new 模式的默认标题（可被用户编辑） */
  defaultTitle?: string;
  /** 增删行数（diff / append 有意义） */
  stats?: { added: number; removed: number };
}

/** 与后端 ContentReprocessApplyService.BuildOutputTitle 对齐：去扩展名 + 「-AI 再加工.md」。 */
export function buildOutputTitle(srcTitle: string): string {
  const trimmed = (srcTitle ?? '').trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  const safeBase = base.length > 0 ? base : '新文档';
  return `${safeBase}-AI 再加工.md`;
}

export function buildApplyPreview(
  mode: ApplyMode,
  docContent: string,
  aiContent: string,
  srcTitle: string,
): ApplyPreview {
  const ai = (aiContent ?? '').trim();
  if (mode === 'replace') {
    const diff = computeLineDiff(docContent ?? '', ai);
    return { kind: 'diff', diff, stats: diffStats(diff) };
  }
  if (mode === 'append') {
    const addedLines = ai === '' ? 0 : ai.split('\n').length;
    return { kind: 'append', body: ai, stats: { added: addedLines, removed: 0 } };
  }
  return { kind: 'new', body: ai, defaultTitle: buildOutputTitle(srcTitle) };
}

const MODE_META: Record<ApplyMode, { title: string; confirmLabel: string; danger: boolean }> = {
  replace: { title: '确认替换原文', confirmLabel: '确认替换', danger: true },
  append: { title: '确认追加到文末', confirmLabel: '确认追加', danger: false },
  new: { title: '另存为新文档', confirmLabel: '创建新文档', danger: false },
};

export function applyModeMeta(mode: ApplyMode) {
  return MODE_META[mode];
}

// ── Phase 2：目录选择器 ──
// 把扁平 folders（id/title/parentId）拼成「按层级缩进」的有序选项，供「另存到指定目录」下拉用。
export interface FolderNode {
  id: string;
  title: string;
  parentId?: string | null;
}
export interface FolderOption {
  id: string;
  label: string;
  depth: number;
}

export function buildFolderOptions(folders: FolderNode[]): FolderOption[] {
  const byParent = new Map<string | null, FolderNode[]>();
  for (const f of folders) {
    const key = f.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(f);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.title.localeCompare(b.title));

  const out: FolderOption[] = [];
  const seen = new Set<string>();
  const walk = (parentKey: string | null, depth: number) => {
    for (const node of byParent.get(parentKey) ?? []) {
      if (seen.has(node.id)) continue; // 防环
      seen.add(node.id);
      out.push({ id: node.id, label: node.title, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);

  // 父目录不在列表里的「孤儿」文件夹（数据残缺）兜底挂到根，避免选不到
  for (const f of folders) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      out.push({ id: f.id, label: f.title, depth: 0 });
    }
  }
  return out;
}
