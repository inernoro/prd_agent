import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { channelService } from '@/services';
import {
  RefreshCw,
  Search,
  ListFilter,
  Clock,
  ArrowLeft,
  RotateCcw,
  XCircle,
  ExternalLink,
  Mail,
  MessageSquare,
  Mic,
  Webhook,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import type { ChannelTask, ChannelTaskStats } from '@/services/contracts/channels';
import {
  ChannelTypeDisplayNames,
  TaskStatusDisplayNames,
  TaskStatus,
  TaskIntents,
} from '@/services/contracts/channels';
import { TaskDetailDrawer } from './components/TaskDetailDrawer';

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

const channelIcons: Record<string, React.ReactNode> = {
  email: <Mail size={16} />,
  sms: <MessageSquare size={16} />,
  siri: <Mic size={16} />,
  webhook: <Webhook size={16} />,
};

const statusColors: Record<string, string> = {
  pending: 'warning',
  processing: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'subtle',
};

export default function ChannelTasksPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialChannelType = searchParams.get('channelType') || '';
  const initialStatus = searchParams.get('status') || '';

  const [tasks, setTasks] = useState<ChannelTask[]>([]);
  const [stats, setStats] = useState<ChannelTaskStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [channelTypeFilter, setChannelTypeFilter] = useState<string>(initialChannelType);
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus);

  const [selectedTask, setSelectedTask] = useState<ChannelTask | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const loadStats = async () => {
    try {
      const data = await channelService.getTaskStats(channelTypeFilter || undefined);
      setStats(data);
    } catch (err) {
      console.error('Load stats failed:', err);
    }
  };

  const loadTasks = async () => {
    setLoading(true);
    try {
      const res = await channelService.getTasks(
        page,
        pageSize,
        channelTypeFilter || undefined,
        statusFilter || undefined,
        search || undefined
      );
      setTasks(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, [channelTypeFilter]);

  useEffect(() => {
    loadTasks();
    // Update URL params
    const params = new URLSearchParams();
    if (channelTypeFilter) params.set('channelType', channelTypeFilter);
    if (statusFilter) params.set('status', statusFilter);
    setSearchParams(params);
  }, [page, search, channelTypeFilter, statusFilter]);

  const handleViewDetail = (task: ChannelTask) => {
    setSelectedTask(task);
    setDrawerOpen(true);
  };

  const handleRetry = async (task: ChannelTask) => {
    const confirmed = await systemDialog.confirm({
      title: '确认重试',
      message: `确定要重试任务 ${task.id} 吗？`,
    });
    if (!confirmed) return;

    try {
      await channelService.retryTask(task.id);
      toast.success('已加入重试队列');
      loadTasks();
      loadStats();
    } catch (err) {
      toast.error('重试失败', String(err));
    }
  };

  const handleCancel = async (task: ChannelTask) => {
    const confirmed = await systemDialog.confirm({
      title: '确认取消',
      message: `确定要取消任务 ${task.id} 吗？`,
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await channelService.cancelTask(task.id);
      toast.success('任务已取消');
      loadTasks();
      loadStats();
    } catch (err) {
      toast.error('取消失败', String(err));
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5">
      <TabBar
        title="任务监控"
        icon={<Clock size={16} />}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/open-platform/channels')}>
              <ArrowLeft size={14} />
              返回
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { loadTasks(); loadStats(); }}>
              <RefreshCw size={14} />
              刷新
            </Button>
          </>
        }
      />

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <GlassCard className="p-3 text-center">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-xs text-muted-foreground">总任务</div>
          </GlassCard>
          <GlassCard className="p-3 text-center">
            <div className="text-2xl font-bold text-yellow-400">{stats.pending}</div>
            <div className="text-xs text-muted-foreground">待处理</div>
          </GlassCard>
          <GlassCard className="p-3 text-center">
            <div className="text-2xl font-bold text-blue-400">{stats.processing}</div>
            <div className="text-xs text-muted-foreground">处理中</div>
          </GlassCard>
          <GlassCard className="p-3 text-center">
            <div className="text-2xl font-bold text-green-400">{stats.completed}</div>
            <div className="text-xs text-muted-foreground">已完成</div>
          </GlassCard>
          <GlassCard className="p-3 text-center">
            <div className="text-2xl font-bold text-red-400">{stats.failed}</div>
            <div className="text-xs text-muted-foreground">失败</div>
          </GlassCard>
          <GlassCard className="p-3 text-center">
            <div className="text-2xl font-bold">{stats.todayTotal}</div>
            <div className="text-xs text-muted-foreground">今日任务</div>
          </GlassCard>
        </div>
      )}

      {/* 任务列表 */}
      <GlassCard glow className="flex-1 flex flex-col">
        <div className="p-4 border-b flex items-center gap-4" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2 flex-1">
            <Search size={16} className="text-muted-foreground" />
            <input
              type="text"
              placeholder="搜索任务 ID、发送者..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 px-3 py-2 rounded-md outline-none transition-colors"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <ListFilter size={16} className="text-muted-foreground" />
            <Select
              value={channelTypeFilter}
              onChange={(e) => { setChannelTypeFilter(e.target.value); setPage(1); }}
              uiSize="sm"
            >
              <option value="">全部通道</option>
              {Object.entries(ChannelTypeDisplayNames).map(([key, name]) => (
                <option key={key} value={key}>{name}</option>
              ))}
            </Select>
            <Select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              uiSize="sm"
            >
              <option value="">全部状态</option>
              {Object.entries(TaskStatusDisplayNames).map(([key, name]) => (
                <option key={key} value={key}>{name}</option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead style={{ background: 'rgba(255,255,255,0.02)' }}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">任务 ID</th>
                <th className="px-4 py-3 text-left text-sm font-medium">通道</th>
                <th className="px-4 py-3 text-left text-sm font-medium">发送者</th>
                <th className="px-4 py-3 text-left text-sm font-medium">意图</th>
                <th className="px-4 py-3 text-left text-sm font-medium">状态</th>
                <th className="px-4 py-3 text-left text-sm font-medium">创建时间</th>
                <th className="px-4 py-3 text-left text-sm font-medium">耗时</th>
                <th className="px-4 py-3 text-right text-sm font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  className="transition-colors cursor-pointer"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => handleViewDetail(task)}
                >
                  <td className="px-4 py-3">
                    <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.2)' }}>
                      {task.id}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {channelIcons[task.channelType]}
                      <span>{ChannelTypeDisplayNames[task.channelType] || task.channelType}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{task.senderDisplayName || task.senderIdentifier}</div>
                    {task.senderDisplayName && (
                      <div className="text-xs text-muted-foreground">{task.senderIdentifier}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="subtle" size="sm">
                      {TaskIntents[task.intent || 'unknown'] || task.intent || '未识别'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={statusColors[task.status] as 'success' | 'warning' | 'danger' | 'info' | 'subtle'} size="sm">
                      {TaskStatusDisplayNames[task.status] || task.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {fmtDate(task.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {task.durationMs ? `${task.durationMs}ms` : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => handleViewDetail(task)}
                        title="查看详情"
                      >
                        <ExternalLink size={12} />
                      </Button>
                      {(task.status === TaskStatus.Failed || task.status === TaskStatus.Cancelled) && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => handleRetry(task)}
                          title="重试"
                        >
                          <RotateCcw size={12} />
                        </Button>
                      )}
                      {(task.status === TaskStatus.Pending || task.status === TaskStatus.Processing) && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => handleCancel(task)}
                          title="取消"
                        >
                          <XCircle size={12} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {tasks.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">
              {search || channelTypeFilter || statusFilter
                ? '未找到匹配的任务'
                : '暂无任务'}
            </div>
          )}
        </div>

        {total > pageSize && (
          <div
            className="p-4 border-t flex justify-between items-center"
            style={{ borderColor: 'rgba(255,255,255,0.06)' }}
          >
            <div className="text-sm text-muted-foreground">
              共 {total} 条，第 {page} / {Math.ceil(total / pageSize)} 页
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                上一页
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= Math.ceil(total / pageSize)}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </GlassCard>

      <TaskDetailDrawer
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedTask(null); }}
        task={selectedTask}
        onRetry={handleRetry}
        onCancel={handleCancel}
      />
    </div>
  );
}
