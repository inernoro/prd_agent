import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * 知识库「文档再加工」任务的页面级状态中枢（SSOT）。
 *
 * 设计动机：再加工的 SSE 流和"完成后刷新文件树"的副作用过去都长在
 * ReprocessDrawer 里，抽屉一关就 unmount → SSE abort + runId 丢失 + 完成回调
 * 失联，用户看不到任何进度、新文档也不会自动出现（详见对话背景）。
 *
 * 现在把"有一个再加工任务在跑"这件事上提到本 store：
 *   - ReprocessRunHost（无 UI）订阅 SSE 并写入这里，与抽屉生命周期解耦
 *   - 抽屉只是这份状态的"展开视图"，开/关不影响任务
 *   - 文件树 chip + 右下角任务 pill 都读这里，关抽屉后仍可见
 *   - runId 持久化到 sessionStorage（项目禁 localStorage），刷新后由 Host
 *     用 afterSeq=0 重连续传
 */

export type ReprocessRunStatus = 'streaming' | 'done' | 'failed';

export interface ReprocessRun {
  runId: string;
  /** 所属知识库，完成后 loadEntries / 渲染 pill 需要按 storeId 过滤 */
  storeId: string;
  /** 源文档（文件树挂 chip 的那一行） */
  sourceEntryId: string;
  sourceTitle: string;
  status: ReprocessRunStatus;
  phase: string;
  progress: number;
  /** 实时打字内容；不持久化（可能很大），刷新后由 Host 从 generatedText 补齐 */
  streamedText: string;
  outputEntryId?: string;
  errorMessage?: string;
  /** 发起时间戳（ms），用于完成后 pill 自动淡出计时 / 排序 */
  startedAt: number;
}

interface ReprocessRunState {
  runs: Record<string, ReprocessRun>;
  /** 抽屉点「开始加工」拿到 runId 后写入，状态 streaming */
  startRun: (meta: {
    runId: string;
    storeId: string;
    sourceEntryId: string;
    sourceTitle: string;
  }) => void;
  /** Host 收到 SSE chunk/progress/done/error 后增量更新 */
  patchRun: (runId: string, partial: Partial<ReprocessRun>) => void;
  /** 用户手动关掉已完成/失败的 pill，或任务被替代时移除 */
  dismissRun: (runId: string) => void;
}

export const useReprocessRunStore = create<ReprocessRunState>()(
  persist(
    (set) => ({
      runs: {},

      startRun: (meta) =>
        set((s) => ({
          runs: {
            ...s.runs,
            [meta.runId]: {
              runId: meta.runId,
              storeId: meta.storeId,
              sourceEntryId: meta.sourceEntryId,
              sourceTitle: meta.sourceTitle,
              status: 'streaming',
              phase: '排队中',
              progress: 0,
              streamedText: '',
              startedAt: Date.now(),
            },
          },
        })),

      patchRun: (runId, partial) =>
        set((s) => {
          const prev = s.runs[runId];
          if (!prev) return s;
          return { runs: { ...s.runs, [runId]: { ...prev, ...partial } } };
        }),

      dismissRun: (runId) =>
        set((s) => {
          if (!s.runs[runId]) return s;
          const next = { ...s.runs };
          delete next[runId];
          return { runs: next };
        }),
    }),
    {
      name: 'reprocess-run-store',
      // 严格遵守 no-localstorage 规则
      storage: createJSONStorage(() => sessionStorage),
      // streaming 的 streamedText 不持久化（刷新后 Host 用 afterSeq=0 重放补齐）；
      // 但 done/failed 的终态 run 不会再挂 Host，必须保留 streamedText，否则刷新后
      // 重开抽屉会看到「已完成但正文空白」（Bugbot 报告）。
      partialize: (s) => ({
        runs: Object.fromEntries(
          Object.entries(s.runs).map(([id, r]) =>
            [id, r.status === 'streaming' ? { ...r, streamedText: '' } : r],
          ),
        ),
      }),
      // 旧架构里 ReprocessRunHost 订阅 SSE 把 streaming → done/failed。新架构走 direct-chat，
      // 不再创建 Run / 不挂 Host，sessionStorage 里残留的 streaming run 没人推进会永远卡住。
      // 重开后把它们当作"失败"显式标注，用户能点 X 关掉。（Bugbot #4 二轮 Medium）
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const scrubbed: Record<string, ReprocessRun> = {};
        for (const [id, r] of Object.entries(state.runs)) {
          if (r.status === 'streaming') {
            scrubbed[id] = {
              ...r,
              status: 'failed',
              errorMessage: r.errorMessage ?? '上次任务未完成（已切换到新架构，请直接重试）',
            };
          } else {
            scrubbed[id] = r;
          }
        }
        state.runs = scrubbed;
      },
    },
  ),
);

/** 取某知识库下、某源文档正在进行的再加工任务（文件树 chip 用） */
export function selectStreamingByEntry(
  runs: Record<string, ReprocessRun>,
  storeId: string,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of Object.values(runs)) {
    if (r.storeId === storeId && r.status === 'streaming') {
      map[r.sourceEntryId] = r.progress;
    }
  }
  return map;
}
