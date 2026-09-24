import { parseDesignArtifactLaunch, type DesignArtifactLaunchContext } from '@/lib/designArtifactLaunch';

const SESSION_KEY = 'md-to-ppt-chat-v1';
const OUTLINE_RUN_KEY = 'md-to-ppt-outline-run-v1';
const ACTIVE_CONTEXT_KEY = 'md-to-ppt-active-context-v1';

export interface PptSessionContext {
  id: string;
  sessionKey: string;
  outlineRunKey: string;
  launch: DesignArtifactLaunchContext | null;
}

function contextFor(id: string, launch: DesignArtifactLaunchContext | null): PptSessionContext {
  const suffix = id === 'legacy' ? '' : `:${id}`;
  return { id, sessionKey: SESSION_KEY + suffix, outlineRunKey: OUTLINE_RUN_KEY + suffix, launch };
}

/** 只存恢复游标，不复制服务器任务。每次显式知识启动独立；同一 history entry 刷新复用。 */
export function resolvePptSessionContext(
  location: { key: string; search: string },
  storage: Pick<Storage, 'getItem'>,
): PptSessionContext {
  const launch = parseDesignArtifactLaunch(location.search);
  if (launch?.target === 'html-ppt') {
    const id = JSON.stringify([location.key, launch.sourceStoreId, launch.sourceEntryId]);
    return contextFor(id, launch);
  }
  try {
    const raw = storage.getItem(ACTIVE_CONTEXT_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { id?: unknown; launch?: DesignArtifactLaunchContext | null };
      if (typeof saved.id === 'string' && saved.id) return contextFor(saved.id, saved.launch ?? null);
    }
  } catch { /* 当前标签页禁用存储时仍可使用默认会话。 */ }
  return contextFor('legacy', null);
}

export function activatePptSessionContext(context: PptSessionContext, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(ACTIVE_CONTEXT_KEY, JSON.stringify({ id: context.id, launch: context.launch }));
  } catch { /* ignore quota errors */ }
}
