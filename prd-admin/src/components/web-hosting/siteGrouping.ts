import type { HostedSite, WebPageGroup } from '@/services/real/webPages';
import { siteSourceLabel } from './siteFormRegistry';

/**
 * 主控台列表的「组织方式」。设计稿屏 1·A 的工具条给了四档：
 * 按时间 / 按文件夹 / 按分组 / 按来源。
 *
 * 其中「按文件夹」（个人空间的 folder 字段）与「按分组」（团队空间的专题/分类实体）
 * 在同一空间里只有一档成立，所以 UI 按空间只露成立的那一档 —— 不摆没得选的按钮
 * （`.claude/rules/chief-designer-usability.md` 第二原则）。
 */
export type GroupMode = 'time' | 'folder' | 'group' | 'source';

export interface SiteGroup {
  key: string;
  label: string;
  items: HostedSite[];
}

export function toDateBucketLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知时间';
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 按分组方式把（已排序的）站点列表切成分节。
 * 关键：保持传入数组的顺序（= 排序结果），只按 first-seen 顺序建组，
 * 因此「分组」与「排序」互不干扰 —— 排序决定顺序，分组只插标题。 */
export function buildSiteGroups(
  items: HostedSite[],
  mode: GroupMode,
  teamGroups?: WebPageGroup[],
  now = new Date(),
): SiteGroup[] {
  const groupById = new Map((teamGroups ?? []).map((g) => [g.id, g]));
  const map = new Map<string, SiteGroup>();
  for (const site of items) {
    let key: string;
    let label: string;
    if (mode === 'group') {
      const g = site.groupId ? groupById.get(site.groupId) : undefined;
      key = g ? `g:${g.id}` : 'g:__none__';
      label = g ? `${g.kind === 'topic' ? '专题' : '分类'} · ${g.name}` : '未分组';
    } else if (mode === 'folder') {
      key = site.folder ? `f:${site.folder}` : 'f:__none__';
      label = site.folder || '未分类';
    } else if (mode === 'source') {
      // 来源标签走注册表，不在这里再抄一份中文名
      key = `s:${site.sourceType || 'upload'}`;
      label = siteSourceLabel(site.sourceType || 'upload');
    } else {
      label = toDateBucketLabel(site.createdAt, now);
      key = `t:${label}`;
    }
    let g = map.get(key);
    if (!g) {
      g = { key, label, items: [] };
      map.set(key, g);
    }
    g.items.push(site);
  }
  return [...map.values()];
}

/** 设计稿工具条固定四档，顺序不变 */
export const ALL_GROUP_MODES: GroupMode[] = ['time', 'folder', 'group', 'source'];

/** 当前空间里成立的档位。四档常驻展示，不成立的置灰而不是消失——
 *  消失会让用户以为这个功能没做（设计稿四档同排）。 */
export function availableGroupModes(spaceKind: 'personal' | 'team'): GroupMode[] {
  return spaceKind === 'team'
    ? ['time', 'group', 'source']
    : ['time', 'folder', 'source'];
}

/** 某档在当前空间是否成立，以及为什么不成立（置灰时的 title） */
export function groupModeAvailability(mode: GroupMode, spaceKind: 'personal' | 'team'): { ok: boolean; reason?: string } {
  if (availableGroupModes(spaceKind).includes(mode)) return { ok: true };
  return {
    ok: false,
    reason: mode === 'folder'
      ? '文件夹是个人空间的归档方式，团队空间请用「按分组」'
      : '分组（专题/分类）是团队空间的归档方式，个人空间请用「按文件夹」',
  };
}

export const GROUP_MODE_LABELS: Record<GroupMode, string> = {
  time: '按时间',
  folder: '按文件夹',
  group: '按分组',
  source: '按来源',
};

/** 空间切换后旧档位可能不成立（个人的「按文件夹」到团队就没有了），落回按时间 */
export function normalizeGroupMode(mode: GroupMode, spaceKind: 'personal' | 'team'): GroupMode {
  return availableGroupModes(spaceKind).includes(mode) ? mode : 'time';
}
