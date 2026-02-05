import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { Switch } from '@/components/design/Switch';
import { Dialog } from '@/components/ui/Dialog';
import { channelService, appCallersService } from '@/services';
import {
  Plus,
  Trash2,
  RefreshCw,
  MoreVertical,
  Pencil,
  FileText,
  HelpCircle,
  Wrench,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import type {
  EmailWorkflow,
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  ChannelSettings,
} from '@/services/contracts/channels';
import type { LLMAppCaller } from '@/types/appCaller';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';

interface WorkflowsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

export default function WorkflowsPanel({ onActionsReady }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<EmailWorkflow[]>([]);
  const [loading, setLoading] = useState(false);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<EmailWorkflow | null>(null);

  // 邮箱配置（用于获取域名）
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  // 已注册应用列表
  const [appCallers, setAppCallers] = useState<LLMAppCaller[]>([]);

  const loadWorkflows = async () => {
    setLoading(true);
    try {
      const res = await channelService.getWorkflows(1, 100);
      setWorkflows(res?.items || []);
    } catch (err) {
      toast.error('加载失败', String(err));
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const data = await channelService.getSettings();
      setSettings(data);
    } catch (err) {
      console.warn('Failed to load settings:', err);
    }
  };

  const loadAppCallers = async () => {
    try {
      const res = await appCallersService.getAppCallers(1, 100);
      setAppCallers(res?.data?.items || []);
    } catch (err) {
      console.warn('Failed to load app callers:', err);
    }
  };

  useEffect(() => {
    loadWorkflows();
    loadSettings();
    loadAppCallers();
  }, []);

  // Setup action buttons for TabBar
  useEffect(() => {
    onActionsReady?.(
      <Button variant="secondary" size="sm" onClick={() => { loadWorkflows(); loadSettings(); }}>
        <RefreshCw size={14} />
      </Button>
    );
  }, [onActionsReady]);

  // 从 IMAP 用户名提取域名
  const emailDomain = settings?.imapUsername?.split('@')[1] || null;

  const handleCreate = async (request: CreateWorkflowRequest) => {
    try {
      await channelService.createWorkflow(request);
      toast.success('创建成功');
      setCreateDialogOpen(false);
      loadWorkflows();
    } catch (err) {
      toast.error('创建失败', String(err));
    }
  };

  const handleEdit = (workflow: EmailWorkflow) => {
    setEditingWorkflow(workflow);
    setEditDialogOpen(true);
  };

  const handleUpdate = async (request: UpdateWorkflowRequest) => {
    if (!editingWorkflow) return;
    try {
      await channelService.updateWorkflow(editingWorkflow.id, request);
      toast.success('更新成功');
      setEditDialogOpen(false);
      setEditingWorkflow(null);
      loadWorkflows();
    } catch (err) {
      toast.error('更新失败', String(err));
    }
  };

  const handleDelete = async (id: string, displayName: string) => {
    const confirmed = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除工作流邮箱"${displayName}"吗？`,
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await channelService.deleteWorkflow(id);
      toast.success('删除成功');
      loadWorkflows();
    } catch (err) {
      toast.error('删除失败', String(err));
    }
  };

  const handleToggleStatus = async (id: string) => {
    try {
      await channelService.toggleWorkflow(id);
      toast.success('状态已切换');
      loadWorkflows();
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
              <FileText size={18} className="text-muted-foreground" />
              <span>自定义邮箱地址和说明来处理不同的任务</span>
            </div>
            <a href="#" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
              了解更多 <ExternalLink size={12} />
            </a>
          </div>
        </div>

        <div className="p-5 space-y-6">
          {/* 手动配置提示 */}
          <div className="flex items-start gap-3 p-3 rounded-lg" style={{ background: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.2)' }}>
            <Wrench size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="text-sm">
              <span className="text-amber-400 font-medium">当前为手动配置模式</span>
              <span className="text-muted-foreground ml-2">
                未来版本将支持自动识别邮件意图，无需预先配置工作流
              </span>
              <Sparkles size={12} className="inline-block ml-1 text-amber-400/60" />
            </div>
          </div>

          {/* 工作流邮箱标题 */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <h3 className="font-medium">工作流邮箱</h3>
                <Tooltip.Provider>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button className="text-muted-foreground hover:text-foreground">
                        <HelpCircle size={14} />
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        className="px-3 py-2 text-sm rounded-lg max-w-xs"
                        style={{ background: 'rgba(0,0,0,0.9)', border: '1px solid rgba(255,255,255,0.1)' }}
                        sideOffset={5}
                      >
                        配置不同的邮箱前缀，发送到对应地址的邮件会触发相应的处理流程
                        <Tooltip.Arrow style={{ fill: 'rgba(0,0,0,0.9)' }} />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setCreateDialogOpen(true)}>
                <Plus size={14} />
                添加工作流邮箱
              </Button>
            </div>

            {/* 工作流列表 */}
            <div className="space-y-2">
              {workflows.length === 0 && !loading ? (
                <div className="text-center py-8 text-muted-foreground">
                  暂无工作流邮箱，点击上方按钮添加
                </div>
              ) : (
                workflows.map((wf) => (
                  <div
                    key={wf.id}
                    className="flex items-center justify-between p-4 rounded-lg transition-colors hover:bg-white/[0.03]"
                    style={{ border: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <span className="text-2xl flex-shrink-0">{wf.icon || '📧'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{wf.displayName}</span>
                          {!wf.isActive && (
                            <Badge variant="subtle" size="sm">已禁用</Badge>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground mt-0.5 truncate">
                          {wf.description || '发送邮件到此地址触发处理'}
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        <code
                          className="px-2.5 py-1 rounded text-sm font-mono"
                          style={{ background: 'rgba(59,130,246,0.1)', color: 'rgba(96,165,250,0.95)' }}
                        >
                          {wf.addressPrefix}@{emailDomain || 'your-domain.com'}
                        </code>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 ml-4">
                      <Switch
                        checked={wf.isActive}
                        onCheckedChange={() => handleToggleStatus(wf.id)}
                        ariaLabel={wf.isActive ? '禁用工作流' : '启用工作流'}
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
                              onSelect={() => handleEdit(wf)}
                            >
                              <Pencil size={14} /> 编辑
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator className="my-1 h-px bg-white/10" />
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/10 text-red-400"
                              onSelect={() => handleDelete(wf.id, wf.displayName)}
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
          </section>
        </div>
      </GlassCard>

      {/* 创建对话框 */}
      <WorkflowEditDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onSubmit={(req) => handleCreate(req as CreateWorkflowRequest)}
        mode="create"
        emailDomain={emailDomain}
        appCallers={appCallers}
      />

      {/* 编辑对话框 */}
      <WorkflowEditDialog
        open={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
          setEditingWorkflow(null);
        }}
        onSubmit={(req) => handleUpdate(req as UpdateWorkflowRequest)}
        mode="edit"
        workflow={editingWorkflow}
        emailDomain={emailDomain}
        appCallers={appCallers}
      />
    </div>
  );
}

// Edit/Create dialog component
function WorkflowEditDialog({
  open,
  onClose,
  onSubmit,
  mode,
  workflow,
  emailDomain,
  appCallers,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (request: CreateWorkflowRequest | UpdateWorkflowRequest) => void;
  mode: 'create' | 'edit';
  workflow?: EmailWorkflow | null;
  emailDomain: string | null;
  appCallers: LLMAppCaller[];
}) {
  const [addressPrefix, setAddressPrefix] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [targetApp, setTargetApp] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [replyTemplate, setReplyTemplate] = useState('');

  useEffect(() => {
    if (mode === 'edit' && workflow) {
      setAddressPrefix(workflow.addressPrefix);
      setDisplayName(workflow.displayName);
      setDescription(workflow.description || '');
      setIcon(workflow.icon || '');
      setTargetApp(workflow.targetAgent || '');
      setCustomPrompt(workflow.customPrompt || '');
      setReplyTemplate(workflow.replyTemplate || '');
    } else {
      setAddressPrefix('');
      setDisplayName('');
      setDescription('');
      setIcon('');
      setTargetApp('');
      setCustomPrompt('');
      setReplyTemplate('');
    }
  }, [open, mode, workflow]);

  const handleSubmit = () => {
    if (!addressPrefix.trim()) {
      toast.warning('验证失败', '邮箱前缀不能为空');
      return;
    }
    if (!displayName.trim()) {
      toast.warning('验证失败', '工作流名称不能为空');
      return;
    }

    onSubmit({
      addressPrefix: addressPrefix.trim().toLowerCase(),
      displayName: displayName.trim(),
      description: description.trim() || undefined,
      icon: icon.trim() || undefined,
      intentType: 'classify', // 默认使用分类
      targetAgent: targetApp || undefined,
      customPrompt: customPrompt.trim() || undefined,
      replyTemplate: replyTemplate.trim() || undefined,
      priority: 100,
    });
  };

  const domainDisplay = emailDomain || 'your-domain.com';

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={mode === 'create' ? '添加工作流邮箱' : '编辑工作流邮箱'}
      maxWidth={500}
      contentClassName="max-h-[85vh] overflow-y-auto"
      content={
        <div className="space-y-5">
          {/* 邮箱地址预览 */}
          <div className="p-3 rounded-lg" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}>
            <div className="text-xs text-muted-foreground mb-1">邮件发送地址</div>
            <code className="text-blue-400 font-mono">
              {addressPrefix || 'prefix'}@{domainDisplay}
            </code>
          </div>

          {/* 邮箱前缀 */}
          <div>
            <label className="block text-sm font-medium mb-1.5">邮箱前缀 *</label>
            <div className="flex items-center">
              <input
                type="text"
                value={addressPrefix}
                onChange={(e) => setAddressPrefix(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className="flex-1 px-3 py-2 rounded-l-lg bg-white/5 border border-white/10 border-r-0 focus:border-blue-500/50 focus:outline-none"
                placeholder="todo"
              />
              <span className="px-3 py-2 rounded-r-lg bg-white/[0.03] border border-white/10 text-muted-foreground text-sm">
                @{domainDisplay}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              只能包含小写字母、数字和短横线
            </p>
          </div>

          {/* 工作流名称 */}
          <div>
            <label className="block text-sm font-medium mb-1.5">工作流名称 *</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              placeholder="待办事项"
            />
            <p className="text-xs text-muted-foreground mt-1">
              在列表中显示的名称，方便识别
            </p>
          </div>

          {/* 图标和目标应用 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">
                图标
                <Tooltip.Provider>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <HelpCircle size={12} className="inline-block ml-1 text-muted-foreground" />
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        className="px-3 py-2 text-xs rounded-lg max-w-xs"
                        style={{ background: 'rgba(0,0,0,0.9)', border: '1px solid rgba(255,255,255,0.1)' }}
                        sideOffset={5}
                      >
                        显示在工作流列表中的图标，帮助快速识别
                        <Tooltip.Arrow style={{ fill: 'rgba(0,0,0,0.9)' }} />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
              </label>
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                placeholder="📋"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">绑定应用</label>
              <Select
                value={targetApp}
                onChange={(e) => setTargetApp(e.target.value)}
                uiSize="md"
              >
                <option value="">自动处理</option>
                {appCallers.map((app) => (
                  <option key={app.id} value={app.appCode}>
                    {app.displayName || app.appCode}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {/* 描述 */}
          <div>
            <label className="block text-sm font-medium mb-1.5">描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              placeholder="发送到此邮箱的邮件会自动创建待办事项"
              rows={2}
            />
          </div>

          {/* 高级设置折叠 */}
          <details className="group">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
              <span className="group-open:rotate-90 transition-transform">▶</span>
              高级设置
            </summary>
            <div className="mt-3 space-y-4 pl-4 border-l border-white/10">
              {/* 追加提示词 */}
              <div>
                <label className="block text-sm font-medium mb-1.5">追加提示词</label>
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-xs font-mono"
                  placeholder="可选，AI 处理邮件时的额外指令..."
                  rows={3}
                />
              </div>

              {/* 自动回复模板 */}
              <div>
                <label className="block text-sm font-medium mb-1.5">自动回复模板</label>
                <textarea
                  value={replyTemplate}
                  onChange={(e) => setReplyTemplate(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-xs font-mono"
                  placeholder="支持变量：{senderName}, {subject}, {result}"
                  rows={3}
                />
              </div>
            </div>
          </details>

          {/* 操作按钮 */}
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
