import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarDays,
  Users,
  Bot,
  DollarSign,
  Link2,
  TrendingUp,
  BarChart3,
  RefreshCw,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  getExecutiveOverview,
  getExecutiveTrends,
  getExecutiveTeam,
  getExecutiveAgents,
  getExecutiveModels,
  getTeamInsights,
} from '@/services';
import TeamInsightsWorkspace from '@/pages/executive/TeamInsightsWorkspace';
import { useExecutiveQuery } from '@/pages/executive/useExecutiveQuery';
import {
  ExecutiveOverviewWorkspace,
  ExecutiveAgentsWorkspace,
  ExecutiveCostWorkspace,
  ExecutiveIntegrationsWorkspace,
} from './executive/ExecutiveOperationsWorkspace';

import './executive/executive-frame.css';

const TABS = [
  {
    key: 'team',
    label: '团队洞察',
    mobileLabel: '团队',
    icon: <Users size={14} />,
  },
  {
    key: 'overview',
    label: '全局概览',
    mobileLabel: '全局',
    icon: <TrendingUp size={14} />,
  },
  {
    key: 'agents',
    label: 'Agent 使用',
    mobileLabel: 'Agent',
    icon: <Bot size={14} />,
  },
  {
    key: 'cost',
    label: '成本中心',
    mobileLabel: '成本',
    icon: <DollarSign size={14} />,
  },
  {
    key: 'integrations',
    label: '外部协作',
    mobileLabel: '协作',
    icon: <Link2 size={14} />,
  },
];

const DAYS_OPTIONS = [
  { value: 0, label: '全部时间' },
  { value: 7, label: '最近 7 天' },
  { value: 14, label: '最近 14 天' },
  { value: 30, label: '最近 30 天' },
];

export default function ExecutiveDashboardPage() {
  const { isMobile } = useBreakpoint();
  const [params, setParams] = useSearchParams();
  const activeTab = TABS.some((tab) => tab.key === params.get('tab'))
    ? params.get('tab')!
    : 'team';
  const setActiveTab = (tab: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', tab);
        next.delete('agent');
        return next;
      },
      { replace: true },
    );
  const requestedDays = Number(params.get('days') ?? 0);
  const days = DAYS_OPTIONS.some((option) => option.value === requestedDays)
    ? requestedDays
    : 0;
  const setDays = (value: number) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('days', String(value));
        return next;
      },
      { replace: true },
    );
  const [revision, setRevision] = useState(0);
  const overviewQuery = useExecutiveQuery(
    getExecutiveOverview,
    days,
    activeTab === 'overview',
    revision,
  );
  const trendsQuery = useExecutiveQuery(
    getExecutiveTrends,
    days || 14,
    activeTab === 'overview',
    revision,
  );
  const teamQuery = useExecutiveQuery(
    getExecutiveTeam,
    days,
    activeTab === 'agents' || activeTab === 'overview',
    revision,
  );
  const agentsQuery = useExecutiveQuery(
    getExecutiveAgents,
    days,
    activeTab === 'overview' || activeTab === 'agents',
    revision,
  );
  const modelsQuery = useExecutiveQuery(
    getExecutiveModels,
    days,
    activeTab === 'cost',
    revision,
  );
  const insightsQuery = useExecutiveQuery(
    getTeamInsights,
    days,
    activeTab === 'team',
    revision,
  );
  const queryRegistry = {
    team: [insightsQuery],
    overview: [overviewQuery, trendsQuery, agentsQuery, teamQuery],
    agents: [agentsQuery, teamQuery],
    cost: [modelsQuery],
    integrations: [],
  };
  const activeQueries =
    queryRegistry[activeTab as keyof typeof queryRegistry] ?? [];
  const loading = activeQueries.some((query) => query.loading);
  const error = activeQueries.find((query) => query.error)?.error;
  const previous = activeQueries.find((query) => query.updatedAt !== undefined);
  const showingPrevious = activeQueries.some((query) => query.stale);
  const [waitingLong, setWaitingLong] = useState(false);
  useEffect(() => {
    setWaitingLong(false);
    if (!loading) return;
    const timer = window.setTimeout(() => setWaitingLong(true), 2000);
    return () => window.clearTimeout(timer);
  }, [loading, activeTab, days, revision]);
  const previousLabel =
    previous?.dataDays === 0 ? '全部时间' : `最近 ${previous?.dataDays} 天`;

  return (
    <div className="executive-dashboard h-full min-h-0 flex flex-col">
      <header className="exec-page-header">
        <div className="exec-page-title">
          <BarChart3 size={16} />
          <span>统计中心</span>
        </div>
        <nav className="exec-page-tabs" aria-label="统计分类">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={activeTab === tab.key ? 'active' : ''}
              aria-current={activeTab === tab.key ? 'page' : undefined}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.icon}
              {isMobile ? tab.mobileLabel : tab.label}
            </button>
          ))}
        </nav>
        <div className="exec-page-actions">
          {activeTab !== 'integrations' && (
            <label className="exec-range-control">
              <CalendarDays size={13} />
              <select
                aria-label="统计时间范围"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                {DAYS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="exec-refresh"
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading}
            title="刷新数据"
          >
            {loading ? <MapSpinner size={13} /> : <RefreshCw size={13} />}刷新
          </button>
        </div>
      </header>
      {loading && (
        <div className="exec-fetch-state" role="status" aria-live="polite">
          <MapSpinner size={12} />
          <span>
            {waitingLong ? '正在汇总历史数据，请稍候…' : '正在更新统计…'}
            {showingPrevious && previous?.dataDays !== undefined
              ? ` 当前仍显示${previousLabel}的上次结果。`
              : ''}
          </span>
        </div>
      )}
      {error && (
        <div role="alert" className="exec-fetch-state error">
          <span>
            统计加载失败：{error}。
            {previous?.updatedAt !== undefined
              ? ` 当前保留${previousLabel}的上次结果。`
              : ''}
          </span>
          <button onClick={() => setRevision((value) => value + 1)}>
            重试
          </button>
        </div>
      )}
      <div className="exec-page-body">
        {activeTab === 'team' && (
          <TeamInsightsWorkspace
            data={insightsQuery.data ?? null}
            loading={insightsQuery.loading}
            onOpenTab={setActiveTab}
          />
        )}
        {activeTab === 'overview' && (
          <div className="exec-other-tab">
            <ExecutiveOverviewWorkspace
              overview={overviewQuery.data}
              trends={trendsQuery.data}
              agents={agentsQuery.data}
              team={teamQuery.data}
              revision={revision}
            />
          </div>
        )}
        {activeTab === 'agents' && (
          <div className="exec-other-tab">
            <ExecutiveAgentsWorkspace
              initialAgent={params.get('agent')}
              agents={agentsQuery.data}
              team={teamQuery.data}
            />
          </div>
        )}
        {activeTab === 'cost' && (
          <div className="exec-other-tab">
            <ExecutiveCostWorkspace models={modelsQuery.data} />
          </div>
        )}
        {activeTab === 'integrations' && (
          <div className="exec-other-tab">
            <ExecutiveIntegrationsWorkspace revision={revision} />
          </div>
        )}
      </div>
    </div>
  );
}
