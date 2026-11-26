/** 关系页的会话内返回上下文；只恢复界面任务，不参与权限或业务操作。刷新/未知来源回分支详情。 */
type BranchListReturnTask = { kind: 'branches'; branchId: string; projectId: string; activeTagFilter: string | null; showArchived: boolean; selectedBranchIds: string[]; relationExpanded: boolean };
export type RelationReturnTask = BranchListReturnTask | { kind: 'branch'; branchId: string };
interface Origin {
  token: string; actor: string; sourceKey: string; sourceIndex: number; task: RelationReturnTask; targetKey?: string;
}
const origins = new Map<string, Origin>();
let sequence = 0;
const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
function cloneTask(task: RelationReturnTask): RelationReturnTask {
  return task.kind === 'branches' ? { ...task, selectedBranchIds: [...task.selectedBranchIds] } : { ...task };
}
export function rememberRelationReturn(task: RelationReturnTask, actor: string | null, sourceKey: string, sourceIndex: unknown): string | undefined {
  if (!actor || !isId(task.branchId) || !isId(sourceKey) || !isIndex(sourceIndex)
    || !['branches', 'branch'].includes(task.kind)) return undefined;
  if (task.kind === 'branches' && (!isId(task.projectId) || !task.selectedBranchIds.every(isId))) return undefined;
  // 同一次来源访问只保留最新任务，Forward不得借回已经结束的旧选择。
  for (const [token, origin] of origins) if (origin.actor === actor && origin.sourceKey === sourceKey) origins.delete(token);
  const token = globalThis.crypto?.randomUUID?.() || `relation-${Date.now()}-${++sequence}`;
  origins.set(token, { token, actor, sourceKey, sourceIndex, task: cloneTask(task) });
  if (origins.size > 32) origins.delete(origins.keys().next().value!);
  return token;
}
function matching(token: unknown, actor: string | null, branchId: string | undefined, targetKey: string, targetIndex: unknown): Origin | null {
  if (typeof token !== 'string' || !actor || !isIndex(targetIndex)) return null;
  const origin = origins.get(token);
  return origin && origin.actor === actor && origin.task.branchId === branchId
    && targetIndex === origin.sourceIndex + 1 && (!origin.targetKey || origin.targetKey === targetKey) ? origin : null;
}
/** 仅目标真正挂载后承认离开来源；来源渲染中的普通state更新不会提前消费返回状态。 */
export function enterRelationReturn(token: unknown, actor: string | null, branchId: string | undefined, targetKey: string, targetIndex: unknown): RelationReturnTask['kind'] | null {
  const origin = matching(token, actor, branchId, targetKey, targetIndex);
  if (!origin) return null;
  origin.targetKey = targetKey;
  return origin.task.kind;
}
export function relationReturnKind(token: unknown, actor: string | null, branchId: string | undefined, targetKey: string, targetIndex: unknown): RelationReturnTask['kind'] | null {
  const origin = matching(token, actor, branchId, targetKey, targetIndex);
  return origin?.targetKey === targetKey ? origin.task.kind : null;
}
export function relationRestoreForVisit(actor: string | null, sourceKey: string, sourceIndex: unknown, projectId: string | undefined): { token: string; task: BranchListReturnTask } | null {
  if (!actor || !isIndex(sourceIndex)) return null;
  for (const origin of [...origins.values()].reverse()) {
    if (!origin.targetKey || origin.actor !== actor || origin.sourceKey !== sourceKey || origin.sourceIndex !== sourceIndex) continue;
    const task = origin.task;
    if (task.kind === 'branches' && task.projectId === projectId) {
      return { token: origin.token, task: { ...task, selectedBranchIds: [...task.selectedBranchIds] } };
    }
  }
  return null;
}
export function consumeRelationRestore(token: string): void { origins.delete(token); }
