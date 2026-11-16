import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bot, ArrowUpRight } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import {
  compact,
  PersonAvatar,
  WorkspaceEmpty,
  WorkspaceMetric,
  WorkspacePanel,
  WorkspaceSearch,
} from '@/components/workspace/Workspace';
import type {
  ExecutiveAgentStat,
  ExecutiveTeamMember,
} from '@/services/contracts/executive';
import {
  agentPlot,
  duration,
  dateTime,
  sumOf,
} from './executiveOperationsModel';

const SORTS = [
  { key: 'llmCalls', label: '模型调用' },
  { key: 'tokens', label: 'Token 消耗' },
  { key: 'avgDurationMs', label: '平均响应' },
] as const;
type SortKey = (typeof SORTS)[number]['key'];
export function ExecutiveAgentsWorkspace({
  agents,
  team,
  initialAgent,
}: {
  agents?: ExecutiveAgentStat[];
  team?: ExecutiveTeamMember[];
  initialAgent?: string | null;
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('llmCalls');
  const [showMembers, setShowMembers] = useState(false);
  const canReadLogs = useAuthStore(
    (s) =>
      s.isRoot ||
      s.permissions.includes('super') ||
      s.permissions.includes('logs.read'),
  );
  const filtered = useMemo(
    () =>
      (agents ?? [])
        .filter((a) =>
          `${a.name} ${a.appKey}`.toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => b[sort] - a[sort]),
    [agents, query, sort],
  );
  const selected = params.get('agent') ?? initialAgent;
  const agent = filtered.find((a) => a.appKey === selected) ?? filtered[0];
  const plot = useMemo(() => agentPlot(filtered), [filtered]);
  const max = Math.max(1, ...filtered.map((a) => a[sort]));
  const members = useMemo(
    () => [...(team ?? [])].sort((a, b) => b.messages - a.messages),
    [team],
  );
  function select(appKey: string) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', 'agents');
        next.set('agent', appKey);
        return next;
      },
      { replace: true },
    );
  }
  return (
    <div className="map-workspace op-workspace" data-workspace="agents">
      <div className="ws-toolbar">
        <WorkspaceSearch
          value={query}
          onChange={setQuery}
          placeholder="搜索 Agent 名称或标识"
        />
        <span>{agents ? filtered.length : '—'} 个 Agent</span>
      </div>
      <div className="ws-metrics">
        <WorkspaceMetric
          label="业务写操作"
          value={agents ? compact(sumOf(agents, (a) => a.apiCalls)!) : null}
        />
        <WorkspaceMetric
          label="模型调用"
          value={agents ? compact(sumOf(agents, (a) => a.llmCalls)!) : null}
        />
        <WorkspaceMetric
          label="Token 消耗"
          value={agents ? compact(sumOf(agents, (a) => a.tokens)!) : null}
        />
        <WorkspaceMetric label="有记录 Agent" value={agents?.length} />
      </div>
      <div className="op-agent-layout">
        <WorkspacePanel
          title="Agent 对比"
          hint="点击列表或图中的点，查看同一对象"
          action={
            <select
              className="op-select"
              aria-label="Agent 排序"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          }
        >
          <div className="op-agent-list">
            {filtered.map((item) => (
              <button
                key={item.appKey}
                className="op-agent-row"
                aria-pressed={agent?.appKey === item.appKey}
                onClick={() => select(item.appKey)}
              >
                <span className="op-agent-name">
                  <Bot size={15} />
                  <strong>{item.name}</strong>
                  <b>
                    {sort === 'avgDurationMs'
                      ? duration(item[sort])
                      : compact(item[sort])}
                  </b>
                </span>
                <span className="op-mini-track">
                  <i style={{ width: `${(item[sort] / max) * 100}%` }} />
                </span>
                <small>
                  API {compact(item.apiCalls)} · LLM {compact(item.llmCalls)} ·{' '}
                  {item.users} 人
                </small>
              </button>
            ))}
          </div>
          {!filtered.length && (
            <WorkspaceEmpty
              title={agents ? '没有匹配的 Agent' : 'Agent 统计读取中'}
            />
          )}
        </WorkspacePanel>
        <WorkspacePanel
          title="模型调用与响应分布"
          hint="横轴：平均响应 · 纵轴：模型调用 · 气泡大小：Token（小值保留可见尺寸）"
          className="op-chart-panel"
        >
          {plot.points.length ? (
            <>
              <div
                className="op-response-chart"
                aria-label="Agent 模型调用与响应比较"
              >
                <div className="op-axis-y">
                  <span>{compact(plot.maxY)}</span>
                  <span>{compact(plot.maxY / 2)}</span>
                  <span>0</span>
                </div>
                <div className="op-plot-area">
                  {plot.points.map(({ agent: item, x, y, size }) => (
                    <button
                      key={item.appKey}
                      className="op-plot-point"
                      style={{
                        left: `${x}%`,
                        bottom: `${y}%`,
                        width: size,
                        height: size,
                      }}
                      aria-label={`${item.name}，模型调用 ${item.llmCalls}，平均响应 ${duration(item.avgDurationMs)}，Token ${item.tokens}`}
                      aria-pressed={agent?.appKey === item.appKey}
                      title={`${item.name} · ${duration(item.avgDurationMs)} · ${compact(item.llmCalls)} 次 · ${compact(item.tokens)} Token`}
                      onClick={() => select(item.appKey)}
                    />
                  ))}
                </div>
                <div className="op-axis-x">
                  <span>0</span>
                  <span>{plot.maxX / 2} 秒</span>
                  <span>{plot.maxX} 秒</span>
                </div>
              </div>
              <div className="op-chart-caption">
                <span>平均模型响应时间</span>
                <span>
                  {plot.omitted
                    ? `${plot.omitted} 个 Agent 未记录模型响应，仅列入左侧对比`
                    : `${plot.points.length} 个 Agent 有模型响应记录`}
                </span>
              </div>
              {agent && (
                <div className="op-selected-summary">
                  <Bot size={16} />
                  <strong>{agent.name}</strong>
                  <span>模型调用 {compact(agent.llmCalls)}</span>
                  <span>响应 {duration(agent.avgDurationMs)}</span>
                  <span>Token {compact(agent.tokens)}</span>
                </div>
              )}
            </>
          ) : (
            <WorkspaceEmpty
              title={
                agents ? '本筛选暂无可绘制的模型响应记录' : '模型响应读取中'
              }
              description="未记录响应时间的 Agent 仍可在列表中选择，未将未知值绘制为零。"
            />
          )}
        </WorkspacePanel>
        <aside className="ws-side op-agent-inspector">
          <WorkspacePanel
            title={agent?.name ?? '选择 Agent'}
            hint={agent?.appKey}
          >
            {agent ? (
              <>
                <dl className="ws-facts">
                  <dt>业务操作</dt>
                  <dd>{compact(agent.apiCalls)}</dd>
                  <dt>模型调用</dt>
                  <dd>{compact(agent.llmCalls)}</dd>
                  <dt>Token 消耗</dt>
                  <dd>{compact(agent.tokens)}</dd>
                  <dt>使用成员</dt>
                  <dd>{agent.users} 人</dd>
                  <dt>模型平均响应</dt>
                  <dd>{duration(agent.avgDurationMs)}</dd>
                </dl>
                <p className="ws-muted">按归一后的应用统计，包含历史调用别名。</p>
              </>
            ) : (
              <WorkspaceEmpty title="暂无可选 Agent" />
            )}
          </WorkspacePanel>
          <WorkspacePanel title="如何比较">
            <p>
              调用多与响应慢分别展示，不合成为质量评分。业务操作与模型请求可能属于同一次工作，不能相加当作去重任务数。
            </p>
            <p>下方成员为全平台活动，接口未提供按 Agent 的成员归属。</p>
          </WorkspacePanel>
        </aside>
      </div>
      <WorkspacePanel
        title="全平台成员"
        hint="当前窗口全平台活动，不归因到选中的 Agent"
        action={
          <button
            className="ws-link"
            aria-expanded={showMembers}
            onClick={() => setShowMembers((v) => !v)}
          >
            {showMembers
              ? '收起成员明细'
              : `展开成员明细${team ? ` · ${team.length} 人` : ''}`}
          </button>
        }
      >
        <div className="op-member-strip">
          {members.slice(0, 6).map((member) => (
            <button
              key={member.userId}
              className="op-member-chip"
              disabled={!canReadLogs}
              onClick={() =>
                navigate(
                  `/logs?tab=llm&userId=${encodeURIComponent(member.userId)}`,
                )
              }
            >
              <PersonAvatar person={member} />
              <span>
                <strong>{member.displayName}</strong>
                <small>{compact(member.messages)} 消息</small>
              </span>
              <ArrowUpRight size={12} />
            </button>
          ))}
        </div>
        {!team?.length && (
          <WorkspaceEmpty
            title={team ? '本窗口暂无成员活动' : '成员活动读取中'}
          />
        )}
        {showMembers && (
          <div className="ws-table-wrap op-members-table">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>最近活动</th>
                  <th>消息</th>
                  <th>会话</th>
                  <th>解决缺陷</th>
                  <th>生图任务</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId}>
                    <td>
                      <span className="ws-person">
                        <PersonAvatar person={member} size={24} />
                        {member.displayName}
                      </span>
                    </td>
                    <td>{dateTime(member.lastActiveAt)}</td>
                    <td>{compact(member.messages)}</td>
                    <td>{member.sessions}</td>
                    <td>{member.defectsResolved}</td>
                    <td>{member.imageRuns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </WorkspacePanel>
    </div>
  );
}
