import { useState, useEffect } from 'react';
import { ArrowRight, FileQuestion } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { getPlanComparison } from '@/services';
import type { PlanComparison } from '@/services/contracts/reportAgent';

interface Props {
  reportId: string;
}

export function PlanComparisonPanel({ reportId }: Props) {
  const [data, setData] = useState<PlanComparison | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getPlanComparison({ reportId }).then((res) => {
      if (res.success && res.data) setData(res.data);
      setLoading(false);
    });
  }, [reportId]);

  if (loading) {
    return <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>;
  }

  if (!data || !data.hasLastWeek) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2">
        <FileQuestion size={24} style={{ color: 'var(--text-muted)' }} />
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>没有找到上周周报，无法进行计划比对</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {/* 上周计划 */}
      <GlassCard variant="subtle" className="p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>上周计划</div>
          {data.lastWeekLabel && (
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
              {data.lastWeekLabel}
            </span>
          )}
        </div>
        {data.lastWeekPlans.length === 0 ? (
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>上周未填写计划</div>
        ) : (
          <ul className="space-y-1">
            {data.lastWeekPlans.map((item, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>•</span>
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{item}</span>
              </li>
            ))}
          </ul>
        )}
      </GlassCard>

      {/* 本周实际 */}
      <GlassCard variant="subtle" className="p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} />
          <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>本周实际</div>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
            {data.thisWeekLabel}
          </span>
        </div>
        {data.thisWeekActuals.length === 0 ? (
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>本周暂未填写完成内容</div>
        ) : (
          <ul className="space-y-1">
            {data.thisWeekActuals.map((item, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>•</span>
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{item}</span>
              </li>
            ))}
          </ul>
        )}
      </GlassCard>
    </div>
  );
}
