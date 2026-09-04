import type { WebHostingRole } from '@/services/real/teams';
import { canEditInWebHosting } from '@/lib/webHostingRole';

export const WEB_PAGE_FOLDER_SLOT_PREFIX = 'web-page-folder:';
export const WEB_PAGE_GROUP_SLOT_PREFIX = 'web-page-group:';

export type PersonalFolderCreatePlan =
  | { kind: 'invalid' }
  | { kind: 'select'; name: string }
  | { kind: 'create'; name: string };

export function personalFolderNamesEqual(
  left: string,
  right: string,
  leftCanonicalName?: string,
  rightCanonicalName?: string,
): boolean {
  if (leftCanonicalName !== undefined && rightCanonicalName !== undefined) {
    return leftCanonicalName === rightCanonicalName;
  }
  return left.trim() === right.trim();
}

/**
 * 持久文件夹优先提供显示名称，历史站点只补不存在的逻辑文件夹。
 * 去重口径与服务端 Trim + FormC + ToUpperInvariant 保持一致。
 */
export function mergePersonalFolderOptions(
  managedFolderNames: readonly string[],
  legacyFolderNames: readonly string[],
  canonicalNames: ReadonlyMap<string, string> = new Map(),
): string[] {
  const byCanonicalName = new Map<string, string>();
  for (const sourceName of [...managedFolderNames, ...legacyFolderNames]) {
    const displayName = sourceName.trim();
    if (!displayName) continue;
    const canonicalName = canonicalNames.get(sourceName) ?? canonicalNames.get(displayName) ?? displayName;
    if (!byCanonicalName.has(canonicalName)) byCanonicalName.set(canonicalName, displayName);
  }
  return [...byCanonicalName.values()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/**
 * 区分“已经持久化的文件夹”和“仅由站点旧 folder 字段推导出的同名选项”。
 * 后者仍必须创建 WebFolder 记录，否则最后一个站点移走后文件夹会凭空消失。
 */
export function planPersonalFolderCreate(
  requestedName: string,
  managedFolderNames: readonly string[],
  visibleFolderNames: readonly string[],
): PersonalFolderCreatePlan {
  const normalized = requestedName.trim();
  if (!normalized) return { kind: 'invalid' };
  const matches = (name: string) => personalFolderNamesEqual(name, normalized);
  const managed = managedFolderNames.find(matches);
  if (managed) return { kind: 'select', name: managed };
  const legacy = visibleFolderNames.find(matches);
  return { kind: 'create', name: legacy ?? normalized };
}

export function canDropSiteIntoTeamGroup(
  role: WebHostingRole | null | undefined,
  ownerUserId: string | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  const isSiteOwner = !!currentUserId && ownerUserId === currentUserId;
  return isSiteOwner || canEditInWebHosting(role);
}

export function buildWebPageFolderSlot(folder: string): string {
  return `${WEB_PAGE_FOLDER_SLOT_PREFIX}${encodeURIComponent(folder)}`;
}

export function buildWebPageGroupSlot(groupId: string): string {
  return `${WEB_PAGE_GROUP_SLOT_PREFIX}${encodeURIComponent(groupId)}`;
}

export function parseWebPageDropSlot(slotKey: string):
  | { kind: 'folder'; value: string }
  | { kind: 'group'; value: string }
  | null {
  const parse = (prefix: string) => {
    if (!slotKey.startsWith(prefix)) return null;
    try {
      const value = decodeURIComponent(slotKey.slice(prefix.length)).trim();
      return value || null;
    } catch {
      return null;
    }
  };

  const folder = parse(WEB_PAGE_FOLDER_SLOT_PREFIX);
  if (folder) return { kind: 'folder', value: folder };
  const group = parse(WEB_PAGE_GROUP_SLOT_PREFIX);
  if (group) return { kind: 'group', value: group };
  return null;
}
