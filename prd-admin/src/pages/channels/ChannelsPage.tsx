import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { Switch } from '@/components/design/Switch';
import { channelService } from '@/services';
import {
  Plus,
  Trash2,
  RefreshCw,
  MoreVertical,
  Mail,
  MessageSquare,
  Mic,
  Webhook,
  Pencil,
  Search,
  ListFilter,
} from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import type {
  ChannelWhitelist,
  ChannelStats,
  CreateWhitelistRequest,
  UpdateWhitelistRequest,
} from '@/services/contracts/channels';
import {
  ChannelTypes,
  ChannelTypeDisplayNames,
} from '@/services/contracts/channels';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { WhitelistEditDialog } from './components/WhitelistEditDialog';
import { useNavigate } from 'react-router-dom';

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

const channelIcons: Record<string, React.ReactNode> = {
  email: <Mail size={20} />,
  sms: <MessageSquare size={20} />,
  siri: <Mic size={20} />,
  webhook: <Webhook size={20} />,
};

export default function ChannelsPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<ChannelStats[]>([]);
  const [whitelists, setWhitelists] = useState<ChannelWhitelist[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [channelTypeFilter, setChannelTypeFilter] = useState<string>('');

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingWhitelist, setEditingWhitelist] = useState<ChannelWhitelist | null>(null);

  const loadStats = async () => {
    try {
      const data = await channelService.getStats();
      setStats(data);
    } catch (err) {
      console.error('Load stats failed:', err);
    }
  };

  const loadWhitelists = async () => {
    setLoading(true);
    try {
      const res = await channelService.getWhitelists(
        page,
        pageSize,
        channelTypeFilter || undefined,
        search || undefined
      );
      setWhitelists(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    loadWhitelists();
  }, [page, search, channelTypeFilter]);

  const handleCreate = async (request: CreateWhitelistRequest) => {
    try {
      await channelService.createWhitelist(request);
      toast.success('创建成功');
      setCreateDialogOpen(false);
      loadWhitelists();
      loadStats();
    } catch (err) {
      toast.error('创建失败', String(err));
    }
  };

  const handleEdit = (whitelist: ChannelWhitelist) => {
    setEditingWhitelist(whitelist);
    setEditDialogOpen(true);
  };

  const handleUpdate = async (request: UpdateWhitelistRequest) => {
    if (!editingWhitelist) return;
    try {
      await channelService.updateWhitelist(editingWhitelist.id, request);
      toast.success('更新成功');
      setEditDialogOpen(false);
      setEditingWhitelist(null);
      loadWhitelists();
    } catch (err) {
      toast.error('更新失败', String(err));
    }
  };

  const handleDelete = async (id: string, pattern: string) => {
    const confirmed = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除白名单规则"${pattern}"吗？此操作不可恢复。`,
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await channelService.deleteWhitelist(id);
      toast.success('删除成功');
      loadWhitelists();
      loadStats();
    } catch (err) {
      toast.error('删除失败', String(err));
    }
  };

  const handleToggleStatus = async (id: string) => {
    try {
      await channelService.toggleWhitelist(id);
      toast.success('状态已切换');
      loadWhitelists();
    } catch (err) {
      toast.error('操作失败', String(err));
    }
  };

  const handleViewTasks = (channelType?: string) => {
    const path = channelType ? `/open-platform/channels/tasks?channelType=${channelType}` : '/open-platform/channels/tasks';
    navigate(path);
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5">
      <TabBar
        title="通道管理"
        icon={<Mail size={16} />}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => handleViewTasks()}>
              任务监控
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate('/open-platform/channels/identity-mappings')}>
              身份映射
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCreateDialogOpen(true)}>
              <Plus size={14} />
              新建白名单
            </Button>
          </>
        }
      />

      {/* 通道状态卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <GlassCard key={stat.channelType} className="p-4">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center"
                style={{
                  background: stat.isEnabled
                    ? 'linear-gradient(135deg, rgba(34,197,94,0.2), rgba(34,197,94,0.1))'
                    : 'rgba(255,255,255,0.05)',
                  color: stat.isEnabled ? 'rgb(34,197,94)' : 'var(--text-muted)',
                }}
              >
                {channelIcons[stat.channelType] || <Webhook size={20} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{stat.displayName}</span>
                  <Badge variant={stat.isEnabled ? 'success' : 'subtle'} size="sm">
                    {stat.isEnabled ? '已启用' : '未配置'}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {stat.whitelistCount} 条规则 · 今日 {stat.taskStats.todayTotal} 任务
                </div>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t flex justify-between text-xs" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              <span className="text-muted-foreground">
                待处理: <span className="text-foreground">{stat.taskStats.pending}</span>
              </span>
              <span className="text-muted-foreground">
                处理中: <span className="text-foreground">{stat.taskStats.processing}</span>
              </span>
              <button
                className="text-primary hover:underline"
                onClick={() => handleViewTasks(stat.channelType)}
              >
                查看任务 →
              </button>
            </div>
          </GlassCard>
        ))}
      </div>

      {/* 白名单列表 */}
      <GlassCard glow className="flex-1 flex flex-col">
        <div className="p-4 border-b flex items-center gap-4" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2 flex-1">
            <Search size={16} className="text-muted-foreground" />
            <input
              type="text"
              placeholder="搜索规则模式或备注..."
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
              onChange={(e) => setChannelTypeFilter(e.target.value)}
              uiSize="sm"
            >
              <option value="">全部通道</option>
              {Object.entries(ChannelTypeDisplayNames).map(([key, name]) => (
                <option key={key} value={key}>{name}</option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" size="sm" onClick={() => { loadWhitelists(); loadStats(); }}>
            <RefreshCw size={14} />
            刷新
          </Button>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead style={{ background: 'rgba(255,255,255,0.02)' }}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">规则模式</th>
                <th className="px-4 py-3 text-left text-sm font-medium">通道</th>
                <th className="px-4 py-3 text-left text-sm font-medium">绑定用户</th>
                <th className="px-4 py-3 text-left text-sm font-medium">允许的 Agent</th>
                <th className="px-4 py-3 text-left text-sm font-medium">配额</th>
                <th className="px-4 py-3 text-left text-sm font-medium">状态</th>
                <th className="px-4 py-3 text-right text-sm font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {whitelists.map((wl) => (
                <tr
                  key={wl.id}
                  className="transition-colors"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td className="px-4 py-3">
                    <div className="font-mono text-sm">{wl.identifierPattern}</div>
                    {wl.displayName && (
                      <div className="text-xs text-muted-foreground mt-1">{wl.displayName}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {channelIcons[wl.channelType]}
                      <span>{ChannelTypeDisplayNames[wl.channelType] || wl.channelType}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {wl.boundUserName ? (
                      <div className="flex items-center gap-2">
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
                          style={{ background: 'var(--gold-gradient)', color: '#1a1206' }}
                        >
                          {wl.boundUserName.charAt(0).toUpperCase()}
                        </div>
                        <span>{wl.boundUserName}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">未绑定</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {wl.allowedAgents.length > 0 ? (
                        wl.allowedAgents.map((agent) => (
                          <Badge key={agent} variant="subtle" size="sm">
                            {agent}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-sm">全部</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm">
                      <span className={wl.todayUsedCount >= wl.dailyQuota ? 'text-red-400' : ''}>
                        {wl.todayUsedCount}
                      </span>
                      <span className="text-muted-foreground"> / {wl.dailyQuota}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={wl.isActive}
                      onCheckedChange={() => handleToggleStatus(wl.id)}
                      ariaLabel={wl.isActive ? '禁用规则' : '启用规则'}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end items-center gap-2">
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <Button variant="ghost" size="sm" title="更多操作">
                            <MoreVertical size={14} />
                          </Button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            align="end"
                            sideOffset={8}
                            className="z-50 rounded-[14px] p-2 min-w-[160px]"
                            style={{
                              background:
                                'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
                              border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
                              boxShadow:
                                '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
                              backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
                              WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
                            }}
                          >
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-2 text-sm rounded-[10px] cursor-pointer outline-none transition-colors"
                              style={{ color: 'var(--text-primary)' }}
                              onSelect={() => handleEdit(wl)}
                            >
                              <Pencil size={14} />
                              <span>编辑规则</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator
                              className="my-1 h-px"
                              style={{ background: 'rgba(255,255,255,0.10)' }}
                            />
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-2 text-sm rounded-[10px] cursor-pointer outline-none transition-colors"
                              style={{ color: 'rgba(239,68,68,0.95)' }}
                              onSelect={() => handleDelete(wl.id, wl.identifierPattern)}
                            >
                              <Trash2 size={14} />
                              <span>删除规则</span>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {whitelists.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">
              {search || channelTypeFilter
                ? '未找到匹配的白名单规则'
                : '暂无白名单规则，点击右上角"新建白名单"开始配置'}
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

      <WhitelistEditDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onSubmit={handleCreate}
        mode="create"
      />

      <WhitelistEditDialog
        open={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
          setEditingWhitelist(null);
        }}
        onSubmit={handleUpdate}
        mode="edit"
        whitelist={editingWhitelist}
      />
    </div>
  );
}
