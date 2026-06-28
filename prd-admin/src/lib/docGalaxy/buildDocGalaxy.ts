// 知识库文档星系 —— 关系识别业务逻辑（SSOT，与可视化解耦）
//
// 输入：知识库 entries（含 title / parentId / sourceUrl）+ 双链 edges。
// 输出：从「根」可索引到每篇文档的层级树 + 横向引用连线 + 统计。
//
// 关系识别按优先级三层（任意知识库都能成图）：
//   1. 点分命名 {type}.{appname}[.{子模块}] —— 本仓库 doc/ 的约定，解析成 根分类→appname→子模块→文档；
//   2. 文件夹 / parentId 层级 —— 通用，任意 GitHub 仓库的目录结构；
//   3. 兜底「未分类」根 —— 既没点分名也没父层级时。
//
// 可视化（Three.js / R3F 星系）只消费本函数的输出，换皮不动这里。

import { resolveCanonicalAppname, CANONICAL_CATEGORY } from './canonicalCategories';

/** appname 解析结果（category 用字符串，兼容注入的自定义分类器）。 */
type AppnameResolution = { category: string; appname: string; sub?: string };

export const DOC_TYPES = ['spec', 'design', 'plan', 'rule', 'guide', 'report', 'debt'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface GalaxyInputEntry {
  id: string;
  title: string;
  parentId?: string | null;
  isFolder?: boolean;
  contentType?: string;
  sourceUrl?: string | null;
}

export interface GalaxyInputLink {
  from: string;
  to: string;
  anchorText?: string;
  isAutoDetected?: boolean;
}

export type GalaxyNodeKind = 'root' | 'group' | 'leaf';

export interface GalaxyNode {
  /** 内部节点 'g:<path>'，文档叶 'e:<entryId>'，中心根 'root'。 */
  id: string;
  name: string;
  kind: GalaxyNodeKind;
  depth: number;
  /** 子树下文档（叶）总数。 */
  docCount: number;
  children: GalaxyNode[];
  /** 仅叶子：对应知识库 entry。 */
  entryId?: string;
  /** 仅叶子：文档类型（点分前缀），无法判定为 null。 */
  docType?: DocType | null;
  /** 是否悬空（无法归到 canonical 根 / 落到未分类）。 */
  orphan?: boolean;
}

export interface GalaxyLink {
  source: string; // 'e:<entryId>'
  target: string; // 'e:<entryId>'
  anchorText?: string;
  isAutoDetected?: boolean;
}

export interface DocGalaxyStats {
  totalDocs: number;
  rootCount: number;
  appnameCount: number;
  typeCounts: Record<string, number>;
  orphanCount: number;
}

export interface DocGalaxy {
  root: GalaxyNode;
  leaves: GalaxyNode[];
  links: GalaxyLink[];
  stats: DocGalaxyStats;
}

export interface BuildDocGalaxyOptions {
  /** appname → 根分类（默认走 canonical 四大类）。通用库可注入自定义或恒等。 */
  classifyAppname?: (appname: string) => string;
  /** 中心根显示名。 */
  rootName?: string;
}

const WEEKLY_RE = /^report\.\d{4}-w\d{2}$/i;
const WEEKLY_GROUP = '周报';
const UNCLASSIFIED_GROUP = CANONICAL_CATEGORY.UNCLASSIFIED;

/** 去掉常见文档后缀，便于解析点分名。 */
function stripExt(name: string): string {
  return name.replace(/\.(md|markdown|mdx)$/i, '');
}

/** 从 sourceUrl 取 basename（不带查询/锚）。 */
function basenameOf(url: string): string {
  const clean = url.split(/[?#]/)[0].replace(/\/+$/, '');
  const seg = clean.split('/').pop() ?? clean;
  return seg;
}

/** 解析文档类型前缀（spec/design/...）；非法返回 null。 */
export function parseDocType(name: string): DocType | null {
  const head = stripExt(name).split('.')[0]?.toLowerCase();
  return (DOC_TYPES as readonly string[]).includes(head) ? (head as DocType) : null;
}

interface Dotted {
  type: DocType;
  appname: string;
  subs: string[];
}

/**
 * 解析点分命名 {type}.{appname}[.{子模块}...]。
 * 注意：appname 本身可含 '-'（如 defect-agent 是一整段），分层只认 '.'。
 */
export function parseDotted(rawName: string): Dotted | null {
  const name = stripExt(rawName);
  const segs = name.split('.');
  if (segs.length < 2) return null;
  const type = segs[0].toLowerCase();
  if (!(DOC_TYPES as readonly string[]).includes(type)) return null;
  const appname = segs[1];
  if (!appname) return null;
  return { type: type as DocType, appname, subs: segs.slice(2) };
}

/** 取一个能用于解析层级的「名字」候选：优先 sourceUrl 的 basename（点分文件名），否则 title。 */
function nameForHierarchy(entry: GalaxyInputEntry): string {
  if (entry.sourceUrl) {
    const base = basenameOf(entry.sourceUrl);
    if (parseDotted(base) || base.includes('/')) return base;
  }
  return entry.title;
}

/** 沿 parentId 链收集文件夹层级（从顶到底，不含自身）。 */
function folderPath(entry: GalaxyInputEntry, byId: Map<string, GalaxyInputEntry>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let pid = entry.parentId ?? null;
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const parent = byId.get(pid);
    if (!parent) break;
    path.unshift(parent.title || '未命名');
    pid = parent.parentId ?? null;
  }
  return path;
}

interface DerivedPath {
  groups: string[];
  docType: DocType | null;
  orphan: boolean;
}

/** 为一篇文档推导「从根到叶父」的分组链 + 类型 + 是否悬空。 */
function derivePath(
  entry: GalaxyInputEntry,
  byId: Map<string, GalaxyInputEntry>,
  resolve: (appname: string) => AppnameResolution,
): DerivedPath {
  const name = nameForHierarchy(entry);
  const bare = stripExt(name);

  // 周报例外：时间即主题
  if (WEEKLY_RE.test(bare)) {
    return { groups: [WEEKLY_GROUP], docType: 'report', orphan: false };
  }

  // 1. 点分命名
  const dotted = parseDotted(name);
  if (dotted) {
    const r = resolve(dotted.appname);
    const orphan = r.category === UNCLASSIFIED_GROUP;
    const groups = [r.category, r.appname, ...(r.sub ? [r.sub] : []), ...dotted.subs];
    return { groups, docType: dotted.type, orphan };
  }

  // 2. 文件夹 / parentId 层级
  const folders = folderPath(entry, byId);
  if (folders.length > 0) {
    return { groups: folders, docType: parseDocType(name), orphan: false };
  }

  // 3. 兜底
  return { groups: [UNCLASSIFIED_GROUP], docType: parseDocType(name), orphan: true };
}

/**
 * 构建文档星系。纯函数、无副作用、可单测。
 */
export function buildDocGalaxy(
  entries: GalaxyInputEntry[],
  links: GalaxyInputLink[] = [],
  options: BuildDocGalaxyOptions = {},
): DocGalaxy {
  // 默认走 canonical 解析（含旧扁平名前缀去扁平化）；注入 classifyAppname 则只用其分类、不去扁平。
  const resolve: (a: string) => AppnameResolution = options.classifyAppname
    ? (a) => ({ category: options.classifyAppname!(a), appname: a })
    : resolveCanonicalAppname;
  const byId = new Map(entries.map((e) => [e.id, e]));

  const root: GalaxyNode = {
    id: 'root',
    name: options.rootName ?? '知识库',
    kind: 'root',
    depth: 0,
    docCount: 0,
    children: [],
  };

  // groupId -> node，避免重复创建中间节点
  const groupIndex = new Map<string, GalaxyNode>();
  groupIndex.set('root', root);
  const leaves: GalaxyNode[] = [];
  const leafIds = new Set<string>();

  const docs = entries.filter((e) => !e.isFolder);

  for (const entry of docs) {
    const { groups, docType, orphan } = derivePath(entry, byId, resolve);

    // 逐级确保中间分组节点存在
    let parent = root;
    let pathKey = 'root';
    groups.forEach((gname, idx) => {
      pathKey += '/' + gname;
      let node = groupIndex.get(pathKey);
      if (!node) {
        node = {
          id: 'g:' + pathKey.slice('root/'.length),
          name: gname,
          kind: 'group',
          depth: idx + 1,
          docCount: 0,
          children: [],
          orphan: idx === 0 && gname === UNCLASSIFIED_GROUP ? true : undefined,
        };
        groupIndex.set(pathKey, node);
        parent.children.push(node);
      }
      parent = node;
    });

    const leaf: GalaxyNode = {
      id: 'e:' + entry.id,
      name: stripExt(entry.title || entry.id),
      kind: 'leaf',
      depth: parent.depth + 1,
      docCount: 1,
      children: [],
      entryId: entry.id,
      docType,
      orphan,
    };
    parent.children.push(leaf);
    leaves.push(leaf);
    leafIds.add(entry.id);
  }

  // 自底向上累加 docCount
  const accumulate = (node: GalaxyNode): number => {
    if (node.kind === 'leaf') return 1;
    let sum = 0;
    for (const c of node.children) sum += accumulate(c);
    node.docCount = sum;
    return sum;
  };
  accumulate(root);

  // 横向引用连线：只保留两端都是已知文档叶的边
  const seenLink = new Set<string>();
  const galaxyLinks: GalaxyLink[] = [];
  for (const l of links) {
    if (!l.from || !l.to || l.from === l.to) continue;
    if (!leafIds.has(l.from) || !leafIds.has(l.to)) continue;
    const key = l.from < l.to ? `${l.from}|${l.to}` : `${l.to}|${l.from}`;
    if (seenLink.has(key)) continue;
    seenLink.add(key);
    galaxyLinks.push({
      source: 'e:' + l.from,
      target: 'e:' + l.to,
      anchorText: l.anchorText,
      isAutoDetected: l.isAutoDetected,
    });
  }

  // 统计
  const typeCounts: Record<string, number> = {};
  let orphanCount = 0;
  for (const leaf of leaves) {
    const t = leaf.docType ?? 'unknown';
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    if (leaf.orphan) orphanCount += 1;
  }
  const appnameCount = root.children.reduce((sum, r) => sum + r.children.length, 0);

  return {
    root,
    leaves,
    links: galaxyLinks,
    stats: {
      totalDocs: leaves.length,
      rootCount: root.children.length,
      appnameCount,
      typeCounts,
      orphanCount,
    },
  };
}
