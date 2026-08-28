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

const KEY_PREFIX = 'recording-offline-edit:';
/** 三天。再久的离线校对补传回去多半是在覆盖别人（或自己在别处）的新版本 */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface QueuedOfflineEdit {
  /** 这份内容属于哪条转录笔记——队列必须**认笔记**，否则切到另一条录音会把 A 的内容写进 B */
  noteId: string;
  /** 用户改了几次（覆盖写语义下内容以最后一次为准，但「欠了多少」按次数说才是他关心的） */
  count: number;
  content: string;
  /** 入队时刻，用于过期判定 */
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // 隐私模式 / 站点数据被禁时读写本身就会抛，此时退化成「只在内存里排队」
    return null;
  }
}

/** 队列里那份内容是不是这条笔记的、且还没过期。两个条件缺一都不该补传。 */
export function isFlushable(
  edit: QueuedOfflineEdit | null | undefined,
  noteId: string,
  now: number = Date.now(),
): boolean {
  if (!edit || !noteId) return false;
  if (edit.noteId !== noteId) return false;
  if (!edit.content) return false;
  return now - edit.savedAt <= MAX_AGE_MS;
}

export function saveOfflineEdit(edit: QueuedOfflineEdit): void {
  const store = storage();
  if (!store || !edit.noteId) return;
  try {
    store.setItem(KEY_PREFIX + edit.noteId, JSON.stringify(edit));
  } catch {
    // 配额满：内存里的队列仍在，横幅照常显示欠了多少，不因为存不下就假装没排队
  }
}

export function loadOfflineEdit(noteId: string, now: number = Date.now()): QueuedOfflineEdit | null {
  const store = storage();
  if (!store || !noteId) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(KEY_PREFIX + noteId);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<QueuedOfflineEdit>;
    const edit: QueuedOfflineEdit = {
      noteId: typeof parsed.noteId === 'string' ? parsed.noteId : '',
      count: typeof parsed.count === 'number' && parsed.count > 0 ? parsed.count : 1,
      content: typeof parsed.content === 'string' ? parsed.content : '',
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    };
    if (!isFlushable(edit, noteId, now)) {
      clearOfflineEdit(noteId);
      return null;
    }
    return edit;
  } catch {
    clearOfflineEdit(noteId);
    return null;
  }
}

export function clearOfflineEdit(noteId: string): void {
  const store = storage();
  if (!store || !noteId) return;
  try {
    store.removeItem(KEY_PREFIX + noteId);
  } catch {
    // 删不掉就算了：下一次 load 的过期判定还会再兜一层
  }
}
