import { useState } from 'react';
import { Plus, ChevronRight, ChevronDown, Target, Milestone as MilestoneIcon, User, CircleCheck, Lock, Package } from 'lucide-react';
import { Button } from '@/components/design/Button';
import type { PmMilestone, PmGoal, PmTask } from '@/services/contracts/pmAgent';
import { MILESTONE_HEALTH_REGISTRY, TASK_STATUS_REGISTRY } from './pmConstants';
import { MilestoneDetailDrawer } from './MilestoneDetailDrawer';
import { fmtDate } from './materialUtils';

interface Props {
  projectId: string;
  milestones: PmMilestone[];
  goals: PmGoal[];
  tasks: PmTask[];
  canManage: boolean;
  onChanged: () => void;
}

/**
 * 里程碑面板（第一公民）—— 时间轴卡片，菱形健康色 + 进度滚动 + 负责人 + 验收(DoD) + 计划/实际偏差。
 * 点卡片进详情抽屉（编辑全字段 / 管理验收 / 标记达成）。进度由后端按任务完成度滚动计算。
 */
export function MilestonesPanel({ projectId, milestones, goals, tasks, canManage, onChanged }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<{ open: boolean; milestone: PmMilestone | null }>({ open: false, milestone: null });

  const teamGoals = goals.filter((g) => g.scope === 'team');
  const goalTitle = (id?: string | null) => (id ? teamGoals.find((g) => g.id === id)?.title ?? goals.find((g) => g.id === id)?.title ?? null : null);
  const tasksOf = (mId: string) => tasks.filter((t) => t.milestoneId === mId);
  const sorted = [...milestones].sort((a, b) => {
    const av = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bv = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return av - bv || (a.orderKey ?? 0) - (b.orderKey ?? 0);
  });

  const toggle = (id: string) => setExpanded((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const openDrawer = (m: PmMilestone | null) => setDrawer({ open: true, milestone: m });
  const closeDrawer = () => setDrawer({ open: false, milestone: null });

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      <div className="flex items-center gap-2 shrink-0">
        <MilestoneIcon size={15} style={{ color: '#A855F7' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>里程碑</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>阶段关键节点：负责人 + 验收标准 + 进度自动滚动；点卡片看详情</span>
        {canManage && <Button variant="primary" size="sm" className="ml-auto" onClick={() => openDrawer(null)}><Plus size={13} />新增里程碑</Button>}
      </div>

      {sorted.length === 0 ? (
        <div className="text-[12px] text-center py-10 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          {canManage ? '还没有里程碑。点「新增里程碑」设定阶段节点，指派负责人、列出验收标准，再到「任务」把任务归属进来，进度会自动滚动。' : '暂无里程碑。'}
        </div>
      ) : (
        <div className="flex flex-col">
          {sorted.map((m, idx) => {
            const h = MILESTONE_HEALTH_REGISTRY[m.health];
            const kids = tasksOf(m.id);
            const isOpen = expanded.has(m.id);
            const gName = goalTitle(m.goalId);
            const cTotal = m.criteriaTotal ?? 0;
            const cDone = m.criteriaDone ?? 0;
            return (
              <div key={m.id} className="flex gap-3">
                {/* 左侧时间轴：菱形 + 连接线 */}
                <div className="flex flex-col items-center shrink-0" style={{ width: 16 }}>
                  <span style={{ width: 12, height: 12, background: h.color, transform: 'rotate(45deg)', display: 'inline-block', borderRadius: 2, marginTop: 14 }} />
                  {idx < sorted.length - 1 && <span className="flex-1" style={{ width: 2, background: 'var(--border-subtle)', marginTop: 4 }} />}
                </div>
                {/* 卡片（整卡可点进详情） */}
                <div className="group flex-1 min-w-0 rounded-lg border mb-2 flex flex-col gap-2 p-3 cursor-pointer transition-colors hover:border-[var(--border-strong)]"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
                  onClick={() => openDrawer(m)}>
                  <div className="flex items-center gap-2">
                    {kids.length > 0 && (
                      <button onClick={(e) => { e.stopPropagation(); toggle(m.id); }} style={{ color: 'var(--text-muted)' }} title={isOpen ? '收起任务' : '展开任务'}>
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                    <span className="text-[13px] font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.title}</span>
                    {m.blocked && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-1" style={{ background: 'rgba(239,68,68,0.14)', color: '#EF4444' }} title={`受阻：${(m.blockedBy ?? []).join('、')} 未达成`}><Lock size={9} />受阻</span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${h.color}22`, color: h.color }}>{h.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                      <div style={{ width: `${m.progress}%`, height: '100%', background: h.color }} />
                    </div>
                    <span className="text-[11px] tabular-nums w-9 text-right" style={{ color: 'var(--text-muted)' }}>{m.progress}%</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                    {m.dueAt && <span>截止 {fmtDate(m.dueAt)}</span>}
                    <span>任务 {m.taskDone}/{m.taskTotal}</span>
                    {cTotal > 0 && (
                      <span className="inline-flex items-center gap-1" style={{ color: cDone === cTotal ? '#10B981' : 'var(--text-muted)' }}>
                        <CircleCheck size={10} />验收 {cDone}/{cTotal}
                      </span>
                    )}
                    {m.ownerName && <span className="inline-flex items-center gap-1"><User size={10} />{m.ownerName}</span>}
                    {(m.deliverables?.length ?? 0) > 0 && <span className="inline-flex items-center gap-1"><Package size={10} />交付物 {m.deliverables!.length}</span>}
                    {(m.dependsOn?.length ?? 0) > 0 && <span className="inline-flex items-center gap-1"><Lock size={10} />前置 {m.dependsOn!.length}</span>}
                    {gName && <span className="inline-flex items-center gap-1"><Target size={10} />{gName}</span>}
                    {m.reachedAt && <span style={{ color: '#10B981' }}>已达成 {fmtDate(m.reachedAt)}</span>}
                    {typeof m.slippageDays === 'number' && m.slippageDays !== 0 && (
                      <span style={{ color: m.slippageDays > 0 ? '#EF4444' : '#10B981' }}>
                        {m.slippageDays > 0 ? `延期 ${m.slippageDays} 天` : `提前 ${-m.slippageDays} 天`}
                      </span>
                    )}
                  </div>
                  {isOpen && kids.length > 0 && (
                    <div className="flex flex-col gap-1 pt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
                      {kids.map((t) => {
                        const st = TASK_STATUS_REGISTRY[t.status];
                        return (
                          <div key={t.id} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.color }} />
                            <span className="truncate flex-1" title={t.title}>{t.title}</span>
                            {t.assigneeName && <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.assigneeName}</span>}
                            <span className="text-[10px] shrink-0" style={{ color: st.color }}>{st.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawer.open && (
        <MilestoneDetailDrawer
          projectId={projectId} milestone={drawer.milestone} allMilestones={milestones} goals={goals} tasks={tasks}
          canManage={canManage} onClose={closeDrawer}
          onSaved={() => { closeDrawer(); onChanged(); }}
        />
      )}
    </div>
  );
}
