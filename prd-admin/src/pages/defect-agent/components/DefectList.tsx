import { GlassCard } from '@/components/design/GlassCard';
import { useDefectStore } from '@/stores/defectStore';
import { DefectCard } from './DefectCard';
import { Bug } from 'lucide-react';

export function DefectList() {
  const { defects, loading, filter } = useDefectStore();

  if (!loading && defects.length === 0) {
    return (
      <GlassCard glow className="py-8 px-4">
        <div className="text-center">
          <Bug
            size={40}
            style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }}
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
      </GlassCard>
    );
  }

  return (
    <div className="space-y-2">
      {defects.map((defect) => (
        <DefectCard key={defect.id} defect={defect} />
      ))}
    </div>
  );
}
