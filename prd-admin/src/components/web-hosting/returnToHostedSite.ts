import type { HostedSite } from '@/services/real/webPages';
import type { Space } from '@/components/team/SpaceBar';

export function returnedSiteSpace(site: HostedSite, teamIds: string[], previous: Space): Space | null {
  const shared = site.sharedTeamIds ?? [];
  if (!shared.length) return { kind: 'personal' };
  const available = shared.filter((id) => teamIds.includes(id));
  const teamId = previous.kind === 'team' && available.includes(previous.teamId)
    ? previous.teamId : available[0];
  return teamId ? { kind: 'team', teamId } : null;
}

/** 短暂强调目标，减少动态效果时只显示静态边框；卸载时恢复原样。 */
export function highlightReturnedSite(element: HTMLElement): () => void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  const previous = element.style.outline;
  element.style.outline = '2px solid var(--accent-primary)';
  const animation = !reduced && element.animate?.([
    { boxShadow: '0 0 0 0 var(--accent-primary)' },
    { boxShadow: '0 0 0 7px transparent' },
  ], { duration: 1200, iterations: 2 });
  return () => { element.style.outline = previous; if (animation) animation.cancel(); };
}

/** 深链读取并入唯一列表；只在定位尚未完成时保留分页之外的目标。 */
export function retainReturnTarget(items: HostedSite[], previous: HostedSite[], targetId: string | null, space: Space): HostedSite[] {
  if (!targetId || items.some(site => site.id === targetId)) return items;
  const target = previous.find(site => site.id === targetId);
  if (!target) return items;
  const inSpace = space.kind === 'team' ? target.sharedTeamIds?.includes(space.teamId) : !target.sharedTeamIds?.length;
  return inSpace ? [target, ...items] : items;
}
