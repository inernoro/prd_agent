/**
 * 藏书阁个人进度（已读标记 + 结业考成绩）。
 *
 * 服务端优先、本地兜底：
 *  - 进入页面先拉 /api/bookshelf/progress，成功就以服务端为准（换设备也在）；
 *  - 拉不到（离线 / 接口挂了）就继续用 localStorage 那份，不清空、不报错，页面照常可用；
 *  - 每次勾选或交卷都乐观更新本地，再异步整包 PUT 回去。
 *
 * 同步失败**必须让用户看见**（syncState='failed'）。
 * 沉默失败比报错更伤：页面显示打了勾、实际只在本地，用户换台设备发现没了，
 * 就再也不信这个功能了。所以失败不回滚（回滚会让刚点的勾弹回去，更难受），
 * 而是亮明状态 + 自动重试。
 *
 * 重试是安全的：每次 PUT 送的都是**当前完整快照**而不是增量，所以重放任意次
 * 结果相同（幂等）。三个重试时机：下一次用户操作、网络恢复（online 事件）、
 * 用户手动点重试。
 *
 * 成绩取「更好的那次」这条判据服务端也有一份：这里挡不住换设备后本地为空、
 * 一交卷就把服务端好成绩冲掉，所以真正的判据在后端。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  getMyBookshelfProgress,
  saveMyBookshelfProgress,
} from '@/services/real/bookshelf';

export interface ExamResult {
  volumeId: string;
  correct: number;
  total: number;
  passed: boolean;
  /**
   * 交卷时这一卷已读几本 / 共几本。
   * 分数脱离这两个数就没有结论：裸考 5/7 与读完 11 本考 5/7 指向完全不同的下一步。
   * 存的是快照——卷里的书会增删，不能事后用当前书数倒推。
   */
  readAtExam: number;
  totalAtExam: number;
  /** ISO 时间戳 */
  takenAt: string;
}

/**
 * synced  已与服务端一致
 * saving  正在写
 * failed  写失败，改动只在本机 —— 必须让用户看见
 * local   还没成功读到过服务端（接口不可用/未登录），退化成纯本地模式
 */
export type SyncState = 'synced' | 'saving' | 'failed' | 'local';

interface BookshelfState {
  readBookIds: string[];
  examResults: Record<string, ExamResult>;
  syncState: SyncState;
  /** 连续失败次数，用于退避与文案分级 */
  failedAttempts: number;
  loadFromServer: () => Promise<void>;
  toggleRead: (bookId: string) => void;
  isRead: (bookId: string) => boolean;
  recordExam: (result: ExamResult) => void;
  /** 用户手动点「重试同步」 */
  retrySync: () => Promise<void>;
  resetAll: () => void;
}

/** 防抖：快速连点十本书不该打十次请求，最后那次带的快照已经包含全部改动。 */
const PUSH_DEBOUNCE_MS = 400;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** 导出给测试用：让用例能确定性地等一次防抖窗口，而不是靠 sleep 猜。 */
export const __pushDebounceMs = PUSH_DEBOUNCE_MS;

function toPayload(readBookIds: string[], examResults: Record<string, ExamResult>) {
  return {
    readBookIds,
    examResults: Object.fromEntries(
      Object.entries(examResults).map(([k, v]) => [
        k, {
          correct: v.correct, total: v.total, passed: v.passed,
          readAtExam: v.readAtExam ?? 0, totalAtExam: v.totalAtExam ?? 0,
        },
      ]),
    ),
  };
}

export const useBookshelfStore = create<BookshelfState>()(
  persist(
    (set, get) => {
      /** 立即推送当前快照。成功→synced，失败→failed（不回滚，只亮状态）。 */
      async function flush(): Promise<void> {
        const { readBookIds, examResults } = get();
        set({ syncState: 'saving' });
        try {
          const res = await saveMyBookshelfProgress(toPayload(readBookIds, examResults));
          if (res.success) {
            set({ syncState: 'synced', failedAttempts: 0 });
          } else {
            console.error('[bookshelfStore] 保存进度失败:', res.error?.message);
            set({ syncState: 'failed', failedAttempts: get().failedAttempts + 1 });
          }
        } catch (err) {
          console.error('[bookshelfStore] 保存进度异常:', err);
          set({ syncState: 'failed', failedAttempts: get().failedAttempts + 1 });
        }
      }

      /** 防抖入口。用户每次操作都走它。 */
      function schedulePush() {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => { pushTimer = null; void flush(); }, PUSH_DEBOUNCE_MS);
      }

      // 网络恢复时自动补一次 —— 用户断网时点的那些勾，不该等他再点一下才存上。
      // 只在失败态才发，避免每次 online 都无谓打一发。
      try {
        window.addEventListener('online', () => {
          if (get().syncState === 'failed') void flush();
        });
      } catch {
        /* 非浏览器环境（SSR / 测试）无 window，跳过即可 */
      }

      return {
        readBookIds: [],
        examResults: {},
        syncState: 'local',
        failedAttempts: 0,

        loadFromServer: async () => {
          try {
            const res = await getMyBookshelfProgress();
            if (!res.success || !res.data) return;   // 拉不到就保留本地那份，停在 local
            const results: Record<string, ExamResult> = {};
            Object.entries(res.data.examResults ?? {}).forEach(([volumeId, r]) => {
              results[volumeId] = {
                volumeId, correct: r.correct, total: r.total, passed: r.passed,
                // 服务端可能是升级前写的旧记录，没有这两个字段——按零本处理（即裸考），
                // 不许拿当前书数倒推假装读过。
                readAtExam: r.readAtExam ?? 0,
                totalAtExam: r.totalAtExam ?? 0,
                takenAt: r.takenAt,
              };
            });
            set({
              readBookIds: res.data.readBookIds ?? [],
              examResults: results,
              syncState: 'synced',
              failedAttempts: 0,
            });
          } catch (err) {
            console.error('[bookshelfStore] 拉取服务端进度失败，继续用本地记录:', err);
          }
        },

        toggleRead: (bookId) => {
          const cur = get().readBookIds;
          const next = cur.includes(bookId) ? cur.filter((id) => id !== bookId) : [...cur, bookId];
          set({ readBookIds: next });
          schedulePush();
        },

        isRead: (bookId) => get().readBookIds.includes(bookId),

        recordExam: (result) => {
          const prev = get().examResults[result.volumeId];
          if (prev && result.correct <= prev.correct) return;   // 只留更好的那次
          set({ examResults: { ...get().examResults, [result.volumeId]: result } });
          schedulePush();
        },

        retrySync: async () => {
          if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
          await flush();
        },

        resetAll: () => {
          set({ readBookIds: [], examResults: {} });
          schedulePush();
        },
      };
    },
    {
      name: 'bookshelf-progress',
      version: 1,
      // 只持久化数据，不持久化同步状态：syncState 是「此刻与服务端的关系」，
      // 存进 localStorage 再读回来就是过期的谎（上次是 synced，这次可能已经断网了）。
      partialize: (s) => ({ readBookIds: s.readBookIds, examResults: s.examResults }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!Array.isArray(state.readBookIds)) state.readBookIds = [];
        if (!state.examResults || typeof state.examResults !== 'object') state.examResults = {};
      },
    },
  ),
);
