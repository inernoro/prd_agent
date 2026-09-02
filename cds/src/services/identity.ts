/**
 * identity —— 身份层的全部判据（纯函数）。
 *
 * ## 它解决的那件事
 *
 * 此前系统里只有钥匙、没有持有者：**钥匙即身份**。于是四件事一起坏：
 *
 * - 钥匙丢了等于身份没了，要重新申请、重新批（挪个目录就中招）；
 * - 钥匙换了，之前批过的运维授权全部失配 —— 「莫名其妙又要审批」的最大来源；
 * - 吊销列表按钥匙平铺，看不出哪把是谁的，用久了糊成一片；
 * - 「从没签发」与「被吊销」只能靠列表里有没有那一行来区分，删也不是留也不是。
 *
 * 四笔债长在同一个根上。补一层很轻的主体（一台机器一个、一个智能体一个，**不是
 * 一把钥匙一个**），加上「用户级凭证签发项目级凭证」和「项目授权表」，四条一起松开。
 *
 * ## 一条必须摆正的事
 *
 * 「用户级只授权不操作」**不是拦截，是留痕**。拿到用户级凭证的人仍然可以先签一张
 * 项目级、再用它去删东西，只是多走一步，最终能力并没有变小。它真正换来的是两样
 * 别的东西：每一次滥用都必然留下一条签发记录（直接操作不留痕，签发一定留痕），
 * 以及一处可一键切断的总闸。所以下面的有效期、级联撤销、签发计数不是装饰，
 * 是这套设计成立的前提。
 *
 * 纯函数：不读 state、不碰网络，可直接单测。
 */

import type { AgentKey, Principal, ProjectGrant, UserCredential } from '../types.js';

/** 用户级凭证有效期：90 天，用一次自动续 90 天（滑动窗口）。 */
export const USER_CREDENTIAL_TTL_DAYS = 90;
/**
 * 项目级凭证有效期：30 天，用即续。
 *
 * 今天存量密钥永不过期，是因为丢了很麻烦；有了自愈补发，丢了不麻烦了，所以没
 * 理由再让它长生。**只对新签发的生效**：存量密钥没有 expiresAt，永远不过期。
 */
export const PROJECT_CREDENTIAL_TTL_DAYS = 30;
/** 吊销记录保留期：90 天后归档，主列表只给活的。 */
export const REVOCATION_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysFromNow(days: number, now: number = Date.now()): string {
  return new Date(now + days * DAY_MS).toISOString();
}

export type CredentialUsability =
  | { usable: true }
  | { usable: false; reason: 'revoked' | 'expired' | 'principal-disabled' | 'principal-missing' };

/**
 * 一张凭证此刻能不能用。
 *
 * 三种不可用要分开报：吊销 / 过期 / 主体被停用。合并成一句「不可用」，
 * 又会退回到自检端点要解决的那个问题上去。
 */
export function credentialUsability(
  cred: Pick<UserCredential, 'revokedAt' | 'expiresAt'> | Pick<AgentKey, 'revokedAt' | 'expiresAt'>,
  principal: Pick<Principal, 'status'> | undefined,
  now: number = Date.now(),
  requirePrincipal = false,
): CredentialUsability {
  if (cred.revokedAt) return { usable: false, reason: 'revoked' };
  const expiresAt = (cred as { expiresAt?: string }).expiresAt;
  // 没有 expiresAt = 永不过期（存量密钥），刻意不视为过期。
  if (expiresAt && Date.parse(expiresAt) <= now) return { usable: false, reason: 'expired' };
  if (!principal) {
    return requirePrincipal ? { usable: false, reason: 'principal-missing' } : { usable: true };
  }
  if (principal.status !== 'active') return { usable: false, reason: 'principal-disabled' };
  return { usable: true };
}

/**
 * 用一次自动续期后的新到期时间。
 *
 * 只在「确实会往后推」时返回新值，否则返回 undefined —— 避免每次调用都写一次
 * state（滑动窗口不该把状态写爆）。阈值取一天：一天内重复使用不重复落盘。
 */
export function slideExpiry(
  currentExpiresAt: string | undefined,
  ttlDays: number,
  now: number = Date.now(),
): string | undefined {
  const next = now + ttlDays * DAY_MS;
  if (!currentExpiresAt) return new Date(next).toISOString();
  const current = Date.parse(currentExpiresAt);
  if (Number.isNaN(current)) return new Date(next).toISOString();
  if (next - current < DAY_MS) return undefined;
  return new Date(next).toISOString();
}

/** 某主体对某项目是否**当前**有授权（created 与 approved 一视同仁）。 */
export function hasActiveGrant(
  grants: readonly ProjectGrant[],
  principalId: string,
  projectId: string,
): boolean {
  return grants.some(
    (g) => g.principalId === principalId && g.projectId === projectId && !g.revokedAt,
  );
}

export type IssueDecision =
  | { allowed: true; grant: ProjectGrant }
  | { allowed: false; reason: 'principal-disabled' | 'no-grant'; message: string };

/**
 * 「这个主体能不能自助为这个项目签一张项目级凭证」。
 *
 * 这是自愈链路的闸门：仓库里的凭据文件丢了（挪目录、换机器、新 clone），
 * 授权还在就当场补一张、全程零人工；没授权才走页面批准 —— 正是「默认只对
 * 自己创建的项目有权限，其余手动批一次」那条规则。
 */
export function decideProjectCredentialIssue(
  principal: Pick<Principal, 'id' | 'status'> | undefined,
  grants: readonly ProjectGrant[],
  projectId: string,
): IssueDecision {
  if (!principal || principal.status !== 'active') {
    return {
      allowed: false,
      reason: 'principal-disabled',
      message: '该主体不存在或已被停用，不能签发任何凭证。',
    };
  }
  const grant = grants.find(
    (g) => g.principalId === principal.id && g.projectId === projectId && !g.revokedAt,
  );
  if (!grant) {
    return {
      allowed: false,
      reason: 'no-grant',
      message: `主体对项目 ${projectId} 没有授权。这个项目不是它建的，需要走一次页面批准；批准之后同一主体换机器、丢凭据都不必再批。`,
    };
  }
  return { allowed: true, grant };
}

/**
 * 撤销一张用户级凭证时，要一起失效的下游项目级凭证。
 *
 * 级联撤销是出事时手里**唯一**的开关：用户级凭证只授权不操作，所以滥用一定
 * 表现为「签出一堆项目级凭证」，撤掉源头却留着下游等于撤了个寂寞。
 */
export function cascadeRevokeTargets(
  agentKeys: readonly (AgentKey & { projectId?: string })[],
  userCredentialId: string,
): Array<{ keyId: string; projectId?: string }> {
  return agentKeys
    .filter((k) => k.issuedByCredentialId === userCredentialId && !k.revokedAt)
    .map((k) => ({ keyId: k.id, ...(k.projectId ? { projectId: k.projectId } : {}) }));
}

export interface PrincipalCredentialView {
  id: string;
  kind: 'user' | 'project';
  label?: string;
  projectId?: string;
  projectName?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  /**
   * 这条凭据**当前实际能不能用**，与鉴权同一口径。
   *
   * 只看凭据自己的吊销与到期是不够的：主体被停用、项目授权被撤，鉴权都会拒，
   * 而总览若仍把它算进「有效凭证」，这一屏就在骗管理员——他刚点了停用，界面
   * 却告诉他对方还有 N 张有效凭证。
   */
  status: 'active' | 'expired' | 'revoked' | 'principal-disabled' | 'grant-revoked';
  /** 用户级凭证专有：累计签出过几张下游凭证（签发留痕） */
  issuedCount?: number;
  lastIssuedAt?: string;
}

export interface PrincipalOverviewRow {
  principal: Principal;
  activeCredentials: PrincipalCredentialView[];
  /** 已吊销 / 已过期的凭证，默认折叠；超过保留期的直接不出现在这里 */
  retiredCredentials: PrincipalCredentialView[];
  grants: Array<{ id: string; projectId: string; projectName?: string; origin: ProjectGrant['origin']; grantedAt: string }>;
}

export interface OverviewInput {
  principals: readonly Principal[];
  userCredentials: readonly UserCredential[];
  /** 项目级凭证（现有 AgentKey），带上它所属的项目 */
  projectCredentials: readonly (AgentKey & { projectId: string; projectName?: string })[];
  grants: readonly ProjectGrant[];
  projectNameById?: Record<string, string>;
  now?: number;
  retentionDays?: number;
}

export interface OverviewResult {
  rows: PrincipalOverviewRow[];
  /** 没有认领主体的存量凭证 —— 明说出来，不假装它们不存在 */
  unclaimed: PrincipalCredentialView[];
  /** 超过保留期、已从主列表归档掉的条数（不是删除，是不再展示） */
  archivedCount: number;
}

function viewOfUserCredential(
  cred: UserCredential,
  now: number,
  principal?: Pick<Principal, 'status'>,
): PrincipalCredentialView {
  const usability = credentialUsability(cred, principal, now);
  return {
    id: cred.id,
    kind: 'user',
    ...(cred.label ? { label: cred.label } : {}),
    createdAt: cred.createdAt,
    expiresAt: cred.expiresAt,
    ...(cred.lastUsedAt ? { lastUsedAt: cred.lastUsedAt } : {}),
    ...(cred.revokedAt ? { revokedAt: cred.revokedAt } : {}),
    ...(cred.revokedBy ? { revokedBy: cred.revokedBy } : {}),
    status: usability.usable
      ? 'active'
      : usability.reason === 'revoked'
        ? 'revoked'
        : usability.reason === 'principal-disabled'
          ? 'principal-disabled'
          : 'expired',
    ...(cred.issuedCount !== undefined ? { issuedCount: cred.issuedCount } : {}),
    ...(cred.lastIssuedAt ? { lastIssuedAt: cred.lastIssuedAt } : {}),
  };
}

function viewOfProjectCredential(
  key: AgentKey & { projectId: string },
  projectName: string | undefined,
  now: number,
  principal?: Pick<Principal, 'status'>,
  grants?: readonly ProjectGrant[],
): PrincipalCredentialView {
  const usability = credentialUsability(key, principal, now);
  // 授权被撤时鉴权照样拒 —— 与 findAgentKeyForAuth 同一条判据，别让总览显示成有效。
  const grantGone = Boolean(key.principalId) && Boolean(grants)
    && usability.usable
    && !hasActiveGrant(grants!, key.principalId!, key.projectId);
  return {
    id: key.id,
    kind: 'project',
    ...(key.label ? { label: key.label } : {}),
    projectId: key.projectId,
    ...(projectName ? { projectName } : {}),
    createdAt: key.createdAt,
    ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
    ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
    ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}),
    status: grantGone
      ? 'grant-revoked'
      : usability.usable
        ? 'active'
        : usability.reason === 'revoked'
          ? 'revoked'
          : usability.reason === 'principal-disabled'
            ? 'principal-disabled'
            : 'expired',
  };
}

/** 某条已退役凭证是否还该出现在「已吊销（折叠）」里。 */
function withinRetention(view: PrincipalCredentialView, now: number, retentionDays: number): boolean {
  const stamp = view.revokedAt || view.expiresAt;
  if (!stamp) return true;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return true;
  return now - at <= retentionDays * DAY_MS;
}

/**
 * 权限总览：**按主体聚合，不按钥匙平铺**。
 *
 * 主列表列的是主体（十几个），凭证历史折叠在主体下面；超过保留期的退役凭证
 * 直接不出现（归档，不是删除 —— 审计留在 state 里）。这就是「保留一大片」与
 * 「删了分不清」之外的第三条路：看板只回答「现在有谁能进来」，
 * 「这把到底怎么了」交给凭据自检端点。
 */
export function buildPrincipalOverview(input: OverviewInput): OverviewResult {
  const now = input.now ?? Date.now();
  const retentionDays = input.retentionDays ?? REVOCATION_RETENTION_DAYS;
  const nameById = input.projectNameById || {};
  const byPrincipal = new Map<string, { active: PrincipalCredentialView[]; retired: PrincipalCredentialView[] }>();
  const bucket = (principalId: string) => {
    let b = byPrincipal.get(principalId);
    if (!b) { b = { active: [], retired: [] }; byPrincipal.set(principalId, b); }
    return b;
  };

  let archivedCount = 0;
  const unclaimed: PrincipalCredentialView[] = [];

  for (const cred of input.userCredentials) {
    const view = viewOfUserCredential(
      cred, now, input.principals.find((p) => p.id === cred.principalId),
    );
    const target = bucket(cred.principalId);
    if (view.status === 'active') target.active.push(view);
    else if (withinRetention(view, now, retentionDays)) target.retired.push(view);
    else archivedCount += 1;
  }

  for (const key of input.projectCredentials) {
    const principal = key.principalId
      ? input.principals.find((p) => p.id === key.principalId)
      : undefined;
    const view = viewOfProjectCredential(
      key, key.projectName || nameById[key.projectId], now, principal, input.grants,
    );
    if (!key.principalId) {
      // 存量凭证没有主体：明说「未认领」，不假装它们不存在，也不硬塞给某个主体。
      if (view.status === 'active' || withinRetention(view, now, retentionDays)) unclaimed.push(view);
      else archivedCount += 1;
      continue;
    }
    const target = bucket(key.principalId);
    if (view.status === 'active') target.active.push(view);
    else if (withinRetention(view, now, retentionDays)) target.retired.push(view);
    else archivedCount += 1;
  }

  const grantsByPrincipal = new Map<string, ProjectGrant[]>();
  for (const grant of input.grants) {
    if (grant.revokedAt) continue;
    const list = grantsByPrincipal.get(grant.principalId) || [];
    list.push(grant);
    grantsByPrincipal.set(grant.principalId, list);
  }

  const rows: PrincipalOverviewRow[] = input.principals.map((principal) => {
    const b = byPrincipal.get(principal.id) || { active: [], retired: [] };
    return {
      principal,
      activeCredentials: b.active,
      retiredCredentials: b.retired,
      grants: (grantsByPrincipal.get(principal.id) || []).map((g) => ({
        id: g.id,
        projectId: g.projectId,
        ...(nameById[g.projectId] ? { projectName: nameById[g.projectId] } : {}),
        origin: g.origin,
        grantedAt: g.grantedAt,
      })),
    };
  });

  return { rows, unclaimed, archivedCount };
}
