import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Plug, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { getMcpConsoleOverview, listMcpCalls } from '@/services';
import type {
  McpCapabilityDto,
  McpClientDto,
} from '@/services/contracts/mcpConsole';
import { useAuthStore } from '@/stores/authStore';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  compact,
  PersonAvatar,
  WorkspaceEmpty,
  WorkspaceLink,
  WorkspaceMetric,
  WorkspacePanel,
} from '@/components/workspace/Workspace';
import { McpCallTrendChart } from '@/pages/mcp-console/McpCallTrendChart';
import { capabilityVisual } from '@/pages/mcp-console/capabilityRegistry';
import { clientVisual } from '@/pages/mcp-console/clientVisualRegistry';
import {
  eventTime,
  groupCalls,
  soloGroup,
  type CallGroup,
} from '@/pages/mcp-console/callGroups';
import { safeArtifactHref } from '@/pages/mcp-console/artifactHref';
import { useExecutiveQuery } from './useExecutiveQuery';
import { dateTime } from './executiveOperationsModel';

import './executive-mcp.css';

const PAGE_SIZE = 20;
const EMPTY_CLIENTS: McpClientDto[] = [];
const OUTCOMES: Record<string, { label: string; tone: string }> = {
  success: { label: '调用成功', tone: 'good' },
  error: { label: '失败', tone: 'danger' },
  denied: { label: '被拒绝', tone: 'warning' },
  pending: { label: '产物待完成', tone: '' },
};
const outcome = (status: string) =>
  OUTCOMES[status] ?? { label: status || '未知状态', tone: '' };
const elapsed = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} 秒` : `${ms.toLocaleString()} 毫秒`;
type Filters = { client: string; capability: string; status: string };

function CallDetails({ group }: { group?: CallGroup }) {
  if (!group)
    return (
      <WorkspaceEmpty
        title="选择一件协作事件"
        description="查看真实工具步骤、调用结果和产物。"
      />
    );
  const result = outcome(group.status);
  const artifact = group.artifact;
  const href = safeArtifactHref(artifact?.url);
  return (
    <>
      <div className="op-mcp-detail-head">
        <Activity size={17} />
        <strong>{group.last.keyName || '历史客户端'}</strong>
        <span className={`ws-badge ${result.tone}`}>{result.label}</span>
      </div>
      <dl className="ws-facts">
        <dt>最后调用</dt>
        <dd>{group.last.toolName}</dd>
        <dt>记录时间</dt>
        <dd>{dateTime(eventTime(group))}</dd>
        <dt>{group.multiStep ? '本页步骤跨度' : '调用耗时'}</dt>
        <dd>{elapsed(group.elapsedMs)}</dd>
        <dt>已载入步骤</dt>
        <dd>{group.steps.length} 次工具调用</dd>
        <dt>操作类型</dt>
        <dd>{group.isWrite ? '包含写入动作' : '读取查询'}</dd>
        {group.steps.some((step) => step.deduplicated) && (
          <>
            <dt>重复请求</dt>
            <dd>包含幂等命中，未重复执行写入</dd>
          </>
        )}
      </dl>
      {group.last.errorMessage && (
        <div className="op-error-detail">
          <strong>调用反馈</strong>
          <p>{group.last.errorMessage}</p>
        </div>
      )}
      {artifact && (
        <section className="op-mcp-artifact">
          <h3>关联产物</h3>
          <strong>{artifact.title || artifact.kind || '已关联产物'}</strong>
          {artifact.status && <small>业务状态：{artifact.status}</small>}
          {href ? (
            <a
              className="ws-link"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              打开产物或任务
            </a>
          ) : (
            <p className="op-scope-note">尚无可打开的产物地址。</p>
          )}
          {group.status === 'pending' && (
            <p className="op-scope-note">工具已响应，产物尚未确认完成。</p>
          )}
        </section>
      )}
      <h3 className="op-timeline-heading">工具调用步骤</h3>
      <ol className="op-mcp-steps">
        {[...group.steps].reverse().map((step) => {
          const status = outcome(step.status);
          return (
            <li key={step.id}>
              <time>{dateTime(step.createdAt)}</time>
              <strong>{step.toolName}</strong>
              <span className={`ws-badge ${status.tone}`}>{status.label}</span>
              <small>
                {elapsed(step.durationMs)} · {step.isWrite ? '写入' : '读取'}
                {step.deduplicated ? ' · 幂等命中' : ''}
              </small>
              {step.argumentsPreview && <p>{step.argumentsPreview}</p>}
              {step.errorMessage && (
                <p className="op-task-error">{step.errorMessage}</p>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** A filter change mounts a new query scope; old-client rows can never appear below new filters. */
function McpActivity({
  filters,
  revision,
  clients,
  hasHistory,
}: {
  filters: Filters;
  revision: number;
  clients: McpClientDto[];
  hasHistory?: boolean;
}) {
  const navigate = useNavigate();
  const [skip, setSkip] = useState(0);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<CallGroup>();
  const [mobileDetail, setMobileDetail] = useState(false);
  const fetchCalls = useCallback(
    (offset: number) =>
      listMcpCalls({
        keyId: filters.client || undefined,
        capability: filters.capability || undefined,
        status: filters.status || undefined,
        skip: offset,
        limit: PAGE_SIZE,
      }),
    [filters.client, filters.capability, filters.status],
  );
  const query = useExecutiveQuery(fetchCalls, skip, true, revision + retry);
  const groups = useMemo(
    () =>
      filters.status
        ? (query.data?.items ?? []).map(soloGroup)
        : groupCalls(query.data?.items ?? []),
    [query.data, filters.status],
  );
  const group = selected
    ? (groups.find((item) => item.id === selected.id) ?? selected)
    : (groups.find((item) => ['error', 'denied'].includes(item.status)) ??
      groups[0]);
  const snapshotOnly = Boolean(
    selected && !groups.some((item) => item.id === selected.id),
  );
  const shownSkip = query.data?.skip ?? query.dataDays ?? skip;
  const total = query.data?.total;
  const pageSize = query.data?.limit || PAGE_SIZE;
  const changePage = (next: number) => {
    setSelected(undefined);
    setMobileDetail(false);
    if (next === skip) setRetry((value) => value + 1);
    else setSkip(next);
  };
  const choose = (item: CallGroup) => {
    setSelected(item);
    if (window.matchMedia?.('(max-width: 760px)')?.matches)
      setMobileDetail(true);
  };
  const details = (
    <>
      <CallDetails group={group} />
      {snapshotOnly && (
        <p className="op-scope-note">
          所选事件已不在当前页，显示上次载入记录。
        </p>
      )}
      <WorkspaceLink onClick={() => navigate('/mcp-console?tab=calls')}>
        打开完整调用记录
      </WorkspaceLink>
    </>
  );
  return (
    <>
      <Dialog
        open={mobileDetail && Boolean(group)}
        onOpenChange={setMobileDetail}
        title={<span className="scene-preview-title">MCP 协作详情</span>}
        maxWidth={900}
        content={<div className="op-task-dialog op-mcp-dialog">{details}</div>}
      />
      <div className="op-mcp-activity">
        <WorkspacePanel
          title="协作事件"
          hint={`本环境全部历史 · 当前页 ${query.data?.items.length ?? '—'} 次调用，归并 ${groups.length} 件事件；共 ${total ?? '—'} 次调用`}
          action={
            <WorkspaceLink onClick={() => navigate('/mcp-console?tab=calls')}>
              完整调用记录
            </WorkspaceLink>
          }
        >
          {query.loading && (
            <div className="op-query-status" role="status">
              <MapSpinner size={12} />
              {query.data
                ? '正在更新，保留已载入记录'
                : '正在读取 MCP 调用记录'}
            </div>
          )}
          {query.error && (
            <div className="ws-alert" role="alert">
              调用记录读取失败：{query.error}
              {query.data
                ? `。暂显示第 ${Math.floor(shownSkip / pageSize) + 1} 页的上次结果。`
                : '。不能据此判断没有调用。'}
              <button
                className="ws-link"
                onClick={() => setRetry((value) => value + 1)}
              >
                重试调用记录
              </button>
            </div>
          )}
          {query.data && groups.length > 0 ? (
            <div className="ws-table-wrap op-mcp-call-table">
              <table className="ws-table">
                <thead>
                  <tr>
                    <th>客户端 / 工具</th>
                    <th>事件结果</th>
                    <th>步骤 / 耗时</th>
                    <th>最近调用</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((item) => {
                    const state = outcome(item.status);
                    const title = item.artifact?.title || item.first.toolName;
                    return (
                      <tr
                        key={item.id}
                        data-mcp-event={item.first.id}
                        aria-selected={group?.id === item.id}
                        onClick={() => choose(item)}
                      >
                        <td>
                          <button className="ws-row-action">
                            <strong>{title}</strong>
                          </button>
                          <small>
                            {item.last.keyName ||
                              clients.find(
                                (client) => client.keyId === item.last.keyId,
                              )?.name ||
                              '历史客户端'}{' '}
                            · {item.last.toolName}
                          </small>
                        </td>
                        <td>
                          <span className={`ws-badge ${state.tone}`}>
                            {state.label}
                          </span>
                        </td>
                        <td>
                          {item.steps.length} 次调用
                          <small>
                            {item.multiStep ? '本页步骤跨度 ' : ''}
                            {elapsed(item.elapsedMs)}
                          </small>
                        </td>
                        <td>{dateTime(eventTime(item))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : query.data ? (
            <WorkspaceEmpty
              title={
                hasHistory === false &&
                !filters.client &&
                !filters.capability &&
                !filters.status
                  ? '本环境暂无 MCP 调用'
                  : '当前条件没有调用记录'
              }
              description="在智能体接入台配置客户端，用你的智能体调用 MAP 工具后，可在这里查看结果与产物。"
              action={
                <WorkspaceLink onClick={() => navigate('/mcp-console')}>
                  前往智能体接入台
                </WorkspaceLink>
              }
            />
          ) : (
            !query.loading && <WorkspaceEmpty title="调用记录暂不可用" />
          )}
          {total !== undefined && total > pageSize && (
            <div className="op-pagination">
              <span>
                第 {Math.floor(shownSkip / pageSize) + 1} /{' '}
                {Math.max(1, Math.ceil(total / pageSize))} 页
                {query.loading && shownSkip !== skip ? ' · 正在翻页' : ''}
              </span>
              <button
                disabled={shownSkip <= 0 || query.loading}
                onClick={() => changePage(Math.max(0, shownSkip - pageSize))}
              >
                上一页
              </button>
              <button
                disabled={shownSkip + pageSize >= total || query.loading}
                onClick={() => changePage(shownSkip + pageSize)}
              >
                下一页
              </button>
            </div>
          )}
          {filters.status && (
            <p className="op-scope-note">
              筛选按工具调用结果；关联产物是否完成另行显示。
            </p>
          )}
        </WorkspacePanel>
        <aside className="ws-side op-mcp-inspector">
          <WorkspacePanel title="事件与产物详情">{details}</WorkspacePanel>
        </aside>
      </div>
    </>
  );
}

export function ExecutiveIntegrationsWorkspace({
  revision,
}: {
  revision: number;
}) {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const [retry, setRetry] = useState(0);
  const [filters, setFilters] = useState<Filters>({
    client: '',
    capability: '',
    status: '',
  });
  const query = useExecutiveQuery(
    getMcpConsoleOverview,
    0,
    true,
    revision + retry,
  );
  const overview = query.data;
  const clients = overview?.clients ?? EMPTY_CLIENTS;
  const select = (key: keyof Filters, value: string) =>
    setFilters((previous) => ({ ...previous, [key]: value }));
  function capabilityButton(cap: McpCapabilityDto) {
    const Icon = capabilityVisual(cap.key).icon;
    return (
      <button
        key={cap.key}
        className="op-mcp-capability"
        aria-pressed={filters.capability === cap.key}
        onClick={() =>
          select('capability', filters.capability === cap.key ? '' : cap.key)
        }
      >
        <span>
          <Icon size={16} />
          <strong>{cap.title}</strong>
          <b>{compact(cap.todayCalls)}</b>
        </span>
        <small>
          {cap.granted ? '已有授权' : '未授权'} · {cap.tools.length} 个工具 ·
          今日调用
        </small>
      </button>
    );
  }
  return (
    <div
      className="map-workspace op-workspace op-mcp-workspace"
      data-workspace="integrations"
    >
      <div className="ws-toolbar">
        <span className="ws-person">
          <PersonAvatar
            person={user ?? { displayName: '当前账号' }}
            size={28}
          />
          <strong>我的 MCP 协作</strong>
        </span>
        <span>
          当前账号的客户端与授权；调用仅限本环境，今日按 UTC 自然日统计
        </span>
        <WorkspaceLink onClick={() => navigate('/mcp-console')}>
          管理 MCP 接入
        </WorkspaceLink>
      </div>
      <div className="ws-metrics op-mcp-metrics">
        <WorkspaceMetric
          label="可用客户端"
          value={
            overview ? clients.filter((client) => client.isActive).length : null
          }
          note={
            overview
              ? `共 ${clients.length} 个 · 不代表实时在线`
              : '读取授权配置'
          }
        />
        <WorkspaceMetric
          label="今日 MCP 调用"
          value={overview ? compact(overview.today.calls) : null}
        />
        <WorkspaceMetric label="今日写入动作" value={overview?.today.writes} />
        <WorkspaceMetric
          label="今日失败调用"
          value={overview?.today.failed}
          tone={overview?.today.failed ? 'danger' : undefined}
        />
        <WorkspaceMetric
          label="今日被拒绝"
          value={overview?.today.denied}
          tone={overview?.today.denied ? 'warning' : undefined}
        />
      </div>
      {query.loading && (
        <div className="op-query-status" role="status">
          <MapSpinner size={12} />
          {overview
            ? '正在更新 MCP 概览，保留上一份数据'
            : '正在读取 MCP 客户端与授权'}
        </div>
      )}
      {query.error && (
        <div role="alert" className="ws-alert">
          MCP 概览读取失败：{query.error}
          {overview ? '。保留上次概览。' : '。调用记录仍独立加载。'}
          <button
            className="ws-link"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试 MCP 概览
          </button>
        </div>
      )}
      <div className="op-mcp-overview">
        <WorkspacePanel
          title="客户端与授权"
          hint="可用性来自凭证状态，最近使用来自真实调用，不推断在线连接"
          action={
            <WorkspaceLink onClick={() => navigate('/mcp-console')}>
              管理客户端
            </WorkspaceLink>
          }
        >
          <div className="op-mcp-clients">
            {clients.map((client) => {
              const Icon = clientVisual(client.name).icon;
              return (
                <button
                  key={client.keyId}
                  className="op-mcp-client"
                  aria-pressed={filters.client === client.keyId}
                  onClick={() =>
                    select(
                      'client',
                      filters.client === client.keyId ? '' : client.keyId,
                    )
                  }
                >
                  <span className="op-mcp-client-name">
                    <Icon size={18} />
                    <strong>{client.name}</strong>
                    <span
                      className={`ws-badge ${client.isActive ? 'good' : 'warning'}`}
                    >
                      {client.isActive
                        ? '可用'
                        : client.unusableReason === 'expired'
                          ? '已到期'
                          : client.unusableReason === 'disabled'
                            ? '已停用'
                            : '不可用'}
                    </span>
                  </span>
                  <span className="op-mcp-client-count">
                    <b>{compact(client.todayCalls)}</b> 今日调用
                    <small>
                      写入 {client.todayWrites} · 生图 {client.todayImages}
                    </small>
                  </span>
                  <small>
                    {client.scopeMode === 'auto'
                      ? '跟随账号权限'
                      : '自定义授权'}{' '}
                    · {client.scopes.length} 项范围
                  </small>
                  <small>
                    最近使用{' '}
                    {client.lastUsedAt
                      ? dateTime(client.lastUsedAt)
                      : '尚无记录'}
                  </small>
                </button>
              );
            })}
          </div>
          {!clients.length && (
            <WorkspaceEmpty
              title={
                query.loading
                  ? '客户端读取中'
                  : query.error
                    ? '客户端配置暂不可用'
                    : '尚未配置 MCP 客户端'
              }
              description="在智能体接入台为 Codex、Claude 等客户端配置 MAP 工具授权。"
              action={
                <WorkspaceLink onClick={() => navigate('/mcp-console')}>
                  配置 MCP 接入
                </WorkspaceLink>
              }
            />
          )}
        </WorkspacePanel>
        <WorkspacePanel
          title="调用频率"
          hint="当前账号 · 本环境 · 近 24 个小时"
        >
          <div className="op-mcp-trend">
            <McpCallTrendChart trend={overview?.callTrend} />
            {overview && (
              <dl className="op-mcp-config-facts">
                <div>
                  <dt>自动授权</dt>
                  <dd>
                    {
                      clients.filter((client) => client.scopeMode === 'auto')
                        .length
                    }
                  </dd>
                </div>
                <div>
                  <dt>自定义授权</dt>
                  <dd>
                    {
                      clients.filter((client) => client.scopeMode === 'manual')
                        .length
                    }
                  </dd>
                </div>
                <div>
                  <dt>未记录使用</dt>
                  <dd>
                    {clients.filter((client) => !client.lastUsedAt).length}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </WorkspacePanel>
      </div>
      <WorkspacePanel
        title="MCP 能力使用"
        hint="点击能力筛选下方历史事件；调用量为今日统计，授权表示当前已有可用凭证"
      >
        <div className="op-mcp-capabilities">
          {overview?.capabilities.map(capabilityButton)}
        </div>
        {!overview?.capabilities.length && (
          <WorkspaceEmpty
            title={
              query.loading
                ? '授权能力读取中'
                : query.error
                  ? '授权能力暂不可用'
                  : '暂无能力数据'
            }
          />
        )}
      </WorkspacePanel>
      <div
        className="op-mcp-filters"
        role="group"
        aria-label="MCP 历史调用筛选"
      >
        <SlidersHorizontal size={15} />
        <label>
          客户端
          <select
            aria-label="筛选 MCP 客户端"
            value={filters.client}
            onChange={(event) => select('client', event.target.value)}
          >
            <option value="">全部客户端</option>
            {filters.client &&
              !clients.some((client) => client.keyId === filters.client) && (
                <option value={filters.client}>历史客户端</option>
              )}
            {clients.map((client) => (
              <option key={client.keyId} value={client.keyId}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          能力
          <select
            aria-label="筛选 MCP 能力"
            value={filters.capability}
            onChange={(event) => select('capability', event.target.value)}
          >
            <option value="">全部能力</option>
            {overview?.capabilities.map((cap) => (
              <option key={cap.key} value={cap.key}>
                {cap.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          调用结果
          <select
            aria-label="筛选 MCP 调用结果"
            value={filters.status}
            onChange={(event) => select('status', event.target.value)}
          >
            <option value="">全部结果</option>
            <option value="success">调用成功</option>
            <option value="error">失败</option>
            <option value="denied">被拒绝</option>
          </select>
        </label>
        {Object.values(filters).some(Boolean) && (
          <button
            className="ws-link"
            onClick={() =>
              setFilters({ client: '', capability: '', status: '' })
            }
          >
            清除筛选
          </button>
        )}
        <span className="op-scope-note">
          <ShieldCheck size={13} />
          仅当前账号授权与调用
        </span>
      </div>
      <McpActivity
        key={JSON.stringify(filters)}
        filters={filters}
        revision={revision + retry}
        clients={clients}
        hasHistory={overview?.hasHistory}
      />
      <p className="op-scope-note">
        <Plug size={13} />
        授权变更与调用处理请前往智能体接入台。
      </p>
    </div>
  );
}
