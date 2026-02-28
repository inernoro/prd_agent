import { useEffect, useMemo, useRef } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { useDefectStore } from '@/stores/defectStore';
import { toast } from '@/lib/toast';
import { DefectStatus } from '@/services/contracts/defectAgent';
import { Bug, Plus, FileText, RefreshCw, LayoutGrid, List } from 'lucide-react';
import { DefectList } from './components/DefectList';
import { DefectSubmitPanel } from './components/DefectSubmitPanel';
import { DefectDetailPanel } from './components/DefectDetailPanel';
import { TemplateDialog } from './components/TemplateDialog';

const NOTIFICATION_STORAGE_KEY = 'defect-agent-notified-ids';

export default function DefectAgentPage() {
  const {
    defects,
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
  } = useDefectStore();

  const notifiedRef = useRef(false);

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
    const pendingStatuses = [DefectStatus.Pending, DefectStatus.Working];
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
            {/* 视图切换 */}
            <div
              className="flex items-center rounded-lg overflow-hidden"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <button
                type="button"
                className="flex items-center justify-center w-7 h-7 transition-colors"
                style={{
                  background: viewMode === 'card' ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: viewMode === 'card' ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                onClick={() => setViewMode('card')}
                title="卡片视图"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                className="flex items-center justify-center w-7 h-7 transition-colors"
                style={{
                  background: viewMode === 'list' ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: viewMode === 'list' ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                onClick={() => setViewMode('list')}
                title="列表视图"
              >
                <List size={14} />
              </button>
            </div>
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
        <GlassCard animated glow className="py-2 px-3">
          <div className="flex items-center justify-between">
            <div
              className="text-[12px]"
              style={{ color: 'rgba(255,120,120,0.95)' }}
            >
              {error}
            </div>
            <Button variant="secondary" size="sm" onClick={() => loadAll()}>
              <RefreshCw size={12} />
              重试
            </Button>
          </div>
        </GlassCard>
      )}

      {/* Loading */}
      {loading && !error && (
        <GlassCard animated glow className="py-3 px-3">
          <div
            className="text-[12px] flex items-center gap-2"
            style={{ color: 'var(--text-muted)' }}
          >
            <RefreshCw size={12} className="animate-spin" />
            加载中...
          </div>
        </GlassCard>
      )}

      {/* Content - 用 GlassCard 包裹整个列表区域 */}
      <GlassCard animated variant="subtle" className="flex-1 min-h-0">
        <div className="h-full min-h-0 overflow-auto">
          <DefectList />
        </div>
      </GlassCard>

      {/* Detail Modal */}
      {selectedDefectId && <DefectDetailPanel />}

      {/* Submit Panel (slide-over) */}
      {showSubmitPanel && <DefectSubmitPanel />}

      {/* Template Dialog */}
      {showTemplateDialog && <TemplateDialog />}
    </div>
  );
}
