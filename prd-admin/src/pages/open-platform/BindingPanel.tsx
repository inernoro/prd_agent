import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { channelService, getUsers } from '@/services';
import {
  Plus,
  Trash2,
  RefreshCw,
  MoreVertical,
  Pencil,
  Mail,
  ExternalLink,
  UserCheck,
  Users,
} from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import type {
  ChannelIdentityMapping,
  CreateIdentityMappingRequest,
  UpdateIdentityMappingRequest,
} from '@/services/contracts/channels';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

interface BindingPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

export default function BindingPanel({ onActionsReady }: BindingPanelProps) {
  const [mappings, setMappings] = useState<ChannelIdentityMapping[]>([]);
  const [loading, setLoading] = useState(false);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ChannelIdentityMapping | null>(null);

  const loadMappings = async () => {
    setLoading(true);
    try {
      const res = await channelService.getIdentityMappings(1, 100, 'email');
      setMappings(res.items || []);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMappings();
  }, []);

  useEffect(() => {
    onActionsReady?.(
      <Button variant="secondary" size="sm" onClick={loadMappings}>
        <RefreshCw size={14} />
      </Button>
    );
  }, [onActionsReady]);

  const handleCreate = async (request: CreateIdentityMappingRequest) => {
    try {
      await channelService.createIdentityMapping(request);
      toast.success('添加成功');
      setCreateDialogOpen(false);
      loadMappings();
    } catch (err) {
      toast.error('添加失败', String(err));
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
      message: `确定要移除授权发件人"${identifier}"吗？`,
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
    <div className="h-full overflow-auto p-1">
      <GlassCard glow className="min-h-full">
        {/* 顶部提示栏 */}
        <div className="p-4 border-b border-white/10" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Users size={18} className="text-muted-foreground" />
              <span>管理可以向系统发送邮件的外部邮箱地址</span>
            </div>
            <a href="#" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
              了解更多 <ExternalLink size={12} />
            </a>
          </div>
        </div>

        <div className="p-5">
          {/* 授权发件人 */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium">授权发件人</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  只有这些邮箱地址发送的邮件才会被系统处理
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setCreateDialogOpen(true)} className="whitespace-nowrap">
                <Plus size={14} />
                添加
              </Button>
            </div>

            {/* 发件人列表 */}
            <div className="space-y-2">
              {mappings.length === 0 && !loading ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Mail size={32} className="mx-auto mb-3 opacity-50" />
                  <p>暂无授权发件人</p>
                  <p className="text-xs mt-1">添加后，这些邮箱发送的邮件将被系统处理</p>
                </div>
              ) : (
                mappings.map((mapping) => (
                  <div
                    key={mapping.id}
                    className="flex items-center justify-between p-4 rounded-lg transition-colors hover:bg-white/[0.03]"
                    style={{ border: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center"
                        style={{ background: 'rgba(59,130,246,0.1)' }}
                      >
                        <Mail size={16} className="text-blue-400" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-sm">{mapping.channelIdentifier}</code>
                          {mapping.isVerified && (
                            <Badge variant="success" size="sm">
                              <UserCheck size={10} className="mr-1" />
                              已验证
                            </Badge>
                          )}
                        </div>
                        {mapping.userName && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            → 映射到用户: {mapping.userName}
                          </div>
                        )}
                      </div>
                    </div>
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
                            onSelect={() => {
                              setEditingMapping(mapping);
                              setEditDialogOpen(true);
                            }}
                          >
                            <Pencil size={14} /> 编辑
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="my-1 h-px bg-white/10" />
                          <DropdownMenu.Item
                            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/10 text-red-400"
                            onSelect={() => handleDelete(mapping.id, mapping.channelIdentifier)}
                          >
                            <Trash2 size={14} /> 删除
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </GlassCard>

      {/* 创建对话框 */}
      <IdentityMappingDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onSubmit={(req) => handleCreate(req as CreateIdentityMappingRequest)}
        mode="create"
      />

      {/* 编辑对话框 */}
      <IdentityMappingDialog
        open={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
          setEditingMapping(null);
        }}
        onSubmit={(req) => handleUpdate(req as UpdateIdentityMappingRequest)}
        mode="edit"
        mapping={editingMapping}
      />
    </div>
  );
}

// ============ 授权发件人编辑弹窗 ============
function IdentityMappingDialog({
  open,
  onClose,
  onSubmit,
  mode,
  mapping,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (req: CreateIdentityMappingRequest | UpdateIdentityMappingRequest) => void;
  mode: 'create' | 'edit';
  mapping?: ChannelIdentityMapping | null;
}) {
  const [channelIdentifier, setChannelIdentifier] = useState('');
  const [userId, setUserId] = useState('');
  const [isVerified, setIsVerified] = useState(false);
  const [users, setUsers] = useState<Array<{ userId: string; username: string; displayName: string }>>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    if (open) {
      loadUsers();
      if (mode === 'edit' && mapping) {
        setChannelIdentifier(mapping.channelIdentifier);
        setUserId(mapping.userId);
        setIsVerified(mapping.isVerified);
      } else {
        setChannelIdentifier('');
        setUserId('');
        setIsVerified(true);
      }
    }
  }, [open, mode, mapping]);

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const res = await getUsers({ page: 1, pageSize: 100 });
      setUsers(res.success ? res.data?.items || [] : []);
    } catch {
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  };

  const handleSubmit = () => {
    if (mode === 'create') {
      if (!channelIdentifier.trim()) {
        toast.warning('验证失败', '邮箱地址不能为空');
        return;
      }
      if (!channelIdentifier.includes('@')) {
        toast.warning('验证失败', '请输入有效的邮箱地址');
        return;
      }
      if (!userId) {
        toast.warning('验证失败', '必须选择映射用户');
        return;
      }
      onSubmit({
        channelType: 'email',
        channelIdentifier: channelIdentifier.trim().toLowerCase(),
        userId,
        isVerified,
      });
    } else {
      onSubmit({ userId, isVerified });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={mode === 'create' ? '添加授权发件人' : '编辑授权发件人'}
      maxWidth={450}
      content={
        <div className="space-y-4">
          {mode === 'create' && (
            <div>
              <label className="block text-sm font-medium mb-1.5">邮箱地址 *</label>
              <input
                type="email"
                value={channelIdentifier}
                onChange={(e) => setChannelIdentifier(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                placeholder="user@example.com"
              />
              <p className="text-xs text-muted-foreground mt-1">
                此邮箱发送的邮件将被系统处理
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1.5">映射用户 *</label>
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
            <p className="text-xs text-muted-foreground mt-1">
              该邮箱的操作将关联到此系统用户
            </p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={isVerified}
                onChange={(e) => setIsVerified(e.target.checked)}
                className="rounded"
              />
              标记为已验证
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t border-white/10">
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button onClick={handleSubmit}>
              {mode === 'create' ? '添加' : '保存'}
            </Button>
          </div>
        </div>
      }
    />
  );
}
