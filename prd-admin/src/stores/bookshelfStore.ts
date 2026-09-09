/**
 * 藏书阁个人进度（已读标记 + 结业考成绩）。
 *
 * 边界（已知，记在 doc/debt.frontend.md）：本版进度只落 localStorage，
 * 换设备或清缓存会丢，也无法在团队里看到彼此进度。书目与考题本身是**公共**
 * 的（catalog.ts / exams.ts 是全站同一份），个人进度才是本地的。
 * 后端持久化（含团队看板、通关证书）是下一步。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  toggleRead: (bookId: string) => void;
  isRead: (bookId: string) => boolean;
  recordExam: (result: ExamResult) => void;
  resetAll: () => void;
}

export const useBookshelfStore = create<BookshelfState>()(
  persist(
    (set, get) => ({
      readBookIds: [],
      examResults: {},

      toggleRead: (bookId) => {
        const cur = get().readBookIds;
        set({
          readBookIds: cur.includes(bookId)
            ? cur.filter((id) => id !== bookId)
            : [...cur, bookId],
        });
      },

      isRead: (bookId) => get().readBookIds.includes(bookId),

      // 只保留更好的一次：同一卷反复刷分时不该把已有的好成绩冲掉。
      recordExam: (result) => {
        const prev = get().examResults[result.volumeId];
        const better = !prev || result.correct > prev.correct;
        if (!better) return;
        set({ examResults: { ...get().examResults, [result.volumeId]: result } });
      },

      resetAll: () => set({ readBookIds: [], examResults: {} }),
    }),
    {
      name: 'bookshelf-progress',
      version: 1,
      // 旧数据兼容（frontend-architecture.md：Store 新增字段必须处理旧数据）
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!Array.isArray(state.readBookIds)) state.readBookIds = [];
        if (!state.examResults || typeof state.examResults !== 'object') state.examResults = {};
      },
    },
  ),
);
