import { useEffect, useMemo } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { useDefectStore } from '@/stores/defectStore';
import { Bug, Plus, FileText, RefreshCw } from 'lucide-react';
import { DefectList } from './components/DefectList';
import { DefectSubmitPanel } from './components/DefectSubmitPanel';
import { DefectDetailPanel } from './components/DefectDetailPanel';
import { TemplateDialog } from './components/TemplateDialog';

export default function DefectAgentPage() {
  const {
    loading,
    error,
    filter,
    setFilter,
    selectedDefectId,
    showSubmitPanel,
    setShowSubmitPanel,
    showTemplateDialog,
    setShowTemplateDialog,
    loadAll,
  } = useDefectStore();

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const tabItems = useMemo(
    () => [
      { key: 'submitted', label: '我提交的' },
      { key: 'assigned', label: '收到的' },
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
        <GlassCard glow className="py-2 px-3">
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
        <GlassCard glow className="py-3 px-3">
          <div
            className="text-[12px] flex items-center gap-2"
            style={{ color: 'var(--text-muted)' }}
          >
            <RefreshCw size={12} className="animate-spin" />
            加载中...
          </div>
        </GlassCard>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 flex gap-4">
        {/* List */}
        <div className="flex-1 min-h-0 overflow-auto">
          <DefectList />
        </div>

        {/* Detail Panel (if selected) */}
        {selectedDefectId && (
          <div className="w-[400px] min-h-0 flex-shrink-0">
            <DefectDetailPanel />
          </div>
        )}
      </div>

      {/* Submit Panel (slide-over) */}
      {showSubmitPanel && <DefectSubmitPanel />}

      {/* Template Dialog */}
      {showTemplateDialog && <TemplateDialog />}
    </div>
  );
}
