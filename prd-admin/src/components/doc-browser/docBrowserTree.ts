type TreeEntry = { id: string; parentId?: string | null; isFolder?: boolean; sourceType?: string };

/** 保留原记录，只在展示树上提升缺失父节点和环的一条边，确保每个条目恰好可达一次。 */
export function buildDocBrowserTree<T extends TreeEntry>(entries: T[]) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const parents = new Map<string, string>();
  for (const entry of byId.values()) {
    const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    if (parent && parent.id !== entry.id && (parent.isFolder !== false || parent.sourceType === 'github_directory'))
      parents.set(entry.id, parent.id);
  }
  const finished = new Set<string>();
  for (const id of byId.keys()) {
    const path = new Set<string>();
    let current: string | undefined = id;
    while (current && !finished.has(current)) {
      if (path.has(current)) { parents.delete(current); break; }
      path.add(current);
      current = parents.get(current);
    }
    for (const visited of path) finished.add(visited);
  }
  const roots: T[] = [];
  const childrenMap = new Map<string, T[]>();
  for (const entry of byId.values()) {
    const parent = parents.get(entry.id);
    if (!parent) roots.push(entry);
    else {
      const siblings = childrenMap.get(parent) ?? [];
      siblings.push(entry);
      childrenMap.set(parent, siblings);
    }
  }
  return { roots, childrenMap, parents };
}
