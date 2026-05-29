import { useCallback, useEffect, useState } from 'react';
import { FolderKanban, Plus, Trash2, TrendingUp } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listPmProjects, deletePmProject } from '@/services';
import type { PmProject } from '@/services/contracts/pmAgent';
import { CreateProjectDialog } from './CreateProjectDialog';
import { ProjectDetailView } from './ProjectDetailView';
import { DashboardView } from './DashboardView';
import { PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY, GRADE_REGISTRY } from './pmConstants';

export function PmAgentPage() {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listPmProjects(1, 100);
    if (res.success) setProjects(res.data.items);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, []);

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

  return (
    <div className="flex flex-col gap-4 h-full min-h-0 p-5">
      {/* 头部 */}
      <div className="shrink-0 flex items-center gap-3">
        <FolderKanban size={22} style={{ color: '#3B82F6' }} />
        <div className="flex-1 min-w-0">
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目管理</h1>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>立项注册 → 任务看板 / 甘特图 → AI 拆解需求（对齐米多 PMO 方法论）</p>
        </div>
        <Button variant="secondary" onClick={() => setShowDashboard(true)}><TrendingUp size={15} />NPSS 看板</Button>
        <Button variant="primary" onClick={() => setShowCreate(true)}><Plus size={15} />立项</Button>
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载项目…" /></div>
      ) : projects.length === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
          <FolderKanban size={40} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          <div className="text-[15px] font-medium" style={{ color: 'var(--text-secondary)' }}>还没有项目</div>
          <div className="text-[12px] max-w-md" style={{ color: 'var(--text-muted)' }}>
            项目是「为创造独特成果而进行的临时性工作」。点击立项，填写业务目标后即可让 AI 帮你拆解任务、可视化排期。
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
