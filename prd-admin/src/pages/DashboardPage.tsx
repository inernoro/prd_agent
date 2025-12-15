import { Badge } from '@/components/design/Badge';
import { Card } from '@/components/design/Card';
import { KpiCard } from '@/components/design/KpiCard';
import { Button } from '@/components/design/Button';
import { getOverviewStats } from '@/services';
import { useEffect, useState } from 'react';

type Overview = {
  totalUsers: number;
  activeUsers: number;
  totalGroups: number;
  todayMessages: number;
};

export default function DashboardPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await getOverviewStats();
        if (res.success) setData(res.data);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[26px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>仪表盘</div>
          <div className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>系统运行概览</div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="discount">限时 3 折</Badge>
          <Badge variant="new">NEW</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="总用户数" value={data?.totalUsers ?? 0} loading={loading} />
        <KpiCard title="活跃用户" value={data?.activeUsers ?? 0} loading={loading} accent="green" />
        <KpiCard title="群组数" value={data?.totalGroups ?? 0} loading={loading} />
        <KpiCard title="今日消息" value={data?.todayMessages ?? 0} loading={loading} accent="green" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>消息趋势（近14天）</div>
          </div>
          <div className="mt-4 h-[280px] rounded-[14px] flex flex-col items-center justify-center gap-3"
               style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
            <svg 
              className="w-16 h-16"
              viewBox="0 0 64 64" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="1.5"
              style={{ color: 'var(--text-muted)', opacity: 0.25 }}
            >
              <path d="M8 48 L16 40 L24 42 L32 28 L40 32 L48 20 L56 24" strokeWidth="2" />
              <circle cx="16" cy="40" r="3" fill="currentColor" />
              <circle cx="24" cy="42" r="3" fill="currentColor" />
              <circle cx="32" cy="28" r="3" fill="currentColor" />
              <circle cx="40" cy="32" r="3" fill="currentColor" />
              <circle cx="48" cy="20" r="3" fill="currentColor" />
              <circle cx="56" cy="24" r="3" fill="currentColor" />
              <rect x="8" y="8" width="48" height="48" rx="4" opacity="0.08" />
            </svg>
            <div className="text-center">
              <div className="text-[14px] font-medium" style={{ color: 'var(--text-muted)' }}>暂无消息趋势数据</div>
              <div className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>图表容器已就绪（后续接入 echarts）</div>
            </div>
          </div>
        </Card>

        <Card variant="gold">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>主推方案</div>
              <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>黑金会员卡片风格示例</div>
            </div>
            <Badge variant="featured">推荐</Badge>
          </div>

          <div className="mt-4 grid gap-2">
            <div className="text-3xl font-semibold" style={{ color: 'var(--text-primary)' }}>916<span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>/首月</span></div>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>下月续费 1149（87 折）</div>

            <div className="mt-3 grid gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <div className="flex items-center gap-2"><span style={{ color: 'var(--accent-green)' }}>✓</span> 专享快速生成通道</div>
              <div className="flex items-center gap-2"><span style={{ color: 'var(--accent-green)' }}>✓</span> 更高并发与稳定性</div>
              <div className="flex items-center gap-2"><span style={{ color: 'var(--accent-green)' }}>✓</span> 优先体验新功能</div>
            </div>

            <Button className="mt-4 w-full" variant="primary">
              特惠订阅
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

