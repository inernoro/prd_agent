/**
 * repo-sharing —— 「一个仓库喂多个项目」这件事的全部判据。
 *
 * ## 为什么要单独一个模块
 *
 * 一个仓库绑上第二个项目之后，用户每一次操作都会多出一个问题：**这会影响到谁**。
 * push 会建几条分支、删项目会不会连累别人、两边是不是在写同一个库 —— 这些问题
 * 的答案散在路由和界面里各算一遍，就会出现「面板说三个、命令行说一个」。所以判据
 * 集中在这里，路由与界面都只负责展示。
 *
 * ## 三条设计取舍
 *
 * 1. **显示关系，不显示标签**。用户要的不是「本项目是多项目」这个状态词，而是
 *    「和谁关联、点得进去」。所以对外给的是兄弟项目清单，不是一个布尔量。
 * 2. **先给结论再给数字**。一句「三个项目都没声明范围，每次推送会全部重建」比
 *    三个计数有用得多，所以这里直接产出那句话。
 * 3. **共享基础设施要算，不要断言**。同一个仓库并不自动意味着共用数据库 ——
 *    那取决于两边环境变量填了什么。所以这里比对真实取值，真撞上了才报，
 *    报的时候点名是哪个变量撞了。断言「你们共用一个库」而实际没有，
 *    比不说更糟。
 *
 * 纯函数：不读状态、不碰网络，可直接单测。
 */

/** 一个同仓项目在判据眼里的样子。 */
export interface RepoSiblingFacts {
  id: string;
  name: string;
  /** 该项目声明的构建范围并集。空数组 = 未声明 = 全通配。 */
  scope: string[];
  /** 该项目的环境变量（用于算真实共享的基础设施）。可不给。 */
  env?: Record<string, string>;
}

/** 两个及以上项目把同一个变量指到了同一个地方。 */
export interface SharedInfraHit {
  /** 环境变量名，例如 MONGO_URL */
  key: string;
  /** 看出来是什么东西：数据库 / 缓存 / 其它地址 */
  kind: 'database' | 'cache' | 'endpoint';
  /** 共享它的项目 id，至少两个 */
  projectIds: string[];
}

export interface RepoSharingSummary {
  /** 同仓项目总数（含自己） */
  total: number;
  /** 其中没有声明构建范围的个数 —— 它们对任何 push 都会重建 */
  unscoped: number;
  /** 一句人话结论，可直接摆在页面顶部 */
  headline: string;
  /** 严重程度：ok = 各自有范围；warn = 有项目会被每次 push 全量重建 */
  level: 'ok' | 'warn';
  /** 真实撞在一起的基础设施（算出来的，不是假设的） */
  sharedInfra: SharedInfraHit[];
}

/** 值看起来像个数据存储地址吗，是的话是哪一类。 */
function classifyValue(key: string, value: string): SharedInfraHit['kind'] | null {
  const v = value.trim();
  // 单字符值多半是开关或序号，不是地址。库名可以很短（`app`），所以门槛只到 2，
  // 不能按连接串的长度去卡 —— 那会把「两个项目都叫 app 的库」这种真共享漏掉。
  if (v.length < 2) return null;
  const lowerKey = key.toLowerCase();
  const lowerVal = v.toLowerCase();
  if (/^(mongodb|mysql|postgres(ql)?|sqlserver|mariadb):\/\//.test(lowerVal)) return 'database';
  if (/^redis(s)?:\/\//.test(lowerVal)) return 'cache';
  // 连接串之外，DB 名这类 key 撞上同一个值同样是共享（配套的 host 往往在别处）
  if (/(database|db)_?name$|^.*_db$|database$/.test(lowerKey)) return 'database';
  if (/^redis/.test(lowerKey)) return 'cache';
  if (/^(https?):\/\//.test(lowerVal)) return 'endpoint';
  return null;
}

/**
 * 找出被多个项目指到同一处的基础设施。
 *
 * 只报**取值完全相同**的：不同项目各自连各自的库是常态，不该报；两边填了同一个
 * 连接串才是真共享。没给 env 的项目不参与比对（不猜）。
 */
export function findSharedInfra(siblings: readonly RepoSiblingFacts[]): SharedInfraHit[] {
  // key -> value -> 项目 id 列表
  const index = new Map<string, Map<string, string[]>>();
  for (const sib of siblings) {
    for (const [key, value] of Object.entries(sib.env || {})) {
      if (typeof value !== 'string') continue;
      if (!classifyValue(key, value)) continue;
      let byValue = index.get(key);
      if (!byValue) { byValue = new Map(); index.set(key, byValue); }
      const ids = byValue.get(value) || [];
      if (!ids.includes(sib.id)) ids.push(sib.id);
      byValue.set(value, ids);
    }
  }

  const hits: SharedInfraHit[] = [];
  for (const [key, byValue] of index) {
    for (const [value, projectIds] of byValue) {
      if (projectIds.length < 2) continue;
      const kind = classifyValue(key, value);
      if (!kind) continue;
      hits.push({ key, kind, projectIds: [...projectIds].sort() });
    }
  }
  // 数据库排前面：撞库比撞一个只读端点严重得多
  const weight = { database: 0, cache: 1, endpoint: 2 } as const;
  return hits.sort((a, b) => weight[a.kind] - weight[b.kind] || a.key.localeCompare(b.key));
}

/**
 * 把同仓项目集算成一句能直接摆在页面上的结论。
 *
 * 只有一个项目时不产出任何东西 —— 单项目仓库不该看见任何多项目字样，
 * 否则等于给所有人凭空加了一个要理解的概念。
 */
export function summarizeRepoSharing(siblings: readonly RepoSiblingFacts[]): RepoSharingSummary | null {
  if (siblings.length < 2) return null;

  const unscoped = siblings.filter((s) => s.scope.length === 0);
  const sharedInfra = findSharedInfra(siblings);

  let headline: string;
  let level: RepoSharingSummary['level'];
  if (unscoped.length === siblings.length) {
    // 最该被看见的那一档：谁都没划范围，于是每次推送把所有项目重建一遍
    headline = `同一个仓库下有 ${siblings.length} 个项目，都没有声明构建范围 —— 任何一次推送都会把它们全部重建。`;
    level = 'warn';
  } else if (unscoped.length > 0) {
    headline = `同一个仓库下有 ${siblings.length} 个项目，其中 ${unscoped.length} 个没有声明构建范围，任何一次推送都会重建它们：${unscoped.map((s) => s.name).join('、')}。`;
    level = 'warn';
  } else {
    headline = `同一个仓库下有 ${siblings.length} 个项目，各自都声明了构建范围，推送只会重建被改到的那些。`;
    level = 'ok';
  }

  return { total: siblings.length, unscoped: unscoped.length, headline, level, sharedInfra };
}

/**
 * 共享基础设施的人话说明。界面直接用，不要各自拼一份。
 */
export function describeSharedInfra(hit: SharedInfraHit, nameOf: (id: string) => string): string {
  const names = hit.projectIds.map(nameOf).join('、');
  const what = hit.kind === 'database' ? '同一个数据库'
    : hit.kind === 'cache' ? '同一个缓存'
      : '同一个地址';
  return `${names} 的 ${hit.key} 指向${what} —— 一边写坏，另一边立刻可见。`;
}
