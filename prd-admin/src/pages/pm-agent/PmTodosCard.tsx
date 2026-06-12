/**
 * 项目管理智能体 — 首页右栏「我的待办」卡片（跨项目）。
 *
 * 数据来自 GET /api/pm/my-todos：指派给我的未完成任务（逾期优先）+ 待我打分的结案评价。
 * 点击任务直达任务详情页，点击评价直达该项目「干系人」模块。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListChecks, CalendarClock, Award } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getPmMyTodos } from '@/services';
import type { PmMyTodoItem } from '@/services/contracts/pmAgent';
import { TASK_STATUS_REGISTRY, PRIORITY_REGISTRY } from './pmConstants';

export function PmTodosCard() {
  const navigate = useNavigate();
  const [items, setItems] = useState<PmMyTodoItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getPmMyTodos();
      if (!alive) return;
      if (res.success) setItems(res.data.items);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const open = (it: PmMyTodoItem) => {
    if (it.kind === 'task') navigate(`/pm-agent/p/${it.projectId}/task/${it.id}`);
    else navigate(`/pm-agent/p/${it.projectId}?tab=stakeholders`);
  };

  // 首页右栏窄卡片：与便捷操作按 7:3 分高（flexGrow），列表内部滚动
  return (
    <div className="min-h-0 flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-4" style={{ flexGrow: 7, flexBasis: 0 }}>
      <div className="shrink-0 flex items-center gap-2 mb-1">
        <ListChecks size={15} className="text-blue-400" />
        <span className="text-sm font-semibold text-white/80">我的待办</span>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">{items.length}</span>
      </div>
      <div className="shrink-0 text-[11px] text-white/40 mb-3">跨项目聚合：指派给我的未完成任务（逾期优先）+ 待我打分的结案评价</div>
      {loading ? (
        <div className="flex-1 flex items-center justify-center"><MapSpinner size={18} /></div>
      ) : items.length === 0 ? (
        <div className="text-[12px] text-white/35 py-6 text-center">暂无待办，保持清爽。</div>
      ) : (
        <div className="flex-1 flex flex-col gap-1.5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {items.map((it) => {
            const statusMeta = it.kind === 'task' && it.status ? TASK_STATUS_REGISTRY[it.status] : null;
            const priMeta = it.kind === 'task' && it.priority && it.priority !== 'none' ? PRIORITY_REGISTRY[it.priority] : null;
            return (
              <button
                key={`${it.kind}-${it.id}`}
                onClick={() => open(it)}
                className="pa-row shrink-0 text-left flex items-center gap-2 px-2.5 py-2 rounded-lg border border-white/5"
              >
                {it.kind === 'evaluation' ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-1" style={{ color: '#FBBF24', background: '#FBBF241a' }}>
                    <Award size={10} /> 评价
                  </span>
                ) : (
                  <span className="text-[11px] text-white/35 shrink-0 truncate" style={{ maxWidth: 88 }} title={it.projectTitle}>{it.projectTitle}</span>
                )}
                <span className="text-sm text-white/85 truncate flex-1">{it.kind === 'evaluation' ? `「${it.projectTitle}」${it.title}` : it.title}</span>
                {it.overdue && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-0.5" style={{ background: 'rgba(239,68,68,0.15)', color: '#EF4444' }}>
                    <CalendarClock size={10} /> 逾期
                  </span>
                )}
                {priMeta && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${priMeta.color}22`, color: priMeta.color }}>{priMeta.label}</span>
                )}
                {statusMeta && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/8 text-white/55 border border-white/10 shrink-0">{statusMeta.label}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
