/**
 * Agent 控制台页面
 *
 * macOS Control Center 风格的 Agent 管理中心
 * - 大图标网格展示各 Agent 入口
 * - 使用统计
 * - 快捷操作
 */

import { useState, useEffect } from 'react';
import { Command, Keyboard } from 'lucide-react';
import { AGENT_DEFINITIONS } from '@/stores/agentSwitcherStore';
import { AgentCard } from './AgentCard';
import { QuickActions } from './QuickActions';
import { UsageStats } from './UsageStats';

export function AgentDashboardPage() {
  const [stats, setStats] = useState<Record<string, number>>({});
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  // 模拟获取统计数据（实际应从 API 获取）
  useEffect(() => {
    // TODO: 替换为实际 API 调用
    setStats({
      'prd-agent': 12,
      'visual-agent': 8,
      'literary-agent': 5,
      'defect-agent': 23,
    });
  }, []);

  return (
    <div className="min-h-full p-6 lg:p-8">
      {/* 页头 */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1
              className="text-[28px] font-bold tracking-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              Agent 控制中心
            </h1>
            <p className="mt-1 text-[14px]" style={{ color: 'var(--text-muted)' }}>
              快速访问和管理你的 AI Agent
            </p>
          </div>

          {/* 快捷键提示 */}
          <div
            className="flex items-center gap-2 px-4 py-2 rounded-[12px]"
            style={{
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <Keyboard size={16} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              随时按
            </span>
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-medium"
              style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-primary)' }}
            >
              {isMac ? <Command size={12} /> : 'Ctrl'}
              <span>K</span>
            </div>
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              快速切换
            </span>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent 卡片网格 - 占 2 列 */}
        <div className="lg:col-span-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {AGENT_DEFINITIONS.map((agent) => (
              <AgentCard
                key={agent.key}
                agent={agent}
                stat={stats[agent.key] || 0}
              />
            ))}
          </div>
        </div>

        {/* 侧边栏 - 占 1 列 */}
        <div className="space-y-6">
          <UsageStats stats={stats} />
          <QuickActions />
        </div>
      </div>

      {/* 底部装饰 */}
      <div
        className="mt-12 pt-6 text-center text-[12px]"
        style={{
          borderTop: '1px solid rgba(255, 255, 255, 0.04)',
          color: 'var(--text-muted)',
        }}
      >
        <p>Agent 控制中心 · 快捷键 {isMac ? '⌘' : 'Ctrl'}+K 随时唤起切换面板</p>
      </div>
    </div>
  );
}

export default AgentDashboardPage;
