/**
 * 「系统互联」连接长效凭据（`ct_` 开头）能到达哪些路由。
 *
 * ## 为什么单独一份
 *
 * 这把凭据是**用户在 CDS 上点过同意**、发给对端系统（MAP）长期使用的授权，
 * 与 CDS 自己的静态访问密钥、项目级 / 全局 Agent Key 是完全不同的东西：
 * 后三者代表「CDS 的管理员或自动化」，这一把代表「一个被授权的外部系统」。
 * 所以它**不该**共享管理员的权限面，只能到达明确列出来的几条路由。
 *
 * 判据集中在这一个函数里，与 `isPublicAccessRequestRoute` 同样的理由：
 * 散在鉴权代码里写 `path.startsWith(...)` 的话，每加一条能力就多一处判断，
 * 改一处忘一处，最终没人答得上来「这把凭据到底能干什么」。要回答这个问题，
 * 读这张表就够了。
 *
 * ## 表里每一条都要能说清「为什么给」
 *
 * 加新条目前先问三句：这条路由是只读的吗？外部系统拿它做什么？
 * 用户在授权页看到的范围说明涵盖它吗？三句里有一句答不上来，就不该加。
 */

/** 连接凭据可达的一条路由，以及它要求的授权范围。 */
interface ConnectionRouteRule {
  /** 允许的 HTTP 方法；`'*'` 表示不限（仅用于 Bridge 那类必须能写的能力）。 */
  methods: readonly string[] | '*';
  /** 路径判据。 */
  match: (path: string) => boolean;
  /** 需要的授权范围，取自连接授权时授予的 scopes。 */
  scope: string;
  /** 给人看的说明，出现在测试与排障里。 */
  why: string;
}

const RULES: readonly ConnectionRouteRule[] = [
  {
    // Page Agent Bridge：这把凭据最初就是为它签发的。它要下发点击 / 输入指令，
    // 所以必须能写，是本表里唯一不限方法的一条。
    methods: '*',
    match: (path) => path.startsWith('/api/bridge/'),
    scope: 'instance:read',
    why: 'Page Agent Bridge：外部系统驱动预览页面，需要读页面快照并下发指令',
  },
  {
    // 验收报告只读：MAP 的知识库把 CDS 上的验收报告镜像过去，需要列表 + 正文两条。
    // **只给 GET。** 建报告、删报告、传附件仍然只有 CDS 自己的密钥能做——
    // 外部系统只是读者，不是作者。
    //
    // 报告正文里的截图走 `/api/reports/assets/`，那条本来就是匿名可读的
    //（内容寻址、不可枚举），所以不必列进来。
    methods: ['GET'],
    match: (path) => path === '/api/reports',
    scope: 'instance:read',
    why: '验收报告列表：外部系统按 updatedSince / projectId / reportId 增量取清单',
  },
  {
    methods: ['GET'],
    match: (path) => /^\/api\/reports\/[^/]+\/raw$/.test(path),
    scope: 'instance:read',
    why: '验收报告正文：镜像一份到外部系统的知识库',
  },
];

/**
 * 这条请求，连接长效凭据够不够得着；够得着的话还需要哪个授权范围。
 *
 * @returns 需要的 scope；`null` = 这条路由不对连接凭据开放。
 */
export function connectionTokenRequiredScope(method: string, path: string): string | null {
  const upper = (method || '').toUpperCase();
  for (const rule of RULES) {
    if (!rule.match(path)) continue;
    if (rule.methods !== '*' && !rule.methods.includes(upper)) continue;
    return rule.scope;
  }
  return null;
}

/**
 * 「最近用过」这个时间戳，隔多久才值得往存储里写一次。
 *
 * 它只是给人看的「这把凭据还活着吗」，精确到分钟绰绰有余。而写它的代价不小：
 * 每次更新都会把整份状态存一遍。
 *
 * 这在原来只有页面代理能用这把凭据时无所谓（那是人在操作，频率很低）。
 * 报告只读放开之后完全不同：一个存了 200 份报告的库，每小时的自动刷新会发出
 * 400 多个请求，每个都想更新一次这个时间戳——一次只读的定时任务就变成了
 * 每小时几百次整份状态落盘（Codex review P2）。
 */
export const CONNECTION_USE_THROTTLE_MS = 5 * 60 * 1000;

/**
 * 这次请求要不要把「最近用过」写回去。
 *
 * @param lastUsedAt 存储里现有的值；空 / 认不出来的一律当成「从没记过」，写一次。
 * @param nowIso 当前时间。
 */
export function shouldRecordConnectionUse(lastUsedAt: string | undefined | null, nowIso: string): boolean {
  if (!lastUsedAt) return true;
  const last = Date.parse(lastUsedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(last) || Number.isNaN(now)) return true;
  // 存的值比现在还新（改过系统时间、或多实例时钟不齐）——写一次把它拉回来，
  // 否则一个未来的时间戳会让这里永远不再更新。
  if (last > now) return true;
  return now - last >= CONNECTION_USE_THROTTLE_MS;
}

/** 给排障与测试用：这把凭据当前能到达哪些东西，以及为什么。 */
export function describeConnectionTokenRoutes(): readonly string[] {
  return RULES.map((r) => `${r.methods === '*' ? 'ANY' : r.methods.join('/')} → ${r.why}`);
}
