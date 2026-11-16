import { useAuthStore } from '@/stores/authStore';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Bot, Coins, Link2 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  compact,
  PersonAvatar,
  WorkspaceEmpty,
  WorkspaceLink,
  WorkspaceMetric,
  WorkspacePanel,
  WorkspaceSearch,
} from '@/components/workspace/Workspace';
import type {
  ExecutiveAgentStat,
  ExecutiveModelStat,
  ExecutiveOverview,
  ExecutiveTeamMember,
  ExecutiveTrendItem,
} from '@/services/contracts/executive';
import { channelService } from '@/services';
import { ok, type ApiResponse } from '@/types/api';
import { callMapLayout } from './callMapLayout';
import { ExecutiveWorkScene } from './ExecutiveWorkScene';
import { useExecutiveQuery } from './useExecutiveQuery';
import type {
  ChannelStatsResponse,
  ChannelTask,
  PagedTaskResponse,
} from '@/services/contracts/channels';

const amount = (value: number) =>
  `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const duration = (value: number) =>
  value > 0 ? `${(value / 1000).toFixed(2)} 秒` : '未记录';
const dateTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN') : '未记录';
const total = <T,>(items: T[] | undefined, read: (item: T) => number) =>
  items?.reduce((sum, item) => sum + read(item), 0);
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
              {!agents?.some((a) => a.calls > 0) && (
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
          <p className="scene-owner">趋势记录消息与 Token；缺陷按全部历史计算。调用数量不代表成员工作质量。</p>
        </aside>
      </div>
    </div>
  );
}

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
  const canReadLogs = useAuthStore(
    (state) =>
      state.isRoot ||
      state.permissions.includes('super') ||
      state.permissions.includes('logs.read'),
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(initialAgent ?? '');
  const filtered = useMemo(
    () =>
      (agents ?? [])
        .filter((item) =>
          `${item.name} ${item.appKey}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .sort((a, b) => b.calls - a.calls),
    [agents, query],
  );
  const maxAgentCalls = Math.max(
    1,
    ...filtered.map((a) => a.apiCalls + a.llmCalls),
  );
  const agent =
    filtered.find((item) => item.appKey === selected) ?? filtered[0];
  return (
    <div className="map-workspace" data-workspace="agents">
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
          value={number(total(agents, (a) => a.apiCalls))}
        />
        <WorkspaceMetric
          label="模型调用"
          value={number(total(agents, (a) => a.llmCalls))}
        />
        <WorkspaceMetric
          label="Token"
          value={number(total(agents, (a) => a.tokens))}
        />
        <WorkspaceMetric label="有记录 Agent" value={agents?.length} />
      </div>
      <div className="ws-layout">
        <div className="ws-main">
          <WorkspacePanel
            title="Agent 运行概览"
            hint="点击一行查看调用来源与明细"
          >
            <div className="ws-table-wrap">
              <table className="ws-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>使用人数</th>
                    <th>调用构成 · API / LLM</th>
                    <th>模型调用</th>
                    <th>Token</th>
                    <th>模型平均响应</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr
                      key={item.appKey}
                      aria-selected={item === agent}
                      onClick={() => setSelected(item.appKey)}
                    >
                      <td>
                        <button className="ws-row-action">
                          <Bot size={17} />
                          <span>
                            <strong>{item.name}</strong>
                            <small>{item.appKey}</small>
                          </span>
                        </button>
                      </td>
                      <td>{item.users} 人</td>
                      <td>
                        <div
                          className="scene-track"
                          title={`业务操作 ${item.apiCalls} · 模型调用 ${item.llmCalls}`}
                        >
                          <i
                            style={{
                              width: `${(item.apiCalls / maxAgentCalls) * 100}%`,
                            }}
                          />
                          <i
                            style={{
                              width: `${(item.llmCalls / maxAgentCalls) * 100}%`,
                            }}
                          />
                        </div>
                        <small>
                          {compact(item.apiCalls)} / {compact(item.llmCalls)}
                        </small>
                      </td>
                      <td className="number">{compact(item.llmCalls)}</td>
                      <td className="number">{compact(item.tokens)}</td>
                      <td>{duration(item.avgDurationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <WorkspaceEmpty
                title={agents ? '没有匹配的 Agent' : 'Agent 统计读取中'}
              />
            )}
          </WorkspacePanel>
          <WorkspacePanel
            title="成员活动"
            hint="当前窗口全平台活动，不归因到选中的 Agent"
          >
            <div className="ws-table-wrap">
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
                  {(team ?? []).map((member) => (
                    <tr key={member.userId}>
                      <td>
                        <button
                          className="ws-row-action"
                          disabled={!canReadLogs}
                          onClick={() =>
                            navigate(
                              `/logs?tab=llm&userId=${encodeURIComponent(member.userId)}`,
                            )
                          }
                        >
                          <PersonAvatar person={member} />
                          <span>{member.displayName}</span>
                        </button>
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
            {!team?.length && (
              <WorkspaceEmpty
                title={team ? '本窗暂无成员活动' : '成员活动读取中'}
              />
            )}
          </WorkspacePanel>
        </div>
        <aside className="ws-side">
          <WorkspacePanel
            title={agent?.name ?? '选择 Agent'}
            hint={agent?.appKey}
          >
            {agent ? (
              <>
                <dl className="ws-facts">
                  <dt>总调用</dt>
                  <dd>{compact(agent.calls)}</dd>
                  <dt>使用成员</dt>
                  <dd>{agent.users} 人</dd>
                  <dt>模型响应</dt>
                  <dd>{duration(agent.avgDurationMs)}</dd>
                </dl>
                <WorkspaceLink
                  permission="logs.read"
                  onClick={() =>
                    navigate(
                      `/logs?tab=llm&appCallerCode=${encodeURIComponent(agent.appKey)}`,
                    )
                  }
                >
                  查看调用明细
                </WorkspaceLink>
              </>
            ) : (
              <WorkspaceEmpty title="暂无可选 Agent" />
            )}
          </WorkspacePanel>
          <WorkspacePanel
            title="全平台活跃成员"
            hint="当前窗口 · 不归因到选中 Agent"
          >
            {(team ?? [])
              .slice()
              .sort((a, b) => b.messages - a.messages)
              .slice(0, 6)
              .map((member) => (
                <button
                  type="button"
                  key={member.userId}
                  className="ws-source-row"
                  disabled={!canReadLogs}
                  onClick={() =>
                    navigate(
                      `/logs?tab=llm&userId=${encodeURIComponent(member.userId)}`,
                    )
                  }
                >
                  <span className="ws-person">
                    <PersonAvatar person={member} size={26} />
                    <span>{member.displayName}</span>
                  </span>
                  <span>{compact(member.messages)} 消息</span>
                </button>
              ))}
            {!team?.length && (
              <WorkspaceEmpty
                title={team ? '此窗口暂无活动成员' : '成员活动尚未就绪'}
              />
            )}
          </WorkspacePanel>
        </aside>
      </div>
    </div>
  );
}

export function ExecutiveCostWorkspace({
  models,
}: {
  models?: ExecutiveModelStat[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState('');
  const filtered = (models ?? [])
    .filter(
      (item) =>
        (item.model || '未记录模型')
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'unpriced' ? !item.hasPricing : item.hasPricing)),
    )
    .sort((a, b) => b.calls - a.calls);
  const maxModelTokens = Math.max(
    1,
    ...filtered.map((m) => m.inputTokens + m.outputTokens),
  );
  const model = filtered.find((item) => item.model === selected) ?? filtered[0];
  const priced = models?.filter((item) => item.hasPricing);
  const missing = models?.filter((item) => !item.hasPricing);
  return (
    <div className="map-workspace" data-workspace="cost">
      <div className="ws-toolbar">
        <WorkspaceSearch
          value={query}
          onChange={setQuery}
          placeholder="搜索模型"
        />
        <div className="ws-tabs">
          {[
            { key: 'all', label: '全部' },
            { key: 'unpriced', label: '缺失定价' },
            { key: 'priced', label: '已定价' },
          ].map((tab) => (
            <button
              key={tab.key}
              aria-pressed={filter === tab.key}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="ws-metrics">
        <WorkspaceMetric
          label="已定价预估成本"
          value={
            priced?.length
              ? amount(priced.reduce((s, m) => s + m.totalCost, 0))
              : models
                ? '暂不可估算'
                : null
          }
          note={
            models
              ? `${priced?.length}/${models.length} 个模型已定价`
              : '等待价格覆盖资料'
          }
        />
        <WorkspaceMetric
          label="模型调用"
          value={number(total(models, (m) => m.calls))}
        />
        <WorkspaceMetric
          label="总 Token"
          value={number(total(models, (m) => m.totalTokens))}
        />
        <WorkspaceMetric
          label="缺失定价模型"
          value={missing?.length}
          tone={missing?.length ? 'warning' : undefined}
        />
      </div>
      {Boolean(missing?.length) && (
        <p className="ws-alert">
          {missing!.length}{' '}
          个模型未配置价格，其调用不能当作零成本，也未包含在已定价预估成本中。
        </p>
      )}
      <div className="ws-layout" style={{ marginTop: 12 }}>
        <div className="ws-main">
          <WorkspacePanel
            title="模型费用与用量"
            hint="按调用量排列；预估价格来自现有模型配置"
          >
            <div className="ws-table-wrap">
              <table className="ws-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>调用</th>
                    <th>输入 / 输出 Token</th>
                    <th>图片</th>
                    <th>平均响应</th>
                    <th>预估成本</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr
                      key={item.model}
                      aria-selected={item === model}
                      onClick={() => setSelected(item.model)}
                    >
                      <td>
                        <button className="ws-row-action">
                          <Coins size={16} />
                          <span>
                            <strong>{item.model || '未记录模型'}</strong>
                            <small>
                              {item.hasPricing ? '已配置价格' : '缺失定价'}
                            </small>
                          </span>
                        </button>
                      </td>
                      <td className="number">{compact(item.calls)}</td>
                      <td>
                        <div
                          className="scene-track token"
                          title={`输入 ${item.inputTokens} · 输出 ${item.outputTokens}`}
                        >
                          <i
                            style={{
                              width: `${(item.inputTokens / maxModelTokens) * 100}%`,
                            }}
                          />
                          <i
                            style={{
                              width: `${(item.outputTokens / maxModelTokens) * 100}%`,
                            }}
                          />
                        </div>
                        <small>
                          {compact(item.inputTokens)} /{' '}
                          {compact(item.outputTokens)}
                        </small>
                      </td>
                      <td className="number">{item.imageCount}</td>
                      <td>{duration(item.avgDurationMs)}</td>
                      <td>
                        {item.hasPricing ? (
                          amount(item.totalCost)
                        ) : (
                          <span className="ws-badge warning">不可估算</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <WorkspaceEmpty
                title={models ? '没有匹配的模型' : '模型统计读取中'}
              />
            )}
          </WorkspacePanel>
        </div>
        <aside className="ws-side">
          <WorkspacePanel
            title={model ? model.model || '未记录模型' : '选择模型'}
          >
            {model ? (
              <>
                <span
                  className={`ws-badge ${model.hasPricing ? 'good' : 'warning'}`}
                >
                  {model.hasPricing ? '已定价预估' : '缺失定价'}
                </span>
                <dl className="ws-facts" style={{ marginTop: 14 }}>
                  <dt>输入 Token</dt>
                  <dd>{compact(model.inputTokens)}</dd>
                  <dt>输出 Token</dt>
                  <dd>{compact(model.outputTokens)}</dd>
                  <dt>Token 成本</dt>
                  <dd>{model.hasPricing ? amount(model.tokenCost) : '—'}</dd>
                  <dt>调用成本</dt>
                  <dd>{model.hasPricing ? amount(model.callCost) : '—'}</dd>
                  <dt>总预估</dt>
                  <dd>{model.hasPricing ? amount(model.totalCost) : '—'}</dd>
                </dl>
                {model.model.trim() ? (
                  <>
                    {' '}
                    <WorkspaceLink
                      permission="logs.read"
                      onClick={() =>
                        navigate(
                          `/logs?tab=llm&model=${encodeURIComponent(model.model)}`,
                        )
                      }
                    >
                      查看该模型调用
                    </WorkspaceLink>
                  </>
                ) : (
                  <p className="ws-note">
                    这些请求未记录模型名称，不能按模型准确筛选。
                  </p>
                )}
              </>
            ) : (
              <WorkspaceEmpty title="暂无可选模型" />
            )}
          </WorkspacePanel>
          <WorkspacePanel title="价格与口径">
            <p>
              预估金额基于当前已配置单价，不是供应商账单。显式零价格保留为零；没有价格的模型显示不可估算。
            </p>
            <WorkspaceLink
              permission="logs.read"
              onClick={() => navigate('/logs?tab=llm')}
            >
              查看调用日志
            </WorkspaceLink>
          </WorkspacePanel>
        </aside>
      </div>
    </div>
  );
}

async function getChannelOverview(): Promise<
  ApiResponse<ChannelStatsResponse>
> {
  return ok(await channelService.getStats());
}
async function getChannelTasks(): Promise<ApiResponse<PagedTaskResponse>> {
  return ok(await channelService.getTasks(1, 12));
}
const TASK_STATES: Record<string, { label: string; tone: string }> = {
  pending: { label: '待处理', tone: 'warning' },
  processing: { label: '处理中', tone: 'warning' },
  completed: { label: '已完成', tone: 'good' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: '' },
};
export function ExecutiveIntegrationsWorkspace({
  revision,
}: {
  revision: number;
}) {
  const navigate = useNavigate();
  const stats = useExecutiveQuery(getChannelOverview, 0, true, revision);
  const tasks = useExecutiveQuery(getChannelTasks, 0, true, revision);
  const [selected, setSelected] = useState<string>();
  const task =
    tasks.data?.items.find((item) => item.id === selected) ??
    tasks.data?.items[0];
  const error = stats.error ?? tasks.error;
  const taskPerson = (item: ChannelTask) => ({
    displayName:
      item.mappedUserName || item.senderDisplayName || item.senderIdentifier,
    avatarFileName: null,
  });
  return (
    <div className="map-workspace" data-workspace="integrations">
      <div className="ws-toolbar">
        <span className="ws-person">
          <Link2 size={15} />
          渠道统计与最近任务
        </span>
        {(stats.loading || tasks.loading) && (
          <span className="ws-person">
            <MapSpinner size={12} />
            正在更新渠道数据
          </span>
        )}
        <WorkspaceLink
          permission="open-platform.manage"
          onClick={() => navigate('/open-platform?tab=webhook')}
        >
          渠道管理
        </WorkspaceLink>
      </div>
      {error && (
        <p role="alert" className="ws-alert">
          渠道数据暂不可用：{error}。不能将读取失败解释为未接入。
        </p>
      )}
      <div className="ws-metrics">
        <WorkspaceMetric label="今日任务" value={stats.data?.todayTaskCount} />
        <WorkspaceMetric label="处理中" value={stats.data?.processingCount} />
        <WorkspaceMetric
          label="成功率"
          value={
            stats.data
              ? stats.data.todayTaskCount > 0
                ? `${stats.data.successRate.toFixed(1)}%`
                : '无任务'
              : null
          }
          note="今日已完成任务 / 今日全部任务"
        />
        <WorkspaceMetric
          label="身份映射"
          value={stats.data?.identityMappingCount}
        />
      </div>
      <div className="ws-layout">
        <div className="ws-main">
          <WorkspacePanel
            title="已配置渠道"
            hint="启用状态不代表外部连接已通过探测"
          >
            {stats.data?.channels.map((channel) => (
              <div key={channel.channelType} className="ws-source-row">
                <span>
                  <strong>{channel.displayName}</strong>
                  <small className="block">
                    今日请求 {channel.todayRequestCount} · 成功{' '}
                    {channel.todaySuccessCount} · 失败 {channel.todayFailCount}
                  </small>
                </span>
                <span className={`ws-badge ${channel.isEnabled ? 'good' : ''}`}>
                  {channel.isEnabled ? '已启用' : '未启用'}
                </span>
              </div>
            ))}
            {stats.data && !stats.data.channels.length && (
              <WorkspaceEmpty
                title="暂无渠道配置"
                description="可到渠道管理配置真实连接。"
              />
            )}
          </WorkspacePanel>
          <WorkspacePanel
            title="最近渠道任务"
            hint="按服务端最近任务列表显示，不受统计时间筛选影响"
          >
            <div className="ws-table-wrap">
              <table className="ws-table">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>人员</th>
                    <th>渠道</th>
                    <th>状态</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.data?.items.map((item) => (
                    <tr
                      key={item.id}
                      aria-selected={item === task}
                      onClick={() => setSelected(item.id)}
                    >
                      <td>
                        <button className="ws-row-action">
                          <Activity size={15} />
                          <strong>
                            {item.originalSubject ||
                              item.originalContent.slice(0, 50) ||
                              item.id}
                          </strong>
                        </button>
                      </td>
                      <td>
                        <span className="ws-person">
                          <PersonAvatar person={taskPerson(item)} size={24} />
                          {taskPerson(item).displayName}
                        </span>
                      </td>
                      <td>{item.channelType}</td>
                      <td>
                        <span
                          className={`ws-badge ${TASK_STATES[item.status.toLowerCase()]?.tone ?? ''}`}
                        >
                          {TASK_STATES[item.status.toLowerCase()]?.label ??
                            item.status}
                        </span>
                      </td>
                      <td>{dateTime(item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tasks.data && !tasks.data.items.length && (
              <WorkspaceEmpty title="暂无渠道任务" />
            )}
          </WorkspacePanel>
        </div>
        <aside className="ws-side">
          <WorkspacePanel title="任务详情">
            {task ? (
              <>
                <div className="ws-identity">
                  <PersonAvatar person={taskPerson(task)} size={36} />
                  <div>
                    <h3>{taskPerson(task).displayName}</h3>
                    <p>{task.channelType}</p>
                  </div>
                </div>
                <dl className="ws-facts">
                  <dt>任务标识</dt>
                  <dd>{task.id}</dd>
                  <dt>目标 Agent</dt>
                  <dd>{task.targetAgent ?? '未识别'}</dd>
                  <dt>状态</dt>
                  <dd>
                    {TASK_STATES[task.status.toLowerCase()]?.label ??
                      task.status}
                  </dd>
                  <dt>创建</dt>
                  <dd>{dateTime(task.createdAt)}</dd>
                  <dt>错误</dt>
                  <dd>{task.error || '未记录错误'}</dd>
                </dl>
                <WorkspaceLink
                  permission="open-platform.manage"
                  onClick={() => navigate('/open-platform?tab=webhook')}
                >
                  查看配置与处理入口
                </WorkspaceLink>
              </>
            ) : (
              <WorkspaceEmpty title="选择任务查看详情" />
            )}
          </WorkspacePanel>
        </aside>
      </div>
    </div>
  );
}
