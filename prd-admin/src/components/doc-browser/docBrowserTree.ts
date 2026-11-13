import type { DocBrowserEntry } from './DocBrowser';

/** 只生成展示关系，不回写存量数据。坏关系回到根级，保证仍可浏览。 */
export function buildDocBrowserTree<T extends DocBrowserEntry>(entries: T[]) {
  const byId = new Map(entries.map(e => [e.id, e]));
  const parents = new Map<string, string>();
  const containers = new Set(entries.filter(e => e.isFolder || e.sourceType === 'github_directory').map(e => e.id));
  for (const entry of entries) {
    const parent = entry.parentId || entry.metadata?.github_parent_id;
    if (parent && parent !== entry.id && byId.has(parent) && containers.has(parent)) parents.set(entry.id, parent);
  }
  // 每个节点最多走一次；循环中以 ID 最小者断开，输入顺序不改变归属。
  const visited = new Set<string>();
  for (const entry of entries) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let id: string | undefined = entry.id;
    while (id && !visited.has(id)) {
      const at = positions.get(id);
      if (at !== undefined) {
        parents.delete(path.slice(at).sort()[0]);
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = parents.get(id);
    }
    for (const member of path) visited.add(member);
  }
  const rootEntries: T[] = [];
  const childrenMap = new Map<string, T[]>();
  for (const entry of entries) {
    const parentId = parents.get(entry.id);
    const display = { ...entry, parentId, isFolder: containers.has(entry.id) };
    if (!parentId) rootEntries.push(display);
    else {
      const children = childrenMap.get(parentId) ?? [];
      children.push(display);
      childrenMap.set(parentId, children);
    }
  }
  return { rootEntries, childrenMap, parentIds: parents };
}
