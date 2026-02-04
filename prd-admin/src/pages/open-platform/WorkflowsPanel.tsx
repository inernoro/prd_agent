import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { Switch } from '@/components/design/Switch';
import { Dialog } from '@/components/ui/Dialog';
import { channelService } from '@/services';
import {
  Plus,
  Trash2,
  RefreshCw,
  MoreVertical,
  Mail,
  Pencil,
  FileText,
  CheckSquare,
  MessageCircle,
  HelpCircle,
  Info,
} from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import type {
  EmailWorkflow,
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
} from '@/services/contracts/channels';
import { EmailIntentTypeDisplayNames } from '@/services/contracts/channels';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

// Intent type icons
const intentIcons: Record<string, React.ReactNode> = {
  classify: <FileText size={16} />,
  createtodo: <CheckSquare size={16} />,
  summarize: <MessageCircle size={16} />,
  followup: <Mail size={16} />,
  fyi: <HelpCircle size={16} />,
  unknown: <HelpCircle size={16} />,
};

interface WorkflowsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

export default function WorkflowsPanel({ onActionsReady }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<EmailWorkflow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<EmailWorkflow | null>(null);

  const loadWorkflows = async () => {
    setLoading(true);
    try {
      const res = await channelService.getWorkflows(page, pageSize);
      setWorkflows(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkflows();
  }, [page]);

  // Setup action buttons for TabBar
  useEffect(() => {
    if (onActionsReady) {
      onActionsReady(
        <>
          <Button variant="secondary" size="sm" onClick={loadWorkflows}>
            <RefreshCw size={14} />
            刷新
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus size={14} />
            新建工作流
          </Button>
        </>
      );
    }
  }, [onActionsReady]);

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
      message: `确定要删除工作流"${displayName}"吗？此操作不可恢复。`,
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
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* 使用指南 */}
      <GlassCard className="p-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-blue-500/20 text-blue-400">
            <Info size={16} />
          </div>
          <div className="flex-1">
            <h3 className="font-medium mb-1">工作流配置说明</h3>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p><strong>企业邮箱模式</strong>：配置自定义邮箱前缀（如 todo@company.com），发送到该地址的邮件会自动触发对应的处理流程。</p>
              <p><strong>普通邮箱模式</strong>（Gmail/163等）：在邮件主题中添加关键词触发，如 [待办]、[分类]、[摘要]。</p>
              <div className="mt-2 p-2 rounded bg-amber-500/10 border border-amber-500/20">
                <span className="text-amber-400">提示：</span> 两种模式可以同时生效，系统会优先匹配邮箱前缀，其次匹配主题关键词。
              </div>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* 工作流列表 */}
      <GlassCard glow className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead style={{ background: 'rgba(255,255,255,0.02)' }}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">工作流</th>
                <th className="px-4 py-3 text-left text-sm font-medium">邮箱前缀</th>
                <th className="px-4 py-3 text-left text-sm font-medium">处理类型</th>
                <th className="px-4 py-3 text-left text-sm font-medium">目标 Agent</th>
                <th className="px-4 py-3 text-left text-sm font-medium">优先级</th>
                <th className="px-4 py-3 text-left text-sm font-medium">状态</th>
                <th className="px-4 py-3 text-right text-sm font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((wf) => (
                <tr
                  key={wf.id}
                  className="transition-colors"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{wf.icon || '📧'}</span>
                      <div>
                        <div className="font-medium">{wf.displayName}</div>
                        {wf.description && (
                          <div className="text-xs text-muted-foreground mt-0.5">{wf.description}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="px-2 py-1 rounded text-sm" style={{ background: 'rgba(59,130,246,0.1)', color: 'rgba(96,165,250,0.95)' }}>
                      {wf.addressPrefix}@...
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {intentIcons[wf.intentType] || <HelpCircle size={16} />}
                      <span>{EmailIntentTypeDisplayNames[wf.intentType] || wf.intentType}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {wf.targetAgent ? (
                      <Badge variant="subtle" size="sm">{wf.targetAgent}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">默认</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm">{wf.priority}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={wf.isActive}
                      onCheckedChange={() => handleToggleStatus(wf.id)}
                      ariaLabel={wf.isActive ? '禁用工作流' : '启用工作流'}
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
                              onSelect={() => handleEdit(wf)}
                            >
                              <Pencil size={14} />
                              <span>编辑工作流</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator
                              className="my-1 h-px"
                              style={{ background: 'rgba(255,255,255,0.10)' }}
                            />
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-2 text-sm rounded-[10px] cursor-pointer outline-none transition-colors"
                              style={{ color: 'rgba(239,68,68,0.95)' }}
                              onSelect={() => handleDelete(wf.id, wf.displayName)}
                            >
                              <Trash2 size={14} />
                              <span>删除工作流</span>
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

          {workflows.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">
              暂无工作流，点击右上角"新建工作流"开始配置
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

      <WorkflowEditDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onSubmit={(req) => handleCreate(req as CreateWorkflowRequest)}
        mode="create"
      />

      <WorkflowEditDialog
        open={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
          setEditingWorkflow(null);
        }}
        onSubmit={(req) => handleUpdate(req as UpdateWorkflowRequest)}
        mode="edit"
        workflow={editingWorkflow}
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
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (request: CreateWorkflowRequest | UpdateWorkflowRequest) => void;
  mode: 'create' | 'edit';
  workflow?: EmailWorkflow | null;
}) {
  const [addressPrefix, setAddressPrefix] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [intentType, setIntentType] = useState('classify');
  const [targetAgent, setTargetAgent] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [replyTemplate, setReplyTemplate] = useState('');
  const [priority, setPriority] = useState(100);

  useEffect(() => {
    if (mode === 'edit' && workflow) {
      setAddressPrefix(workflow.addressPrefix);
      setDisplayName(workflow.displayName);
      setDescription(workflow.description || '');
      setIcon(workflow.icon || '');
      setIntentType(workflow.intentType);
      setTargetAgent(workflow.targetAgent || '');
      setCustomPrompt(workflow.customPrompt || '');
      setReplyTemplate(workflow.replyTemplate || '');
      setPriority(workflow.priority);
    } else {
      setAddressPrefix('');
      setDisplayName('');
      setDescription('');
      setIcon('');
      setIntentType('classify');
      setTargetAgent('');
      setCustomPrompt('');
      setReplyTemplate('');
      setPriority(100);
    }
  }, [open, mode, workflow]);

  const handleSubmit = () => {
    if (!addressPrefix.trim()) {
      toast.warning('验证失败', '邮箱前缀不能为空');
      return;
    }
    if (!displayName.trim()) {
      toast.warning('验证失败', '显示名称不能为空');
      return;
    }

    onSubmit({
      addressPrefix: addressPrefix.trim().toLowerCase(),
      displayName: displayName.trim(),
      description: description.trim() || undefined,
      icon: icon.trim() || undefined,
      intentType,
      targetAgent: targetAgent.trim() || undefined,
      customPrompt: customPrompt.trim() || undefined,
      replyTemplate: replyTemplate.trim() || undefined,
      priority,
    });
  };

  const intentOptions = [
    { value: 'classify', label: '邮件分类', icon: '📁' },
    { value: 'createtodo', label: '创建待办', icon: '📋' },
    { value: 'summarize', label: '内容摘要', icon: '📝' },
    { value: 'followup', label: '跟进回复', icon: '📨' },
    { value: 'fyi', label: '仅供参考', icon: '📄' },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={mode === 'create' ? '新建工作流' : '编辑工作流'}
      maxWidth={600}
      contentClassName="max-h-[85vh] overflow-y-auto"
      content={
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">邮箱前缀 *</label>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={addressPrefix}
                  onChange={(e) => setAddressPrefix(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                  placeholder="todo"
                />
                <span className="text-muted-foreground">@domain</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">发送到此前缀的邮件将触发工作流</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">显示名称 *</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                placeholder="待办事项"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">处理类型 *</label>
              <Select
                value={intentType}
                onChange={(e) => setIntentType(e.target.value)}
                uiSize="md"
              >
                {intentOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.icon} {opt.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">图标</label>
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                placeholder="📋"
              />
              <p className="text-xs text-muted-foreground mt-1">支持 emoji 或图标名</p>
            </div>
          </div>

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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">目标 Agent</label>
              <input
                type="text"
                value={targetAgent}
                onChange={(e) => setTargetAgent(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                placeholder="defect-agent"
              />
              <p className="text-xs text-muted-foreground mt-1">留空则使用默认处理器</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">优先级</label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 100)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                min={1}
                max={999}
              />
              <p className="text-xs text-muted-foreground mt-1">数字越小优先级越高</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">自定义处理提示词</label>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-xs font-mono"
              placeholder="可选，用于 LLM 处理时的自定义提示词..."
              rows={3}
            />
          </div>

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

          <div className="flex justify-end gap-2 pt-4 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button onClick={handleSubmit}>
              {mode === 'create' ? '创建' : '保存'}
            </Button>
          </div>
        </div>
      }
    />
  );
}
