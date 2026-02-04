/**
 * Agent 卡片组件
 *
 * macOS Control Center 风格的大卡片，用于展示 Agent 入口
 * - 大图标 + 名称
 * - 统计数字
 * - 悬浮动效
 */

import { useNavigate } from 'react-router-dom';
import {
  MessagesSquare,
  Image,
  PenLine,
  Bug,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { cn } from '@/lib/cn';
import { useAgentSwitcherStore, type AgentDefinition } from '@/stores/agentSwitcherStore';

/** 图标映射 */
const ICON_MAP: Record<string, LucideIcon> = {
  MessagesSquare,
  Image,
  PenLine,
  Bug,
};

interface AgentCardProps {
  agent: AgentDefinition;
  stat?: number;
  className?: string;
}

export function AgentCard({ agent, stat = 0, className }: AgentCardProps) {
  const navigate = useNavigate();
  const addRecentVisit = useAgentSwitcherStore((s) => s.addRecentVisit);
  const Icon = ICON_MAP[agent.icon] || MessagesSquare;

  const handleClick = () => {
    addRecentVisit({
      agentKey: agent.key,
      agentName: agent.name,
      title: '首页',
      path: agent.route,
    });
    navigate(agent.route);
  };

  return (
    <GlassCard
      className={cn(
        'group relative cursor-pointer overflow-hidden',
        'transition-all duration-300 ease-out',
        'hover:scale-[1.02] hover:shadow-xl',
        'active:scale-[0.99]',
        className
      )}
      style={{
        ['--accent-hue' as string]: getHueFromColor(agent.color.text),
      }}
      onClick={handleClick}
      interactive
      glow
    >
      {/* 背景装饰 */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background: `radial-gradient(circle at 30% 30%, ${agent.color.bg} 0%, transparent 60%)`,
        }}
      />

      {/* 内容 */}
      <div className="relative p-6 flex flex-col h-full min-h-[200px]">
        {/* 图标 */}
        <div
          className="w-16 h-16 rounded-[20px] flex items-center justify-center mb-4 transition-all duration-300 group-hover:scale-110"
          style={{
            background: agent.color.iconBg,
            boxShadow: `0 8px 24px ${agent.color.bg}`,
          }}
        >
          <Icon size={32} style={{ color: agent.color.text }} strokeWidth={1.5} />
        </div>

        {/* 名称 */}
        <h3
          className="text-[18px] font-semibold mb-1"
          style={{ color: 'var(--text-primary)' }}
        >
          {agent.name}
        </h3>

        {/* 统计 */}
        <div className="flex items-baseline gap-2 mb-auto">
          <span
            className="text-[28px] font-bold tracking-tight"
            style={{ color: agent.color.text }}
          >
            {stat}
          </span>
          <span className="text-[14px]" style={{ color: 'var(--text-muted)' }}>
            {agent.statLabel}
          </span>
        </div>

        {/* 进入按钮 */}
        <div
          className="flex items-center gap-2 mt-4 text-[13px] font-medium opacity-60 group-hover:opacity-100 transition-all duration-300"
          style={{ color: agent.color.text }}
        >
          <span>进入</span>
          <ArrowRight
            size={14}
            className="transition-transform duration-300 group-hover:translate-x-1"
          />
        </div>
      </div>
    </GlassCard>
  );
}

/** 从颜色值提取色相（简单实现） */
function getHueFromColor(color: string): number {
  // 简单的颜色到色相映射
  if (color.includes('246')) return 220; // 蓝色
  if (color.includes('139') || color.includes('A78')) return 260; // 紫色
  if (color.includes('197') || color.includes('4ADE')) return 140; // 绿色
  if (color.includes('249') || color.includes('FB9')) return 25; // 橙色
  return 220;
}

export default AgentCard;
