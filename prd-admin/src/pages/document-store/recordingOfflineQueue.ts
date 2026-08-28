/**
 * 离线校对队列的持久化。
 *
 * 为什么要它：结果页离线时把校对收进队列，横幅对用户承诺「联网后自动上传，无需重做」。
 * 那个队列此前只活在 React state 里——刷新一次、关掉标签页、或者从侧栏切到另一条录音
 * 把这一屏换掉，队列就没了，而承诺还写在屏幕上（Codex P1 抓到的正是这条）。
 * 承诺要么兑现要么别写，所以把它落到本机存储。
 *
 * 为什么用 localStorage 而不是默认的 sessionStorage（`no-localstorage.md` 的例外判定）：
 * 这条承诺覆盖的正是「关掉再回来」，sessionStorage 关标签页即丢，物理上兑现不了。
 * 它同时满足那条规则允许的三个前提——非敏感、设备本地、发版后拿到旧值也不会出错
 * （内容按笔记 id 绑定，只在同一条笔记上补传）。
 *
 * 陈旧兜底：超过 `MAX_AGE_MS` 的队列不再补传。放太久的稿子多半已经在别处被改过，
 * 静默覆盖比丢掉更糟；过期时如实丢弃，不假装还能补。
 */

/*
 * 键里必须带**用户**：共享浏览器上只按笔记 id 存，A 排下的草稿会被 B 打开同一篇时
 * 恢复出来，并且用 B 的凭据传上去——既泄露 A 的内容，又覆盖共享笔记（Codex P1）。
 * 拿不到用户 id 时干脆不落盘（队列只留在内存里），宁可这一次刷新丢掉，
 * 也不留一份不知道属于谁的草稿。
 */
const KEY_PREFIX = 'recording-offline-edit:';
/** 三天。再久的离线校对补传回去多半是在覆盖别人（或自己在别处）的新版本 */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function storageKey(ownerId: string, noteId: string): string {
  return `${KEY_PREFIX}${ownerId}:${noteId}`;
}

export interface QueuedOfflineEdit {
  /** 这份草稿属于哪个账号——共享浏览器上换个人登录就不该再认它 */
  ownerId: string;
  /** 这份内容属于哪条转录笔记——队列必须**认笔记**，否则切到另一条录音会把 A 的内容写进 B */
  noteId: string;
  /** 用户改了几次（覆盖写语义下内容以最后一次为准，但「欠了多少」按次数说才是他关心的） */
  count: number;
  content: string;
  /** 入队时刻，用于过期判定 */
  savedAt: number;
  /**
   * 排这份草稿时，服务端那份笔记的最后更新时刻。补传前拿它和服务端当前值比一下：
   * 不一样就说明这条笔记在别处被改过，直接 PUT 会把别人的新内容整篇盖掉。
   * 旧版本存下的草稿没有这个字段（`undefined`），那时按「比不了」处理，不阻断补传。
   */
  baseUpdatedAt?: string | null;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // 隐私模式 / 站点数据被禁时读写本身就会抛，此时退化成「只在内存里排队」
    return null;
  }
}

/**
 * 服务端那份笔记，在草稿排下之后有没有被别人（或自己在另一台设备上）改过。
 *
 * 只在**两边都知道**更新时刻时才判冲突：旧版本存下的草稿没有基线，
 * 或服务端这次没给出 updatedAt，那都是「比不了」，不能当成冲突把补传卡死。
 */
export function hasRemoteChangedSince(
  edit: QueuedOfflineEdit | null | undefined,
  remoteUpdatedAt: string | null | undefined,
): boolean {
  if (!edit?.baseUpdatedAt || !remoteUpdatedAt) return false;
  return edit.baseUpdatedAt !== remoteUpdatedAt;
}

/** 队列里那份内容是不是这条笔记的、且还没过期。两个条件缺一都不该补传。 */
export function isFlushable(
  edit: QueuedOfflineEdit | null | undefined,
  noteId: string,
  ownerId: string,
  now: number = Date.now(),
): boolean {
  if (!edit || !noteId || !ownerId) return false;
  if (edit.noteId !== noteId) return false;
  if (edit.ownerId !== ownerId) return false;
  if (!edit.content) return false;
  return now - edit.savedAt <= MAX_AGE_MS;
}

/**
 * 落盘这份草稿。**返回它到底有没有落住**——调用方据此决定怎么跟用户说话：
 * 落住了才配说「联网后自动上传，无需重做」；没落住（隐私模式、站点数据被禁、配额满）
 * 只能说「这次改动留在本页，刷新会丢」。此前这里把异常吞掉、调用方照样报成功，
 * 承诺就成了空头支票（Codex P1）。
 */
export function saveOfflineEdit(edit: QueuedOfflineEdit): boolean {
  const store = storage();
  if (!store || !edit.noteId || !edit.ownerId) return false;
  try {
    store.setItem(storageKey(edit.ownerId, edit.noteId), JSON.stringify(edit));
    return true;
  } catch {
    // 配额满：内存里的队列仍在，横幅照常显示欠了多少，不因为存不下就假装没排队
    return false;
  }
}

export function loadOfflineEdit(
  noteId: string,
  ownerId: string,
  now: number = Date.now(),
): QueuedOfflineEdit | null {
  const store = storage();
  if (!store || !noteId || !ownerId) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(storageKey(ownerId, noteId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<QueuedOfflineEdit>;
    const edit: QueuedOfflineEdit = {
      ownerId: typeof parsed.ownerId === 'string' ? parsed.ownerId : '',
      noteId: typeof parsed.noteId === 'string' ? parsed.noteId : '',
      count: typeof parsed.count === 'number' && parsed.count > 0 ? parsed.count : 1,
      content: typeof parsed.content === 'string' ? parsed.content : '',
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      baseUpdatedAt: typeof parsed.baseUpdatedAt === 'string' ? parsed.baseUpdatedAt : null,
    };
    if (!isFlushable(edit, noteId, ownerId, now)) {
      clearOfflineEdit(noteId, ownerId);
      return null;
    }
    return edit;
  } catch {
    clearOfflineEdit(noteId, ownerId);
    return null;
  }
}

/**
 * 退出登录时把本机所有离线草稿清掉（不分账号）。
 *
 * 键里带账号只决定「恢复谁的草稿」，挡不住同一台设备上的下一个人翻本地存储看内容。
 * 草稿是用户的正文，不该在人已经登出之后还躺在盘上——所以登出即清，
 * 由 `authStore.logout` 调用（Codex P1）。代价是「登出前排下的离线校对，登出后不再补传」，
 * 这条边界写在这里：要补传就先联网、别先登出。
 */
export function clearAllOfflineEdits(): void {
  const store = storage();
  if (!store) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // 存储不可用时本来也没落下任何草稿
  }
}

export function clearOfflineEdit(noteId: string, ownerId: string): void {
  const store = storage();
  if (!store || !noteId || !ownerId) return;
  try {
    store.removeItem(storageKey(ownerId, noteId));
  } catch {
    // 删不掉就算了：下一次 load 的过期判定还会再兜一层
  }
}
