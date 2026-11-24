import type { GitHubDirectoryNode, GitHubDirectoryScan } from '@/services/real/githubConnect';

/**
 * GitHub 同步向导「勾目录」这一步的纯逻辑：树结构、默认选中、勾选联动、汇总。
 *
 * 单独成文件是为了能被 vitest 直接打红 —— 默认预勾选是用户口径的核心
 * （"默认同步所有的 doc 目录"），它退化成"只勾根目录"或"一个都不勾"时必须变红，
 * 而不是等到有人打开页面才发现。
 */

export interface DirectoryTreeNode extends GitHubDirectoryNode {
  children: DirectoryTreeNode[];
}

/**
 * 扁平目录清单 → 树。
 * 找不到父节点的目录（后端按上限截断时可能出现）挂到根上，不静默丢弃。
 */
export function buildDirectoryTree(directories: GitHubDirectoryNode[]): DirectoryTreeNode[] {
  const byPath = new Map<string, DirectoryTreeNode>();
  for (const dir of directories) {
    byPath.set(dir.path, { ...dir, children: [] });
  }

  const roots: DirectoryTreeNode[] = [];
  for (const node of byPath.values()) {
    const parent = node.parentPath === null ? null : byPath.get(node.parentPath);
    if (parent && parent.path !== node.path) parent.children.push(node);
    else roots.push(node);
  }

  const sortTree = (nodes: DirectoryTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    nodes.forEach((n) => sortTree(n.children));
  };
  sortTree(roots);

  return roots;
}

/** 默认选中集合：后端算出的 recommendedPaths（所有 doc / docs 目录，递归） */
export function defaultSelection(scan: Pick<GitHubDirectoryScan, 'recommendedPaths'>): Set<string> {
  return new Set(scan.recommendedPaths ?? []);
}

/** 勾/取消一个目录（只影响它自己，不级联子目录——同步本来就是单层的） */
export function toggleSelection(selected: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** 一键全选 / 全不选当前可见的目录 */
export function setSelection(
  selected: ReadonlySet<string>,
  paths: string[],
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const path of paths) {
    if (checked) next.add(path);
    else next.delete(path);
  }
  return next;
}

/** 汇总：勾了几个目录、大约会同步多少个 Markdown 文件（让用户点确认前知道自己勾了多大一坨） */
export function selectionSummary(
  directories: GitHubDirectoryNode[],
  selected: ReadonlySet<string>,
): { directoryCount: number; markdownCount: number } {
  let directoryCount = 0;
  let markdownCount = 0;
  for (const dir of directories) {
    if (!selected.has(dir.path)) continue;
    directoryCount += 1;
    markdownCount += dir.markdownCount;
  }
  return { directoryCount, markdownCount };
}

/** 关键词过滤（匹配路径，命中的目录连同其祖先一起保留，保证树不断链） */
/**
 * 关键词**真正命中**的目录（不含只为把树连起来而保留的祖先）。
 *
 * 「全选 / 清空」必须用这个，不能用渲染用的那份列表：搜 `docs` 时，`packages`、
 * `packages/web` 只是为了让树不断链才保留的上下文，把它们也勾上就等于订阅了仓库根目录
 * 和一堆中间层——要么导进一批不相干的 Markdown，要么建出一个空订阅；「清空」同理，
 * 会把用户此前勾好的祖先目录一起抹掉。
 */
export function keywordMatchedPaths(
  directories: GitHubDirectoryNode[],
  keyword: string,
): string[] {
  const trimmed = keyword.trim().toLowerCase();
  if (!trimmed) return directories.map((d) => d.path);
  return directories.filter((d) => matchesKeyword(d, trimmed)).map((d) => d.path);
}

/** 命中判据的唯一定义：过滤与批量操作共用，免得两处各判一次然后漂开（形状 3）。 */
function matchesKeyword(dir: GitHubDirectoryNode, lowerKeyword: string): boolean {
  return dir.path.toLowerCase().includes(lowerKeyword)
    || dir.name.toLowerCase().includes(lowerKeyword);
}

export function filterDirectories(
  directories: GitHubDirectoryNode[],
  keyword: string,
): GitHubDirectoryNode[] {
  const trimmed = keyword.trim().toLowerCase();
  if (!trimmed) return directories;

  const keep = new Set<string>();
  for (const dir of directories) {
    if (!matchesKeyword(dir, trimmed)) continue;
    keep.add(dir.path);
    let parent = dir.parentPath;
    while (parent !== null && !keep.has(parent)) {
      keep.add(parent);
      parent = directories.find((d) => d.path === parent)?.parentPath ?? null;
    }
  }
  return directories.filter((d) => keep.has(d.path));
}

/**
 * 初始展开集合：只展开「通往已勾选目录」的那几条路径。
 *
 * 一个真实仓库有几百个目录（本仓库 666 个），全部摊平渲染既慢又让人找不到重点。
 * 默认只把 doc/docs 那几条链展开，其余折叠着，用户想找别的再自己点开或搜。
 */
export function defaultExpanded(
  directories: GitHubDirectoryNode[],
  selected: ReadonlySet<string>,
): Set<string> {
  const byPath = new Map(directories.map((d) => [d.path, d]));
  const expanded = new Set<string>(['']);
  for (const dir of directories) {
    if (!selected.has(dir.path)) continue;
    let parent = dir.parentPath;
    while (parent !== null && !expanded.has(parent)) {
      expanded.add(parent);
      parent = byPath.get(parent)?.parentPath ?? null;
    }
  }
  return expanded;
}

/** 目录展示名：根目录显示为「仓库根目录」，其余显示相对路径 */
export function directoryLabel(dir: Pick<GitHubDirectoryNode, 'path' | 'name'>): string {
  return dir.path === '' ? '仓库根目录' : dir.path;
}

/**
 * 后端一次批量订阅的目录上限（`MaxGitHubBatchDirectories`）。
 *
 * 两边必须一致：前端按这个数分批提交，后端超过就 400。
 * 预勾选是「所有 doc / docs 目录」，monorepo 里每个包一个 docs/ 很容易超过 50——
 * 不分批的话，用户按了「开启同步」只会拿到一句「请分批开启」，而界面上根本没有分批的办法。
 */
export const GITHUB_BATCH_DIRECTORY_LIMIT = 50;

/** 把勾选的目录按后端上限切成若干批（顺序保持稳定，便于失败时说清第几批） */
export function chunkDirectories(paths: string[], limit = GITHUB_BATCH_DIRECTORY_LIMIT): string[][] {
  const size = Math.max(1, limit);
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += size) chunks.push(paths.slice(i, i + size));
  return chunks;
}
