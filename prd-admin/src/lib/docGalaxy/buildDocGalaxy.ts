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
  /** 文档摘要（hover 缩略卡预览用）。 */
  summary?: string | null;
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
  /** 仅叶子：文档摘要（hover 缩略卡预览用），无则 null。 */
  summary?: string | null;
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

/**
 * 是否为「目录订阅容器」条目（非真文档）。
 * GitHub 目录订阅的父条目 contentType 标记为目录，但 IsFolder 默认 false，
 * 它没有正文，不应进入星系成叶。
 */
function isContainerEntry(e: GalaxyInputEntry): boolean {
  return !!e.contentType && e.contentType.toLowerCase().includes('x-github-directory');
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

/**
 * 从 GitHub 文件 URL 还原「仓库内目录段」（不含文件名）。
 * 支持 raw.githubusercontent.com/{o}/{r}/{branch}/PATH 与
 * github.com/{o}/{r}/(blob|raw|tree)/{branch}/PATH 两种形态；其余主机返回 []。
 * 用途：GitHub 目录订阅来的非点分文件（README/guide 风格）没有 parentId，
 * 靠这个还原子目录层级，避免一律落到「未分类」。
 */
function githubDirSegments(url: string): string[] {
  const clean = url.split(/[?#]/)[0];
  let m = clean.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/i);
  if (!m) m = clean.match(/github\.com\/[^/]+\/[^/]+\/(?:blob|raw|tree)\/[^/]+\/(.+)$/i);
  if (!m) return [];
  const parts = m[1].split('/').filter(Boolean);
  return parts.slice(0, -1); // 去掉文件名，仅留目录段
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
  /** 覆盖叶子显示名（标题分隔符分组时，叶名取消费掉前缀段后的剩余）。不填则用结构名（文件名/点分名）。 */
  leafName?: string;
}

/**
 * 标题层级分隔符：中点（· U+00B7 / ・ U+30FB / • bullet）、斜杠（/ ／）、尖括号（> ＞）、
 * 竖线（| ｜）、书名号（»），以及「空格-空格」包裹的连字符。
 * 刻意不含「裸连字符」——否则会把 prd-agent / defect-agent 这类整段 appname 拆开。
 */
const TITLE_SEP_RE = /\s*[·・•／/＞>｜|»]\s*|\s+[-–—]\s+/;

/** 把描述式标题按层级分隔符切成段（去空白、去空段）。 */
function splitTitleSegments(title: string): string[] {
  return stripExt(title)
    .split(TITLE_SEP_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 一篇文档「天然适配哪种分割方式」：结构化（点分 / 文件夹 / GitHub 目录 / 周报）vs 标题分割 vs 无。
 * 用于全库主导方式检测——一个知识库应作为整体遵循一种分割方式（用户 2026-06-27 定调）。
 */
function schemeOf(entry: GalaxyInputEntry, byId: Map<string, GalaxyInputEntry>): 'structured' | 'title' | 'none' {
  const nm = nameForHierarchy(entry);
  if (WEEKLY_RE.test(stripExt(nm))) return 'structured';
  if (parseDotted(nm)) return 'structured';
  if (folderPath(entry, byId).length > 0) return 'structured';
  if (entry.sourceUrl && githubDirSegments(entry.sourceUrl).length > 0) return 'structured';
  const segs = splitTitleSegments(entry.title);
  const first = segs[0] || '';
  if (segs.length >= 2 || first.split(/\s+/).filter(Boolean).length >= 2) return 'title';
  return 'none';
}

/**
 * 全库主导分割方式：标题分割的文档数 > 结构化文档数，才认为这是一个「标题分割为主」的库。
 * 只有这种库才启用标题分组；否则（如 MAP 这种点分为主的库）少数描述式标题统一归「未分类」，
 * 不用标题分割把它们打散成满天单点（用户：一个知识库应遵循一种分割方式，取最常见的）。
 */
function detectTitleDominant(docs: GalaxyInputEntry[], byId: Map<string, GalaxyInputEntry>): boolean {
  let structured = 0;
  let title = 0;
  for (const e of docs) {
    const s = schemeOf(e, byId);
    if (s === 'structured') structured++;
    else if (s === 'title') title++;
  }
  return title > structured;
}

/** 为一篇文档推导「从根到叶父」的分组链 + 类型 + 是否悬空。 */
function derivePath(
  entry: GalaxyInputEntry,
  byId: Map<string, GalaxyInputEntry>,
  resolve: (appname: string) => AppnameResolution,
  titleDominant: boolean,
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

  // 2b. GitHub 目录订阅的非点分文件：从 sourceUrl 还原仓库内目录层级
  //     （这类条目无 parentId，否则一律落「未分类」——见 buildDocGalaxy 关系识别注释第 2 层）。
  if (entry.sourceUrl) {
    const ghDirs = githubDirSegments(entry.sourceUrl);
    if (ghDirs.length > 0) {
      return { groups: ghDirs, docType: parseDocType(name), orphan: false };
    }
  }

  // 2c. 标题分割层级——仅当本库「以标题分割为主」时启用（titleDominant）。
  //     点分为主的库（如 MAP）走不到这里：少数描述式标题统一落「未分类」(下方兜底)，
  //     不用标题分割把它们打散，保持全库一种分割方式（用户 2026-06-27 定调）。
  if (titleDominant) {
    const segs = splitTitleSegments(entry.title);
    const first = segs[0] || '';
    const words = first.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      // 首段含空格 → 前两词作家族分组（CDS Agent / CDS Web…），同族聚簇；叶名留完整标题
      return { groups: [`${words[0]} ${words[1]}`], docType: parseDocType(name), orphan: false, leafName: stripExt(entry.title).trim() };
    }
    if (segs.length >= 2) {
      // 首段无空格但有 ·（prd-agent·知识库·…）→ 取前 1-2 段作分组
      const groupCount = Math.min(2, segs.length - 1);
      return { groups: segs.slice(0, groupCount), docType: parseDocType(name), orphan: false, leafName: segs.slice(groupCount).join(' · ') };
    }
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

  // 排除「目录订阅容器」条目：GitHub 目录订阅的父条目 contentType 标为目录、
  // 但 IsFolder 默认为 false，不是真文档（无正文、打开是空），不应成叶子，
  // 否则会多出一个未分类幽灵节点、虚增 totalDocs、点开是空白阅读器（Codex P2）。
  const docs = entries.filter((e) => !e.isFolder && !isContainerEntry(e));

  // 全库主导分割方式检测：决定是否启用标题分割（一个库遵循一种分割方式）。
  const titleDominant = detectTitleDominant(docs, byId);

  for (const entry of docs) {
    const { groups, docType, orphan, leafName } = derivePath(entry, byId, resolve, titleDominant);

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
      // 叶子「结构名」恒取文件名/点分名（nameForHierarchy 优先 sourceUrl 点分 basename，
      // 无则回退 title）——structural 标签模式直接用它；正文标题走 content 模式叠加（contentTitles）。
      // 历史回归：旧版误把 leaf.name 设成 entry.title，导致 structural 模式也显示长正文标题而非文件名。
      name: leafName || stripExt(nameForHierarchy(entry) || entry.title || entry.id),
      kind: 'leaf',
      depth: parent.depth + 1,
      docCount: 1,
      children: [],
      entryId: entry.id,
      docType,
      summary: entry.summary ?? null,
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
