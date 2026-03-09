import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 100;

/**
 * 使用 dagre 对节点进行自动布局（从上到下）。
 * 优先使用 ReactFlow 测量的实际节点尺寸，确保居中对齐、连线笔直。
 */
export function autoLayoutNodes<T extends Record<string, unknown>>(
  nodes: Node<T>[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
): Node<T>[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 60,
    ranksep: 80,
    marginx: 40,
    marginy: 40,
  });

  // 记录每个节点的实际尺寸（优先用 measured，回退到默认值）
  const dims = new Map<string, { w: number; h: number }>();

  for (const node of nodes) {
    const w = node.measured?.width ?? DEFAULT_WIDTH;
    const h = node.measured?.height ?? DEFAULT_HEIGHT;
    dims.set(node.id, { w, h });
    g.setNode(node.id, { width: w, height: h });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const d = dims.get(node.id)!;
    return {
      ...node,
      position: {
        x: pos.x - d.w / 2,
        y: pos.y - d.h / 2,
      },
    };
  });
}
