import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Sparkles, Plus, LayoutGrid, List, GanttChartSquare, Trash2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  getPmProject, createPmTask, updatePmTask, deletePmTask,
} from '@/services';
import type { PmProject, PmTask, PmTaskStatus } from '@/services/contracts/pmAgent';
import { KanbanBoard } from './KanbanBoard';
import { GanttChart } from './GanttChart';
import { DecomposePanel } from './DecomposePanel';
import { PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY, TASK_STATUS_REGISTRY, PRIORITY_REGISTRY } from './pmConstants';

interface Props {
  projectId: string;
  onBack: () => void;
}

type ViewTab = 'board' | 'list' | 'gantt';

const TABS: { key: ViewTab; label: string; icon: typeof LayoutGrid }[] = [
  { key: 'board', label: '看板', icon: LayoutGrid },
  { key: 'list', label: '列表', icon: List },
  { key: 'gantt', label: '甘特图', icon: GanttChartSquare },
];

export function ProjectDetailView({ projectId, onBack }: Props) {
  const [project, setProject] = useState<PmProject | null>(null);
  const [tasks, setTasks] = useState<PmTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ViewTab>('board');
  const [showDecompose, setShowDecompose] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await getPmProject(projectId);
    if (res.success) {
      setProject(res.data.project);
      setTasks(res.data.tasks);
    } else {
      toast.error('加载失败', res.error?.message || '');
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = useCallback(async (taskId: string, status: PmTaskStatus) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status } : t)));
    const res = await updatePmTask(taskId, { status });
    if (!res.success) { toast.error('更新失败', res.error?.message || ''); load(); }
  }, [load]);

  const handleDelete = useCallback(async (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    const res = await deletePmTask(taskId);
    if (!res.success) { toast.error('删除失败', res.error?.message || ''); load(); }
  }, [load]);

  const handleAddTask = async () => {
    if (!newTitle.trim()) return;
    setAdding(true);
    const res = await createPmTask(projectId, { title: newTitle.trim(), status: 'todo' });
    setAdding(false);
    if (res.success) { setNewTitle(''); setTasks((prev) => [...prev, res.data]); }
    else toast.error('创建失败', res.error?.message || '');
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载项目…" /></div>;
  if (!project) return null;

  const typeMeta = PROJECT_TYPE_REGISTRY[project.projectType];
  const lifeMeta = LIFECYCLE_REGISTRY[project.lifecycle];

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* 项目头部 */}
      <div className="shrink-0">
        <button onClick={onBack} className="flex items-center gap-1 text-[12px] mb-2 hover:opacity-70" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={14} /> 返回项目列表
        </button>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold" style={{ background: `${typeMeta.color}22`, color: typeMeta.color }}>{typeMeta.short}</span>
              <h2 className="text-[17px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{project.title}</h2>
              <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: `${lifeMeta.color}22`, color: lifeMeta.color }}>{lifeMeta.label}</span>
            </div>
            <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>{project.projectNo}｜目标：{project.businessGoal}</div>
          </div>
          <Button variant="primary" onClick={() => setShowDecompose(true)}><Sparkles size={14} />AI 拆解需求</Button>
        </div>
      </div>

      {/* Tab 切换 + 快速加任务 */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--bg-base)' }}>
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] transition-colors"
                style={{ background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
              >
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <input
            className="rounded-lg px-3 py-1.5 text-[12px] outline-none border"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 200 }}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddTask(); }}
            placeholder="快速添加任务…"
          />
          <Button variant="secondary" size="sm" onClick={handleAddTask} disabled={adding || !newTitle.trim()}><Plus size={14} /></Button>
        </div>
      </div>

      {/* 主视图 */}
      {tasks.length === 0 && (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
          <div className="text-[14px] font-medium" style={{ color: 'var(--text-secondary)' }}>还没有任务</div>
          <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>点击右上角「AI 拆解需求」，让 AI 根据业务目标自动生成任务清单</div>
          <Button variant="primary" onClick={() => setShowDecompose(true)}><Sparkles size={14} />AI 拆解需求</Button>
        </div>
      )}

      {tasks.length > 0 && tab === 'board' && (
        <KanbanBoard tasks={tasks} onStatusChange={handleStatusChange} onDelete={handleDelete} />
      )}

      {tasks.length > 0 && tab === 'list' && (
        <div className="flex-1 min-h-0 overflow-y-auto border rounded-xl" style={{ borderColor: 'var(--border-subtle)', overscrollBehavior: 'contain' }}>
          {[...tasks].sort((a, b) => PRIORITY_REGISTRY[b.priority].weight - PRIORITY_REGISTRY[a.priority].weight).map((t) => {
            const p = PRIORITY_REGISTRY[t.priority];
            const s = TASK_STATUS_REGISTRY[t.status];
            return (
              <div key={t.id} className="group flex items-center gap-3 px-4 py-2.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} title={s.label} />
                <span className="text-[13px] flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>{t.title}</span>
                {t.priority !== 'none' && <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${p.color}22`, color: p.color }}>{p.label}</span>}
                {t.estimateDays != null && <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.estimateDays}人天</span>}
                <span className="text-[11px] shrink-0 w-16 text-right" style={{ color: 'var(--text-muted)' }}>{s.label}</span>
                <button onClick={() => handleDelete(t.id)} className="opacity-0 group-hover:opacity-100 p-0.5 shrink-0" style={{ color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
      )}

      {tasks.length > 0 && tab === 'gantt' && <GanttChart tasks={tasks} />}

      {showDecompose && (
        <DecomposePanel
          projectId={projectId}
          businessGoal={project.businessGoal}
          onClose={() => setShowDecompose(false)}
          onCreated={() => { setShowDecompose(false); load(); }}
        />
      )}
    </div>
  );
}
