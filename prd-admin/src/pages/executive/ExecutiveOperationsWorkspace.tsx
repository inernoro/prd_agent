import './executive-operations.css';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  compact,
  PersonAvatar,
  WorkspaceEmpty,
  WorkspaceLink,
  WorkspaceMetric,
  WorkspacePanel,
} from '@/components/workspace/Workspace';
import type {
  ExecutiveAgentStat,
  ExecutiveOverview,
  ExecutiveTeamMember,
  ExecutiveTrendItem,
} from '@/services/contracts/executive';
import { callMapLayout } from './callMapLayout';
import { ExecutiveWorkScene } from './ExecutiveWorkScene';
export { ExecutiveAgentsWorkspace } from './ExecutiveAgentsWorkspace';
export { ExecutiveCostWorkspace } from './ExecutiveCostWorkspace';
export { ExecutiveIntegrationsWorkspace } from './ExecutiveIntegrationsWorkspace';
const number = (value: number | undefined) =>
  value === undefined ? '—' : compact(value);

export function ExecutiveOverviewWorkspace({
  overview,
  trends,
  agents,
  team,
  revision = 0,
}: {
  team?: ExecutiveTeamMember[];
  revision?: number;
  overview?: ExecutiveOverview;
  trends?: ExecutiveTrendItem[];
  agents?: ExecutiveAgentStat[];
}) {
  const navigate = useNavigate();
  const [view, setView] = useState<'scene' | 'distribution'>('scene');
  const [field, setField] = useState<'messages' | 'tokens'>('messages');
  const [date, setDate] = useState('');
  const point = trends?.find((item) => item.date === date) ?? trends?.at(-1);
  const max = Math.max(1, ...(trends ?? []).map((item) => item[field]));
  return (
    <div className="map-workspace" data-workspace="overview">
      <div className="ws-metrics">
        <WorkspaceMetric
          label="活跃成员"
          value={number(overview?.activeUsers)}
          note={
            overview ? `注册成员 ${overview.totalUsers} 人` : '等待成员统计'
          }
        />
        <WorkspaceMetric
          label="对话消息"
          value={number(overview?.periodMessages)}
          note="当前所选窗口"
        />
        <WorkspaceMetric
          label="Token 消耗"
          value={number(overview?.periodTokens)}
          note="PRD 对话口径"
        />
        <WorkspaceMetric
          label="模型调用"
          value={number(overview?.llmCalls)}
          note="LLM Gateway 请求"
        />
        <WorkspaceMetric
          label="生图任务"
          value={number(overview?.periodImages)}
          note="所选窗口的任务数"
        />
        <WorkspaceMetric
          label="缺陷解决率"
          value={
            overview ? `${overview.defectResolutionRate.toFixed(1)}%` : null
          }
          note="全时间缺陷口径"
        />
      </div>
      <div className="ws-toolbar scene-heading">
        <h1>{view === 'scene' ? '工作现场' : '使用版图'}</h1>
        <div className="ws-tabs">
          <button
            aria-pressed={view === 'scene'}
            onClick={() => setView('scene')}
          >
            工作现场
          </button>
          <button
            aria-pressed={view === 'distribution'}
            onClick={() => setView('distribution')}
          >
            使用分布
          </button>
        </div>
      </div>
      <div className="ws-layout scene-layout">
        <div className="ws-main">
          {view === 'scene' ? (
            <ExecutiveWorkScene revision={revision} />
          ) : (
            <WorkspacePanel
              title="Agent 调用版图"
              hint="面积对应业务操作与模型调用记录合计；不同类型记录可能属于同一次工作"
            >
              {agents?.some((a) => a.calls > 0) ? (
                <div className="scene-treemap">
                  {callMapLayout(agents ?? [], (a) => a.calls).map(
                    ({ item: agent, x, y, width, height }, index) => (
                      <button
                        key={agent.appKey}
                        style={{
                          left: `${x}%`,
                          top: `${y}%`,
                          width: `${width}%`,
                          height: `${height}%`,
                        }}
                        data-tone={index % 3}
                        title={`${agent.name} · ${compact(agent.calls)} 条调用记录`}
                        onClick={() =>
                          navigate(
                            `/executive?tab=agents&agent=${encodeURIComponent(agent.appKey)}`,
                          )
                        }
                      >
                        <strong>{agent.name}</strong>
                        <b>{compact(agent.calls)}</b>
                        <small>
                          API {compact(agent.apiCalls)} · LLM{' '}
                          {compact(agent.llmCalls)}
                        </small>
                      </button>
                    ),
                  )}
                </div>
              ) : (
                <WorkspaceEmpty
                  title={agents ? '此窗口暂无调用记录' : '调用分布读取中'}
                />
              )}
            </WorkspacePanel>
          )}
        </div>
        <aside className="ws-side">
          <WorkspacePanel
            title="全平台成员"
            hint="当前统计窗口 · 按消息数排列"
            action={
              <WorkspaceLink
                permission="team-activity.read"
                onClick={() => navigate('/team-activity')}
              >
                全部动态
              </WorkspaceLink>
            }
          >
            {(team ?? [])
              .slice()
              .sort((a, b) => b.messages - a.messages)
              .slice(0, 6)
              .map((member) => (
                <div className="ws-source-row" key={member.userId}>
                  <span className="ws-person">
                    <PersonAvatar person={member} />
                    <span>{member.displayName}</span>
                  </span>
                  <b>{compact(member.messages)} 消息</b>
                </div>
              ))}
            {!team?.length && (
              <WorkspaceEmpty
                title={team ? '此窗口暂无成员活动' : '成员统计读取中'}
              />
            )}
          </WorkspacePanel>
          <WorkspacePanel
            title="使用趋势"
            hint={
              trends?.length
                ? `${trends[0].date} 至 ${trends.at(-1)?.date} · 点击日期查看数值`
                : '正在读取独立趋势数据'
            }
            action={
              <div className="ws-tabs">
                <button
                  aria-pressed={field === 'messages'}
                  onClick={() => setField('messages')}
                >
                  消息
                </button>
                <button
                  aria-pressed={field === 'tokens'}
                  onClick={() => setField('tokens')}
                >
                  Token
                </button>
              </div>
            }
          >
            {trends?.length ? (
              <div className="ws-trend" aria-label="每日使用趋势">
                {trends.map((item) => (
                  <button
                    key={item.date}
                    onClick={() => setDate(item.date)}
                    aria-pressed={point?.date === item.date}
                    title={`${item.date} · ${field === 'messages' ? '消息' : 'Token'} ${item[field].toLocaleString()}`}
                  >
                    <i
                      style={{
                        height: `${Math.max(2, (item[field] / max) * 122)}px`,
                      }}
                    />
                    <small>{item.date.slice(5)}</small>
                  </button>
                ))}
              </div>
            ) : (
              <WorkspaceEmpty
                title={trends ? '此范围暂无趋势记录' : '趋势读取中'}
                description="趋势与核心指标独立加载。"
              />
            )}
            <dl className="ws-facts">
              <dt>日期</dt>
              <dd>{point?.date ?? '—'}</dd>
              <dt>消息</dt>
              <dd>{point ? compact(point.messages) : '—'}</dd>
              <dt>Token</dt>
              <dd>{point ? compact(point.tokens) : '—'}</dd>
            </dl>
            <WorkspaceLink
              permission="team-activity.read"
              onClick={() => navigate('/team-activity')}
            >
              查看团队动态
            </WorkspaceLink>
          </WorkspacePanel>
          <WorkspacePanel title="业务结果" hint="缺陷为全时间快照">
            <dl className="ws-facts">
              <dt>缺陷总数</dt>
              <dd>{number(overview?.totalDefects)}</dd>
              <dt>已解决</dt>
              <dd>{number(overview?.resolvedDefects)}</dd>
              <dt>统计窗口</dt>
              <dd>
                {overview
                  ? overview.days
                    ? `最近 ${overview.days} 天`
                    : '全部时间'
                  : '读取中'}
              </dd>
            </dl>
            <WorkspaceLink
              permission="defect-agent.use"
              onClick={() => navigate('/defect-agent')}
            >
              打开缺陷工作区
            </WorkspaceLink>
          </WorkspacePanel>
          <p className="scene-owner">
            趋势记录消息与
            Token；缺陷按全部历史计算。调用数量不代表成员工作质量。
          </p>
        </aside>
      </div>
    </div>
  );
}
