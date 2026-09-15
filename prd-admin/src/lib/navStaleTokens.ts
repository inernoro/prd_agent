import { migrateLegacyNavId } from '@/lib/launcherCatalog';
import { NAV_DIVIDER_KEY } from '@/stores/navOrderStore';

/**
 * 从若干导航 token 列表里挑出「目录里已不存在」的条目（菜单下线后残留的旧 key）。
 * - 判定用迁移后的 id：用户偏好里可能还存着 v7 之前的前缀 id（utility:emergence），那不是下线，是旧写法；
 * - 返回的是**原始** token：清理接口要按库里的原样去 pull，迁移后的写法在库里不存在。
 */
export function collectStaleNavTokens(lists: readonly (readonly string[])[], knownIds: ReadonlySet<string>): string[] {
  const set = new Set<string>();
  for (const arr of lists) {
    for (const t of arr) {
      if (t === NAV_DIVIDER_KEY) continue;
      if (!knownIds.has(migrateLegacyNavId(t))) set.add(t);
    }
  }
  return [...set].sort();
}

/** 单个 token 是否已下线（与 collectStaleNavTokens 同一判据） */
export function isStaleNavToken(token: string, knownIds: ReadonlySet<string>): boolean {
  return token !== NAV_DIVIDER_KEY && !knownIds.has(migrateLegacyNavId(token));
}
