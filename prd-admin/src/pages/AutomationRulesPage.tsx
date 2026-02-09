import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Switch } from '@/components/design/Switch';
import { Dialog } from '@/components/ui/Dialog';
import { automationsService } from '@/services';
import { toast } from '@/lib/toast';
import {
  Plus,
  Loader2,
  Trash2,
  Play,
  Webhook,
  Bell,
  Zap,
  Check,
  X,
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
  webhook: 'Webhook',
  admin_notification: '站内信',
};

const actionTypeIcons: Record<string, React.ReactNode> = {
  webhook: <Webhook size={12} />,
  admin_notification: <Bell size={12} />,
};

export default function AutomationRulesPage() {
  const [rules, setRules] = useState<RuleListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [eventTypes, setEventTypes] = useState<EventTypeDef[]>([]);

  // 创建对话框
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState('');
  const [formEventType, setFormEventType] = useState('');
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
      const data = await automationsService.listRules(page, 20);
      setRules(data.items);
      setTotal(data.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  }, [page]);

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
    if (!formName || !formEventType) {
      toast.error('请填写规则名称和事件类型');
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
        eventType: formEventType,
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

  const resetForm = () => {
    setFormName('');
    setFormEventType('');
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

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Zap size={22} /> 自动化
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            当事件发生时，自动执行 Webhook 推送、站内信通知等动作
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            resetForm();
            setCreateOpen(true);
          }}
        >
          <Plus size={14} /> 新建规则
        </Button>
      </div>

      {/* 规则列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : rules.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Zap size={36} className="mx-auto mb-3 opacity-40" />
          <p>暂无自动化规则</p>
          <p className="text-xs mt-1">点击「新建规则」创建第一条自动化</p>
        </div>
      ) : (
        <div className="space-y-2">
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
                    <Badge variant="subtle" size="sm">
                      {rule.eventType}
                    </Badge>
                    {!rule.enabled && (
                      <Badge variant="danger" size="sm">
                        已禁用
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    {/* 动作摘要 */}
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
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <span className="text-xs text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}

      {/* 创建规则对话框 */}
      <Dialog
        open={createOpen}
        onOpenChange={(isOpen) => !isOpen && setCreateOpen(false)}
        title="新建自动化规则"
        maxWidth={560}
        contentClassName="max-h-[85vh] overflow-y-auto"
        content={
          <div className="space-y-4">
            {/* 规则名称 */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">规则名称</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="如：额度预警推送"
                className={inputCls}
              />
            </div>

            {/* 事件类型 */}
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

            {/* 动作列表 */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">动作</label>
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
                      <button
                        onClick={() => removeAction(idx)}
                        className="text-muted-foreground hover:text-red-400"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {action.type === 'webhook' && (
                      <>
                        <input
                          value={action.webhookUrl || ''}
                          onChange={(e) => updateAction(idx, { webhookUrl: e.target.value })}
                          placeholder="https://example.com/webhook"
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
                  <Webhook size={12} /> 添加 Webhook
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
