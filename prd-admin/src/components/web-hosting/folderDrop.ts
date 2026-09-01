export const WEB_PAGE_FOLDER_SLOT_PREFIX = 'web-page-folder:';
export const WEB_PAGE_GROUP_SLOT_PREFIX = 'web-page-group:';

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
