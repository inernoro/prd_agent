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
import { canAccessPage } from '@/lib/access';
import type { ConsolePage } from '@/lib/access';
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
      (item) => item.enabled && (!item.expiresAt || new Date(item.expiresAt).getTime() > now),
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
  const canReadOrganization = canAccessPage(tenant, 'organization');
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
        request: keys.everUsed,
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
    // 到不了那个页面就不给 CTA——否则 viewer / billing 点进去只会撞权限墙。
    actionable: canAccessPage(tenant, STEP_PAGE[id]),
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
