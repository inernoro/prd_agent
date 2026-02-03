import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { Switch } from '@/components/design/Switch';
import { channelService } from '@/services';
import { Plus, Trash2, RefreshCw, MoreVertical, Mail, MessageSquare, Mic, Webhook, Pencil, Search } from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import type { ChannelWhitelist, ChannelStatsResponse, CreateWhitelistRequest, UpdateWhitelistRequest } from '@/services/contracts/channels';
import { ChannelTypeDisplayNames } from '@/services/contracts/channels';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { WhitelistEditDialog } from '../channels/components/WhitelistEditDialog';

interface ChannelsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

const channelIcons: Record<string, React.ReactNode> = {
  email: <Mail size={18} />,
  sms: <MessageSquare size={18} />,
  siri: <Mic size={18} />,
  webhook: <Webhook size={18} />,
};

export default function ChannelsPanel({ onActionsReady }: ChannelsPanelProps) {
  const [statsResponse, setStatsResponse] = useState<ChannelStatsResponse | null>(null);
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
      setStatsResponse(data);
    } catch (err) {
      console.error('Load stats failed:', err);
    }
  };

  const loadWhitelists = async () => {
    setLoading(true);
    try {
      const res = await channelService.getWhitelists(page, pageSize, channelTypeFilter || undefined, search || undefined);
      setWhitelists(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStats(); }, []);
  useEffect(() => { loadWhitelists(); }, [page, search, channelTypeFilter]);

  // 传递 actions 给父容器
  useEffect(() => {
    onActionsReady?.(
      <>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜索白名单..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-9 pr-3 text-sm rounded-lg outline-none"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', width: '180px' }}
          />
        </div>
        <Select value={channelTypeFilter} onChange={(e) => setChannelTypeFilter(e.target.value)} uiSize="sm">
          <option value="">全部通道</option>
          {Object.entries(ChannelTypeDisplayNames).map(([key, name]) => (
            <option key={key} value={key}>{name}</option>
          ))}
        </Select>
        <Button variant="secondary" size="sm" onClick={() => { loadWhitelists(); loadStats(); }}>
          <RefreshCw size={14} />
        </Button>
        <Button variant="primary" size="sm" className="whitespace-nowrap" onClick={() => setCreateDialogOpen(true)}>
          <Plus size={14} /> 新建
        </Button>
      </>
    );
  }, [search, channelTypeFilter, onActionsReady]);

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
      message: `确定要删除白名单规则"${pattern}"吗？`,
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

  return (
    <div className="h-full flex flex-col gap-4">
      {/* 通道状态卡片 */}
      <div className="grid grid-cols-4 gap-3">
        {(statsResponse?.channels || []).map((stat) => (
          <GlassCard key={stat.channelType} className="p-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{
                background: stat.isEnabled ? 'linear-gradient(135deg, rgba(34,197,94,0.2), rgba(34,197,94,0.1))' : 'rgba(255,255,255,0.05)',
                color: stat.isEnabled ? 'rgb(34,197,94)' : 'var(--text-muted)',
              }}>
                {channelIcons[stat.channelType] || <Webhook size={18} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{stat.displayName}</span>
                  <Badge variant={stat.isEnabled ? 'success' : 'subtle'} size="sm">
                    {stat.isEnabled ? '启用' : '未配置'}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  今日 {stat.todayRequestCount} 请求 · {stat.todaySuccessCount} 成功
                </div>
              </div>
            </div>
          </GlassCard>
        ))}
      </div>

      {/* 白名单列表 */}
      <GlassCard glow className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0" style={{ background: 'rgba(0,0,0,0.4)' }}>
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
                <tr key={wl.id} className="transition-colors hover:bg-white/[0.02]" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-sm">{wl.identifierPattern}</div>
                    {wl.displayName && <div className="text-xs text-muted-foreground mt-0.5">{wl.displayName}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {channelIcons[wl.channelType]}
                      <span className="text-sm">{ChannelTypeDisplayNames[wl.channelType] || wl.channelType}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {wl.boundUserName ? (
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: 'var(--gold-gradient)', color: '#1a1206' }}>
                          {wl.boundUserName.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm">{wl.boundUserName}</span>
                      </div>
                    ) : <span className="text-muted-foreground text-sm">未绑定</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {wl.allowedAgents.length > 0 ? (
                        wl.allowedAgents.map((agent) => <Badge key={agent} variant="subtle" size="sm">{agent}</Badge>)
                      ) : <span className="text-muted-foreground text-sm">全部</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm">
                      <span className={wl.todayUsedCount >= wl.dailyQuota ? 'text-red-400' : ''}>{wl.todayUsedCount}</span>
                      <span className="text-muted-foreground"> / {wl.dailyQuota}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Switch checked={wl.isActive} onCheckedChange={() => handleToggleStatus(wl.id)} ariaLabel={wl.isActive ? '禁用' : '启用'} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <Button variant="ghost" size="sm"><MoreVertical size={14} /></Button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content align="end" sideOffset={8} className="z-50 rounded-xl p-2 min-w-[140px]" style={{
                            background: 'linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
                            border: '1px solid rgba(255,255,255,0.15)',
                            boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
                            backdropFilter: 'blur(40px)',
                          }}>
                            <DropdownMenu.Item className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/10" onSelect={() => { setEditingWhitelist(wl); setEditDialogOpen(true); }}>
                              <Pencil size={14} /> 编辑
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator className="my-1 h-px bg-white/10" />
                            <DropdownMenu.Item className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/10 text-red-400" onSelect={() => handleDelete(wl.id, wl.identifierPattern)}>
                              <Trash2 size={14} /> 删除
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
              {search || channelTypeFilter ? '未找到匹配的白名单规则' : '暂无白名单规则'}
            </div>
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

      <WhitelistEditDialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} onSubmit={(req) => handleCreate(req as CreateWhitelistRequest)} mode="create" />
      <WhitelistEditDialog open={editDialogOpen} onClose={() => { setEditDialogOpen(false); setEditingWhitelist(null); }} onSubmit={(req) => handleUpdate(req as UpdateWhitelistRequest)} mode="edit" whitelist={editingWhitelist} />
    </div>
  );
}
