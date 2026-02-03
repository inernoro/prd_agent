import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Select } from '@/components/design/Select';
import { getUsers } from '@/services';
import { toast } from '@/lib/toast';
import type {
  ChannelWhitelist,
  CreateWhitelistRequest,
  UpdateWhitelistRequest,
} from '@/services/contracts/channels';
import { ChannelTypes, ChannelTypeDisplayNames } from '@/services/contracts/channels';

interface WhitelistEditDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (request: CreateWhitelistRequest | UpdateWhitelistRequest) => void;
  mode: 'create' | 'edit';
  whitelist?: ChannelWhitelist | null;
}

const AVAILABLE_AGENTS = [
  { key: 'visual-agent', name: '视觉创作' },
  { key: 'prd-agent', name: 'PRD 助手' },
  { key: 'defect-agent', name: '缺陷管理' },
  { key: 'literary-agent', name: '文学创作' },
];

export function WhitelistEditDialog({
  open,
  onClose,
  onSubmit,
  mode,
  whitelist,
}: WhitelistEditDialogProps) {
  const [channelType, setChannelType] = useState<string>(ChannelTypes.Email);
  const [identifierPattern, setIdentifierPattern] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [boundUserId, setBoundUserId] = useState('');
  const [allowedAgents, setAllowedAgents] = useState<string[]>([]);
  const [dailyQuota, setDailyQuota] = useState(100);
  const [priority, setPriority] = useState(0);

  const [users, setUsers] = useState<Array<{ userId: string; username: string; displayName: string }>>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    if (open) {
      loadUsers();
      if (mode === 'edit' && whitelist) {
        setChannelType(whitelist.channelType);
        setIdentifierPattern(whitelist.identifierPattern);
        setDisplayName(whitelist.displayName || '');
        setDescription(whitelist.description || '');
        setBoundUserId(whitelist.boundUserId || '');
        setAllowedAgents(whitelist.allowedAgents || []);
        setDailyQuota(whitelist.dailyQuota);
        setPriority(whitelist.priority);
      } else {
        // Reset form for create mode
        setChannelType(ChannelTypes.Email);
        setIdentifierPattern('');
        setDisplayName('');
        setDescription('');
        setBoundUserId('');
        setAllowedAgents([]);
        setDailyQuota(100);
        setPriority(0);
      }
    }
  }, [open, mode, whitelist]);

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

  const handleAgentToggle = (agentKey: string) => {
    setAllowedAgents((prev) =>
      prev.includes(agentKey) ? prev.filter((a) => a !== agentKey) : [...prev, agentKey]
    );
  };

  const handleSubmit = () => {
    if (!identifierPattern.trim()) {
      toast.warning('验证失败', '规则模式不能为空');
      return;
    }

    if (mode === 'create') {
      const request: CreateWhitelistRequest = {
        channelType,
        identifierPattern: identifierPattern.trim(),
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
        boundUserId: boundUserId || undefined,
        allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
        dailyQuota,
        priority,
      };
      onSubmit(request);
    } else {
      const request: UpdateWhitelistRequest = {
        identifierPattern: identifierPattern.trim(),
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
        boundUserId: boundUserId || undefined,
        allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
        dailyQuota,
        priority,
      };
      onSubmit(request);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={mode === 'create' ? '新建白名单规则' : '编辑白名单规则'}
      maxWidth={600}
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

          {/* 规则模式 */}
          <div>
            <label className="block text-sm font-medium mb-1">规则模式 *</label>
            <input
              type="text"
              value={identifierPattern}
              onChange={(e) => setIdentifierPattern(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-md"
              placeholder={
                channelType === ChannelTypes.Email
                  ? '例如：*@company.com 或 user@example.com'
                  : '输入匹配规则'
              }
            />
            <p className="text-xs text-muted-foreground mt-1">
              支持通配符 *，例如：*@company.com 匹配该域名下所有邮箱
            </p>
          </div>

          {/* 显示名称 */}
          <div>
            <label className="block text-sm font-medium mb-1">显示名称</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-md"
              placeholder="规则的友好名称（可选）"
            />
          </div>

          {/* 备注说明 */}
          <div>
            <label className="block text-sm font-medium mb-1">备注说明</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-md"
              placeholder="规则的详细说明（可选）"
              rows={2}
            />
          </div>

          {/* 绑定用户 */}
          <div>
            <label className="block text-sm font-medium mb-1">绑定用户</label>
            <Select
              value={boundUserId}
              onChange={(e) => setBoundUserId(e.target.value)}
              disabled={loadingUsers}
              uiSize="md"
            >
              <option value="">{loadingUsers ? '加载中...' : '不绑定（由身份映射决定）'}</option>
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.displayName} (@{u.username})
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              绑定后，所有匹配该规则的请求都将以此用户身份执行
            </p>
          </div>

          {/* 允许的 Agent */}
          <div>
            <label className="block text-sm font-medium mb-2">允许的 Agent</label>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_AGENTS.map((agent) => (
                <button
                  key={agent.key}
                  type="button"
                  onClick={() => handleAgentToggle(agent.key)}
                  className="px-3 py-1.5 text-sm rounded-md transition-colors"
                  style={{
                    background: allowedAgents.includes(agent.key)
                      ? 'rgba(34,197,94,0.2)'
                      : 'rgba(255,255,255,0.05)',
                    border: allowedAgents.includes(agent.key)
                      ? '1px solid rgba(34,197,94,0.4)'
                      : '1px solid rgba(255,255,255,0.1)',
                    color: allowedAgents.includes(agent.key)
                      ? 'rgb(34,197,94)'
                      : 'var(--text-secondary)',
                  }}
                >
                  {agent.name}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              不选择表示允许全部 Agent
            </p>
          </div>

          {/* 每日配额和优先级 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">每日配额</label>
              <input
                type="number"
                value={dailyQuota}
                onChange={(e) => setDailyQuota(parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md"
                min={0}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">优先级</label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md"
              />
              <p className="text-xs text-muted-foreground mt-1">数值越大优先级越高</p>
            </div>
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
