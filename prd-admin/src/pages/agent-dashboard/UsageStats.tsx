/**
 * 使用统计组件
 *
 * 显示各 Agent 的使用比例
 */

import { GlassCard } from '@/components/design/GlassCard';
import { AGENT_DEFINITIONS, type AgentDefinition } from '@/stores/agentSwitcherStore';

interface UsageStatsProps {
  stats: Record<string, number>;
}

export function UsageStats({ stats }: UsageStatsProps) {
  // 计算总数和百分比
  const total = Object.values(stats).reduce((a, b) => a + b, 0) || 1;

  const items = AGENT_DEFINITIONS.map((agent) => ({
    agent,
    count: stats[agent.key] || 0,
    percentage: Math.round(((stats[agent.key] || 0) / total) * 100),
  }));

  return (
    <GlassCard className="p-4">
      <div
        className="flex items-center gap-2 px-2 mb-4 text-[12px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        <span>📈</span>
        <span>使用统计</span>
      </div>

      <div className="space-y-4 px-2">
        {items.map(({ agent, count, percentage }) => (
          <UsageStatItem
            key={agent.key}
            agent={agent}
            count={count}
            percentage={percentage}
          />
        ))}
      </div>

      {/* 总计 */}
      <div
        className="mt-4 pt-4 px-2 flex items-center justify-between text-[13px]"
        style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}
      >
        <span style={{ color: 'var(--text-muted)' }}>总计</span>
        <span style={{ color: 'var(--text-primary)' }} className="font-semibold">
          {total} 次交互
        </span>
      </div>
    </GlassCard>
  );
}

function UsageStatItem({
  agent,
  count,
  percentage,
}: {
  agent: AgentDefinition;
  count: number;
  percentage: number;
}) {
  return (
    <div className="space-y-2">
      {/* 标签行 */}
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {agent.name}
        </span>
        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {count} ({percentage}%)
        </span>
      </div>

      {/* 进度条 */}
      <div
        className="h-2 rounded-full overflow-hidden"
        style={{ background: 'rgba(255, 255, 255, 0.06)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${percentage}%`,
            background: `linear-gradient(90deg, ${agent.color.text} 0%, ${agent.color.iconBg} 100%)`,
            boxShadow: `0 0 8px ${agent.color.iconBg}`,
          }}
        />
      </div>
    </div>
  );
}

export default UsageStats;
