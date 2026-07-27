/**
 * 项目级整组的成员归组（Codex 第二十轮 P1）：优先按持久化的 projectGroupId
 * join——项目级计划部分失败/单侧下线会让各 profile 的成员数组错位，按位配对
 * 会把不同批次/不同版本的副本拼成假组，并被整组预览的钉选链放大成错误路由。
 * 无 projectGroupId 的存量成员退回按位配对（各 profile 的无组成员按数组序
 * 对齐）。组序：先存量按位组，再按组内最早 createdAt 升序排 id 组。
 * ReplicaSetPanel 项目舞台与 BranchListPage 整组卡共用本函数（SSOT）。
 */
export interface ProjectGroupMemberLike {
  id: string;
  projectGroupId?: string;
  createdAt?: string;
}

export function buildProjectGroups<M extends ProjectGroupMemberLike>(
  profileIds: string[],
  membersOf: (profileId: string) => M[],
): Array<Record<string, M | undefined>> {
  const idGroups = new Map<string, Record<string, M | undefined>>();
  const legacyByProfile = new Map<string, M[]>();
  for (const pid of profileIds) {
    for (const m of membersOf(pid)) {
      if (m.projectGroupId) {
        const g = idGroups.get(m.projectGroupId) ?? {};
        if (!g[pid]) g[pid] = m;
        idGroups.set(m.projectGroupId, g);
      } else {
        const arr = legacyByProfile.get(pid) ?? [];
        arr.push(m);
        legacyByProfile.set(pid, arr);
      }
    }
  }
  const legacyLen = Math.max(0, ...profileIds.map((p) => legacyByProfile.get(p)?.length ?? 0));
  const groups: Array<Record<string, M | undefined>> = [];
  for (let k = 0; k < legacyLen; k += 1) {
    const g: Record<string, M | undefined> = {};
    for (const pid of profileIds) g[pid] = legacyByProfile.get(pid)?.[k];
    groups.push(g);
  }
  const earliest = (g: Record<string, M | undefined>): string => {
    let min = '';
    for (const m of Object.values(g)) {
      if (m?.createdAt && (!min || m.createdAt < min)) min = m.createdAt;
    }
    return min || '9999';
  };
  groups.push(...[...idGroups.values()].sort((a, b) => earliest(a).localeCompare(earliest(b))));
  return groups;
}

/** 生成一次「整组副本」手势的组 id（进 add-replica 计划步骤参数，后端持久化到成员）。 */
export function newProjectGroupId(): string {
  return `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 单个计划步数上限 —— 必须与后端 `cds/src/services/replica-set.ts` 的
 * `REPLICA_PLAN_MAX_STEPS` 相等（Codex 第二十六轮 P2）。项目级整组动作按服务数
 * 生成步骤，前端据此在**加草稿前**预检并给出可读提示，而不是让用户攒完一堆草稿
 * 才在保存时撞 400。两值漂移由 tests/web/replica-plan-limit-contract.test.ts 拦截。
 */
export const REPLICA_PLAN_MAX_STEPS = 60;

/**
 * 分流占比（%）—— 全零权重必须按 resolver 的真实行为渲染（Codex 第三十七轮 P2）。
 *
 * 权重 0 是合法值：`primaryWeight=0` + 全部运行中成员都是 0 时总权重为 0，
 * 直接 `weight / total` 会渲染出 `NaN%`。而 forwarder 在这种情况下并不是「不转发」，
 * 而是**回落到主实例**（SSOT：`cds/src/forwarder/route-resolver.ts` 的 `total <= 0`
 * 分支）。所以画布必须显示「主 100% / 副本 0%」——既不是 NaN，也不能装作还在分流，
 * 否则用户看到的占比与真实落点相反。
 */
export function replicaSharePct(weight: number, totalWeight: number, isPrimary: boolean): number {
  if (totalWeight > 0) return Math.round((weight / totalWeight) * 100);
  return isPrimary ? 100 : 0;
}
