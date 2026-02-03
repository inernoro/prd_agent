import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { channelService } from '@/services';
import { RefreshCw, Search, Clock, CheckCircle, XCircle, Loader2 } from 'lucide-react';
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

  // 传递 actions 给父容器
  useEffect(() => {
    onActionsReady?.(
      <>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜索任务..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-9 pr-3 text-sm rounded-lg outline-none"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', width: '160px' }}
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
        <Button variant="secondary" size="sm" onClick={() => { loadTasks(); loadStats(); }}>
          <RefreshCw size={14} />
        </Button>
      </>
    );
  }, [search, channelTypeFilter, statusFilter, onActionsReady]);

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
    <div className="h-full flex flex-col gap-4">
      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-5 gap-3">
          <GlassCard className="p-3 text-center">
            <div className="text-2xl font-bold">{stats.todayTotal}</div>
            <div className="text-xs text-muted-foreground">今日任务</div>
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
        </div>
      )}

      {/* 任务列表 */}
      <GlassCard glow className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0" style={{ background: 'rgba(0,0,0,0.4)' }}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">任务 ID</th>
                <th className="px-4 py-3 text-left text-sm font-medium">通道</th>
                <th className="px-4 py-3 text-left text-sm font-medium">发送者</th>
                <th className="px-4 py-3 text-left text-sm font-medium">意图</th>
                <th className="px-4 py-3 text-left text-sm font-medium">状态</th>
                <th className="px-4 py-3 text-left text-sm font-medium">创建时间</th>
                <th className="px-4 py-3 text-right text-sm font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  className="transition-colors hover:bg-white/[0.02] cursor-pointer"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                  onClick={() => openDetail(task)}
                >
                  <td className="px-4 py-3">
                    <code className="text-xs bg-muted px-2 py-1 rounded">{task.id.slice(-12)}</code>
                  </td>
                  <td className="px-4 py-3 text-sm">{ChannelTypeDisplayNames[task.channelType] || task.channelType}</td>
                  <td className="px-4 py-3">
                    <div className="text-sm">{task.senderDisplayName || task.senderIdentifier}</div>
                    {task.mappedUserName && <div className="text-xs text-muted-foreground">→ {task.mappedUserName}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="subtle" size="sm">{task.intent || '未识别'}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {statusIcons[task.status]}
                      <span className="text-sm">{TaskStatusDisplayNames[task.status] || task.status}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{fmtDate(task.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      {task.status === 'failed' && (
                        <Button variant="secondary" size="xs" onClick={() => handleRetry(task.id)}>重试</Button>
                      )}
                      {(task.status === 'pending' || task.status === 'processing') && (
                        <Button variant="secondary" size="xs" onClick={() => handleCancel(task.id)}>取消</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {tasks.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">暂无任务记录</div>
          )}
        </div>

        {total > pageSize && (
          <div className="p-4 border-t flex justify-between items-center" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <div className="text-sm text-muted-foreground">共 {total} 条</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button>
              <Button variant="secondary" size="sm" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(page + 1)}>下一页</Button>
            </div>
          </div>
        )}
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
