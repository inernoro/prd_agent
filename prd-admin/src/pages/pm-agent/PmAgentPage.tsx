import { useCallback, useEffect, useState } from 'react';
import { FolderKanban, Plus, Trash2, TrendingUp, Lightbulb, ChevronUp, ChevronDown, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { listPmProjects, deletePmProject } from '@/services';
import type { PmProject, PmProjectScope } from '@/services/contracts/pmAgent';
import { CreateProjectDialog } from './CreateProjectDialog';
import { ProjectDetailView } from './ProjectDetailView';
import { DashboardView } from './DashboardView';
import { AuditLogView } from './AuditLogView';
import { PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY, GRADE_REGISTRY } from './pmConstants';

export function PmAgentPage() {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [scope, setScope] = useState<PmProjectScope>('managed');
  // 组织 NPSS 看板仅对管理层开放（pm-agent.dashboard），与普通的 pm-agent.use 区分
  const canViewDashboard = useAuthStore((s) => {
    const perms = Array.isArray(s.permissions) ? s.permissions : [];
    return perms.includes('pm-agent.dashboard') || perms.includes('super');
  });
  // 审计日志仅对管理层开放（pm-agent.audit）
  const canViewAudit = useAuthStore((s) => {
    const perms = Array.isArray(s.permissions) ? s.permissions : [];
    return perms.includes('pm-agent.audit') || perms.includes('super');
  });
  const [guideOpen, setGuideOpen] = useState(() => sessionStorage.getItem('pm-guide-collapsed') !== '1');
  const toggleGuide = () => setGuideOpen((v) => { sessionStorage.setItem('pm-guide-collapsed', v ? '1' : '0'); return !v; });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listPmProjects({ pageSize: 100, scope });
    if (res.success) setProjects(res.data.items);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [scope]);

  useEffect(() => { if (!selectedId) load(); }, [load, selectedId]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const res = await deletePmProject(id);
    if (res.success) { setProjects((prev) => prev.filter((p) => p.id !== id)); toast.success('已删除', ''); }
    else toast.error('删除失败', res.error?.message || '');
  };

  // 详情视图
  if (selectedId) {
    return (
      <div className="h-full min-h-0 p-5">
        <ProjectDetailView projectId={selectedId} onBack={() => setSelectedId(null)} />
      </div>
    );
  }

  // 组织 NPSS 看板
  if (showDashboard) {
    return (
      <div className="h-full min-h-0 p-5">
        <DashboardView onBack={() => setShowDashboard(false)} />
      </div>
    );
  }

  // 审计日志
  if (showAudit) {
    return (
      <div className="h-full min-h-0 p-5">
        <AuditLogView onBack={() => setShowAudit(false)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 h-full min-h-0 p-5">
      {/* 头部 */}
      <div className="shrink-0 flex items-center gap-3">
        <FolderKanban size={22} style={{ color: '#3B82F6' }} />
        <div className="flex-1 min-w-0">
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目管理</h1>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>立项 → 目标 → 里程碑 / 任务 → 推进 → 结案</p>
        </div>
        <button onClick={toggleGuide} className="flex items-center gap-1 text-[12px] px-2 py-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }} title="使用说明">
          <Lightbulb size={14} />说明{guideOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {canViewAudit && (
          <Button variant="secondary" onClick={() => setShowAudit(true)}><ShieldCheck size={15} />审计日志</Button>
        )}
        {canViewDashboard && (
          <Button variant="secondary" onClick={() => setShowDashboard(true)}><TrendingUp size={15} />NPSS 看板</Button>
        )}
        <Button variant="primary" onClick={() => setShowCreate(true)}><Plus size={15} />立项</Button>
      </div>

      {/* 使用说明（引导区） */}
      {guideOpen && (
        <div className="shrink-0 rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <div className="flex items-start gap-2">
            <Lightbulb size={16} className="mt-0.5 shrink-0" style={{ color: '#F59E0B' }} />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目管理能帮你做什么</div>
              <div className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                把「有明确目标、有起止时间」的临时性工作当作项目：先定目标（可让 AI 依据业务目标拆解 OKR），再用里程碑 + 任务（看板 / 列表 / 甘特）排计划与跟踪，结案时按 NPSS 评价。
              </div>
              <div className="grid gap-2 mt-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
                {[
                  { n: '1', t: '立项', d: '填项目名、业务目标、项目类型（默认普通），指定项目经理' },
                  { n: '2', t: '定目标', d: '在「目标」围绕业务目标设 OKR，可 AI 拆解；进度由里程碑滚动' },
                  { n: '3', t: '推进', d: '用里程碑 + 任务（看板 / 列表 / 甘特）排期跟踪，或 AI 拆解需求成任务' },
                  { n: '4', t: '结案', d: '维护干系人打分得 NPSS，看板汇总成功度与奖金' },
                ].map((s) => (
                  <div key={s.n} className="rounded-lg p-2.5" style={{ background: 'var(--bg-base)' }}>
                    <div className="flex items-center gap-1.5">
                      <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: 'rgba(59,130,246,0.2)', color: '#3B82F6' }}>{s.n}</span>
                      <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{s.t}</span>
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{s.d}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 范围分段：我管理的 / 我相关的 / 全部 */}
      <div className="shrink-0 flex items-center gap-1 rounded-lg p-1 w-fit" style={{ background: 'var(--bg-base)' }}>
        {([
          { key: 'managed' as const, label: '我管理的' },
          { key: 'related' as const, label: '我相关的' },
          { key: 'all' as const, label: '全部' },
        ]).map((s) => {
          const active = scope === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setScope(s.key)}
              className="px-3 py-1.5 rounded-md text-[12px] transition-colors"
              style={{ background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载项目…" /></div>
      ) : projects.length === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
          <FolderKanban size={40} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          <div className="text-[15px] font-medium" style={{ color: 'var(--text-secondary)' }}>还没有项目</div>
          <div className="text-[12px] max-w-md" style={{ color: 'var(--text-muted)' }}>
            项目是「为创造独特成果而进行的临时性工作」。点击立项、填写业务目标后，可让 AI 拆解目标与任务，用里程碑可视化排期，并跟踪到结案评价。
          </div>
          <Button variant="primary" onClick={() => setShowCreate(true)}><Plus size={15} />立项第一个项目</Button>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {projects.map((p) => {
              const typeMeta = PROJECT_TYPE_REGISTRY[p.projectType];
              const lifeMeta = LIFECYCLE_REGISTRY[p.lifecycle];
              const progress = p.taskCount > 0 ? Math.round((p.doneTaskCount / p.taskCount) * 100) : 0;
              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className="group rounded-xl border p-4 cursor-pointer transition-colors hover:border-current"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold shrink-0" style={{ background: `${typeMeta.color}22`, color: typeMeta.color }}>{typeMeta.short}</span>
                    <span className="text-[14px] font-semibold flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>{p.title}</span>
                    <button onClick={(e) => handleDelete(p.id, e)} className="opacity-0 group-hover:opacity-100 p-0.5 shrink-0" style={{ color: 'var(--text-muted)' }}><Trash2 size={14} /></button>
                  </div>
                  <div className="text-[11px] mt-1.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{p.businessGoal}</div>
                  <div className="flex items-center gap-2 mt-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${lifeMeta.color}22`, color: lifeMeta.color }}>{lifeMeta.label}</span>
                    {p.evaluation && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ background: `${GRADE_REGISTRY[p.evaluation.grade].color}22`, color: GRADE_REGISTRY[p.evaluation.grade].color }}>
                        NPSS {p.evaluation.satisfactionScore}
                      </span>
                    )}
                    <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>{p.doneTaskCount}/{p.taskCount} 任务</span>
                  </div>
                  {/* 进度条 */}
                  <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                    <div className="h-full rounded-full" style={{ width: `${progress}%`, background: lifeMeta.color, transition: 'width .3s' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showCreate && (
        <CreateProjectDialog
          onClose={() => setShowCreate(false)}
          onCreated={(project) => { setShowCreate(false); setSelectedId(project.id); }}
        />
      )}
    </div>
  );
}
