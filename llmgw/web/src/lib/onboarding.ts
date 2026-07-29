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
import { getLogsSummary, getOrganization, getServiceKeys } from '@/lib/api';
import { canAccessPage } from '@/lib/access';
import type { ConsolePage } from '@/lib/access';
import { useAuth } from '@/lib/auth';

/** 缓存 TTL：够短，签发密钥后回到概览页最多一分钟就能看到步骤变绿。 */
const TTL_MS = 60_000;

/** 「有过请求」看的是整个生命周期，不是日志页默认的 7 天窗口。 */
const REQUEST_LOOKBACK_DAYS = 365;

type CacheKind = 'organization' | 'serviceKeys' | 'requests';

const CACHE = new Map<string, { at: number; promise: Promise<unknown> }>();

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

/** 供签发密钥、创建团队等写操作之后主动刷新（不传租户则清空全部）。 */
export function invalidateOnboardingCache(tenantId?: string) {
  if (!tenantId) {
    CACHE.clear();
    return;
  }
  for (const key of [...CACHE.keys()]) {
    if (key.endsWith(`::${tenantId}`)) CACHE.delete(key);
  }
}

type TeamFacts = { hasTeam: boolean; hasMember: boolean };

function loadTeamFacts(tenantId: string): Promise<TeamFacts> {
  return cached('organization', tenantId, async () => {
    const response = await getOrganization();
    if (!response.success) return { hasTeam: false, hasMember: false };
    return {
      hasTeam: response.data.teams.length > 0,
      hasMember: response.data.members.length > 1,
    };
  });
}

/** 掩码展示用：只取前缀与可用状态，永远不涉及密钥明文（明文只在签发那一刻存在）。 */
export type ServiceKeyDigest = { total: number; activePrefix: string | null };

function loadServiceKeyDigest(tenantId: string): Promise<ServiceKeyDigest> {
  return cached('serviceKeys', tenantId, async () => {
    const response = await getServiceKeys();
    if (!response.success) return { total: 0, activePrefix: null };
    const items = response.data;
    const usable = items.find((item) => item.enabled);
    return { total: items.length, activePrefix: usable?.keyPrefix ?? null };
  });
}

function loadHasRequests(tenantId: string): Promise<boolean> {
  return cached('requests', tenantId, async () => {
    const to = new Date();
    const from = new Date(to.getTime() - REQUEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const response = await getLogsSummary({ from: from.toISOString(), to: to.toISOString(), pageSize: 1 });
    return response.success && response.data.total > 0;
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
  const canReadLogs = canAccessPage(tenant, 'logs');

  const [facts, setFacts] = useState<Facts>(EMPTY_FACTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) {
      setFacts(EMPTY_FACTS);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      canReadOrganization ? loadTeamFacts(tenantId) : Promise.resolve<TeamFacts>({ hasTeam: false, hasMember: false }),
      canReadKeys ? loadServiceKeyDigest(tenantId) : Promise.resolve<ServiceKeyDigest>({ total: 0, activePrefix: null }),
      canReadLogs ? loadHasRequests(tenantId) : Promise.resolve(false),
    ]).then(([team, keys, hasRequests]) => {
      if (cancelled) return;
      setFacts({ team: team.hasTeam, member: team.hasMember, key: keys.total > 0, request: hasRequests });
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setFacts(EMPTY_FACTS);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // 三个权限位进依赖：切租户或换角色都会重算。
  }, [tenantId, canReadOrganization, canReadKeys, canReadLogs]);

  const readableOf: Record<OnboardingStepId, boolean> = {
    team: canReadOrganization,
    member: canReadOrganization,
    key: canReadKeys,
    request: canReadLogs,
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
  }, [tenantId, canRead]);

  return { loading, canRead, keyPrefix };
}
