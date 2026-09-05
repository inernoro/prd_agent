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
  return result;
}
