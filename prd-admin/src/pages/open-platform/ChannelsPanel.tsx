import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { Switch } from '@/components/design/Switch';
import { channelService } from '@/services';
import { Plus, Trash2, RefreshCw, MoreVertical, Mail, MessageSquare, Mic, Webhook, Pencil, Search, Shield, ExternalLink } from 'lucide-react';
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

  useEffect(() => {
    onActionsReady?.(
      <Button variant="secondary" size="sm" onClick={() => { loadWhitelists(); loadStats(); }}>
        <RefreshCw size={14} />
      </Button>
    );
  }, [onActionsReady]);

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
    <div className="h-full overflow-auto p-1">
      <GlassCard glow className="min-h-full">
        {/* 顶部提示栏 */}
        <div className="p-4 border-b border-white/10" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Shield size={18} className="text-muted-foreground" />
              <span>配置通道白名单，只有白名单内的标识才能访问系统</span>
            </div>
            <a href="#" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
              了解更多 <ExternalLink size={12} />
            </a>
          </div>
        </div>

        <div className="p-5 space-y-5">
          {/* 通道状态卡片 */}
          {statsResponse?.channels && statsResponse.channels.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium">通道状态</h3>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {statsResponse.channels.map((stat) => (
                  <div
                    key={stat.channelType}
                    className="p-3 rounded-lg transition-colors"
                    style={{
                      background: stat.isEnabled ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.02)',
                      border: stat.isEnabled ? '1px solid rgba(34,197,94,0.2)' : '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center"
                        style={{
                          background: stat.isEnabled ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)',
                          color: stat.isEnabled ? 'rgb(34,197,94)' : 'var(--text-muted)',
                        }}
                      >
                        {channelIcons[stat.channelType] || <Webhook size={18} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{stat.displayName}</span>
                          {stat.isEnabled && (
                            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          今日 <span className={stat.todayRequestCount > 0 ? 'text-blue-400' : ''}>{stat.todayRequestCount}</span> 请求 · <span className={stat.todaySuccessCount > 0 ? 'text-green-400' : ''}>{stat.todaySuccessCount}</span> 成功
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="border-t border-white/10" />

          {/* 白名单规则 */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium">白名单规则</h3>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="搜索规则..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-8 pr-3 text-sm rounded-lg outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', width: '160px' }}
                  />
                </div>
                <Select value={channelTypeFilter} onChange={(e) => setChannelTypeFilter(e.target.value)} uiSize="sm">
                  <option value="">全部通道</option>
                  {Object.entries(ChannelTypeDisplayNames).map(([key, name]) => (
                    <option key={key} value={key}>{name}</option>
                  ))}
                </Select>
                <Button variant="secondary" size="sm" onClick={() => setCreateDialogOpen(true)}>
                  <Plus size={14} />
                  添加规则
                </Button>
              </div>
            </div>

            {/* 规则列表 */}
            <div className="space-y-2">
              {whitelists.length === 0 && !loading ? (
                <div className="text-center py-8 text-muted-foreground">
                  {search || channelTypeFilter ? '未找到匹配的规则' : '暂无白名单规则，点击上方按钮添加'}
                </div>
              ) : (
                whitelists.map((wl) => (
                  <div
                    key={wl.id}
                    className="flex items-center justify-between p-4 rounded-lg transition-colors hover:bg-white/[0.03]"
                    style={{ border: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ background: 'rgba(255,255,255,0.05)' }}
                      >
                        {channelIcons[wl.channelType] || <Webhook size={16} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-sm">{wl.identifierPattern}</code>
                          {wl.displayName && (
                            <span className="text-xs text-muted-foreground">({wl.displayName})</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>{ChannelTypeDisplayNames[wl.channelType]}</span>
                          {wl.boundUserName && (
                            <span>→ {wl.boundUserName}</span>
                          )}
                          <span>
                            配额: <span className={wl.todayUsedCount >= wl.dailyQuota ? 'text-red-400' : 'text-blue-400'}>{wl.todayUsedCount}</span>/{wl.dailyQuota}
                          </span>
                        </div>
                      </div>
                      {wl.allowedAgents.length > 0 && (
                        <div className="flex flex-wrap gap-1 flex-shrink-0">
                          {wl.allowedAgents.slice(0, 2).map((agent) => (
                            <Badge key={agent} variant="subtle" size="sm">{agent}</Badge>
                          ))}
                          {wl.allowedAgents.length > 2 && (
                            <Badge variant="subtle" size="sm">+{wl.allowedAgents.length - 2}</Badge>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3 ml-4">
                      <Switch
                        checked={wl.isActive}
                        onCheckedChange={() => handleToggleStatus(wl.id)}
                        ariaLabel={wl.isActive ? '禁用' : '启用'}
                      />
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button className="p-1.5 rounded hover:bg-white/10 transition-colors text-muted-foreground hover:text-foreground">
                            <MoreVertical size={16} />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            align="end"
                            sideOffset={8}
                            className="z-50 rounded-xl p-2 min-w-[140px]"
                            style={{
                              background: 'linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
                              border: '1px solid rgba(255,255,255,0.15)',
                              boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
                              backdropFilter: 'blur(40px)',
                            }}
                          >
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/10"
                              onSelect={() => { setEditingWhitelist(wl); setEditDialogOpen(true); }}
                            >
                              <Pencil size={14} /> 编辑
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator className="my-1 h-px bg-white/10" />
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/10 text-red-400"
                              onSelect={() => handleDelete(wl.id, wl.identifierPattern)}
                            >
                              <Trash2 size={14} /> 删除
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
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

      <WhitelistEditDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onSubmit={(req) => handleCreate(req as CreateWhitelistRequest)}
        mode="create"
      />
      <WhitelistEditDialog
        open={editDialogOpen}
        onClose={() => { setEditDialogOpen(false); setEditingWhitelist(null); }}
        onSubmit={(req) => handleUpdate(req as UpdateWhitelistRequest)}
        mode="edit"
        whitelist={editingWhitelist}
      />
    </div>
  );
}
