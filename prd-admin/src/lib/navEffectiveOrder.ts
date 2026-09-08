import { migrateLegacyNavId } from '@/lib/launcherCatalog';
import { NAV_DIVIDER_KEY } from '@/stores/navOrderStore';

export interface EffectiveNavEntry {
  /** 原始 token（库里怎么存就怎么给，分隔符也在内） */
  token: string;
  /** 迁移后的 id，用它去查目录 */
  id: string;
  /** true = 不在保存的顺序里、由侧栏自动补到末尾的目录项（AppShell「新功能上线兜底」） */
  auto: boolean;
}

/**
 * 复演 AppShell 的侧栏渲染规则：按保存的顺序排，再把目录里可见、既不在顺序里也没被隐藏的项追加到末尾。
 * 总览按这个画，用户看到的行才等于他侧栏里真实的那一列（用户反馈「只覆盖了一部分」的根因）。
 * 与 AppShell 一样按迁移后的 id 去重、按隐藏集过滤；重复出现的 token 只保留第一次。
 */
export function buildEffectiveNavOrder(args: {
  order: readonly string[];
  hidden: readonly string[];
  /** 侧栏对该用户可见的目录 appKey（不含 home），顺序即 AppShell 追加顺序 */
  sidebarIds: readonly string[];
}): EffectiveNavEntry[] {
  const hidden = new Set(args.hidden.map(migrateLegacyNavId));
  const seen = new Set<string>();
  const result: EffectiveNavEntry[] = [];
  for (const token of args.order) {
    if (token === NAV_DIVIDER_KEY) {
      result.push({ token, id: token, auto: false });
      continue;
    }
    const id = migrateLegacyNavId(token);
    if (seen.has(id) || hidden.has(id)) continue;
    seen.add(id);
    result.push({ token, id, auto: false });
  }
  for (const id of args.sidebarIds) {
    if (seen.has(id) || hidden.has(id)) continue;
    seen.add(id);
    result.push({ token: id, id, auto: true });
  }
  return collapseDividerEntries(result);
}

/** 与 AppShell 一致：段里没攒到可见项就不出横杆——去掉开头、连续、结尾的分隔符（隐藏过滤后常见） */
function collapseDividerEntries(entries: EffectiveNavEntry[]): EffectiveNavEntry[] {
  const out: EffectiveNavEntry[] = [];
  for (const e of entries) {
    if (e.token === NAV_DIVIDER_KEY) {
      if (out.length === 0 || out[out.length - 1].token === NAV_DIVIDER_KEY) continue;
    }
    out.push(e);
  }
  while (out.length > 0 && out[out.length - 1].token === NAV_DIVIDER_KEY) out.pop();
  return out;
}

/**
 * 与 AppShell.effectiveNavHidden 同口径：管理员默认隐藏项（除非用户把它显式排进了 navOrder）∪ 用户自己隐藏的。
 * 只隐藏过、没排过顺序的人（navOrder 空、navHidden 非空）侧栏走默认顺序，总览也一样——
 * 顺序取舍看 navOrder 是否为空，不看后端的 customized 标签（Codex P2）。
 */
export function mergeEffectiveHidden(navOrder: readonly string[], navHidden: readonly string[], defaultHidden: readonly string[]): string[] {
  const userNavSet = new Set(navOrder.filter((k) => k !== NAV_DIVIDER_KEY).map(migrateLegacyNavId));
  const merged: string[] = [];
  for (const key of defaultHidden) {
    if (!userNavSet.has(migrateLegacyNavId(key))) merged.push(key);
  }
  for (const key of navHidden) if (!merged.includes(key)) merged.push(key);
  return merged;
}
