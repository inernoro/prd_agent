import { useMemo, useState } from 'react';
import { useDefectStore } from '@/stores/defectStore';
import { useAuthStore } from '@/stores/authStore';
import { DefectStatus } from '@/services/contracts/defectAgent';
import { DefectCard } from './DefectCard';
import { DefectListRow } from './DefectListRow';
import { Bug, ChevronRight, ChevronDown, Archive } from 'lucide-react';

export function DefectList() {
  const { defects, loading, filter, viewMode, readIds } = useDefectStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

  // 按用户角色筛选，但不再排除已完成/拒绝的缺陷
  const filteredDefects = useMemo(() => {
    if (!userId) return defects;
    if (filter === 'submitted') {
      return defects.filter((d) => d.reporterId === userId);
    }
    if (filter === 'assigned') {
      return defects.filter((d) => d.assigneeId === userId);
    }
    return defects;
  }, [defects, filter, userId]);

  // 分成两组：进行中 和 已归档（完成/拒绝）
  const { activeDefects, archivedDefects } = useMemo(() => {
    const active = filteredDefects.filter(
      (d) => d.status !== DefectStatus.Resolved && d.status !== DefectStatus.Rejected
    );
    const archived = filteredDefects.filter(
      (d) => d.status === DefectStatus.Resolved || d.status === DefectStatus.Rejected
    );
    return { activeDefects: active, archivedDefects: archived };
  }, [filteredDefects]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      </div>
    );
  }

  if (filteredDefects.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Bug
            size={40}
            style={{ color: 'var(--text-muted)', margin: '0 auto 12px', opacity: 0.5 }}
          />
          <div
            className="text-[13px] font-medium"
            style={{ color: 'var(--text-secondary)' }}
          >
            {filter === 'submitted' ? '暂无提交的缺陷' : '暂无收到的缺陷'}
          </div>
          <div
            className="text-[11px] mt-1"
            style={{ color: 'var(--text-muted)' }}
          >
            {filter === 'submitted'
              ? '点击右上角「提交缺陷」开始'
              : '等待他人提交缺陷给你'}
          </div>
        </div>
      </div>
    );
  }

  // 列表视图
  if (viewMode === 'list') {
    return (
      <div className="flex flex-col">
        {/* 列表头部 */}
        <div
          className="flex items-center gap-3 px-3 py-2 text-[10px] font-medium select-none"
          style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div className="w-1 flex-shrink-0" />
          <div className="w-2 flex-shrink-0" />
          <span className="w-[46px] flex-shrink-0">严重性</span>
          <span className="flex-1 min-w-0">标题</span>
          <span className="w-[52px] flex-shrink-0">状态</span>
          <span className="w-[26px] flex-shrink-0" />
          <span className="w-[58px] flex-shrink-0">人员</span>
          <span className="w-[64px] flex-shrink-0 text-right">时间</span>
          <span className="w-5 flex-shrink-0" />
        </div>

        {/* 进行中的缺陷 */}
        {activeDefects.map((defect) => (
          <DefectListRow key={defect.id} defect={defect} isRead={readIds.has(defect.id)} />
        ))}

        {/* 进行中为空时的提示 */}
        {activeDefects.length === 0 && archivedDefects.length > 0 && (
          <div className="flex items-center justify-center py-8">
            <div className="text-center">
              <Bug size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 8px', opacity: 0.4 }} />
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无进行中的缺陷</div>
            </div>
          </div>
        )}

        {/* 已归档的缺陷（可折叠） */}
        {archivedDefects.length > 0 && (
          <>
            <div
              className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none transition-colors hover:bg-white/5"
              style={{ borderBottom: '1px solid var(--border-subtle)' }}
              onClick={() => setArchivedCollapsed(!archivedCollapsed)}
            >
              {archivedCollapsed ? (
                <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
              ) : (
                <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
              )}
              <Archive size={14} style={{ color: 'var(--text-muted)' }} />
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                已归档
              </span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.06)' }}
              >
                {archivedDefects.length}
              </span>
            </div>
            {!archivedCollapsed && archivedDefects.map((defect) => (
              <DefectListRow key={defect.id} defect={defect} isRead={readIds.has(defect.id)} />
            ))}
          </>
        )}
      </div>
    );
  }

  // 卡片视图（原有逻辑）
  return (
    <div className="flex flex-col gap-4">
      {/* 进行中的缺陷 */}
      {activeDefects.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {activeDefects.map((defect) => (
            <DefectCard key={defect.id} defect={defect} />
          ))}
        </div>
      )}

      {/* 进行中为空时的提示 */}
      {activeDefects.length === 0 && archivedDefects.length > 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="text-center">
            <Bug
              size={32}
              style={{ color: 'var(--text-muted)', margin: '0 auto 8px', opacity: 0.4 }}
            />
            <div
              className="text-[12px]"
              style={{ color: 'var(--text-muted)' }}
            >
              暂无进行中的缺陷
            </div>
          </div>
        </div>
      )}

      {/* 已归档的缺陷（可折叠） */}
      {archivedDefects.length > 0 && (
        <div className="mt-2">
          {/* 折叠标题栏 */}
          <div
            className="flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer select-none mb-3 transition-colors hover:bg-white/5"
            onClick={() => setArchivedCollapsed(!archivedCollapsed)}
          >
            {archivedCollapsed ? (
              <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
            ) : (
              <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
            )}
            <Archive size={14} style={{ color: 'var(--text-muted)' }} />
            <span
              className="text-[12px] font-medium"
              style={{ color: 'var(--text-secondary)' }}
            >
              已归档
            </span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                color: 'var(--text-muted)',
                background: 'rgba(255,255,255,0.06)',
              }}
            >
              {archivedDefects.length}
            </span>
          </div>

          {/* 已归档的缺陷列表 */}
          {!archivedCollapsed && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {archivedDefects.map((defect) => (
                <DefectCard key={defect.id} defect={defect} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
