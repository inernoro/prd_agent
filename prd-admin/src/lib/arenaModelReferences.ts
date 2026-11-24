import type { ArenaGroup, ArenaSlot } from '@/services/contracts/arena';

export function arenaUnavailableSlots(slots: ArenaSlot[]): ArenaSlot[] {
  return slots.filter(slot => slot.enabled !== false && slot.modelReferenceStatus !== 'available');
}

/** 展示服务端预检结果；阵容身份有变化时必须由用户核对后重新开始。 */
export function arenaLineupProblem(previous: ArenaGroup | undefined, current: ArenaGroup | undefined): string | null {
  if (!current || !current.slots.length) return '当前阵容没有可用槽位，请先配置阵容。';
  if (arenaUnavailableSlots(current.slots).length) return '阵容中有模型引用需要修复，请先检查阵容。';
  const identity = (group?: ArenaGroup) => (group?.slots ?? []).map(slot => `${slot.id}:${slot.logicalModelId ?? ''}`).sort().join('|');
  if (identity(previous) !== identity(current)) return '阵容已更新，请核对后重新开始。';
  return null;
}
