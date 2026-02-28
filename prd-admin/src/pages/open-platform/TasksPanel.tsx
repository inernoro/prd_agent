import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { channelService } from '@/services';
import { RefreshCw, Search, Clock, CheckCircle, XCircle, Loader2, ListTodo, Mail, MessageSquare, Mic, Webhook, ExternalLink } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { ChannelTask, ChannelTaskStats } from '@/services/contracts/channels';
import { ChannelTypeDisplayNames, TaskStatusDisplayNames } from '@/services/contracts/channels';
import { TaskDetailDrawer } from '../channels/components/TaskDetailDrawer';

interface TasksPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

const statusIcons: Record<string, React.ReactNode> = {
  pending: <Clock size={14} className="text-yellow-400" />,
  processing: <Loader2 size={14} className="text-blue-400 animate-spin" />,
  completed: <CheckCircle size={14} className="text-green-400" />,
  failed: <XCircle size={14} className="text-red-400" />,
  cancelled: <XCircle size={14} className="text-gray-400" />,
};

const statusBgColors: Record<string, string> = {
  pending: 'rgba(234,179,8,0.08)',
  processing: 'rgba(59,130,246,0.08)',
  completed: 'rgba(34,197,94,0.08)',
  failed: 'rgba(239,68,68,0.08)',
  cancelled: 'rgba(107,114,128,0.08)',
};

const statusBorderColors: Record<string, string> = {
  pending: 'rgba(234,179,8,0.2)',
  processing: 'rgba(59,130,246,0.2)',
  completed: 'rgba(34,197,94,0.2)',
  failed: 'rgba(239,68,68,0.2)',
  cancelled: 'rgba(107,114,128,0.2)',
};

const channelIcons: Record<string, React.ReactNode> = {
  email: <Mail size={16} />,
  sms: <MessageSquare size={16} />,
  siri: <Mic size={16} />,
  webhook: <Webhook size={16} />,
};

export default function TasksPanel({ onActionsReady }: TasksPanelProps) {
  const [searchParams] = useSearchParams();
  const channelTypeFromUrl = searchParams.get('channelType') || '';

  const [tasks, setTasks] = useState<ChannelTask[]>([]);
  const [stats, setStats] = useState<ChannelTaskStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [channelTypeFilter, setChannelTypeFilter] = useState(channelTypeFromUrl);
  const [statusFilter, setStatusFilter] = useState('');

  const [selectedTask, setSelectedTask] = useState<ChannelTask | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const loadTasks = async () => {
    setLoading(true);
    try {
      const res = await channelService.getTasks(page, pageSize, channelTypeFilter || undefined, statusFilter || undefined, search || undefined);
      setTasks(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const data = await channelService.getTaskStats(channelTypeFilter || undefined);
      setStats(data);
    } catch (err) {
      console.error('Load stats failed:', err);
    }
  };

  useEffect(() => { loadTasks(); loadStats(); }, [page, search, channelTypeFilter, statusFilter]);

  useEffect(() => {
    onActionsReady?.(
      <Button variant="secondary" size="sm" onClick={() => { loadTasks(); loadStats(); }}>
        <RefreshCw size={14} />
      </Button>
    );
  }, [onActionsReady]);

  const handleRetry = async (id: string) => {
    try {
      await channelService.retryTask(id);
      toast.success('已重新提交');
      loadTasks();
      loadStats();
    } catch (err) {
      toast.error('操作失败', String(err));
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await channelService.cancelTask(id);
      toast.success('已取消');
      loadTasks();
      loadStats();
    } catch (err) {
      toast.error('操作失败', String(err));
    }
  };

  const openDetail = (task: ChannelTask) => {
    setSelectedTask(task);
    setDrawerOpen(true);
  };

  return (
    <div className="h-full overflow-auto p-1">
      <GlassCard animated glow className="min-h-full">
        {/* 顶部提示栏 */}
        <div className="p-4 border-b border-white/10" style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ListTodo size={18} className="text-muted-foreground" />
              <span>查看通道任务的处理状态和执行历史</span>
            </div>
            <a href="#" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
              了解更多 <ExternalLink size={12} />
            </a>
          </div>
        </div>

        <div className="p-5 space-y-5">
          {/* 统计卡片 */}
          {stats && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium">任务统计</h3>
              </div>
              <div className="grid grid-cols-5 gap-3">
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', border: '1px solid var(--nested-block-border)' }}
                >
                  <div className="text-2xl font-bold">{stats.todayTotal}</div>
                  <div className="text-xs text-muted-foreground mt-1">今日任务</div>
                </div>
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)' }}
                >
                  <div className="text-2xl font-bold text-yellow-400">{stats.pending}</div>
                  <div className="text-xs text-muted-foreground mt-1">待处理</div>
                </div>
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)' }}
                >
                  <div className="text-2xl font-bold text-blue-400">{stats.processing}</div>
                  <div className="text-xs text-muted-foreground mt-1">处理中</div>
                </div>
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }}
                >
                  <div className="text-2xl font-bold text-green-400">{stats.completed}</div>
                  <div className="text-xs text-muted-foreground mt-1">已完成</div>
                </div>
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)' }}
                >
                  <div className="text-2xl font-bold text-red-400">{stats.failed}</div>
                  <div className="text-xs text-muted-foreground mt-1">失败</div>
                </div>
              </div>
            </section>
          )}

          <div className="border-t border-white/10" />

          {/* 任务列表 */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium">任务列表</h3>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="搜索任务..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-8 pr-3 text-sm rounded-lg outline-none"
                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-default)', width: '160px' }}
                  />
                </div>
                <Select value={channelTypeFilter} onChange={(e) => setChannelTypeFilter(e.target.value)} uiSize="sm">
                  <option value="">全部通道</option>
                  {Object.entries(ChannelTypeDisplayNames).map(([key, name]) => (
                    <option key={key} value={key}>{name}</option>
                  ))}
                </Select>
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} uiSize="sm">
                  <option value="">全部状态</option>
                  {Object.entries(TaskStatusDisplayNames).map(([key, name]) => (
                    <option key={key} value={key}>{name}</option>
                  ))}
                </Select>
              </div>
            </div>

            {/* 任务卡片列表 */}
            <div className="space-y-2">
              {tasks.length === 0 && !loading ? (
                <div className="text-center py-8 text-muted-foreground">
                  {search || channelTypeFilter || statusFilter ? '未找到匹配的任务' : '暂无任务记录'}
                </div>
              ) : (
                tasks.map((task) => (
                  <div
                    key={task.id}
                    className="surface-row p-4 rounded-lg cursor-pointer"
                    style={{
                      background: statusBgColors[task.status] || 'transparent',
                      border: `1px solid ${statusBorderColors[task.status] || 'var(--nested-block-border)'}`,
                    }}
                    onClick={() => openDetail(task)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 flex-1 min-w-0">
                        {/* 通道图标 */}
                        <div
                          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: 'var(--bg-card-hover)' }}
                        >
                          {channelIcons[task.channelType] || <Webhook size={16} />}
                        </div>

                        {/* 主要信息 */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">
                              {task.senderDisplayName || task.senderIdentifier}
                            </span>
                            {task.mappedUserName && (
                              <span className="text-xs text-muted-foreground">→ {task.mappedUserName}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span>{ChannelTypeDisplayNames[task.channelType] || task.channelType}</span>
                            <span>·</span>
                            <Badge variant="subtle" size="sm">{task.intent || '未识别'}</Badge>
                            {task.targetAgent && (
                              <>
                                <span>·</span>
                                <span>{task.targetAgent}</span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* 任务 ID */}
                        <code className="text-xs text-muted-foreground px-2 py-1 rounded flex-shrink-0" style={{ background: 'var(--nested-block-bg)' }}>
                          {task.id.slice(-12)}
                        </code>
                      </div>

                      {/* 右侧状态和操作 */}
                      <div className="flex items-center gap-4 ml-4">
                        {/* 状态 */}
                        <div className="flex items-center gap-2">
                          {statusIcons[task.status]}
                          <span className="text-sm">{TaskStatusDisplayNames[task.status] || task.status}</span>
                        </div>

                        {/* 时间 */}
                        <div className="text-xs text-muted-foreground w-[140px] text-right">
                          {fmtDate(task.createdAt)}
                        </div>

                        {/* 操作按钮 */}
                        <div className="flex gap-1 w-[60px] justify-end" onClick={(e) => e.stopPropagation()}>
                          {task.status === 'failed' && (
                            <Button variant="secondary" size="xs" onClick={() => handleRetry(task.id)}>重试</Button>
                          )}
                          {(task.status === 'pending' || task.status === 'processing') && (
                            <Button variant="secondary" size="xs" onClick={() => handleCancel(task.id)}>取消</Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {total > pageSize && (
              <div className="flex justify-between items-center pt-4 mt-4 border-t border-white/10">
                <div className="text-sm text-muted-foreground">共 {total} 条</div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button>
                  <Button variant="secondary" size="sm" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(page + 1)}>下一页</Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </GlassCard>

      <TaskDetailDrawer
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedTask(null); }}
        task={selectedTask}
        onRetry={(task) => handleRetry(task.id)}
        onCancel={(task) => handleCancel(task.id)}
      />
    </div>
  );
}
