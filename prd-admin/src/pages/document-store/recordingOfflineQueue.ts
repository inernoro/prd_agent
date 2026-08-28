/**
 * 离线校对队列的持久化。
 *
 * 为什么要它：结果页离线时把校对收进队列，横幅对用户承诺「联网后自动上传，刷新也不用重做」。
 * 那个队列此前只活在 React state 里——刷新一次、关掉标签页、或者从侧栏切到另一条录音
 * 把这一屏换掉，队列就没了，而承诺还写在屏幕上（Codex P1 抓到的正是这条）。
 * 承诺要么兑现要么别写，所以把它落到本机存储。
 *
 * 为什么是 sessionStorage：`no-localstorage.md` 的例外只给「非敏感 + 设备本地 +
 * 发版后用旧值无害」的那一类（纯 UI 偏好），而这里存的是**用户录音的正文全文**——
 * 会议、访谈、商务沟通的原话都在里面，不满足「非敏感」这一条。会话 token 那条例外
 * 是用户明确要求的超长登录期，且靠服务端每请求校验撤销兜底，不能类推到正文。
 * 早先这里用了 localStorage，理由是「承诺覆盖关掉再回来」——那是拿承诺去挑存储，
 * 顺序反了：存储由规则定，承诺跟着存储说实话（Codex 第二十轮 P1）。
 * 代价写明白：草稿只在**这个标签页**里活着，刷新、组件卸载、切走再回来都还在，
 * 关掉标签页就没了；横幅文案照这个边界写，不许再许「关掉也不丢」。
 *
 * 陈旧兜底：超过 `MAX_AGE_MS` 的草稿**不自动补传**，但也**不静默删**——放太久的稿子
 * 多半已经在别处被改过，直接盖是错的，而悄悄删掉用户几处校对同样是错的
 * （此前这里是后者，Codex 第二十轮 P1）。过期就走冲突横幅，覆盖还是丢弃由用户定。
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
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // 隐私模式 / 站点数据被禁时读写本身就会抛，此时退化成「只在内存里排队」
    return null;
  }
}

/**
 * 队列里那份内容是不是**这条笔记、这个账号**的，且非空。
 *
 * 这里不再判年龄：过期是「要不要自动传」的问题（见 `isStaleOfflineEdit`），
 * 不是「这份草稿归不归这一屏」的问题。混在一起会让用户在冲突横幅上点
 * 「仍然用我的版本覆盖」时**什么都不发生**——那颗按钮走的也是这道门。
 */
export function isFlushable(
  edit: QueuedOfflineEdit | null | undefined,
  noteId: string,
  ownerId: string,
): boolean {
  if (!edit || !noteId || !ownerId) return false;
  if (edit.noteId !== noteId) return false;
  if (edit.ownerId !== ownerId) return false;
  return Boolean(edit.content);
}

/** 放得太久，不能再自动覆盖服务端那份——交给用户裁决，不是删掉 */
export function isStaleOfflineEdit(
  edit: QueuedOfflineEdit | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!edit) return false;
  return now - edit.savedAt > MAX_AGE_MS;
}

/**
 * 自动补传前的裁决：能传，还是必须停下来问用户（问的理由是哪一种）。
 *
 * 三种「不确定」一律停：基线未知（排队时没拿到服务端版本，或旧草稿没这个字段）、
 * 服务端这次没给出 updatedAt、草稿放过期了。此前前两种被当成「比不了 → 当没冲突 → 照传」,
 * 于是初次加载时条目请求偶发失败，就会拿一个 null 基线把同事的新版本静默盖掉
 * （Codex 第二十轮 P1）。停下来最多让用户多点一下，盖错了没法撤。
 */
/**
 * 两个时刻是不是同一个时刻——**按时刻比，不按字符串比**。
 *
 * 这两个值来自两条不同的路：写回响应给的是服务端内存里那个时刻，读回来的是它在库里
 * 存过一轮之后的样子。两条路的小数位数可以不一样（库里是毫秒精度），字符串相等会把
 * 同一个时刻判成两个，于是「我自己刚存的那一版」被当成别人改的——一条永远为真的假冲突。
 * 后端已经把写入时刻截到毫秒对齐了库的精度；这里再按时刻比一次，是为了不把正确性
 * 押在「后端某一处的写法不变」上（换个接口、换个字段就又栽）。
 * 解析不出来就退回字符串比，宁可多问一次用户，也不当成没变过。
 */
export function isSameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

export type OfflineFlushVerdict = 'flush' | 'remote-changed' | 'unknown-base' | 'stale';
/** 停下来的那三种（横幅要按它选措辞） */
export type OfflineFlushReason = Exclude<OfflineFlushVerdict, 'flush'>;

export function decideOfflineFlush(
  edit: QueuedOfflineEdit | null | undefined,
  remoteUpdatedAt: string | null | undefined,
  now: number = Date.now(),
): OfflineFlushVerdict {
  if (isStaleOfflineEdit(edit, now)) return 'stale';
  if (!edit?.baseUpdatedAt || !remoteUpdatedAt) return 'unknown-base';
  if (!isSameInstant(edit.baseUpdatedAt, remoteUpdatedAt)) return 'remote-changed';
  return 'flush';
}

/**
 * 落盘这份草稿。**返回它到底有没有落住**——调用方据此决定怎么跟用户说话：
 * 落住了才配说「刷新也不用重做」；没落住（隐私模式、站点数据被禁、配额满）
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
    // 过期的草稿照样接回来：它是用户的正文，删不得。传不传由 `decideOfflineFlush` 裁决
    if (!isFlushable(edit, noteId, ownerId)) {
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
