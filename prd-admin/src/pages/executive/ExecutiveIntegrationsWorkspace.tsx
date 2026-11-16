import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Mail,
  MessageSquare,
  Mic,
  Webhook,
  Link2,
  ListChecks,
  Users,
  Settings2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { channelService } from '@/services';
import type {
  ChannelTask,
  ChannelStatsResponse,
  PagedTaskResponse,
} from '@/services/contracts/channels';
import { ok, type ApiResponse } from '@/types/api';
import { Dialog } from '@/components/ui/Dialog';
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
import { useExecutiveQuery } from './useExecutiveQuery';
import { dateTime, taskLane, taskStatus } from './executiveOperationsModel';

const EMPTY_TASKS: ChannelTask[] = [];
const readStats = async (): Promise<ApiResponse<ChannelStatsResponse>> =>
  ok(await channelService.getStats());
const readTasks = async (
  page: number,
): Promise<ApiResponse<PagedTaskResponse>> =>
  ok(await channelService.getTasks(page, 40));
const CHANNEL_ICONS: Record<string, LucideIcon> = {
  email: Mail,
  sms: MessageSquare,
  siri: Mic,
  webhook: Webhook,
};
const LANES = [
  { key: 'pending', label: '待处理' },
  { key: 'processing', label: '处理中' },
  { key: 'failed', label: '失败' },
  { key: 'ended', label: '已结束' },
] as const;
const person = (task: ChannelTask) => ({
  displayName:
    task.mappedUserName ||
    task.senderDisplayName ||
    task.senderIdentifier ||
    '未识别来源',
});
const title = (task: ChannelTask) =>
  task.originalSubject || task.originalContent || task.intent || task.id;
const configPath = (channel: string) =>
  `/open-platform?tab=${channel === 'email' ? 'email' : 'webhook'}`;

function TaskCard({
  task,
  selected,
  onSelect,
}: {
  task: ChannelTask;
  selected: boolean;
  onSelect: () => void;
}) {
  const lane = taskLane(task.status);
  return (
    <button
      className={`op-task-card ${lane}`}
      data-task-id={task.id}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <strong>{title(task)}</strong>
      <span className="ws-person">
        <PersonAvatar person={person(task)} size={23} />
        <span>{person(task).displayName}</span>
      </span>
      <span className="op-task-meta">
        <small>
          {task.channelType} · {dateTime(task.createdAt)}
        </small>
        <span
          className={`ws-badge ${lane === 'failed' ? 'danger' : lane === 'processing' ? 'warning' : ''}`}
        >
          {lane === 'processing' && <MapSpinner size={10} />}{' '}
          {taskStatus(task.status)}
        </span>
      </span>
      {task.error && <small className="op-task-error">{task.error}</small>}
    </button>
  );
}

function TaskInspector({ task }: { task?: ChannelTask }) {
  const navigate = useNavigate();
  return (
    <>
      {task ? (
        <>
          <div className="ws-identity">
            <PersonAvatar person={person(task)} size={36} />
            <div>
              <h3>{person(task).displayName}</h3>
              <p>
                {task.channelType} · {taskStatus(task.status)}
              </p>
            </div>
          </div>
          <strong className="op-task-detail-title">{title(task)}</strong>
          <dl className="ws-facts">
            <dt>任务标识</dt>
            <dd>{task.id}</dd>
            <dt>目标 Agent</dt>
            <dd>{task.targetAgent || '未识别'}</dd>
            <dt>创建</dt>
            <dd>{dateTime(task.createdAt)}</dd>
            <dt>开始处理</dt>
            <dd>{dateTime(task.startedAt)}</dd>
            <dt>结束</dt>
            <dd>{dateTime(task.completedAt)}</dd>
            <dt>记录耗时</dt>
            <dd>
              {task.durationMs == null
                ? '未记录'
                : `${task.durationMs.toLocaleString()} 毫秒`}
            </dd>
            <dt>重试次数</dt>
            <dd>{task.retryCount ?? '未记录'}</dd>
          </dl>
          {task.error && (
            <div className="op-error-detail">
              <strong>{task.errorCode || '处理失败'}</strong>
              <p>{task.error}</p>
            </div>
          )}
          <h3 className="op-timeline-heading">状态历史</h3>
          {task.statusHistory?.length ? (
            <ol className="op-timeline">
              {task.statusHistory.map((event, index) => (
                <li
                  key={`${event.at}:${index}`}
                  className={taskLane(event.status)}
                >
                  <strong>{taskStatus(event.status)}</strong>
                  <time>{dateTime(event.at)}</time>
                  {event.note && <p>{event.note}</p>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="op-scope-note">
              未记录状态历史，可查看上方已有时间记录。
            </p>
          )}
          {task.responsesSent?.length > 0 && (
            <div className="op-response-history">
              <h3>响应记录</h3>
              {task.responsesSent.map((response, index) => (
                <p key={index}>
                  {response.type} · {response.status}
                  <time>{dateTime(response.sentAt)}</time>
                  {response.error && <small>{response.error}</small>}
                </p>
              ))}
            </div>
          )}
          <WorkspaceLink
            permission="open-platform.manage"
            onClick={() =>
              navigate(
                `/open-platform?tab=tasks&channelType=${encodeURIComponent(task.channelType)}`,
              )
            }
          >
            前往任务监控处理
          </WorkspaceLink>
        </>
      ) : (
        <>
          <WorkspaceEmpty
            title="当前暂无可选任务"
            description="选择任务后查看真实过程与错误。"
          />
          <p className="op-scope-note">
            启用状态、身份映射和任务执行分别展示。今日成功记录不能替代连接探测。
          </p>
        </>
      )}
    </>
  );
}

export function ExecutiveIntegrationsWorkspace({
  revision,
}: {
  revision: number;
}) {
  const navigate = useNavigate();
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const [channel, setChannel] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [selectedSnapshot, setSelectedSnapshot] = useState<ChannelTask>();
  const [mobileDetail, setMobileDetail] = useState(false);
  const stats = useExecutiveQuery(readStats, 0, true, revision + retry);
  const tasks = useExecutiveQuery(readTasks, page, true, revision + retry);
  const all = tasks.data?.items ?? EMPTY_TASKS;
  const filtered = useMemo(
    () =>
      all.filter(
        (task) =>
          (!channel || task.channelType === channel) &&
          `${title(task)} ${person(task).displayName} ${task.targetAgent ?? ''} ${task.id}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [all, channel, query],
  );
  const task = selected
    ? (all.find((item) => item.id === selected) ??
      (selectedSnapshot?.id === selected ? selectedSnapshot : undefined))
    : (filtered.find((item) => taskLane(item.status) === 'failed') ??
      filtered[0]);
  const snapshotOnly = Boolean(
    selected && task && !all.some((item) => item.id === selected),
  );
  function chooseTask(item: ChannelTask) {
    setSelected(item.id);
    setSelectedSnapshot(item);
    if (window.matchMedia?.('(max-width: 760px)')?.matches)
      setMobileDetail(true);
  }
  function goToPage(next: number) {
    setSelected(undefined);
    setSelectedSnapshot(undefined);
    setMobileDetail(false);
    if (next === page) setRetry((v) => v + 1);
    else setPage(next);
  }
  const currentPage = tasks.data?.page ?? tasks.dataDays ?? page;
  const totalPages = Math.max(
    1,
    Math.ceil((tasks.data?.total ?? 0) / (tasks.data?.pageSize || 40)),
  );
  const active =
    all.some((item) =>
      ['pending', 'processing'].includes(item.status.toLowerCase()),
    ) || (stats.data?.processingCount ?? 0) > 0;
  useEffect(() => {
    if (!active || stats.loading || tasks.loading) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible')
        setRetry((value) => value + 1);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [active, stats.loading, tasks.loading]);
  const known = LANES.map((lane) => ({
    ...lane,
    items: filtered.filter((item) => taskLane(item.status) === lane.key),
  }));
  const other = filtered.filter((item) => taskLane(item.status) === 'other');
  const lanes = other.length
    ? [...known, { key: 'other', label: '其他状态', items: other }]
    : known;
  const selectedChannel = stats.data?.channels.find(
    (item) => item.channelType === channel,
  );
  return (
    <div className="map-workspace op-workspace" data-workspace="integrations">
      <Dialog
        open={mobileDetail && Boolean(task)}
        onOpenChange={setMobileDetail}
        title={
          <span className="scene-preview-title">
            任务过程 · {task ? title(task) : ''}
          </span>
        }
        maxWidth={900}
        content={
          <div className="op-task-dialog">
            <TaskInspector task={task} />
            {snapshotOnly && (
              <p className="op-scope-note">
                所选任务已不在当前页，显示上次载入记录。
              </p>
            )}
          </div>
        }
      />
      <div className="ws-toolbar">
        <span className="ws-person">
          <Link2 size={15} />
          渠道与任务过程
        </span>
        <span>
          {active ? '有进行中的任务，空闲时每15秒更新' : '按需刷新当前快照'}
        </span>
        <WorkspaceLink
          permission="open-platform.manage"
          onClick={() => navigate('/open-platform?tab=tasks')}
        >
          完整任务监控
        </WorkspaceLink>
      </div>
      <div className="ws-metrics">
        <WorkspaceMetric
          label="今日任务 · 全渠道"
          value={stats.data?.todayTaskCount}
        />
        <WorkspaceMetric
          label="处理中 · 全渠道"
          value={stats.data?.processingCount}
        />
        <WorkspaceMetric
          label="今日成功率"
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
      {(stats.loading || tasks.loading) && (
        <div className="op-query-status" role="status">
          <MapSpinner size={12} />
          正在更新渠道数据{tasks.data ? '，已载入任务仍可查看' : ''}
        </div>
      )}
      {stats.error && (
        <p className="ws-alert" role="alert">
          渠道统计读取失败：{stats.error}。不能据此判定未接入。
          <button className="ws-link" onClick={() => setRetry((v) => v + 1)}>
            重试
          </button>
        </p>
      )}
      <WorkspacePanel
        title="外部渠道"
        hint="启用是配置状态；连接是否可用需要在渠道管理中验证"
        action={
          <WorkspaceLink
            permission="open-platform.manage"
            onClick={() => navigate(configPath(channel))}
          >
            渠道管理
          </WorkspaceLink>
        }
      >
        <div className="op-channel-grid">
          {stats.data?.channels.map((item) => {
            const Icon = CHANNEL_ICONS[item.channelType] ?? Link2;
            return (
              <button
                key={item.channelType}
                className="op-channel-card"
                aria-pressed={channel === item.channelType}
                onClick={() => {
                  setChannel((value) =>
                    value === item.channelType ? '' : item.channelType,
                  );
                  setSelected(undefined);
                }}
              >
                <span className="op-channel-name">
                  <Icon size={18} />
                  <strong>{item.displayName}</strong>
                  <span
                    className={`ws-badge ${item.isEnabled ? 'warning' : ''}`}
                  >
                    {item.isEnabled ? '已启用' : '未启用'}
                  </span>
                </span>
                <small>连接未验证</small>
                <span className="op-channel-count">
                  今日请求 <b>{compact(item.todayRequestCount)}</b>
                  <small>
                    成功 {item.todaySuccessCount} · 失败 {item.todayFailCount}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
        {!stats.data?.channels.length && (
          <WorkspaceEmpty
            title={
              stats.loading
                ? '渠道配置读取中'
                : stats.error
                  ? '渠道统计暂不可用'
                  : '暂无渠道配置'
            }
          />
        )}
      </WorkspacePanel>
      <div className="ws-layout op-channel-layout">
        <div className="ws-main">
          <WorkspacePanel
            title="任务过程"
            hint={`已载入第 ${currentPage} 页 ${all.length} 条 / 总计 ${tasks.data?.total ?? '—'} 条；搜索、渠道和分栏计数仅作用于本页`}
            action={
              <WorkspaceLink
                permission="open-platform.manage"
                onClick={() =>
                  navigate(
                    `/open-platform?tab=tasks${channel ? `&channelType=${encodeURIComponent(channel)}` : ''}`,
                  )
                }
              >
                查看全部任务
              </WorkspaceLink>
            }
          >
            <div className="ws-toolbar">
              <WorkspaceSearch
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setSelected(undefined);
                  setSelectedSnapshot(undefined);
                  setMobileDetail(false);
                }}
                placeholder="搜索本页任务、人员或 Agent"
              />
              {channel && (
                <button className="ws-link" onClick={() => setChannel('')}>
                  清除渠道 · {selectedChannel?.displayName || channel}
                </button>
              )}
            </div>
            {tasks.error && (
              <p role="alert" className="ws-alert">
                任务读取失败：{tasks.error}
                {tasks.data
                  ? `。暂显示第 ${currentPage} 页的上次结果。`
                  : '。不能将失败解释为没有任务。'}
                <button
                  className="ws-link"
                  onClick={() => setRetry((v) => v + 1)}
                >
                  重试任务
                </button>
              </p>
            )}
            <div className="op-lane-summary">
              {lanes.map((lane) => (
                <span key={lane.key} className={lane.key}>
                  <i />
                  {lane.label}
                  <b>{tasks.data ? lane.items.length : '—'}</b>
                </span>
              ))}
            </div>
            {tasks.data && filtered.length > 0 ? (
              <div className="op-task-board">
                {lanes.map((lane) => (
                  <section
                    key={lane.key}
                    className={`op-lane ${lane.key}`}
                    aria-label={`${lane.label}任务`}
                  >
                    <h3>
                      {lane.label}
                      <span>{lane.items.length}</span>
                    </h3>
                    {lane.items.map((item) => (
                      <TaskCard
                        key={item.id}
                        task={item}
                        selected={task?.id === item.id}
                        onSelect={() => chooseTask(item)}
                      />
                    ))}
                    {!lane.items.length && (
                      <p className="op-lane-empty">本页无此类任务</p>
                    )}
                  </section>
                ))}
              </div>
            ) : tasks.loading && !tasks.data ? (
              <WorkspaceEmpty
                title="任务过程读取中"
                description="渠道统计与任务列表分别加载。"
              />
            ) : !tasks.data ? (
              <WorkspaceEmpty title="任务列表暂不可用" />
            ) : tasks.data.total === 0 ? (
              <div className="op-channel-onboarding">
                <h3>暂无外部协作任务</h3>
                <p>先配置可信来源和成员，再在这里追踪任务过程。</p>
                <div className="op-setup-steps">
                  <section>
                    <Settings2 size={21} />
                    <strong>配置渠道</strong>
                    <p>
                      核对服务配置与授权；当前管理入口提供邮箱与 Webhook
                      配置，其余渠道请核对接入端。
                    </p>
                    <WorkspaceLink
                      permission="open-platform.manage"
                      onClick={() => navigate(configPath(channel))}
                    >
                      打开渠道管理
                    </WorkspaceLink>
                  </section>
                  <section>
                    <Users size={21} />
                    <strong>绑定发送来源</strong>
                    <p>
                      在来源白名单中设置权限和映射用户。当前白名单{' '}
                      {stats.data?.whitelistCount ?? '—'} 条、身份映射{' '}
                      {stats.data?.identityMappingCount ?? '—'} 条。
                    </p>
                    <WorkspaceLink
                      permission="open-platform.manage"
                      onClick={() => navigate('/open-platform?tab=email')}
                    >
                      查看邮箱与白名单
                    </WorkspaceLink>
                  </section>
                  <section>
                    <ListChecks size={21} />
                    <strong>查看任务过程</strong>
                    <p>任务接入后，展示真实状态历史、处理耗时和错误。</p>
                    <WorkspaceLink
                      permission="open-platform.manage"
                      onClick={() => navigate('/open-platform?tab=tasks')}
                    >
                      打开任务监控
                    </WorkspaceLink>
                  </section>
                </div>
              </div>
            ) : (
              <WorkspaceEmpty
                title="本页没有匹配的任务"
                description="筛选只覆盖本页已载入记录，可清除筛选或继续翻页。"
                action={
                  <button
                    className="ws-link"
                    onClick={() => {
                      setQuery('');
                      setChannel('');
                    }}
                  >
                    清除本页筛选
                  </button>
                }
              />
            )}
            {tasks.data && totalPages > 1 && (
              <div className="op-pagination">
                <span>
                  第 {currentPage} / {totalPages} 页
                  {tasks.loading && page !== currentPage
                    ? ` · 正在读取第 ${page} 页`
                    : ''}
                </span>
                <button
                  disabled={currentPage <= 1 || tasks.loading}
                  onClick={() => goToPage(currentPage - 1)}
                >
                  上一页
                </button>
                <button
                  disabled={currentPage >= totalPages || tasks.loading}
                  onClick={() => {
                    goToPage(currentPage + 1);
                  }}
                >
                  下一页
                </button>
              </div>
            )}
          </WorkspacePanel>
        </div>
        <aside className="ws-side">
          <WorkspacePanel
            title="任务详情"
            hint={
              snapshotOnly
                ? '所选任务已不在当前页，显示上次载入记录'
                : undefined
            }
          >
            <TaskInspector task={task} />
          </WorkspacePanel>
        </aside>
      </div>
      <p className="op-scope-note">
        这里为只读任务看板；重试、取消等操作沿用任务监控中的权限与确认流程。
      </p>
    </div>
  );
}
