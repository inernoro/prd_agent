// 新人轨的派生状态（SSOT）——「这个租户还差哪一步才算接上」由这里算，组件只负责画。
//
// 由来：控制台此前只有一条中间轨道（Quickstart 教程页）。普通人不知道自己缺什么，
// 熟人则被同一段说明反复挡路。补两头的前提是先有一份**派生**状态：
// 不新增后端字段、不让用户自己勾，全部从既有三个接口推出来。
//
// 三条硬约束：
//   1. 只读既有接口：getOrganization / getServiceKeys / getLogsSummary。
//   2. 模块级缓存（租户 id 作键 + 60 秒 TTL）。这些 hook 会同时挂在概览页与 Quickstart，
//      不缓存就是每进一个页面多打三次请求。
//   3. 读不到的不猜：当前角色没权限打开的数据源一律**不发请求**，标成 unreadable，
//      由调用方渲染成「由管理员完成」，而不是显示一个永远完不成的步骤。
import { useEffect, useState } from 'react';
import { getOrganization, getServiceKeys } from '@/lib/api';
import { canAccessPage, canUseCapability } from '@/lib/access';
import type { ConsoleCapability, ConsolePage } from '@/lib/access';
import { useAuth } from '@/lib/auth';

/** 缓存 TTL：够短，签发密钥后回到概览页最多一分钟就能看到步骤变绿。 */
const TTL_MS = 60_000;

type CacheKind = 'organization' | 'serviceKeys';

const CACHE = new Map<string, { at: number; promise: Promise<unknown> }>();

/**
 * 「这次没读到」——与「确实没有」必须分开。
 * 前者不缓存、不渲染清单；后者才是可以拿去告诉用户的事实。
 */
export class OnboardingFactsUnavailable extends Error {
  constructor(readonly source: CacheKind) {
    super(`onboarding facts unavailable: ${source}`);
    this.name = 'OnboardingFactsUnavailable';
  }
}

/** 失效订阅者。清缓存本身不会让已挂载的 hook 重跑，必须显式通知（Codex P2）。 */
const INVALIDATION_LISTENERS = new Set<() => void>();

function subscribeInvalidation(listener: () => void): () => void {
  INVALIDATION_LISTENERS.add(listener);
  return () => { INVALIDATION_LISTENERS.delete(listener); };
}

/** 模块级缓存：同一租户 60 秒内只打一次；失败不缓存，避免把一次网络抖动钉死一分钟。 */
function cached<T>(kind: CacheKind, tenantId: string, load: () => Promise<T>): Promise<T> {
  const key = `${kind}::${tenantId}`;
  const hit = CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.promise as Promise<T>;
  const promise = load().catch((reason) => {
    CACHE.delete(key);
    throw reason;
  });
  CACHE.set(key, { at: now, promise });
  return promise;
}

/**
 * 供签发密钥、创建团队等写操作之后主动刷新（不传租户则清空全部）。
 *
 * 光清 map 不够：60 秒 TTL 只在下次加载时才被查，已挂载的清单不会自己重跑，
 * 于是刚建完团队的用户会一直看着「建一个团队」没变绿。所以清完必须通知订阅者。
 */
export function invalidateOnboardingCache(tenantId?: string) {
  if (!tenantId) {
    CACHE.clear();
  } else {
    for (const key of [...CACHE.keys()]) {
      if (key.endsWith(`::${tenantId}`)) CACHE.delete(key);
    }
  }
  for (const listener of [...INVALIDATION_LISTENERS]) listener();
}

/**
 * 「这个租户刚刚亲自跑通过一条请求」的本地确证。
 *
 * 为什么不能只靠重拉 digest：serving 端把 LastUsedAt 写成 fire-and-forget
 * （`GatewayRuntimeGovernance.cs` 的 `_ = keys.UpdateOneAsync(...)`，不 await），
 * Quickstart 测试成功后立刻失效并重拉，完全可能抢在那次写落库之前读到旧值，
 * 于是把 everUsed:false 又缓存 60 秒 —— 用户明明刚看到「已写入请求记录」，
 * 清单却还说没跑通（Codex P2）。
 *
 * 请求成功本身就是这件事的第一手证据，不需要绕回数据库再问一遍。这里只做
 * 单调的「一旦为真永远为真」叠加：它不会让任何步骤被错误地标成未完成。
 */
const REQUEST_COMPLETED_TENANTS = new Set<string>();

/** Quickstart 测试成功时调用：钉住既成事实 + 失效缓存，取代裸失效。 */
export function markRequestCompleted(tenantId?: string): void {
  if (tenantId) REQUEST_COMPLETED_TENANTS.add(tenantId);
  invalidateOnboardingCache(tenantId);
}

type TeamFacts = { hasTeam: boolean; hasMember: boolean };

function loadTeamFacts(tenantId: string): Promise<TeamFacts> {
  return cached('organization', tenantId, async () => {
    const response = await getOrganization();
    // 失败必须抛：resolve 一个「都没有」会被 cached() 当成事实钉死 60 秒，
    // 一次瞬时 500 就会让配置齐全的租户被告知去建团队、拉成员（Codex P2）。
    if (!response.success) throw new OnboardingFactsUnavailable('organization');
    // 只数 **active** 的：Quickstart 用 status==='active' 过滤团队，没有 active 团队时
    // 直接挡住签发。按总数判定会让清单先消失、下一步却做不了（Codex P2）。
    const activeTeams = response.data.teams.filter((team) => team.status === 'active');
    const activeMembers = response.data.members.filter((member) => member.status === 'active');
    return {
      hasTeam: activeTeams.length > 0,
      hasMember: activeMembers.length > 1,
    };
  });
}

/** 掩码展示用：只取前缀与可用状态，永远不涉及密钥明文（明文只在签发那一刻存在）。 */
export type ServiceKeyDigest = {
  total: number;
  activePrefix: string | null;
  /**
   * 这个租户是否**曾经**用密钥跑过请求。
   *
   * 取自密钥的 lastUsedAt 而不是查日志：请求日志默认只留 90 天
   * （LlmGateway:Retention:RequestLogDays），拿它当「一生是否跑通过」的依据，
   * 长期不活跃的租户过了保留期就会被打回「还没跑通首条请求」（Codex P2）。
   * lastUsedAt 挂在密钥上，不随日志清理消失；顺带也省掉一次范围查询。
   */
  everUsed: boolean;
};

/**
 * 网关认可的「业务调用」scope。对应 serving 侧的具名常量
 * `GatewaySuccessorObservationPolicy.IsBusinessInvocationScope`。
 */
const INVOCATION_SCOPES = ['invoke', 'stream:invoke', 'raw:invoke'];

/**
 * 这把密钥能不能发起调用。只镜像 scope 这一项，**不复刻整张授权矩阵**。
 *
 * 判据来自 serving 的 `MatchesAny`：空列表恒不匹配（= 拒绝），`*` 通配，
 * 其余大小写不敏感精确匹配。只看 enabled + 未过期会把一把 `readiness:read`
 * 的探针密钥当成「可以去跑请求了」，清单划掉、接入片段还把它的前缀亮出来（Codex P2）。
 *
 * 已知边界（见 doc/debt.platform.preview-entrypoints.md 的 ONB-key-usability）：
 * purpose / ingressProtocol / appCallerCode 三项同样参与服务端授权，这里没有镜像 ——
 * 把整张矩阵抄进 TS 就是判据分裂（形状 3），必然漂移。正解是服务端出一个
 * onboarding digest，而那需要 console-api 与 serving 共享判定，属独立改动。
 */
function allowsInvocation(scopes: string[] | undefined): boolean {
  const values = (scopes ?? []).map((s) => s.trim()).filter(Boolean);
  if (values.length === 0) return false;
  return values.some((s) => s === '*' || INVOCATION_SCOPES.includes(s.toLowerCase()));
}

function loadServiceKeyDigest(tenantId: string): Promise<ServiceKeyDigest> {
  return cached('serviceKeys', tenantId, async () => {
    const response = await getServiceKeys();
    if (!response.success) throw new OnboardingFactsUnavailable('serviceKeys');
    const items = response.data;
    // 「可用」= 启用**且未过期**。GatewayRuntimeGovernance 对 enabled-but-expired 的
    // 密钥同样拒签（`!record.Enabled || record.ExpiresAt <= now`），只看 enabled 会让
    // 清单标完成、接入片段亮出一把根本认证不过的前缀（Codex P2）。
    const now = Date.now();
    const usable = items.find(
      (item) => item.enabled
        && (!item.expiresAt || new Date(item.expiresAt).getTime() > now)
        && allowsInvocation(item.scopes),
    );
    // 已吊销/禁用的密钥也算数：它证明这个租户历史上确实跑通过。
    const everUsed = items.some((item) => Boolean(item.lastUsedAt));
    return { total: items.length, activePrefix: usable?.keyPrefix ?? null, everUsed };
  });
}

export type OnboardingStepId = 'team' | 'member' | 'key' | 'request';

export type OnboardingStep = {
  id: OnboardingStepId;
  /** 步骤标签，≤8 个汉字：清单只做提示，不承担解释。 */
  label: string;
  done: boolean;
  /** 当前角色能否自己去做这一步（决定渲染 CTA 还是「由管理员完成」）。 */
  actionable: boolean;
  /** 当前角色能否读到判定这一步的数据源；读不到时 done 恒为 false，但不阻塞整体完成。 */
  readable: boolean;
  to: string;
};

export type OnboardingState = {
  loading: boolean;
  /** 四步都成立（读不到的步骤不阻塞）——组件据此整体消失。 */
  complete: boolean;
  /**
   * 这一轮没读到事实（接口失败）。此时**什么都不要渲染**：
   * 把读取失败画成「四步全没做」，等于对着配置齐全的租户胡说八道。
   */
  unavailable: boolean;
  steps: OnboardingStep[];
};

const STEP_PAGE: Record<OnboardingStepId, ConsolePage> = {
  team: 'organization',
  member: 'organization',
  key: 'serviceKeys',
  request: 'quickstart',
};

/**
 * 每一步真正需要的**写**能力（全部满足才给 CTA）。
 *
 * 光看「页面到得了」不够：organization 与 quickstart 两个页面都只要求 logsRead，
 * developer / viewer 都能打开，清单于是给出「去完成」链接——可页面里的动作另有门控，
 * 点进去是个只读页面，没有任何办法完成被承诺的动作（Codex P2）。
 *
 * `request` 要求 appCallerWrite + serviceKeyWrite：上一轮我判断「跑一条请求只需要
 * 一把已存在的密钥」，但 QuickstartPage 的测试按钮整个包在
 * `canCreateAccess = appCallerWrite && serviceKeyWrite` 里 —— 不满足时按钮压根不渲染，
 * 页面自己写着「请联系 Owner、Admin 或 Developer 完成签发与测试」。判据必须照抄它，
 * 不能照抄我对流程的想象。
 */
const STEP_WRITE_CAPABILITIES: Partial<Record<OnboardingStepId, readonly ConsoleCapability[]>> = {
  team: ['organizationWrite'],
  member: ['organizationWrite'],
  key: ['serviceKeyWrite'],
  request: ['appCallerWrite', 'serviceKeyWrite'],
};

const STEP_TO: Record<OnboardingStepId, string> = {
  team: '/organization',
  member: '/organization',
  key: '/service-keys',
  request: '/quickstart',
};

const STEP_LABEL: Record<OnboardingStepId, string> = {
  team: '建一个团队',
  member: '拉一个成员',
  key: '签一把密钥',
  request: '跑通首条请求',
};

type Facts = Record<OnboardingStepId, boolean>;

const EMPTY_FACTS: Facts = { team: false, member: false, key: false, request: false };

export function useOnboardingState(): OnboardingState {
  const { tenant } = useAuth();
  const tenantId = tenant?.id ?? '';
  // 「读得到组织全貌」而不是「打得开组织页」：/gw/organization 对 owner / admin 之外的
  // 角色会按 caller 的 teamIds 收窄 teams 与 memberships（console-api Program.cs 的
  // canReadEntireOrganization 分支）。拿那份局部视图数成员必然偏小 —— 一个独自待在新建
  // 团队里的 developer 看不到默认团队里的 owner，activeMembers 只有 1，清单就一直说
  // 「拉一个成员」没做完，而他既改不了（写操作限 admin）也没法自证（Codex P2）。
  // 读不到就标 unreadable：不阻塞整体完成，渲染成「由管理员完成」。
  const canReadOrganization = canUseCapability(tenant?.role, 'organizationWrite');
  const canReadKeys = canAccessPage(tenant, 'serviceKeys');

  const [facts, setFacts] = useState<Facts>(EMPTY_FACTS);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  // 写操作后由 invalidateOnboardingCache 触发重算：+1 进 effect 依赖。
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeInvalidation(() => setRevision((n) => n + 1)), []);

  useEffect(() => {
    if (!tenantId) {
      setFacts(EMPTY_FACTS);
      setUnavailable(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      canReadOrganization ? loadTeamFacts(tenantId) : Promise.resolve<TeamFacts>({ hasTeam: false, hasMember: false }),
      canReadKeys ? loadServiceKeyDigest(tenantId) : Promise.resolve<ServiceKeyDigest>({ total: 0, activePrefix: null, everUsed: false }),
    ]).then(([team, keys]) => {
      if (cancelled) return;
      // 只有还能用的密钥才算这一步完成：全被禁用/吊销时清单不该消失，
      // 否则用户既跑不出下一条请求，AccessSnippetBar 又还在催他签一把（Codex P2）。
      setFacts({
        team: team.hasTeam,
        member: team.hasMember,
        // 只有还能用的密钥才算这一步完成（全被禁用/吊销时清单不该消失）。
        key: keys.activePrefix !== null,
        // 「跑通首条请求」取密钥的 lastUsedAt —— 持久事实，不受 90 天日志保留期影响。
        // 叠上本地确证：serving 端 LastUsedAt 是不 await 的后台写，本轮重拉可能
        // 抢在它落库之前，只信 digest 会把刚跑成功的租户又标成未完成（Codex P2）。
        request: keys.everUsed || REQUEST_COMPLETED_TENANTS.has(tenantId),
      });
      setUnavailable(false);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      // 读不到就沉默：不假装「一步都没做」（Codex P2）。
      setFacts(EMPTY_FACTS);
      setUnavailable(true);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // 三个权限位进依赖：切租户或换角色都会重算；revision 让写操作后立刻重算。
  }, [tenantId, canReadOrganization, canReadKeys, revision]);

  const readableOf: Record<OnboardingStepId, boolean> = {
    team: canReadOrganization,
    member: canReadOrganization,
    key: canReadKeys,
    // 判定源已从日志换成密钥的 lastUsedAt，可读性随之改看密钥权限。
    request: canReadKeys,
  };

  const steps: OnboardingStep[] = (Object.keys(STEP_LABEL) as OnboardingStepId[]).map((id) => ({
    id,
    label: STEP_LABEL[id],
    done: facts[id],
    // 到得了页面 **且** 有那一步的写权限才给 CTA——否则 viewer / developer 点进去
    // 是个只读页面，看得见做不了（Codex P2）。没有写权限时由调用方渲染成
    // 「由管理员完成」，与 readable=false 的呈现一致。
    // 三个条件同时成立才给 CTA：页面到得了、有这一步全部写能力、并且**读得到**这一步
    // 的判定源。读不到时 done 恒为 false，若还给「去完成」就是让人去点一个自己也不知道
    // 做完没有的动作（Codex P2）。
    actionable: canAccessPage(tenant, STEP_PAGE[id])
      && readableOf[id]
      && (STEP_WRITE_CAPABILITIES[id] ?? []).every((capability) => canUseCapability(tenant?.role, capability)),
    readable: readableOf[id],
    to: STEP_TO[id],
  }));

  return {
    loading,
    // 读不到的步骤不计入未完成——否则 viewer / billing 会永远盯着一条完不成的清单。
    complete: steps.every((step) => step.done || !step.readable),
    unavailable,
    steps,
  };
}

/** 老手轨用：当前租户可展示的那把密钥（只给前缀）。无权限时 canRead=false，组件据此隐身。 */
export function usePrimaryServiceKey(): { loading: boolean; canRead: boolean; keyPrefix: string | null } {
  const { tenant } = useAuth();
  const tenantId = tenant?.id ?? '';
  const canRead = canAccessPage(tenant, 'serviceKeys');
  const [keyPrefix, setKeyPrefix] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeInvalidation(() => setRevision((n) => n + 1)), []);

  useEffect(() => {
    if (!tenantId || !canRead) {
      setKeyPrefix(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadServiceKeyDigest(tenantId).then((digest) => {
      if (cancelled) return;
      setKeyPrefix(digest.activePrefix);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setKeyPrefix(null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenantId, canRead, revision]);

  return { loading, canRead, keyPrefix };
}
