import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { channelService, getUsers } from '@/services';
import { Plus, Trash2, RefreshCw, MoreVertical, Pencil, Search, Mail, MessageSquare, Mic, Webhook, UserCheck } from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import type { ChannelIdentityMapping, CreateIdentityMappingRequest, UpdateIdentityMappingRequest } from '@/services/contracts/channels';
import { ChannelTypeDisplayNames } from '@/services/contracts/channels';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

interface IdentityPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

const channelIcons: Record<string, React.ReactNode> = {
  email: <Mail size={14} />,
  sms: <MessageSquare size={14} />,
  siri: <Mic size={14} />,
  webhook: <Webhook size={14} />,
};

export default function IdentityPanel({ onActionsReady }: IdentityPanelProps) {
  const [mappings, setMappings] = useState<ChannelIdentityMapping[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [channelTypeFilter, setChannelTypeFilter] = useState('');

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ChannelIdentityMapping | null>(null);

  const loadMappings = async () => {
    setLoading(true);
    try {
      const res = await channelService.getIdentityMappings(page, pageSize, channelTypeFilter || undefined, search || undefined);
      setMappings(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMappings(); }, [page, search, channelTypeFilter]);

  // 传递 actions 给父容器
  useEffect(() => {
    onActionsReady?.(
      <>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜索身份..."
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
        <Button variant="secondary" size="sm" onClick={loadMappings}>
          <RefreshCw size={14} />
        </Button>
        <Button variant="primary" size="sm" onClick={() => setCreateDialogOpen(true)}>
          <Plus size={14} /> 新建
        </Button>
      </>
    );
  }, [search, channelTypeFilter, onActionsReady]);

  const handleCreate = async (request: CreateIdentityMappingRequest) => {
    try {
      await channelService.createIdentityMapping(request);
      toast.success('创建成功');
      setCreateDialogOpen(false);
      loadMappings();
    } catch (err) {
      toast.error('创建失败', String(err));
    }
  };

  const handleUpdate = async (request: UpdateIdentityMappingRequest) => {
    if (!editingMapping) return;
    try {
      await channelService.updateIdentityMapping(editingMapping.id, request);
      toast.success('更新成功');
      setEditDialogOpen(false);
      setEditingMapping(null);
      loadMappings();
    } catch (err) {
      toast.error('更新失败', String(err));
    }
  };

  const handleDelete = async (id: string, identifier: string) => {
    const confirmed = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除身份映射"${identifier}"吗？`,
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await channelService.deleteIdentityMapping(id);
      toast.success('删除成功');
      loadMappings();
    } catch (err) {
      toast.error('删除失败', String(err));
    }
  };

  return (
    <div className="h-full flex flex-col gap-4">
      <GlassCard glow className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0" style={{ background: 'rgba(0,0,0,0.4)' }}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">通道标识</th>
                <th className="px-4 py-3 text-left text-sm font-medium">通道类型</th>
                <th className="px-4 py-3 text-left text-sm font-medium">映射用户</th>
                <th className="px-4 py-3 text-left text-sm font-medium">验证状态</th>
                <th className="px-4 py-3 text-left text-sm font-medium">创建时间</th>
                <th className="px-4 py-3 text-right text-sm font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping) => (
                <tr key={mapping.id} className="transition-colors hover:bg-white/[0.02]" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-sm">{mapping.channelIdentifier}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {channelIcons[mapping.channelType]}
                      <span className="text-sm">{ChannelTypeDisplayNames[mapping.channelType] || mapping.channelType}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: 'var(--gold-gradient)', color: '#1a1206' }}>
                        {(mapping.userName || '?').charAt(0).toUpperCase()}
                      </div>
                      <span className="text-sm">{mapping.userName || mapping.userId}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={mapping.isVerified ? 'success' : 'subtle'} size="sm">
                      <UserCheck size={12} className="mr-1" />
                      {mapping.isVerified ? '已验证' : '未验证'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{fmtDate(mapping.createdAt)}</td>
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
                            <DropdownMenu.Item className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/10" onSelect={() => { setEditingMapping(mapping); setEditDialogOpen(true); }}>
                              <Pencil size={14} /> 编辑
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator className="my-1 h-px bg-white/10" />
                            <DropdownMenu.Item className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/10 text-red-400" onSelect={() => handleDelete(mapping.id, mapping.channelIdentifier)}>
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

          {mappings.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">
              {search || channelTypeFilter ? '未找到匹配的身份映射' : '暂无身份映射'}
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

      <IdentityMappingDialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} onSubmit={(req) => handleCreate(req as CreateIdentityMappingRequest)} mode="create" />
      <IdentityMappingDialog open={editDialogOpen} onClose={() => { setEditDialogOpen(false); setEditingMapping(null); }} onSubmit={(req) => handleUpdate(req as UpdateIdentityMappingRequest)} mode="edit" mapping={editingMapping} />
    </div>
  );
}

// ============ 身份映射编辑弹窗 ============
function IdentityMappingDialog({ open, onClose, onSubmit, mode, mapping }: {
  open: boolean;
  onClose: () => void;
  onSubmit: (req: CreateIdentityMappingRequest | UpdateIdentityMappingRequest) => void;
  mode: 'create' | 'edit';
  mapping?: ChannelIdentityMapping | null;
}) {
  const [channelType, setChannelType] = useState('email');
  const [channelIdentifier, setChannelIdentifier] = useState('');
  const [userId, setUserId] = useState('');
  const [isVerified, setIsVerified] = useState(false);
  const [users, setUsers] = useState<Array<{ userId: string; username: string; displayName: string }>>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    if (open) {
      loadUsers();
      if (mode === 'edit' && mapping) {
        setChannelType(mapping.channelType);
        setChannelIdentifier(mapping.channelIdentifier);
        setUserId(mapping.userId);
        setIsVerified(mapping.isVerified);
      } else {
        setChannelType('email');
        setChannelIdentifier('');
        setUserId('');
        setIsVerified(false);
      }
    }
  }, [open, mode, mapping]);

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const res = await getUsers({ page: 1, pageSize: 100 });
      setUsers(res.success ? res.data?.items || [] : []);
    } catch { setUsers([]); }
    finally { setLoadingUsers(false); }
  };

  const handleSubmit = () => {
    if (mode === 'create') {
      if (!channelIdentifier.trim()) { toast.warning('验证失败', '通道标识不能为空'); return; }
      if (!userId) { toast.warning('验证失败', '必须选择用户'); return; }
      onSubmit({ channelType, channelIdentifier: channelIdentifier.trim(), userId, isVerified });
    } else {
      onSubmit({ userId, isVerified });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()} title={mode === 'create' ? '新建身份映射' : '编辑身份映射'} maxWidth={500}
      content={
        <div className="space-y-4">
          {mode === 'create' && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">通道类型 *</label>
                <Select value={channelType} onChange={(e) => setChannelType(e.target.value)} uiSize="md">
                  {Object.entries(ChannelTypeDisplayNames).map(([key, name]) => (
                    <option key={key} value={key}>{name}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">通道标识 *</label>
                <input type="text" value={channelIdentifier} onChange={(e) => setChannelIdentifier(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-md" placeholder="如：user@example.com" />
              </div>
            </>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">映射用户 *</label>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)} disabled={loadingUsers} uiSize="md">
              <option value="">{loadingUsers ? '加载中...' : '请选择用户'}</option>
              {users.map((u) => <option key={u.userId} value={u.userId}>{u.displayName} (@{u.username})</option>)}
            </Select>
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isVerified} onChange={(e) => setIsVerified(e.target.checked)} />
              已验证身份
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button onClick={handleSubmit}>{mode === 'create' ? '创建' : '保存'}</Button>
          </div>
        </div>
      }
    />
  );
}
