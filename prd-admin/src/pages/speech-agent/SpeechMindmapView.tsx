import { useMemo } from 'react';
import type { SpeechNode } from '@/services/contracts/speechAgent';

interface Props {
  nodes: SpeechNode[];
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
}

/**
 * 思维导图视图（MVP 版）—— 列式分层（root | depth-1 | depth-2 | …）
 * 简单清晰，能在 30s 内看清整棵树的层次。
 * Phase 2 升级为 ReactFlow 画布（手势按 .claude/rules/gesture-unification.md 标准 B）。
 */
export function SpeechMindmapView({ nodes, selectedNodeId, onSelect }: Props) {
  const { columns, childrenOf } = useMemo(() => buildLayout(nodes), [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-white/45 text-sm">
        节点会在生成过程中陆续出现……
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto" style={{ overscrollBehavior: 'contain' }}>
      <div className="flex gap-6 px-6 py-5 min-w-max">
        {columns.map((column, colIdx) => (
          <div key={colIdx} className="flex flex-col gap-3 min-w-[240px] max-w-[280px]">
            <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1 px-1">
              {colIdx === 0 ? '主题' : `Level ${colIdx}`}
            </div>
            {column.map((n) => {
              const expanded = (childrenOf.get(n.id)?.length ?? 0) > 0;
              const isSelected = n.id === selectedNodeId;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className={`text-left rounded-xl border px-3.5 py-3 transition-all ${
                    isSelected
                      ? 'bg-violet-500/15 border-violet-400/60 shadow-lg shadow-violet-500/20'
                      : 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08] hover:border-white/20'
                  }`}
                >
                  <div className="text-sm font-medium text-white/90 mb-1.5 leading-snug">
                    {n.title}
                  </div>
                  {n.bulletPoints.length > 0 && (
                    <ul className="space-y-1">
                      {n.bulletPoints.slice(0, 3).map((bp, i) => (
                        <li key={i} className="text-xs text-white/55 leading-relaxed pl-2 relative">
                          <span className="absolute left-0 top-1.5 w-1 h-1 rounded-full bg-white/30" />
                          {bp}
                        </li>
                      ))}
                      {n.bulletPoints.length > 3 && (
                        <li className="text-xs text-white/35 pl-2">…还有 {n.bulletPoints.length - 3} 条</li>
                      )}
                    </ul>
                  )}
                  {expanded && (
                    <div className="mt-2 text-[10px] text-violet-300/70">
                      {childrenOf.get(n.id)?.length} 个子节点
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function buildLayout(nodes: SpeechNode[]) {
  const sorted = [...nodes].sort((a, b) => a.depth - b.depth || a.order - b.order);
  const maxDepth = sorted.reduce((m, n) => Math.max(m, n.depth), 0);
  const columns: SpeechNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  const childrenOf = new Map<string, SpeechNode[]>();
  for (const n of sorted) {
    columns[n.depth].push(n);
    if (n.parentId) {
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n);
      childrenOf.set(n.parentId, arr);
    }
  }
  return { columns, childrenOf };
}
