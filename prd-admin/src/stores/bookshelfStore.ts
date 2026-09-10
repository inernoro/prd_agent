/**
 * 藏书阁个人进度（已读标记 + 结业考成绩）。
 *
 * 服务端优先、本地兜底：
 *  - 进入页面先拉 /api/bookshelf/progress，成功就以服务端为准（换设备也在）；
 *  - 拉不到（离线 / 接口挂了）就继续用 localStorage 里的那份，不清空、不报错，
 *    页面照常可用；
 *  - 每次勾选或交卷都乐观更新本地，再异步整包 PUT 回去。PUT 失败只记日志不回滚——
 *    回滚会让用户刚点的勾突然弹回去，比「这次没同步上」更难受，下次操作会带着
 *    完整快照重试。
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
  /** ISO 时间戳 */
  takenAt: string;
}

interface BookshelfState {
  /** 已读书目 id */
  readBookIds: string[];
  /** 每卷最好的一次成绩，key = volumeId */
  examResults: Record<string, ExamResult>;
  /** 服务端是否已成功同步过一次（false 时页面提示「仅本机记录」） */
  syncedFromServer: boolean;
  loadFromServer: () => Promise<void>;
  toggleRead: (bookId: string) => void;
  isRead: (bookId: string) => boolean;
  recordExam: (result: ExamResult) => void;
  resetAll: () => void;
}

/**
 * 整包 PUT 回服务端。失败只记日志不回滚——回滚会让用户刚点的勾弹回去，
 * 比「这次没同步上」更难受；下一次操作会带着完整快照重试。
 */
async function pushToServer(readBookIds: string[], examResults: Record<string, ExamResult>) {
  try {
    const payload = {
      readBookIds,
      examResults: Object.fromEntries(
        Object.entries(examResults).map(([k, v]) => [k, { correct: v.correct, total: v.total, passed: v.passed }]),
      ),
    };
    const res = await saveMyBookshelfProgress(payload);
    if (!res.success) {
      console.error('[bookshelfStore] 保存进度失败:', res.error?.message);
    }
  } catch (err) {
    console.error('[bookshelfStore] 保存进度异常:', err);
  }
}

export const useBookshelfStore = create<BookshelfState>()(
  persist(
    (set, get) => ({
      readBookIds: [],
      examResults: {},
      syncedFromServer: false,

      loadFromServer: async () => {
        try {
          const res = await getMyBookshelfProgress();
          if (!res.success || !res.data) return;   // 拉不到就保留本地那份，不清空
          const results: Record<string, ExamResult> = {};
          Object.entries(res.data.examResults ?? {}).forEach(([volumeId, r]) => {
            results[volumeId] = {
              volumeId, correct: r.correct, total: r.total, passed: r.passed, takenAt: r.takenAt,
            };
          });
          set({
            readBookIds: res.data.readBookIds ?? [],
            examResults: results,
            syncedFromServer: true,
          });
        } catch (err) {
          console.error('[bookshelfStore] 拉取服务端进度失败，继续用本地记录:', err);
        }
      },

      toggleRead: (bookId) => {
        const cur = get().readBookIds;
        const next = cur.includes(bookId) ? cur.filter((id) => id !== bookId) : [...cur, bookId];
        set({ readBookIds: next });
        void pushToServer(next, get().examResults);
      },

      isRead: (bookId) => get().readBookIds.includes(bookId),

      // 只保留更好的一次：同一卷反复刷分时不该把已有的好成绩冲掉。
      recordExam: (result) => {
        const prev = get().examResults[result.volumeId];
        const better = !prev || result.correct > prev.correct;
        if (!better) return;
        const next = { ...get().examResults, [result.volumeId]: result };
        set({ examResults: next });
        void pushToServer(get().readBookIds, next);
      },

      resetAll: () => {
        set({ readBookIds: [], examResults: {} });
        void pushToServer([], {});
      },
    }),
    {
      name: 'bookshelf-progress',
      version: 1,
      // 旧数据兼容（frontend-architecture.md：Store 新增字段必须处理旧数据）
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!Array.isArray(state.readBookIds)) state.readBookIds = [];
        if (!state.examResults || typeof state.examResults !== 'object') state.examResults = {};
        // 新增字段的旧数据兼容：本地存档里没有这个键，回来时当作「还没同步过」
        if (typeof state.syncedFromServer !== 'boolean') state.syncedFromServer = false;
      },
    },
  ),
);
