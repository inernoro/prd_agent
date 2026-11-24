import { useEffect, useState } from 'react';
import { listSelectionRewriteActions, type SelectionRewriteActionItem } from '@/services/real/documentStore';

// 划词改写的动作清单是后端 SSOT（GET selection-rewrite/actions），
// 前端只做一次模块级缓存。两个入口（就地改写提示条 / 兜底浮层）共用这一份，
// 避免两处各自缓存又各自拉取（frontend-architecture.md：一个概念一个数据源）。
let cachedActions: SelectionRewriteActionItem[] | null = null;
let inflight: Promise<SelectionRewriteActionItem[]> | null = null;

async function loadActions(): Promise<SelectionRewriteActionItem[]> {
  if (cachedActions) return cachedActions;
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await listSelectionRewriteActions();
        if (res.success) {
          cachedActions = res.data.items;
          return cachedActions;
        }
        return [];
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

/** 快捷改写动作（润色/精简/扩写…）。拉不到就返回空数组，调用方退化为纯自定义指令。 */
export function useSelectionRewriteActions(): SelectionRewriteActionItem[] {
  const [actions, setActions] = useState<SelectionRewriteActionItem[]>(cachedActions ?? []);
  useEffect(() => {
    if (cachedActions) return;
    let alive = true;
    void loadActions().then((items) => { if (alive) setActions(items); });
    return () => { alive = false; };
  }, []);
  return actions;
}
