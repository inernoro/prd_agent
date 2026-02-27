import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { Switch } from '@/components/design/Switch';
import { channelService, getUsers } from '@/services';
import {
  Plus,
  Trash2,
  RefreshCw,
  MoreVertical,
  Search,
  ListFilter,
  ArrowLeft,
  Pencil,
  UserCheck,
  Mail,
  MessageSquare,
  Mic,
  Webhook,
} from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import type {
  ChannelIdentityMapping,
  CreateIdentityMappingRequest,
  UpdateIdentityMappingRequest,
} from '@/services/contracts/channels';
import { ChannelTypes, ChannelTypeDisplayNames } from '@/services/contracts/channels';
import { glassPanel } from '@/lib/glassStyles';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

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

export default function IdentityMappingsPage() {
  const navigate = useNavigate();
  const [mappings, setMappings] = useState<ChannelIdentityMapping[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [channelTypeFilter, setChannelTypeFilter] = useState<string>('');

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ChannelIdentityMapping | null>(null);

  const loadMappings = async () => {
    setLoading(true);
    try {
      const res = await channelService.getIdentityMappings(
        page,
        pageSize,
        channelTypeFilter || undefined,
        search || undefined
      );
      setMappings(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMappings();
  }, [page, search, channelTypeFilter]);

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

  const handleEdit = (mapping: ChannelIdentityMapping) => {
    setEditingMapping(mapping);
    setEditDialogOpen(true);
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
      message: `确定要删除身份映射"${identifier}"吗？此操作不可恢复。`,
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
    <div className="h-full min-h-0 flex flex-col gap-5">
      <TabBar
        title="身份映射"
        icon={<UserCheck size={16} />}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/open-platform/channels')}>
              <ArrowLeft size={14} />
              返回
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCreateDialogOpen(true)}>
              <Plus size={14} />
              新建映射
            </Button>
          </>
        }
      />

      <GlassCard animated glow className="flex-1 flex flex-col">
        <div className="p-4 border-b flex items-center gap-4" style={{ borderColor: 'var(--nested-block-border)' }}>
          <div className="flex items-center gap-2 flex-1">
            <Search size={16} className="text-muted-foreground" />
            <input
              type="text"
              placeholder="搜索标识或用户名..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 px-3 py-2 rounded-md outline-none transition-colors"
              style={{
                background: 'var(--nested-block-bg)',
                border: '1px solid var(--border-subtle)',
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
          <Button variant="secondary" size="sm" onClick={loadMappings}>
            <RefreshCw size={14} />
            刷新
          </Button>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead className="surface-inset">
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
                <tr
                  key={mapping.id}
                  className="surface-row transition-colors"
                  style={{ borderTop: '1px solid var(--bg-input)' }}
                >
                  <td className="px-4 py-3">
                    <div className="font-mono text-sm">{mapping.channelIdentifier}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {channelIcons[mapping.channelType]}
                      <span>{ChannelTypeDisplayNames[mapping.channelType] || mapping.channelType}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
                        style={{ background: 'var(--gold-gradient)', color: '#ffffff' }}
                      >
                        {(mapping.userName || mapping.userId).charAt(0).toUpperCase()}
                      </div>
                      <span>{mapping.userName || mapping.userId}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={mapping.isVerified ? 'success' : 'subtle'} size="sm">
                      {mapping.isVerified ? '已验证' : '待验证'}
                    </Badge>
                    {mapping.verifiedAt && (
                      <div className="text-xs text-muted-foreground mt-1">
                        {fmtDate(mapping.verifiedAt)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {fmtDate(mapping.createdAt)}
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
                              ...glassPanel,
                            }}
                          >
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-2 text-sm rounded-[10px] cursor-pointer outline-none transition-colors"
                              style={{ color: 'var(--text-primary)' }}
                              onSelect={() => handleEdit(mapping)}
                            >
                              <Pencil size={14} />
                              <span>编辑映射</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator
                              className="my-1 h-px"
                              style={{ background: 'var(--border-default)' }}
                            />
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-2 text-sm rounded-[10px] cursor-pointer outline-none transition-colors"
                              style={{ color: 'rgba(239,68,68,0.95)' }}
                              onSelect={() => handleDelete(mapping.id, mapping.channelIdentifier)}
                            >
                              <Trash2 size={14} />
                              <span>删除映射</span>
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
              {search || channelTypeFilter
                ? '未找到匹配的身份映射'
                : '暂无身份映射，点击右上角"新建映射"开始配置'}
            </div>
          )}
        </div>

        {total > pageSize && (
          <div
            className="p-4 border-t flex justify-between items-center"
            style={{ borderColor: 'var(--nested-block-border)' }}
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

      <IdentityMappingDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onSubmit={(req) => handleCreate(req as CreateIdentityMappingRequest)}
        mode="create"
      />

      <IdentityMappingDialog
        open={editDialogOpen}
        onClose={() => { setEditDialogOpen(false); setEditingMapping(null); }}
        onSubmit={(req) => handleUpdate(req as UpdateIdentityMappingRequest)}
        mode="edit"
        mapping={editingMapping}
      />
    </div>
  );
}

interface IdentityMappingDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (request: CreateIdentityMappingRequest | UpdateIdentityMappingRequest) => void;
  mode: 'create' | 'edit';
  mapping?: ChannelIdentityMapping | null;
}

function IdentityMappingDialog({
  open,
  onClose,
  onSubmit,
  mode,
  mapping,
}: IdentityMappingDialogProps) {
  const [channelType, setChannelType] = useState<string>(ChannelTypes.Email);
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
        setChannelType(ChannelTypes.Email);
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
      if (!res.success) {
        toast.error('加载用户失败', res.error?.message || '未知错误');
        setUsers([]);
        return;
      }
      setUsers(res.data?.items || []);
    } catch (err) {
      toast.error('加载用户失败', String(err));
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  };

  const handleSubmit = () => {
    if (mode === 'create') {
      if (!channelIdentifier.trim()) {
        toast.warning('验证失败', '通道标识不能为空');
        return;
      }
      if (!userId) {
        toast.warning('验证失败', '必须选择映射用户');
        return;
      }

      const request: CreateIdentityMappingRequest = {
        channelType,
        channelIdentifier: channelIdentifier.trim(),
        userId,
        isVerified,
      };
      onSubmit(request);
    } else {
      const request: UpdateIdentityMappingRequest = {
        userId: userId || undefined,
        isVerified,
      };
      onSubmit(request);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={mode === 'create' ? '新建身份映射' : '编辑身份映射'}
      maxWidth={500}
      content={
        <div className="space-y-4">
          {/* 通道类型 */}
          <div>
            <label className="block text-sm font-medium mb-1">通道类型 *</label>
            <Select
              value={channelType}
              onChange={(e) => setChannelType(e.target.value)}
              disabled={mode === 'edit'}
              uiSize="md"
            >
              {Object.entries(ChannelTypeDisplayNames).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </Select>
          </div>

          {/* 通道标识 */}
          <div>
            <label className="block text-sm font-medium mb-1">通道标识 *</label>
            <input
              type="text"
              value={channelIdentifier}
              onChange={(e) => setChannelIdentifier(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-md"
              placeholder={
                channelType === ChannelTypes.Email
                  ? '例如：user@example.com'
                  : channelType === ChannelTypes.Sms
                  ? '例如：+8613800138000'
                  : '输入通道内唯一标识'
              }
              disabled={mode === 'edit'}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {channelType === ChannelTypes.Email && '用户的邮箱地址'}
              {channelType === ChannelTypes.Sms && '用户的手机号码'}
              {channelType === ChannelTypes.Siri && 'Siri 设备标识'}
              {channelType === ChannelTypes.Webhook && 'Webhook 客户端标识'}
            </p>
          </div>

          {/* 映射用户 */}
          <div>
            <label className="block text-sm font-medium mb-1">映射用户 *</label>
            <Select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={loadingUsers}
              uiSize="md"
            >
              <option value="">{loadingUsers ? '加载中...' : '请选择用户'}</option>
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.displayName} (@{u.username})
                </option>
              ))}
            </Select>
          </div>

          {/* 验证状态 */}
          <div className="flex items-center justify-between p-3 bg-muted/30 rounded-md">
            <div>
              <div className="text-sm font-medium">已验证</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                标记此映射是否已通过验证
              </p>
            </div>
            <Switch
              checked={isVerified}
              onCheckedChange={setIsVerified}
              ariaLabel="验证状态"
            />
          </div>

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button onClick={handleSubmit}>{mode === 'create' ? '创建' : '保存'}</Button>
          </div>
        </div>
      }
    />
  );
}
