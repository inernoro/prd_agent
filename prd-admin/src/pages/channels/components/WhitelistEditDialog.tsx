import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { getUsers } from '@/services';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import type { AdminUser } from '@/types/admin';
import { toast } from '@/lib/toast';
import type {
  ChannelWhitelist,
  CreateWhitelistRequest,
  UpdateWhitelistRequest,
} from '@/services/contracts/channels';
import { ChannelTypes, ChannelTypeDisplayNames } from '@/services/contracts/channels';
import { Mail, MessageSquare, Mic, Webhook, HelpCircle } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';

interface WhitelistEditDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (request: CreateWhitelistRequest | UpdateWhitelistRequest) => void;
  mode: 'create' | 'edit';
  whitelist?: ChannelWhitelist | null;
  /** 固定通道类型，设置后隐藏类型选择器 */
  fixedChannelType?: string;
}

const AVAILABLE_AGENTS = [
  { key: 'visual-agent', name: '视觉创作', icon: '🎨' },
  { key: 'prd-agent', name: 'PRD 助手', icon: '📋' },
  { key: 'defect-agent', name: '缺陷管理', icon: '🐛' },
  { key: 'literary-agent', name: '文学创作', icon: '✍️' },
];

const channelIcons: Record<string, React.ReactNode> = {
  email: <Mail size={14} />,
  sms: <MessageSquare size={14} />,
  siri: <Mic size={14} />,
  webhook: <Webhook size={14} />,
};

export function WhitelistEditDialog({
  open,
  onClose,
  onSubmit,
  mode,
  whitelist,
  fixedChannelType,
}: WhitelistEditDialogProps) {
  const [channelType, setChannelType] = useState<string>(fixedChannelType || ChannelTypes.Email);
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
        setChannelType(fixedChannelType || whitelist.channelType);
        setIdentifierPattern(whitelist.identifierPattern);
        setDisplayName(whitelist.displayName || '');
        setDescription(whitelist.description || '');
        setBoundUserId(whitelist.boundUserId || '');
        setAllowedAgents(whitelist.allowedAgents || []);
        setDailyQuota(whitelist.dailyQuota);
        setPriority(whitelist.priority);
      } else {
        setChannelType(fixedChannelType || ChannelTypes.Email);
        setIdentifierPattern('');
        setDisplayName('');
        setDescription('');
        setBoundUserId('');
        setAllowedAgents([]);
        setDailyQuota(100);
        setPriority(0);
      }
    }
  }, [open, mode, whitelist, fixedChannelType]);

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

  const inputCls = "w-full px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm";

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={mode === 'create' ? '新建白名单规则' : '编辑白名单规则'}
      maxWidth={520}
      contentClassName="max-h-[85vh] overflow-y-auto"
      content={
        <div className="space-y-5">
          {/* 通道类型预览 */}
          <div className="p-3 rounded-lg flex items-center gap-3" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}>
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(59,130,246,0.15)' }}>
              {channelIcons[channelType] || <Webhook size={14} />}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">通道类型</div>
              <div className="text-sm font-medium text-blue-400">{ChannelTypeDisplayNames[channelType]}</div>
            </div>
          </div>

          {/* 通道类型选择 - 仅在创建模式且未固定类型时显示 */}
          {mode === 'create' && !fixedChannelType && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">选择通道 *</label>
              <div className="flex gap-2">
                {Object.entries(ChannelTypeDisplayNames).map(([key, name]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setChannelType(key)}
                    className="flex-1 px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                    style={{
                      background: channelType === key ? 'rgba(59,130,246,0.15)' : 'var(--nested-block-bg)',
                      border: channelType === key ? '1px solid rgba(59,130,246,0.4)' : '1px solid var(--border-subtle)',
                      color: channelType === key ? 'rgb(96,165,250)' : 'var(--text-secondary)',
                    }}
                  >
                    {channelIcons[key]}
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 规则模式 */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              规则模式 *
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <HelpCircle size={12} className="inline-block ml-1" />
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="px-3 py-2 text-xs rounded-lg max-w-xs"
                      style={{ background: 'rgba(0,0,0,0.9)', border: '1px solid var(--border-default)' }}
                      sideOffset={5}
                    >
                      支持通配符 *，例如 *@company.com 匹配该域名下所有邮箱
                      <Tooltip.Arrow style={{ fill: 'rgba(0,0,0,0.9)' }} />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            </label>
            <input
              type="text"
              value={identifierPattern}
              onChange={(e) => setIdentifierPattern(e.target.value)}
              className={inputCls}
              placeholder={channelType === ChannelTypes.Email ? '*@company.com 或 user@example.com' : '输入匹配规则'}
            />
          </div>

          {/* 显示名称 & 绑定用户 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">显示名称</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={inputCls}
                placeholder="规则的友好名称"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">绑定用户</label>
              <UserSearchSelect
                value={boundUserId}
                onChange={setBoundUserId}
                users={users as unknown as AdminUser[]}
                showAllOption
                allOptionLabel="不绑定"
                placeholder={loadingUsers ? '加载中...' : '搜索用户名或昵称...'}
              />
            </div>
          </div>

          {/* 备注说明 */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">备注说明</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputCls}
              placeholder="规则的详细说明（可选）"
              rows={2}
            />
          </div>

          {/* 允许的 Agent */}
          <div>
            <label className="block text-xs text-muted-foreground mb-2">允许的 Agent</label>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_AGENTS.map((agent) => (
                <button
                  key={agent.key}
                  type="button"
                  onClick={() => handleAgentToggle(agent.key)}
                  className="px-3 py-1.5 text-sm rounded-lg transition-colors flex items-center gap-1.5"
                  style={{
                    background: allowedAgents.includes(agent.key) ? 'rgba(34,197,94,0.15)' : 'var(--nested-block-bg)',
                    border: allowedAgents.includes(agent.key) ? '1px solid rgba(34,197,94,0.4)' : '1px solid var(--border-subtle)',
                    color: allowedAgents.includes(agent.key) ? 'rgb(34,197,94)' : 'var(--text-secondary)',
                  }}
                >
                  <span>{agent.icon}</span>
                  {agent.name}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">不选择表示允许全部 Agent</p>
          </div>

          {/* 每日配额和优先级 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">每日配额</label>
              <input
                type="number"
                value={dailyQuota}
                onChange={(e) => setDailyQuota(parseInt(e.target.value) || 0)}
                className={inputCls}
                min={0}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                优先级
                <Tooltip.Provider>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <HelpCircle size={12} className="inline-block ml-1" />
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        className="px-3 py-2 text-xs rounded-lg"
                        style={{ background: 'rgba(0,0,0,0.9)', border: '1px solid var(--border-default)' }}
                        sideOffset={5}
                      >
                        数值越大优先级越高
                        <Tooltip.Arrow style={{ fill: 'rgba(0,0,0,0.9)' }} />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
              </label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                className={inputCls}
              />
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2 pt-4 border-t border-white/10">
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button onClick={handleSubmit}>{mode === 'create' ? '创建' : '保存'}</Button>
          </div>
        </div>
      }
    />
  );
}
