import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Switch } from '@/components/design/Switch';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Dialog } from '@/components/ui/Dialog';
import { automationsService } from '@/services';
import { toast } from '@/lib/toast';
import {
  Plus,
  Loader2,
  Trash2,
  Play,
  Bell,
  Zap,
  Check,
  X,
  ArrowRight,
  Copy,
  RefreshCw,
  Link,
  ExternalLink,
} from 'lucide-react';
import type {
  RuleListItem,
  AutomationAction,
  EventTypeDef,
  CreateRuleRequest,
} from '@/services/contracts/automations';

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

const actionTypeLabels: Record<string, string> = {
  webhook: '传出 Webhook',
  admin_notification: '站内信',
};

const actionTypeIcons: Record<string, React.ReactNode> = {
  webhook: <ExternalLink size={12} />,
  admin_notification: <Bell size={12} />,
};

function FlowPreview({ triggerType, actions }: { triggerType: string; actions: AutomationAction[] }) {
  const triggerLabel = triggerType === 'incoming_webhook' ? '外部系统 POST' : '系统事件触发';
  const triggerSub = triggerType === 'incoming_webhook' ? '别人调用我们的 URL' : '内部事件匹配';
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg text-xs" style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)' }}>
      <div className="text-center px-2">
        <div className="font-medium" style={{ color: 'rgba(96,165,250,0.95)' }}>
          {triggerType === 'incoming_webhook' ? <Link size={14} className="mx-auto mb-1" /> : <Zap size={14} className="mx-auto mb-1" />}
          {triggerLabel}
        </div>
        <div style={{ color: 'rgba(96,165,250,0.6)' }}>{triggerSub}</div>
      </div>
      <ArrowRight size={14} style={{ color: 'rgba(96,165,250,0.5)', flexShrink: 0 }} />
      <div className="text-center px-2">
        <div className="font-medium" style={{ color: 'rgba(96,165,250,0.95)' }}>自动化引擎</div>
        <div style={{ color: 'rgba(96,165,250,0.6)' }}>匹配规则</div>
      </div>
      <ArrowRight size={14} style={{ color: 'rgba(96,165,250,0.5)', flexShrink: 0 }} />
      <div className="text-center px-2">
        <div className="font-medium" style={{ color: 'rgba(96,165,250,0.95)' }}>
          {actions.length > 0 ? actions.map((a) => actionTypeLabels[a.type] || a.type).join(' + ') : '执行动作'}
        </div>
        <div style={{ color: 'rgba(96,165,250,0.6)' }}>
          {actions.some((a) => a.type === 'webhook') ? '我们 POST 到外部' : ''}
          {actions.some((a) => a.type === 'webhook') && actions.some((a) => a.type === 'admin_notification') ? ' + ' : ''}
          {actions.some((a) => a.type === 'admin_notification') ? '站内通知' : ''}
          {actions.length === 0 && '待配置'}
        </div>
      </div>
    </div>
  );
}

function HookUrlDisplay({ hookId }: { hookId: string }) {
  const url = `${window.location.origin}/api/automations/hooks/${hookId}`;
  const handleCopy = () => {
    navigator.clipboard.writeText(url);
    toast.success('已复制 Webhook URL');
  };
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
      <Link size={14} style={{ color: 'rgba(34,197,94,0.8)', flexShrink: 0 }} />
      <code className="flex-1 text-xs truncate" style={{ color: 'rgba(34,197,94,0.9)' }}>{url}</code>
      <button onClick={handleCopy} className="p-1 rounded hover:bg-white/10" title="复制">
        <Copy size={12} style={{ color: 'rgba(34,197,94,0.8)' }} />
      </button>
    </div>
  );
}

export default function AutomationRulesPage() {
  const [activeTab, setActiveTab] = useState('event');
  const [rules, setRules] = useState<RuleListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [eventTypes, setEventTypes] = useState<EventTypeDef[]>([]);

  // 创建对话框
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formTriggerType, setFormTriggerType] = useState<'event' | 'incoming_webhook'>('event');
  const [formName, setFormName] = useState('');
  const [formEventType, setFormEventType] = useState('');
  const [formHookSecret, setFormHookSecret] = useState('');
  const [formActions, setFormActions] = useState<AutomationAction[]>([]);

  // 测试对话框
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [triggerRuleId, setTriggerRuleId] = useState('');
  const [triggerTitle, setTriggerTitle] = useState('');
  const [triggerContent, setTriggerContent] = useState('');
  const [triggering, setTriggering] = useState(false);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await automationsService.listRules(page, 20, undefined, undefined, activeTab);
      setRules(data.items);
      setTotal(data.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  }, [page, activeTab]);

  const loadEventTypes = useCallback(async () => {
    try {
      const types = await automationsService.getEventTypes();
      setEventTypes(types);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadRules();
    loadEventTypes();
  }, [loadRules, loadEventTypes]);

  const handleTabChange = (key: string) => {
    setActiveTab(key);
    setPage(1);
  };

  const handleToggle = async (id: string) => {
    try {
      const res = await automationsService.toggleRule(id);
      toast.success(res.enabled ? '已启用' : '已禁用');
      loadRules();
    } catch (err) {
      toast.error('操作失败', String(err));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定删除规则「${name}」？`)) return;
    try {
      await automationsService.deleteRule(id);
      toast.success('已删除');
      loadRules();
    } catch (err) {
      toast.error('删除失败', String(err));
    }
  };

  const handleCreate = async () => {
    if (!formName) {
      toast.error('请填写规则名称');
      return;
    }
    if (formTriggerType === 'event' && !formEventType) {
      toast.error('请选择或输入事件类型');
      return;
    }
    if (formActions.length === 0) {
      toast.error('至少需要一个动作');
      return;
    }

    setCreating(true);
    try {
      const req: CreateRuleRequest = {
        name: formName,
        enabled: true,
        triggerType: formTriggerType,
        eventType: formTriggerType === 'event' ? formEventType : undefined,
        hookSecret: formTriggerType === 'incoming_webhook' && formHookSecret ? formHookSecret : undefined,
        actions: formActions,
      };
      await automationsService.createRule(req);
      toast.success('规则已创建');
      setCreateOpen(false);
      resetForm();
      loadRules();
    } catch (err) {
      toast.error('创建失败', String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      const result = await automationsService.triggerRule(triggerRuleId, {
        title: triggerTitle || '手动触发测试',
        content: triggerContent || '这是一条手动触发的测试通知',
      });
      if (result.allSucceeded) {
        toast.success('触发成功，所有动作执行完毕');
      } else {
        const failed = result.actionResults.filter((r) => !r.success);
        toast.error('部分动作失败', failed.map((r) => r.errorMessage).join('; '));
      }
      setTriggerOpen(false);
      loadRules();
    } catch (err) {
      toast.error('触发失败', String(err));
    } finally {
      setTriggering(false);
    }
  };

  const handleRegenerateHook = async (id: string) => {
    if (!confirm('重新生成后旧 URL 将立即失效，确定继续？')) return;
    try {
      await automationsService.regenerateHook(id);
      toast.success('Hook URL 已重新生成');
      loadRules();
    } catch (err) {
      toast.error('操作失败', String(err));
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormTriggerType(activeTab === 'incoming_webhook' ? 'incoming_webhook' : 'event');
    setFormEventType('');
    setFormHookSecret('');
    setFormActions([]);
  };

  const addAction = (type: string) => {
    setFormActions((prev) => [
      ...prev,
      {
        type,
        ...(type === 'webhook' ? { webhookUrl: '' } : {}),
        ...(type === 'admin_notification' ? { notifyUserIds: [], notifyLevel: 'info' } : {}),
      },
    ]);
  };

  const removeAction = (idx: number) => {
    setFormActions((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateAction = (idx: number, patch: Partial<AutomationAction>) => {
    setFormActions((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };

  const inputCls =
    'w-full px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm';

  const totalPages = Math.ceil(total / 20);

  const emptyIcon = activeTab === 'incoming_webhook' ? <Link size={36} className="mx-auto mb-3 opacity-40" /> : <Zap size={36} className="mx-auto mb-3 opacity-40" />;
  const emptyText = activeTab === 'incoming_webhook' ? '暂无传入 Webhook' : '暂无事件触发规则';
  const emptyHint = activeTab === 'incoming_webhook'
    ? '创建传入 Webhook 后，外部系统可以通过 POST 请求触发动作'
    : '创建事件规则后，当系统事件发生时自动执行动作';

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-x-hidden">
      <TabBar
        items={[
          { key: 'event', label: '事件触发', icon: <Zap size={14} /> },
          { key: 'incoming_webhook', label: '传入 Webhook', icon: <Link size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={handleTabChange}
        actions={
          <Button
            size="sm"
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
          >
            <Plus size={14} /> 新建规则
          </Button>
        }
      />

      <GlassCard glow className="flex-1 min-h-0 flex flex-col p-5">
        {/* 规则列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : rules.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {emptyIcon}
            <p>{emptyText}</p>
            <p className="text-xs mt-1">{emptyHint}</p>
          </div>
        ) : (
          <div className="space-y-2 flex-1 overflow-y-auto">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="p-4 rounded-xl border transition-colors"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  borderColor: rule.enabled ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
                  opacity: rule.enabled ? 1 : 0.6,
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{rule.name}</span>
                      {rule.triggerType === 'event' && (
                        <Badge variant="subtle" size="sm">{rule.eventType}</Badge>
                      )}
                      {rule.triggerType === 'incoming_webhook' && (
                        <Badge variant="success" size="sm">
                          传入 Webhook
                        </Badge>
                      )}
                      {!rule.enabled && (
                        <Badge variant="danger" size="sm">已禁用</Badge>
                      )}
                    </div>

                    {/* 传入 Webhook 显示 URL */}
                    {rule.triggerType === 'incoming_webhook' && rule.hookId && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <HookUrlDisplay hookId={rule.hookId} />
                        <button
                          onClick={() => handleRegenerateHook(rule.id)}
                          className="p-1 rounded hover:bg-white/10 text-muted-foreground"
                          title="重新生成 URL"
                        >
                          <RefreshCw size={12} />
                        </button>
                      </div>
                    )}

                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        {rule.actions.map((a, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(255,255,255,0.05)' }}
                          >
                            {actionTypeIcons[a.type]}
                            {actionTypeLabels[a.type] || a.type}
                          </span>
                        ))}
                      </div>
                      <span>|</span>
                      <span>触发 {rule.triggerCount} 次</span>
                      {rule.lastTriggeredAt && <span>最近: {fmtDate(rule.lastTriggeredAt)}</span>}
                      <span>创建: {rule.createdByName}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      title="手动触发"
                      onClick={() => {
                        setTriggerRuleId(rule.id);
                        setTriggerTitle('');
                        setTriggerContent('');
                        setTriggerOpen(true);
                      }}
                      className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      title="删除"
                      onClick={() => handleDelete(rule.id, rule.name)}
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={() => handleToggle(rule.id)}
                      ariaLabel="启用/禁用"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-3">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              上一页
            </Button>
            <span className="text-xs text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              下一页
            </Button>
          </div>
        )}
      </GlassCard>

      {/* 创建规则对话框 */}
      <Dialog
        open={createOpen}
        onOpenChange={(isOpen) => !isOpen && setCreateOpen(false)}
        title="新建自动化规则"
        maxWidth={600}
        contentClassName="max-h-[85vh] overflow-y-auto"
        content={
          <div className="space-y-4">
            {/* 流程预览 */}
            <FlowPreview triggerType={formTriggerType} actions={formActions} />

            {/* 触发方式切换 */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">触发方式</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setFormTriggerType('event')}
                  className="flex-1 p-3 rounded-lg border text-left text-sm transition-all"
                  style={{
                    background: formTriggerType === 'event' ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.02)',
                    borderColor: formTriggerType === 'event' ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.08)',
                  }}
                >
                  <div className="flex items-center gap-2 font-medium">
                    <Zap size={14} /> 事件触发
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">系统内部事件发生时自动触发</div>
                </button>
                <button
                  onClick={() => setFormTriggerType('incoming_webhook')}
                  className="flex-1 p-3 rounded-lg border text-left text-sm transition-all"
                  style={{
                    background: formTriggerType === 'incoming_webhook' ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.02)',
                    borderColor: formTriggerType === 'incoming_webhook' ? 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.08)',
                  }}
                >
                  <div className="flex items-center gap-2 font-medium">
                    <Link size={14} /> 传入 Webhook
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">外部系统 POST 到我们的 URL</div>
                </button>
              </div>
            </div>

            {/* 规则名称 */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">规则名称</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={formTriggerType === 'incoming_webhook' ? '如：GitHub Push 通知' : '如：额度预警推送'}
                className={inputCls}
              />
            </div>

            {/* 事件触发：事件类型选择 */}
            {formTriggerType === 'event' && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">触发事件</label>
                <select
                  value={formEventType}
                  onChange={(e) => setFormEventType(e.target.value)}
                  className={inputCls}
                >
                  <option value="">选择事件类型...</option>
                  {eventTypes.map((et) => (
                    <option key={et.eventType} value={et.eventType}>
                      [{et.category}] {et.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground mt-1">或直接输入自定义事件类型（支持通配符 *）</p>
                <input
                  value={formEventType}
                  onChange={(e) => setFormEventType(e.target.value)}
                  placeholder="如：visual-agent.image-gen.*"
                  className={inputCls + ' mt-1'}
                />
              </div>
            )}

            {/* 传入 Webhook：密钥（可选） */}
            {formTriggerType === 'incoming_webhook' && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">签名密钥（可选）</label>
                <input
                  value={formHookSecret}
                  onChange={(e) => setFormHookSecret(e.target.value)}
                  placeholder="留空则不校验签名"
                  className={inputCls}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  设置后，外部请求需在 <code className="px-1 py-0.5 rounded bg-white/5">X-Hook-Signature</code> 头中携带 HMAC-SHA256 签名
                </p>
              </div>
            )}

            {/* 动作列表 */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">执行动作</label>
              <div className="space-y-2">
                {formActions.map((action, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg border space-y-2"
                    style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.08)' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium flex items-center gap-1">
                        {actionTypeIcons[action.type]}
                        {actionTypeLabels[action.type] || action.type}
                      </span>
                      <button onClick={() => removeAction(idx)} className="text-muted-foreground hover:text-red-400">
                        <X size={14} />
                      </button>
                    </div>
                    {action.type === 'webhook' && (
                      <>
                        <input
                          value={action.webhookUrl || ''}
                          onChange={(e) => updateAction(idx, { webhookUrl: e.target.value })}
                          placeholder="https://example.com/webhook（我们 POST 到这个地址）"
                          className={inputCls}
                        />
                        <input
                          value={action.webhookSecret || ''}
                          onChange={(e) => updateAction(idx, { webhookSecret: e.target.value })}
                          placeholder="Bearer 凭证（可选）"
                          className={inputCls}
                        />
                      </>
                    )}
                    {action.type === 'admin_notification' && (
                      <>
                        <select
                          value={action.notifyLevel || 'info'}
                          onChange={(e) => updateAction(idx, { notifyLevel: e.target.value })}
                          className={inputCls}
                        >
                          <option value="info">信息</option>
                          <option value="warning">警告</option>
                          <option value="error">错误</option>
                        </select>
                        <p className="text-xs text-muted-foreground">
                          通知目标：留空为全局通知，填写用户 ID 以逗号分隔
                        </p>
                        <input
                          value={(action.notifyUserIds || []).join(',')}
                          onChange={(e) =>
                            updateAction(idx, {
                              notifyUserIds: e.target.value ? e.target.value.split(',').map((s) => s.trim()) : [],
                            })
                          }
                          placeholder="留空 = 全局通知"
                          className={inputCls}
                        />
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-2">
                <Button variant="secondary" size="sm" onClick={() => addAction('webhook')}>
                  <ExternalLink size={12} /> 添加传出 Webhook
                </Button>
                <Button variant="secondary" size="sm" onClick={() => addAction('admin_notification')}>
                  <Bell size={12} /> 添加站内信
                </Button>
              </div>
            </div>

            {/* 操作按钮 */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>
                取消
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={creating}>
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                创建
              </Button>
            </div>
          </div>
        }
      />

      {/* 手动触发对话框 */}
      <Dialog
        open={triggerOpen}
        onOpenChange={(isOpen) => !isOpen && setTriggerOpen(false)}
        title="手动触发规则"
        maxWidth={440}
        content={
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">标题</label>
              <input
                value={triggerTitle}
                onChange={(e) => setTriggerTitle(e.target.value)}
                placeholder="手动触发测试"
                className={inputCls}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">内容</label>
              <textarea
                value={triggerContent}
                onChange={(e) => setTriggerContent(e.target.value)}
                placeholder="这是一条手动触发的测试通知"
                className={inputCls + ' h-20 resize-none'}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setTriggerOpen(false)}>
                取消
              </Button>
              <Button size="sm" onClick={handleTrigger} disabled={triggering}>
                {triggering ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                触发
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
