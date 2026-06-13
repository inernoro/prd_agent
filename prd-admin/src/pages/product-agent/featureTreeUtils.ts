import type { Feature } from './types';

export interface FeatureTreeNode {
  feature: Feature;
  children: FeatureTreeNode[];
}

/** 规范化目录路径分隔符（支持 /、\\、>） */
export function normalizeFeaturePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\s*>\s*/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

export function parseFeaturePathSegments(path: string): string[] {
  const normalized = normalizeFeaturePath(path);
  return normalized ? normalized.split('/') : [];
}

/** 由 parentId 构建森林（多根） */
export function buildFeatureTree(features: Feature[]): FeatureTreeNode[] {
  const ids = new Set(features.map((f) => f.id));
  const byParent = new Map<string, Feature[]>();
  for (const f of features) {
    const pid = f.parentId && ids.has(f.parentId) ? f.parentId : '__root__';
    const list = byParent.get(pid) ?? [];
    list.push(f);
    byParent.set(pid, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }
  const walk = (pid: string): FeatureTreeNode[] =>
    (byParent.get(pid) ?? []).map((feature) => ({
      feature,
      children: walk(feature.id),
    }));
  return walk('__root__');
}

const childrenMap = (features: Feature[]) => {
  const map = new Map<string, string[]>();
  for (const f of features) {
    if (!f.parentId) continue;
    const list = map.get(f.parentId) ?? [];
    list.push(f.id);
    map.set(f.parentId, list);
  }
  return map;
};

/** 收集某节点下所有后代 id（不含自身）；rootId=null 表示全量 */
export function collectDescendantIds(features: Feature[], rootId: string | null): Set<string> {
  if (rootId === null) return new Set(features.map((f) => f.id));
  const ch = childrenMap(features);
  const out = new Set<string>();
  const stack = [...(ch.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(ch.get(id) ?? []));
  }
  return out;
}

/** 收集某节点子树全部 id（含自身） */
export function collectSubtreeIds(features: Feature[], rootId: string | null): Set<string> {
  if (rootId === null) return new Set(features.map((f) => f.id));
  const desc = collectDescendantIds(features, rootId);
  desc.add(rootId);
  return desc;
}

export function featurePathLabel(features: Feature[], id: string): string {
  const byId = new Map(features.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur: Feature | undefined = byId.get(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.title);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}

export function countDescendants(node: FeatureTreeNode): number {
  let n = node.children.length;
  for (const c of node.children) n += countDescendants(c);
  return n;
}

/** 默认展开前 N 级：展开有子节点的祖先直至可见层级达到 maxVisibleLevels */
export interface CatalogModuleOption {
  featureId: string;
  title: string;
  path: string;
  hasChildren: boolean;
  moduleName: string;
}

export function findTreeNode(nodes: FeatureTreeNode[], id: string): FeatureTreeNode | null {
  for (const node of nodes) {
    if (node.feature.id === id) return node;
    const found = findTreeNode(node.children, id);
    if (found) return found;
  }
  return null;
}

/** 取某父节点下的直接子节点；parentId=null 为根级 */
export function getTreeChildren(nodes: FeatureTreeNode[], parentId: string | null): FeatureTreeNode[] {
  if (!parentId) return nodes;
  return findTreeNode(nodes, parentId)?.children ?? [];
}

export function flattenCatalogModuleOptions(tree: FeatureTreeNode[], features: Feature[]): CatalogModuleOption[] {
  const out: CatalogModuleOption[] = [];
  const walk = (nodes: FeatureTreeNode[]) => {
    for (const node of nodes) {
      out.push({
        featureId: node.feature.id,
        title: node.feature.title,
        path: featurePathLabel(features, node.feature.id),
        hasChildren: node.children.length > 0,
        moduleName: node.feature.moduleName?.trim() ?? '',
      });
      walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/** 将已保存的模块值解析为目录节点（兼容路径、标题、模块名） */
export function resolveCatalogModuleValue(
  features: Feature[],
  tree: FeatureTreeNode[],
  value: string,
): CatalogModuleOption | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const flat = flattenCatalogModuleOptions(tree, features);
  const norm = (s: string) => normalizeFeaturePath(s).toLowerCase();
  const target = norm(trimmed);
  return (
    flat.find((o) => norm(o.path) === target)
    ?? flat.find((o) => o.title === trimmed)
    ?? flat.find((o) => o.moduleName === trimmed)
    ?? flat.find((o) => norm(o.path).endsWith(`/${target}`) || norm(o.path).includes(target))
    ?? null
  );
}

export function collectDefaultExpandedIds(tree: FeatureTreeNode[], maxVisibleLevels = 3): Set<string> {
  const out = new Set<string>();
  const maxExpandDepth = Math.max(0, maxVisibleLevels - 1);
  const walk = (nodes: FeatureTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.children.length > 0 && depth < maxExpandDepth) {
        out.add(node.feature.id);
        walk(node.children, depth + 1);
      }
    }
  };
  walk(tree, 0);
  return out;
}
