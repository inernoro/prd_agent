import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useHistoryBackedView } from '@/hooks/useHistoryBackedView';
import type { QuickVideoSummary } from '@/services/contracts/quickCreate';
import { listQuickVideosReal } from '@/services/real/quickCreate';
import { QuickVideoTemplateGallery, QuickVideoTemplateResult } from './QuickVideoTemplatePanel';

const runLabels: Record<QuickVideoSummary['status'], string> = {
  Queued: '排队中', Running: '正在创作', Completed: '已生成', Failed: '生成失败',
};

export default function QuickCreatePage() {
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<QuickVideoSummary[]>([]);
  const refresh = useCallback(async () => {
    try {
      const result = await listQuickVideosReal();
      if (result.success) setRecentRuns(result.data);
    } catch {
      // 模板输入可以独立使用，记录在下一次返回时重新读取。
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useHistoryBackedView({
    param: 'run', value: activeRun, onExit: () => { setActiveRun(null); void refresh(); },
    onRestore: (id) => {
      if (!/^[a-f0-9]{32}$/.test(id)) return false;
      setActiveRun(id);
      return true;
    },
  });

  if (activeRun) return <QuickVideoTemplateResult key={activeRun} runId={activeRun} onCreated={setActiveRun}
    onBack={() => { setActiveRun(null); void refresh(); }} />;

  return (
    <main className="h-full overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-6 text-2xl font-semibold">快速创作</h1>
        <QuickVideoTemplateGallery onCreated={setActiveRun} />
        {recentRuns.length > 0 && (
          <section aria-label="最近创作" className="mt-7 max-w-[720px]">
            <h2 className="mb-3 text-sm font-semibold">最近创作</h2>
            {recentRuns.map((run) => (
              <button key={run.id} type="button" onClick={() => setActiveRun(run.id)}
                className="mb-2 flex w-full items-center gap-3 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-left">
                <span className="min-w-0 flex-1 truncate">{run.articleTitle}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">{run.publishedSiteId ? '已发布' : runLabels[run.status]}</span>
                <ArrowUpRight size={14} className="shrink-0" />
              </button>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
