import { parseDesignArtifactLaunch, TEAM_ID_PATTERN, type DesignArtifactLaunchContext } from '@/lib/designArtifactLaunch';

const SESSION_KEY = 'md-to-ppt-chat-v1';
const OUTLINE_RUN_KEY = 'md-to-ppt-outline-run-v1';
const ACTIVE_CONTEXT_KEY = 'md-to-ppt-active-context-v1';

export interface PptSessionContext {
  id: string;
  sessionKey: string;
  outlineRunKey: string;
  launch: DesignArtifactLaunchContext | null;
  /** 发布落到哪个团队：知识交接带在 launch 里，不带资料的空白会话单独带；都没有即个人空间。 */
  destinationTeamId?: string;
}

function contextFor(
  id: string,
  launch: DesignArtifactLaunchContext | null,
  destinationTeamId?: string,
): PptSessionContext {
  const suffix = id === 'legacy' ? '' : `:${id}`;
  const team = launch?.destinationTeamId ?? destinationTeamId;
  return {
    id,
    sessionKey: SESSION_KEY + suffix,
    outlineRunKey: OUTLINE_RUN_KEY + suffix,
    launch,
    ...(team ? { destinationTeamId: team } : {}),
  };
}

function validTeamId(value: unknown): string | undefined {
  return typeof value === 'string' && TEAM_ID_PATTERN.test(value.trim()) ? value.trim() : undefined;
}

/**
 * 「不带资料，直接打开」这类入口要的是一个空白会话：带上这个参数，就不去恢复上一次的会话游标。
 * 同一 history entry 刷新复用同一个新会话（按 location.key），与显式知识启动同一口径。
 */
export const FRESH_PPT_SESSION_PARAM = 'fresh';
export const FRESH_PPT_SESSION_PATH = `/md-to-ppt-agent?${FRESH_PPT_SESSION_PARAM}=1`;

/** 空白会话的入口地址；从团队空间发起时把团队带上，发布仍落进同一个团队。 */
export function freshPptSessionPath(destinationTeamId?: string | null): string {
  const team = validTeamId(destinationTeamId);
  return team ? `${FRESH_PPT_SESSION_PATH}&destTeam=${encodeURIComponent(team)}` : FRESH_PPT_SESSION_PATH;
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
  const params = new URLSearchParams(location.search);
  if (params.get(FRESH_PPT_SESSION_PARAM) === '1') {
    return contextFor(JSON.stringify(['fresh', location.key]), null, validTeamId(params.get('destTeam')));
  }
  try {
    const raw = storage.getItem(ACTIVE_CONTEXT_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { id?: unknown; launch?: DesignArtifactLaunchContext | null; destinationTeamId?: unknown };
      if (typeof saved.id === 'string' && saved.id)
        return contextFor(saved.id, saved.launch ?? null, validTeamId(saved.destinationTeamId));
    }
  } catch { /* 当前标签页禁用存储时仍可使用默认会话。 */ }
  return contextFor('legacy', null);
}

export function activatePptSessionContext(context: PptSessionContext, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(ACTIVE_CONTEXT_KEY, JSON.stringify({
      id: context.id,
      launch: context.launch,
      ...(context.destinationTeamId ? { destinationTeamId: context.destinationTeamId } : {}),
    }));
  } catch { /* ignore quota errors */ }
}
