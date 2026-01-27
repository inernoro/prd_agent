import { useMemo } from 'react';
import { useDefectStore } from '@/stores/defectStore';
import { useAuthStore } from '@/stores/authStore';
import { DefectStatus } from '@/services/contracts/defectAgent';
import { DefectCard } from './DefectCard';
import { Bug } from 'lucide-react';

export function DefectList() {
  const { defects, loading, filter } = useDefectStore();
  const userId = useAuthStore((s) => s.user?.userId);

  const filteredDefects = useMemo(() => {
    if (!userId) return defects;
    if (filter === 'submitted') {
      return defects.filter(
        (d) =>
          d.reporterId === userId &&
          d.status !== DefectStatus.Resolved &&
          d.status !== DefectStatus.Rejected
      );
    }
    if (filter === 'assigned') {
      return defects.filter(
        (d) =>
          d.assigneeId === userId &&
          d.status !== DefectStatus.Resolved &&
          d.status !== DefectStatus.Rejected
      );
    }
    if (filter === 'completed') {
      return defects.filter((d) => d.status === DefectStatus.Resolved);
    }
    if (filter === 'rejected') {
      return defects.filter((d) => d.status === DefectStatus.Rejected);
    }
    return defects;
  }, [defects, filter, userId]);

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
            {filter === 'submitted'
              ? '暂无提交的缺陷'
              : filter === 'assigned'
              ? '暂无收到的缺陷'
              : filter === 'rejected'
              ? '暂无拒绝的缺陷'
              : '暂无完成的缺陷'}
          </div>
          <div
            className="text-[11px] mt-1"
            style={{ color: 'var(--text-muted)' }}
          >
            {filter === 'submitted'
              ? '点击右上角「提交缺陷」开始'
              : filter === 'assigned'
              ? '等待他人提交缺陷给你'
              : filter === 'rejected'
              ? '被拒绝的缺陷会显示在这里'
              : '处理完的缺陷会显示在这里'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {filteredDefects.map((defect) => (
        <DefectCard key={defect.id} defect={defect} />
      ))}
    </div>
  );
}
