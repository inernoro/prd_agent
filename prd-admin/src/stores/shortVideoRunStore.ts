import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * 短视频解析任务的页面级状态中枢（SSOT），用于「关闭抽屉/刷新后仍能看到运行中的智能体」。
 *
 * 设计动机：短视频解析是后端持久 run（状态存 Mongo，可用 GET /runs/{id} 续查），但过去
 * 前端只在抽屉打开且处于短视频模式时才轮询、且只在 sessionStorage 存了一个裸 runId。
 * 关掉抽屉或刷新后既没有「运行中」入口、也不恢复轮询，用户感觉任务凭空消失/重新计时。
 *
 * 现在把「有哪些短视频任务在跑」上提到本 store：
 *   - 抽屉创建/轮询短视频 run 时 upsert 到这里（带 storeId + 源链接标题，供右上角入口重开抽屉）
 *   - 右上角「运行中的智能体」入口读这里，关抽屉后仍可见，点击重开抽屉
 *   - ShortVideoRunHost（无 UI，挂在页面级）对非终态 run 周期性 GET 续查，刷新后自动恢复
 *   - 持久化到 sessionStorage（项目禁 localStorage，见 no-localstorage 规则）
 */

export type ShortVideoRunStatus = 'running' | 'done' | 'failed';

export interface ShortVideoRunRecord {
  runId: string;
  /** 所属知识库，重开抽屉 + 续查需要 */
  storeId: string;
  /** 展示标题（源链接或解析出的标题），右上角入口/卡片用 */
  title: string;
  status: ShortVideoRunStatus;
  /** 当前阶段中文短语（解析/保存/转写…），入口副标题展示 */
  phase: string;
  /** 是否已生成转写文字条目（完成态展示用） */
  hasTranscript?: boolean;
  errorMessage?: string;
  /** 发起时间戳（ms），用于排序 + 完成后自动淡出计时 */
  startedAt: number;
  /** 最近一次状态更新时间戳（ms） */
  updatedAt: number;
}

interface ShortVideoRunState {
  runs: Record<string, ShortVideoRunRecord>;
  /** 抽屉创建短视频 run 后登记（running） */
  startRun: (meta: { runId: string; storeId: string; title: string; phase?: string }) => void;
  /** 轮询/续查拿到最新状态后增量更新 */
  patchRun: (runId: string, partial: Partial<ShortVideoRunRecord>) => void;
  /** 用户手动关掉已完成/失败的入口，或任务被替代时移除 */
  dismissRun: (runId: string) => void;
}

export const useShortVideoRunStore = create<ShortVideoRunState>()(
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
              title: meta.title,
              status: 'running',
              phase: meta.phase ?? '排队中',
              startedAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        })),

      patchRun: (runId, partial) =>
        set((s) => {
          const prev = s.runs[runId];
          if (!prev) return s;
          return { runs: { ...s.runs, [runId]: { ...prev, ...partial, updatedAt: Date.now() } } };
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
      name: 'short-video-run-store',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);

/** 取某知识库下仍在运行（running）的短视频任务数量（入口徽章用）。 */
export function selectRunningShortVideoCount(
  runs: Record<string, ShortVideoRunRecord>,
  storeId: string,
): number {
  let n = 0;
  for (const r of Object.values(runs)) {
    if (r.storeId === storeId && r.status === 'running') n += 1;
  }
  return n;
}
