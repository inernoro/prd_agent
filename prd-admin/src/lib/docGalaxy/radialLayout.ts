/**
 * 放射状层级树 2D 布局(星系「折叠 2D」的目标形态)。
 *
 * root 居中,子层按 depth 落到同心环上;每个分支按「子树叶子数」占据一段角度扇区,
 * 节点放在自己扇区的中线角上 —— 球形星系铺平成圆盘,层级方向感与相邻关系都保留。
 * 环半径自适应:既保证环间距下限,又保证该环节点的平均弧距不小于下限(364 叶大库外环自动变大)。
 *
 * 纯函数、不依赖 three.js,供 DocumentGalaxyView 折叠动画消费,可单测。
 */

export interface RadialTreeNode {
  id: string;
  kind: string; // 'root' | 'group' | 'leaf'
  children: RadialTreeNode[];
}

export interface RadialLayoutResult {
  /** 节点 id → XY 平面坐标(root 恒 (0,0)) */
  pos2dById: Map<string, { x: number; y: number }>;
  /** 最外环半径(相机取景距离按它自适应) */
  maxRadius: number;
}

/** 环间距下限:第一环留大一点给 root 呼吸,往外逐环收敛(收紧后图盘更满,相机不用退太远) */
function ringGap(depth: number): number {
  return depth === 1 ? 170 : 130;
}

/** 同环相邻节点的最小弧距:枢纽环稀(标签大),叶子环密 */
function minArc(depth: number): number {
  return depth === 1 ? 70 : 18;
}

export function layoutRadial2D(root: RadialTreeNode): RadialLayoutResult {
  const pos2dById = new Map<string, { x: number; y: number }>();
  pos2dById.set(root.id, { x: 0, y: 0 });

  // 1) 叶子权重:leaf=1;分组 = 子树叶子数(空分组下限 1,防零宽扇区)
  const weightById = new Map<string, number>();
  const weight = (n: RadialTreeNode): number => {
    const cached = weightById.get(n.id);
    if (cached !== undefined) return cached;
    const w = n.kind === 'leaf' ? 1 : Math.max(1, n.children.reduce((s, c) => s + weight(c), 0));
    weightById.set(n.id, w);
    return w;
  };
  weight(root);

  // 2) 各 depth 节点数(root=0 不占环)
  const countByDepth = new Map<number, number>();
  let maxDepth = 0;
  const countWalk = (n: RadialTreeNode, depth: number) => {
    if (depth > 0) countByDepth.set(depth, (countByDepth.get(depth) ?? 0) + 1);
    maxDepth = Math.max(maxDepth, depth);
    for (const c of n.children) countWalk(c, depth + 1);
  };
  countWalk(root, 0);

  // 3) 环半径:R[d] = max(R[d-1] + ringGap, 该环节点平均弧距 >= minArc 所需半径)
  const radii: number[] = [0];
  for (let d = 1; d <= maxDepth; d++) {
    const count = countByDepth.get(d) ?? 0;
    const byGap = radii[d - 1] + ringGap(d);
    const byArc = (count * minArc(d)) / (2 * Math.PI);
    radii.push(Math.max(byGap, byArc));
  }

  // 4) 递归扇区分配:每个分支按子树叶子数占角度,节点放扇区中线角 x R[depth]
  const assign = (n: RadialTreeNode, a0: number, a1: number, depth: number) => {
    if (depth > 0) {
      const ang = (a0 + a1) / 2;
      const r = radii[Math.min(depth, radii.length - 1)];
      pos2dById.set(n.id, { x: Math.cos(ang) * r, y: Math.sin(ang) * r });
    }
    if (!n.children.length) return;
    const totalW = n.children.reduce((s, c) => s + (weightById.get(c.id) ?? 1), 0);
    let acc = a0;
    for (const c of n.children) {
      const span = totalW > 0 ? ((a1 - a0) * (weightById.get(c.id) ?? 1)) / totalW : 0;
      assign(c, acc, acc + span, depth + 1);
      acc += span;
    }
  };
  // 12 点方向起始,顺时针铺满一圈
  assign(root, -Math.PI / 2, Math.PI * 1.5, 0);

  return { pos2dById, maxRadius: radii[radii.length - 1] ?? 0 };
}
