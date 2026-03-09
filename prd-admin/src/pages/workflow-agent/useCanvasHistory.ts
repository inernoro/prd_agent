import { useCallback, useRef } from 'react';
import type { Node, Edge } from '@xyflow/react';

interface Snapshot<T extends Record<string, unknown> = Record<string, unknown>> {
  nodes: Node<T>[];
  edges: Edge[];
}

const MAX_HISTORY = 50;

/**
 * 深拷贝，自动剥离函数等不可序列化属性（structuredClone 无法克隆函数）。
 * 使用 JSON 往返实现，性能足够满足画布快照场景。
 */
function safeClone<V>(value: V): V {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 画布历史管理 hook — 支持 undo/redo。
 *
 * 用法：
 *   const history = useCanvasHistory<MyNodeData>();
 *   // 每次变更后：history.push(nodes, edges)
 *   // 撤销：const snap = history.undo()
 *   // 重做：const snap = history.redo()
 */
export function useCanvasHistory<T extends Record<string, unknown> = Record<string, unknown>>() {
  const pastRef = useRef<Snapshot<T>[]>([]);
  const futureRef = useRef<Snapshot<T>[]>([]);
  const currentRef = useRef<Snapshot<T> | null>(null);

  /** 推入一个新快照（任何 nodes/edges 变更后调用） */
  const push = useCallback((nodes: Node<T>[], edges: Edge[]) => {
    if (currentRef.current) {
      pastRef.current = [...pastRef.current, currentRef.current].slice(-MAX_HISTORY);
    }
    currentRef.current = { nodes: safeClone(nodes), edges: safeClone(edges) };
    futureRef.current = []; // 新操作清空 redo 栈
  }, []);

  /** 撤销：返回上一个快照 */
  const undo = useCallback((): Snapshot<T> | null => {
    if (pastRef.current.length === 0) return null;
    const prev = pastRef.current[pastRef.current.length - 1];
    pastRef.current = pastRef.current.slice(0, -1);
    if (currentRef.current) {
      futureRef.current = [currentRef.current, ...futureRef.current];
    }
    currentRef.current = prev;
    return safeClone(prev);
  }, []);

  /** 重做：返回下一个快照 */
  const redo = useCallback((): Snapshot<T> | null => {
    if (futureRef.current.length === 0) return null;
    const next = futureRef.current[0];
    futureRef.current = futureRef.current.slice(1);
    if (currentRef.current) {
      pastRef.current = [...pastRef.current, currentRef.current];
    }
    currentRef.current = next;
    return safeClone(next);
  }, []);

  const canUndo = useCallback(() => pastRef.current.length > 0, []);
  const canRedo = useCallback(() => futureRef.current.length > 0, []);

  return { push, undo, redo, canUndo, canRedo };
}
