export type DesignArtifactTarget = 'web-page' | 'html-ppt';

export interface DesignArtifactLaunchContext {
  target: DesignArtifactTarget;
  sourceStoreId: string;
  sourceEntryId: string;
  sourceTitle: string;
  sourceStoreName?: string;
  /**
   * 发起方已经写好的那句要求的交接编号（可选）。正文不进 URL：4000 个汉字编码后约 36 KB，
   * 刷新或带 Referer 时会撞上网关默认的请求行/请求头缓冲上限。正文按编号放在 sessionStorage，
   * 目标页据此预填输入框（不自动发送），见 stashLaunchRequest / readLaunchRequest。
   */
  handoffId?: string;
  /**
   * 发起方所在的团队空间（可选）。在团队空间里发起的生成，产物发布时也该落进同一个团队，
   * 而不是悄悄掉回个人空间。团队编号本身可以放进 URL；是否有权发布由服务端发布接口校验。
   */
  destinationTeamId?: string;
}

/** 与服务端「设计要求不能超过 4000 个字符」同一上限，超出部分截掉而不是整条丢弃。 */
export const MAX_LAUNCH_REQUEST_CHARS = 4000;

const HANDOFF_KEY_PREFIX = 'design-launch-request:';
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/;
const TEAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 已提交的交接草稿留一个墓碑，刷新后既不回填、也不误报「没带过来」。 */
const CONSUMED_MARKER = '\u0000consumed';

type HandoffStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type LaunchRequestDraft =
  | { status: 'ready'; text: string }
  | { status: 'consumed' }
  /** 编号在、正文不在：换了标签页打开、隐私模式或存储被清。必须明说，不许静默丢。 */
  | { status: 'missing' };

function createHandoffId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return random.slice(0, 16).padEnd(8, '0');
}

/**
 * 把要求草稿按随机编号存进 sessionStorage，返回要放进 URL 的编号；要求为空返回 undefined。
 * 写入失败也照样返回编号：目标页读不到时会明说「要求没带过来」，而不是装作没写过。
 */
export function stashLaunchRequest(
  request: string | undefined,
  storage: HandoffStorage | null,
  createId: () => string = createHandoffId,
): string | undefined {
  const text = request?.trim().slice(0, MAX_LAUNCH_REQUEST_CHARS);
  if (!text) return undefined;
  const id = createId();
  try { storage?.setItem(HANDOFF_KEY_PREFIX + id, text); } catch { /* 目标页会提示重新输入 */ }
  return id;
}

/** 读交接草稿，不删除：用户提交之前刷新或返回，草稿必须还在。 */
export function readLaunchRequest(handoffId: string, storage: Pick<Storage, 'getItem'> | null): LaunchRequestDraft {
  let value: string | null = null;
  try { value = storage?.getItem(HANDOFF_KEY_PREFIX + handoffId) ?? null; } catch { value = null; }
  if (value === CONSUMED_MARKER) return { status: 'consumed' };
  const text = value?.trim().slice(0, MAX_LAUNCH_REQUEST_CHARS);
  return text ? { status: 'ready', text } : { status: 'missing' };
}

/** 用户真的把这条要求发出去之后才标记已用。 */
export function consumeLaunchRequest(handoffId: string, storage: HandoffStorage | null): void {
  try { storage?.setItem(HANDOFF_KEY_PREFIX + handoffId, CONSUMED_MARKER); } catch { /* 刷新后最多再预填一次 */ }
}

export function buildDesignArtifactLaunchPath(context: DesignArtifactLaunchContext): string {
  const params = new URLSearchParams({
    designTarget: context.target,
    sourceStore: context.sourceStoreId,
    sourceEntry: context.sourceEntryId,
    sourceTitle: context.sourceTitle,
  });
  if (context.sourceStoreName) params.set('sourceStoreName', context.sourceStoreName);
  if (context.handoffId && HANDOFF_ID_PATTERN.test(context.handoffId)) params.set('handoff', context.handoffId);
  if (context.destinationTeamId && TEAM_ID_PATTERN.test(context.destinationTeamId))
    params.set('destTeam', context.destinationTeamId);
  const pathname = context.target === 'html-ppt' ? '/md-to-ppt-agent' : '/web-pages';
  return `${pathname}?${params.toString()}`;
}

export function parseDesignArtifactLaunch(search: string): DesignArtifactLaunchContext | null {
  const params = new URLSearchParams(search);
  const target = params.get('designTarget');
  const sourceStoreId = params.get('sourceStore')?.trim();
  const sourceEntryId = params.get('sourceEntry')?.trim();
  const sourceTitle = params.get('sourceTitle')?.trim();
  if ((target !== 'web-page' && target !== 'html-ppt') || !sourceStoreId || !sourceEntryId || !sourceTitle)
    return null;
  const handoffId = params.get('handoff')?.trim();
  const destinationTeamId = params.get('destTeam')?.trim();
  return {
    target,
    sourceStoreId,
    sourceEntryId,
    sourceTitle,
    sourceStoreName: params.get('sourceStoreName')?.trim() || undefined,
    ...(handoffId && HANDOFF_ID_PATTERN.test(handoffId) ? { handoffId } : {}),
    ...(destinationTeamId && TEAM_ID_PATTERN.test(destinationTeamId) ? { destinationTeamId } : {}),
  };
}

/** 取当前标签页的 sessionStorage；隐私模式或沙箱里访问本身会抛错，此时返回 null。 */
export function sessionStorageOrNull(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}
