/**
 * 项目管理智能体 — 工作台层（全屏，左侧一级导航）。
 *
 * 信息架构：工作台层（项目 / NPSS 看板 / 审计日志）+ 项目层（/pm-agent/p/:projectId，
 * 项目内 9 个模块在项目层左侧导航）。布局复用 AgentFullscreenLayout，蓝色强调。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FolderKanban, Plus, Trash2, TrendingUp, Lightbulb, ChevronUp, ChevronDown, ShieldCheck, Home, BarChart3, ArrowLeft, Library } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { AgentFullscreenLayout, type NavItem } from '@/components/agent-shell/AgentFullscreenLayout';
import '@/components/agent-shell/agent-cards.css';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { listPmProjects, deletePmProject } from '@/services';
import type { PmProject, PmProjectScope } from '@/services/contracts/pmAgent';
import { CreateProjectDialog } from './CreateProjectDialog';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';
import { DashboardView } from './DashboardView';
import { GlobalKnowledgeView } from './GlobalKnowledgeView';
import { AuditLogView } from './AuditLogView';
import { PmAssistantPanel } from './PmAssistantPanel';
import { PmTodosCard } from './PmTodosCard';
import { PmQuickActionsCard } from './PmQuickActionsCard';
import { PmReportsSection } from './PmReportsSection';
import { PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY, GRADE_REGISTRY, PM_ACCENT } from './pmConstants';

type WorkspaceNav = 'home' | 'projects' | 'reports' | 'dashboard' | 'knowledge' | 'audit';

const NAV_KEYS = new Set<WorkspaceNav>(['home', 'projects', 'reports', 'dashboard', 'knowledge', 'audit']);

export function PmAgentPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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

  // 一级导航记录在 URL（?nav=），刷新/返回不丢位置；默认落在首页（AI 工作台）
  const navParam = searchParams.get('nav');
  const active: WorkspaceNav = navParam && NAV_KEYS.has(navParam as WorkspaceNav) ? (navParam as WorkspaceNav) : 'home';
  const setActive = (key: WorkspaceNav) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('nav', key);
      return next;
    }, { replace: true });
  };

  // 旧深链兼容：/pm-agent?project=xxx → 项目层独立路由
  const legacyProject = searchParams.get('project');
  useEffect(() => {
    if (legacyProject) navigate(`/pm-agent/p/${legacyProject}`, { replace: true });
  }, [legacyProject, navigate]);

  // 便捷操作：立项弹窗（页面级宿主）+ AI 助手输入预填（nonce 保证同模板可重复触发）
  const [showCreate, setShowCreate] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const fillAssistant = (text: string) => setPrefill({ text, nonce: Date.now() });

  const NAV: NavItem<WorkspaceNav>[] = [
    { key: 'home', label: '首页', icon: Home },
    { key: 'projects', label: '项目', icon: FolderKanban },
    { key: 'reports', label: '报表', icon: BarChart3 },
    { key: 'dashboard', label: 'NPSS 看板', icon: TrendingUp, hidden: !canViewDashboard, dividerBefore: true },
    { key: 'knowledge', label: '全局知识库', icon: Library, hidden: !canViewDashboard },
    { key: 'audit', label: '审计日志', icon: ShieldCheck, hidden: !canViewAudit },
  ];

  return (
    <AgentFullscreenLayout
      title="项目管理"
      subtitle="立项 → 目标 → 里程碑 / 任务 → 结案"
      topSlot={
        <div className="mb-2">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white"
          >
            <ArrowLeft size={13} /> 返回首页
          </button>
        </div>
      }
      items={NAV}
      active={active}
      onSelect={setActive}
      accent={PM_ACCENT}
    >
      {active === 'home' ? (
        // 首页：AI 助手主区（70%）+ 右栏待办/便捷操作（30%），撑满高度各自滚动
        <div className="flex-1 min-h-0 flex pa-accent-blue">
          <div className="h-full min-h-0 min-w-0 flex flex-col border-r border-white/10" style={{ width: '70%' }}>
            <PmAssistantPanel prefill={prefill} />
          </div>
          <aside className="h-full min-h-0 min-w-0 flex flex-col gap-4 p-4" style={{ width: '30%' }}>
            <PmTodosCard />
            <PmQuickActionsCard ctx={{ openCreateProject: () => setShowCreate(true), fillAssistant, gotoNav: (n) => setActive(n as WorkspaceNav) }} />
          </aside>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col p-5 pa-accent-blue">
          {active === 'projects' && <ProjectsSection onOpen={(id) => navigate(`/pm-agent/p/${id}`)} />}
          {active === 'reports' && <PmReportsSection />}
          {active === 'dashboard' && canViewDashboard && <DashboardView />}
          {active === 'knowledge' && canViewDashboard && <GlobalKnowledgeView />}
          {active === 'audit' && canViewAudit && <AuditLogView />}
        </div>
      )}
      {showCreate && (
        <CreateProjectDialog
          onClose={() => setShowCreate(false)}
          onCreated={(project) => { setShowCreate(false); navigate(`/pm-agent/p/${project.id}`); }}
        />
      )}
    </AgentFullscreenLayout>
  );
}

/** 项目列表（使用说明 + 范围分段 + 卡片网格） */
function ProjectsSection({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [scope, setScope] = useState<PmProjectScope>('managed');
  const [guideOpen, setGuideOpen] = useState(() => sessionStorage.getItem('pm-guide-collapsed') !== '1');
  const toggleGuide = () => setGuideOpen((v) => { sessionStorage.setItem('pm-guide-collapsed', v ? '1' : '0'); return !v; });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listPmProjects({ pageSize: 100, scope });
    if (res.success) setProjects(res.data.items);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const res = await deletePmProject(id);
    if (res.success) { setProjects((prev) => prev.filter((p) => p.id !== id)); toast.success('已删除', ''); }
    else toast.error('删除失败', res.error?.message || '');
  };

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* 头部 */}
      <div className="shrink-0 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目</h1>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>把「有明确目标、有起止时间」的临时性工作当作项目来管</p>
        </div>
        <TipsEntryButton compact />
        <button onClick={toggleGuide} className="flex items-center gap-1 text-[12px] px-2 py-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }} title="使用说明">
          <Lightbulb size={14} />说明{guideOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
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
                  { n: '1', t: '立项', d: '起个项目名、说清想达成的业务目标、挑个项目类型，再点一位项目经理扛旗——填完即开张，随后就能拉成员一起干' },
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
                  onClick={() => onOpen(p.id)}
                  className="pa-card group rounded-xl border p-4 cursor-pointer"
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
          onCreated={(project) => { setShowCreate(false); onOpen(project.id); }}
        />
      )}
    </div>
  );
}
