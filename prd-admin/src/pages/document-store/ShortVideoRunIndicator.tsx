import { useEffect, useMemo, useRef } from 'react';
import { CheckCircle2, AlertCircle, X, Video } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getShortVideoMaterialRun } from '@/services';
import { shortVideoCompactStatus } from './ReprocessChatDrawer';
import {
  useShortVideoRunStore,
  type ShortVideoRunRecord,
} from '@/stores/shortVideoRunStore';

/**
 * 右上角「运行中的智能体」入口（短视频解析）。关掉抽屉 / 刷新页面后仍可见，点击重开抽屉恢复状态。
 *
 * 兼任「无 UI 的 Host」职责：对本知识库下仍 running 的短视频 run 周期性 GET 续查并写回 store，
 * 这样抽屉关着 / 刷新后也能继续推进状态、最终自动收尾（done/failed），不再凭空卡住。
 * 短视频 run 是后端持久任务，前端只是观察者（符合 server-authority / 前端无业务状态原则）。
 */
export function ShortVideoRunIndicator({
  storeId,
  onOpenRun,
  onRunCompleted,
  hidden = false,
}: {
  storeId: string;
  onOpenRun: (run: ShortVideoRunRecord) => void;
  /** 后台 run（抽屉关着/刷新后）跑完时回调，让页面重新拉取知识库条目，否则新入库的视频/文字不出现 */
  onRunCompleted?: () => void;
  /** 仅隐藏右上角浮层（抽屉打开时避免遮挡），但 Host 轮询照常运行——否则开抽屉就停更（Bugbot Medium） */
  hidden?: boolean;
}) {
  const runsMap = useShortVideoRunStore((s) => s.runs);
  const patchRun = useShortVideoRunStore((s) => s.patchRun);
  const dismissRun = useShortVideoRunStore((s) => s.dismissRun);

  // onRunCompleted 每次父级渲染都是新内联函数；用 ref 存最新值，避免它进 effect 依赖导致
  // 每次渲染都拆/建轮询 interval、并 cancel 掉进行中的 GET，使完成检测/列表刷新变得不稳定（Bugbot Medium）。
  const onRunCompletedRef = useRef(onRunCompleted);
  useEffect(() => { onRunCompletedRef.current = onRunCompleted; });

  // 仅展示本知识库的 run，按发起时间倒序（新的在上）
  const runs = useMemo(
    () =>
      Object.values(runsMap)
        .filter((r) => r.storeId === storeId)
        .sort((a, b) => b.startedAt - a.startedAt),
    [runsMap, storeId],
  );

  const runningIds = useMemo(
    () => runs.filter((r) => r.status === 'running').map((r) => r.runId).join(','),
    [runs],
  );

  // Host 轮询：对仍 running 的 run 每 3s GET 一次续查，写回 store（抽屉关着也推进）。
  // 用 ref 防止并发重入；终态自动停止；组件卸载清理。
  const pollingRef = useRef(false);
  useEffect(() => {
    if (!runningIds) return;
    let cancelled = false;
    const ids = runningIds.split(',').filter(Boolean);
    const tick = async () => {
      if (cancelled || pollingRef.current) return;
      pollingRef.current = true;
      try {
        for (const id of ids) {
          const res = await getShortVideoMaterialRun(id);
          if (cancelled) return;
          if (res.success && res.data) {
            const run = res.data;
            const status = run.status === 'done' ? 'done' : run.status === 'failed' ? 'failed' : 'running';
            // running → done 跃迁时回调页面 reload：抽屉关着/刷新后本 Host 是唯一轮询者，
            // 不通知页面的话新入库的源视频/转写条目不会出现在知识库列表（Codex P2）。
            const prevStatus = useShortVideoRunStore.getState().runs[id]?.status;
            // 同步 phase（阶段推进）+ title，否则抽屉关着时副标题会停在初始文案（Bugbot Medium）
            patchRun(id, {
              status,
              phase: shortVideoCompactStatus(run).text,
              ...(run.title ? { title: run.title } : {}),
              hasTranscript: !!run.transcriptEntryId,
              errorMessage: run.errorMessage || undefined,
            });
            // 终态（done 或 failed）跃迁都刷新列表：失败也可能已部分入库（如视频已保存），
            // 不刷新会让这些条目直到手动刷新才出现（Bugbot Medium）。
            const terminal = status === 'done' || status === 'failed';
            if (terminal && prevStatus && prevStatus !== status) onRunCompletedRef.current?.();
          }
        }
      } catch {
        /* 网络抖动忽略，下一拍重试 */
      } finally {
        pollingRef.current = false;
      }
    };
    void tick();
    const iv = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [runningIds, patchRun]);

  // 完成/失败的入口在 30s 后自动淡出（避免堆积），running 的常驻。
  useEffect(() => {
    const now = Date.now();
    const timers: number[] = [];
    for (const r of runs) {
      if (r.status === 'running') continue;
      const age = now - r.updatedAt;
      const delay = Math.max(0, 30000 - age);
      timers.push(window.setTimeout(() => dismissRun(r.runId), delay));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [runs, dismissRun]);

  // 所有 hook 都在此之前执行，所以即便隐藏浮层（抽屉打开时），上面的 Host 轮询仍持续运行。
  if (hidden || runs.length === 0) return null;

  return (
    <div className="fixed top-20 right-5 z-40 flex flex-col gap-2" style={{ maxWidth: 300 }}>
      {runs.map((r) => {
        const accent = r.status === 'done'
          ? 'rgba(74,222,128,0.95)'
          : r.status === 'failed'
            ? 'rgba(248,113,113,0.95)'
            : 'rgba(96,165,250,0.95)';
        const subtitle = r.status === 'running'
          ? r.phase || '处理中…'
          : r.status === 'done'
            ? (r.hasTranscript ? '已完成 · 已生成文字' : '视频已入库')
            : (r.errorMessage ? `失败：${r.errorMessage}` : '解析失败，可重试');
        return (
          <div
            key={r.runId}
            className="surface-popover flex items-center gap-2.5 rounded-[12px] border border-token-subtle px-3 py-2.5 cursor-pointer"
            title="运行中的智能体 · 点击重新打开查看进度"
            onClick={() => onOpenRun(r)}
          >
            <div
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px]"
              style={{ background: 'rgba(255,255,255,0.05)', color: accent }}
            >
              {r.status === 'done'
                ? <CheckCircle2 size={14} />
                : r.status === 'failed'
                  ? <AlertCircle size={14} />
                  : <MapSpinner size={14} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-semibold text-token-primary">
                <Video size={11} className="mr-1 inline align-[-1px] text-token-muted" />
                {r.title}
              </p>
              <p className="truncate text-[10px] text-token-muted">{subtitle}</p>
            </div>
            {r.status !== 'running' && (
              <button
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[6px] text-token-muted hover:bg-white/6"
                title="移除"
                onClick={(e) => { e.stopPropagation(); dismissRun(r.runId); }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
