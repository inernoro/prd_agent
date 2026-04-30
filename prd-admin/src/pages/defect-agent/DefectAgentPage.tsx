import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/design/Button';
import { Surface } from '@/components/design';
import { TabBar } from '@/components/design/TabBar';
import { useDefectStore } from '@/stores/defectStore';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';
import { DefectStatus } from '@/services/contracts/defectAgent';
import { Bug, Plus, FileText, RefreshCw, LayoutGrid, List, Columns3, BarChart3, FolderKanban } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { DefectList } from './components/DefectList';
import { DefectSubmitPanel } from './components/DefectSubmitPanel';
import { DefectDetailPanel } from './components/DefectDetailPanel';
import { TemplateDialog } from './components/TemplateDialog';
import { ProjectDialog } from './components/ProjectDialog';
import { KanbanBoard } from './components/KanbanBoard';
import { StatsPanel } from './components/StatsPanel';
import { SharesListPanel } from './components/SharesListPanel';
import { Share2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const NOTIFICATION_STORAGE_KEY = 'defect-agent-notified-ids';

export default function DefectAgentPage() {
  const {
    defects,
    defectsTotal,
    loading,
    error,
    filter,
    setFilter,
    selectedDefectId,
    showSubmitPanel,
    setShowSubmitPanel,
    showTemplateDialog,
    setShowTemplateDialog,
    viewMode,
    setViewMode,
    loadAll,
    projects,
    teams,
    projectFilter,
    teamFilter,
    setProjectFilter,
    setTeamFilter,
    searchQuery,
  } = useDefectStore();

  const userId = useAuthStore((s) => s.user?.userId);
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [showSharesPanel, setShowSharesPanel] = useState(false);
  const notifiedRef = useRef(false);

  // 与 DefectList 一致的客户端过滤逻辑，计算当前可见的缺陷 ID
  const visibleDefectIds = useMemo(() => {
    const archivedStatuses = [DefectStatus.Closed, DefectStatus.Rejected];
    let filtered = defects;
    if (userId && filter === 'submitted') filtered = defects.filter((d) => d.reporterId === userId);
    else if (userId && filter === 'assigned') filtered = defects.filter((d) => d.assigneeId === userId);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((d) =>
        d.defectNo?.toLowerCase().includes(q) ||
        d.title?.toLowerCase().includes(q) ||
        d.rawContent?.toLowerCase().includes(q)
      );
    }
    return filtered.filter((d) => !archivedStatuses.includes(d.status as typeof DefectStatus.Closed)).map((d) => d.id);
  }, [defects, filter, userId, searchQuery]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 显示待处理缺陷的通知（每次会话显示一次）
  useEffect(() => {
    if (loading || notifiedRef.current) return;
    if (filter !== 'assigned') return;

    // 获取已通知的缺陷 ID（使用 sessionStorage，每次登录清空）
    const notifiedIdsStr = sessionStorage.getItem(NOTIFICATION_STORAGE_KEY);
    const notifiedIds = new Set<string>(notifiedIdsStr ? JSON.parse(notifiedIdsStr) : []);

    // 找出待处理的缺陷（待处理、处理中状态）
    const pendingStatuses = [DefectStatus.Pending, DefectStatus.Working, DefectStatus.Verifying];
    const pendingDefects = defects.filter(
      (d) => pendingStatuses.includes(d.status as typeof DefectStatus.Pending) && !notifiedIds.has(d.id)
    );

    if (pendingDefects.length > 0) {
      notifiedRef.current = true;

      // 显示通知
      if (pendingDefects.length === 1) {
        const d = pendingDefects[0];
        toast.warning(`有待处理缺陷: ${d.defectNo}`, undefined, 8000);
      } else {
        toast.warning(`有 ${pendingDefects.length} 个待处理缺陷等待您处理`, undefined, 8000);
      }

      // 记录已通知的缺陷 ID
      pendingDefects.forEach((d) => notifiedIds.add(d.id));
      sessionStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify([...notifiedIds]));
    }
  }, [defects, loading, filter]);

  const tabItems = useMemo(
    () => [
      { key: 'assigned', label: '收到的' },
      { key: 'submitted', label: '我提交的' },
    ],
    []
  );

  const viewButtons: { key: typeof viewMode; icon: typeof LayoutGrid; title: string }[] = [
    { key: 'list', icon: List, title: '列表视图' },
    { key: 'card', icon: LayoutGrid, title: '卡片视图' },
    { key: 'kanban', icon: Columns3, title: '看板视图' },
    { key: 'stats', icon: BarChart3, title: '统计看板' },
  ];

  const isStatsView = viewMode === 'stats';

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title="缺陷管理"
        icon={<Bug size={16} />}
        items={tabItems}
        activeKey={filter}
        onChange={(key) => setFilter(key as 'submitted' | 'assigned')}
        actions={
          <>
            {/* 项目/团队筛选 */}
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className={cn('prd-field h-7 px-2 rounded-lg text-[12px]', !projectFilter && 'text-token-muted')}
            >
              <option value="">全部项目</option>
              {projects.filter(p => !p.isArchived).map((p) => (
                <option key={p.id} value={p.id}>[{p.key}] {p.name}</option>
              ))}
            </select>
            {teams.length > 0 && (
              <select
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
                className={cn('prd-field h-7 px-2 rounded-lg text-[12px]', !teamFilter && 'text-token-muted')}
              >
                <option value="">全部团队</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}

            {/* 视图切换：卡片 / 列表 / 看板 / 统计 */}
            <div className="surface-inset flex items-center rounded-lg overflow-hidden">
              {viewButtons.map(({ key, icon: Icon, title }) => (
                <button
                  key={key}
                  type="button"
                  className={cn(
                    'flex items-center justify-center w-7 h-7 transition-colors',
                    viewMode === key ? 'bg-token-nested text-token-primary' : 'text-token-muted hover:text-token-primary'
                  )}
                  onClick={() => setViewMode(key)}
                  title={title}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowSharesPanel(true)}
            >
              <Share2 size={14} />
              分享管理
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowProjectDialog(true)}
            >
              <FolderKanban size={14} />
              项目管理
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowTemplateDialog(true)}
            >
              <FileText size={14} />
              我的模板
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-tour-id="defect-create"
              onClick={() => setShowSubmitPanel(true)}
            >
              <Plus size={14} />
              提交缺陷
            </Button>
          </>
        }
      />

      {/* Error */}
      {error && (
        <Surface variant="raised" className="py-2 px-3 rounded-xl">
          <div className="flex items-center justify-between">
            <div className="text-token-error text-[12px]">
              {error}
            </div>
            <Button variant="secondary" size="sm" onClick={() => loadAll()}>
              <RefreshCw size={12} />
              重试
            </Button>
          </div>
        </Surface>
      )}

      {/* Loading */}
      {loading && !error && (
        <Surface variant="raised" className="py-3 px-3 rounded-xl">
          <div className="text-token-muted text-[12px] flex items-center gap-2">
            <MapSpinner size={12} />
            加载中...
          </div>
        </Surface>
      )}

      {/* 数据截断提示：服务端总数 > 已加载条数时显式告知用户"还有未显示的数据"，避免"我的缺陷凭空消失"的困惑 */}
      {!loading && !error && defectsTotal > defects.length && (
        <Surface variant="raised" className="py-2 px-3 rounded-xl">
          <div className="text-token-muted text-[12px] flex items-center justify-between gap-2">
            <span>
              已加载最新 {defects.length} 条，共 {defectsTotal} 条。请使用项目/团队/状态筛选缩小范围以查看更多。
            </span>
            <Button variant="secondary" size="sm" onClick={() => loadAll()}>
              <RefreshCw size={12} />
              重新加载
            </Button>
          </div>
        </Surface>
      )}

      {/* Content */}
      {isStatsView ? (
        /* 统计看板：不需要外层 GlassCard 包裹，StatsPanel 内部自己用 */
        <div className="flex-1 min-h-0 overflow-auto">
          <StatsPanel />
        </div>
      ) : viewMode === 'kanban' ? (
        /* 看板视图 */
        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
      ) : (
        /* 卡片/列表视图 */
        <Surface variant="raised" className="flex-1 min-h-0 rounded-xl">
          <div className="h-full min-h-0 overflow-auto">
            <DefectList />
          </div>
        </Surface>
      )}

      {/* Detail Modal */}
      {selectedDefectId && <DefectDetailPanel />}

      {/* Submit Panel (slide-over) */}
      {showSubmitPanel && <DefectSubmitPanel />}

      {/* Template Dialog */}
      {showTemplateDialog && <TemplateDialog />}

      {/* Project Dialog */}
      {showProjectDialog && <ProjectDialog onClose={() => setShowProjectDialog(false)} />}

      {/* Shares Panel */}
      {showSharesPanel && (
        <SharesListPanel
          open={showSharesPanel}
          onClose={() => setShowSharesPanel(false)}
          visibleDefectIds={visibleDefectIds}
        />
      )}
    </div>
  );
}
