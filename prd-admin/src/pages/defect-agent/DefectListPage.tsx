import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDefectAgentStore } from '@/stores/defectAgentStore';
import type { DefectReport, DefectStatus } from '@/services/contracts/defectAgent';
import { Plus, List, LayoutGrid, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const STATUS_LABELS: Record<DefectStatus, string> = {
  Draft: '草稿',
  Submitted: '待审核',
  Reviewing: '审核中',
  Analyzed: '已分析',
  Rejected: '已驳回',
  Fixing: '修复中',
  PrCreated: 'PR 已创建',
  Merged: '已合并',
  Verified: '已验证',
  Closed: '已关闭',
};

const STATUS_COLORS: Record<DefectStatus, string> = {
  Draft: 'bg-gray-400/20 text-gray-300',
  Submitted: 'bg-blue-400/20 text-blue-300',
  Reviewing: 'bg-yellow-400/20 text-yellow-300',
  Analyzed: 'bg-green-400/20 text-green-300',
  Rejected: 'bg-red-400/20 text-red-300',
  Fixing: 'bg-orange-400/20 text-orange-300',
  PrCreated: 'bg-purple-400/20 text-purple-300',
  Merged: 'bg-emerald-400/20 text-emerald-300',
  Verified: 'bg-teal-400/20 text-teal-300',
  Closed: 'bg-gray-500/20 text-gray-400',
};

const PRIORITY_LABELS: Record<string, string> = {
  P0_Blocker: 'P0',
  P1_Critical: 'P1',
  P2_Normal: 'P2',
  P3_Minor: 'P3',
};

const PRIORITY_COLORS: Record<string, string> = {
  P0_Blocker: 'text-red-400',
  P1_Critical: 'text-orange-400',
  P2_Normal: 'text-yellow-400',
  P3_Minor: 'text-gray-400',
};

function StatusBadge({ status }: { status: DefectStatus }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[status] || ''}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function DefectRow({ defect, onClick }: { defect: DefectReport; onClick: () => void }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 cursor-pointer border-b border-white/5 last:border-b-0"
      onClick={onClick}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {defect.priority && (
            <span className={`text-xs font-bold ${PRIORITY_COLORS[defect.priority] || ''}`}>
              {PRIORITY_LABELS[defect.priority] || ''}
            </span>
          )}
          <span className="text-sm text-white/90 truncate">{defect.title}</span>
        </div>
        <div className="text-xs text-white/40 mt-0.5">
          {new Date(defect.createdAt).toLocaleDateString()}
          {defect.tags.length > 0 && (
            <span className="ml-2">
              {defect.tags.slice(0, 3).map((t) => (
                <span key={t} className="ml-1 px-1.5 py-0.5 bg-white/5 rounded text-[10px]">{t}</span>
              ))}
            </span>
          )}
        </div>
      </div>
      <StatusBadge status={defect.status} />
    </div>
  );
}

function KanbanColumn({ title, defects, onCardClick }: { title: string; defects: DefectReport[]; onCardClick: (id: string) => void }) {
  return (
    <div className="flex-1 min-w-[200px]">
      <div className="text-xs text-white/50 mb-2 px-1">
        {title} ({defects.length})
      </div>
      <div className="space-y-2">
        {defects.map((d) => (
          <GlassCard key={d.id} className="p-3 cursor-pointer hover:bg-white/10" onClick={() => onCardClick(d.id)}>
            <div className="text-sm text-white/90 truncate">{d.title}</div>
            <div className="flex items-center gap-2 mt-1.5">
              {d.priority && (
                <span className={`text-[10px] font-bold ${PRIORITY_COLORS[d.priority] || ''}`}>
                  {PRIORITY_LABELS[d.priority] || ''}
                </span>
              )}
              <span className="text-[10px] text-white/30">{new Date(d.createdAt).toLocaleDateString()}</span>
            </div>
          </GlassCard>
        ))}
      </div>
    </div>
  );
}

export function DefectListPage() {
  const navigate = useNavigate();
  const { defects, loading, viewMode, filter, setViewMode, setFilter, fetchDefects, fetchStats, stats } = useDefectAgentStore();
  const [statusFilter, setStatusFilter] = useState<string>('');

  useEffect(() => {
    fetchDefects();
    fetchStats();
  }, [fetchDefects, fetchStats]);

  useEffect(() => {
    setFilter({ ...filter, status: statusFilter || undefined });
  }, [statusFilter]);

  useEffect(() => {
    fetchDefects();
  }, [filter, fetchDefects]);

  const handleCardClick = (id: string) => navigate(`/defect-agent/${id}`);

  const kanbanStatuses: DefectStatus[] = ['Submitted', 'Reviewing', 'Analyzed', 'Fixing', 'PrCreated', 'Merged'];
  const groupedByStatus = kanbanStatuses.reduce(
    (acc, s) => {
      acc[s] = defects.filter((d) => d.status === s);
      return acc;
    },
    {} as Record<string, DefectReport[]>
  );

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white/90">缺陷管理 Agent</h1>
          {stats && (
            <p className="text-xs text-white/40 mt-0.5">
              总计 {stats.total} | 活跃 {stats.open} | 已修复 {stats.fixed}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setViewMode(viewMode === 'list' ? 'kanban' : 'list')}>
            {viewMode === 'list' ? <LayoutGrid className="w-4 h-4" /> : <List className="w-4 h-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate('/defect-agent/settings')}>
            <Settings className="w-4 h-4" />
          </Button>
          <Button size="sm" onClick={() => navigate('/defect-agent/new')}>
            <Plus className="w-4 h-4 mr-1" /> 新建缺陷
          </Button>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <select
          className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-white/70"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-white/40 text-sm">加载中...</div>
        ) : defects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-white/40 text-sm">
            <p>暂无缺陷报告</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => navigate('/defect-agent/new')}>
              提交第一个缺陷
            </Button>
          </div>
        ) : viewMode === 'list' ? (
          <GlassCard className="overflow-hidden">
            {defects.map((d) => (
              <DefectRow key={d.id} defect={d} onClick={() => handleCardClick(d.id)} />
            ))}
          </GlassCard>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-4">
            {kanbanStatuses.map((s) => (
              <KanbanColumn key={s} title={STATUS_LABELS[s]} defects={groupedByStatus[s] || []} onCardClick={handleCardClick} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
