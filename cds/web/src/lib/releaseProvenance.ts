export function releaseActorLabel(actor?: string): string {
  if (!actor || ['user', 'ai', 'unknown'].includes(actor)) return '发布人待核实';
  if (actor.startsWith('user:')) {
    const parts = actor.split(':');
    try { return parts.length === 3 ? decodeURIComponent(parts[2]) : '发布人待核实'; } catch { return '发布人待核实'; }
  }
  if (actor.startsWith('ai:key:')) return `项目 Agent · ${actor.slice(7)}`;
  return `历史记录：${actor}`;
}
export function releaseMergeState(position?: {aheadCount: number | null; behindCount: number | null}): string {
  if (!position || position.aheadCount === null || position.behindCount === null) return '回并待核实';
  return position.aheadCount === 0 ? '主干已包含该版本历史' : '存在尚未回并的提交';
}
