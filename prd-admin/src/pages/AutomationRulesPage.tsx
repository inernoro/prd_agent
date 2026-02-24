import { useState, useEffect, useCallback, useRef } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { glassPopoverCompact } from '@/lib/glassStyles';
import { Button } from '@/components/design/Button';
import { Switch } from '@/components/design/Switch';
import { GlassCard } from '@/components/design/GlassCard';
import { SearchableSelect } from '@/components/design/SearchableSelect';
import { WorkflowProgressBar } from '@/components/ui/WorkflowProgressBar';
import {
  selectContentStyle,
  selectItemClass,
} from '@/components/design/selectStyles';
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
  Copy,
  RefreshCw,
  Link,
  ExternalLink,
  ChevronDown,
  Search,
  Users,
  Save,
  Terminal,
} from 'lucide-react';
import type {
  RuleListItem,
  AutomationAction,
  EventTypeDef,
  CreateRuleRequest,
  NotifyTarget,
} from '@/services/contracts/automations';

// ── 常量 & 小组件 ──

const actionTypeLabels: Record<string, string> = {
  webhook: '传出 Webhook',
  admin_notification: '站内信',
};
const actionTypeIcons: Record<string, React.ReactNode> = {
  webhook: <ExternalLink size={12} />,
  admin_notification: <Bell size={12} />,
};
const triggerTypeLabel: Record<string, string> = {
  event: '事件触发',
  incoming_webhook: '传入 Webhook',
};
const triggerTypeIcon: Record<string, React.ReactNode> = {
  event: <Zap size={12} />,
  incoming_webhook: <Link size={12} />,
};
const inputCls =
  'w-full px-3 py-2 rounded-[12px] text-sm outline-none transition-colors'
  + ' hover:border-white/20 focus:ring-2 focus:ring-white/10';
const inputStyle: React.CSSProperties = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
};

function getFlowSteps(triggerType: string, actions: AutomationAction[]) {
  const t = triggerType === 'incoming_webhook' ? '外部 POST' : '事件匹配';
  const a = actions.length > 0 ? actions.map((x) => actionTypeLabels[x.type] || x.type).join(' + ') : '执行动作';
  return [
    { key: 1, label: t },
    { key: 2, label: '模板渲染' },
    { key: 3, label: a },
  ];
}

function HookUrlDisplay({ hookId, onRegenerate }: { hookId: string; onRegenerate: () => void }) {
  const url = `${window.location.origin}/api/automations/hooks/${hookId}`;
  const curlCmd = `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 p-2.5 rounded-[12px] min-w-0" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
        <Link size={14} style={{ color: 'rgba(34,197,94,0.8)', flexShrink: 0 }} />
        <code className="flex-1 text-xs break-all" style={{ color: 'rgba(34,197,94,0.9)' }}>{url}</code>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => { navigator.clipboard.writeText(url); toast.success('已复制地址'); }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors hover:bg-white/8"
          style={{ color: 'rgba(34,197,94,0.8)', border: '1px solid rgba(34,197,94,0.15)' }}
        >
          <Copy size={12} /> 复制地址
        </button>
        <button
          onClick={() => { navigator.clipboard.writeText(curlCmd); toast.success('已复制 curl'); }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors hover:bg-white/8"
          style={{ color: 'rgba(168,85,247,0.8)', border: '1px solid rgba(168,85,247,0.15)' }}
        >
          <Terminal size={12} /> 复制 curl
        </button>
        <div className="flex-1" />
        <button
          onClick={onRegenerate}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors hover:bg-white/8"
          style={{ color: 'var(--text-muted)' }}
        >
          <RefreshCw size={12} /> 重新生成
        </button>
      </div>
    </div>
  );
}

/** 用户多选下拉 */
function UserMultiSelect({ allUsers, selectedIds, onChange }: {
  allUsers: NotifyTarget[]; selectedIds: string[]; onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  useEffect(() => { if (open) setTimeout(() => searchRef.current?.focus(), 100); else setSearch(''); }, [open]);

  const toggle = (id: string) => onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  const filtered = allUsers.filter((u) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q);
  });
  const names = selectedIds.map((id) => allUsers.find((u) => u.userId === id)).filter(Boolean).map((u) => u!.displayName);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className="relative w-full pr-9 h-9 rounded-[12px] text-sm outline-none transition-colors flex items-center px-3 hover:border-white/20"
        style={inputStyle}
      >
        <span className="truncate">
          {selectedIds.length === 0
            ? <span style={{ color: 'var(--text-muted)' }}>全局通知（所有管理员）</span>
            : names.join('、')}
        </span>
        <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div className="absolute z-[120] mt-2 w-full rounded-[14px] overflow-hidden" style={selectContentStyle}>
          <div className="p-2 border-b" style={{ borderColor: 'var(--border-default)' }}>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input ref={searchRef} type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索用户..." className="w-full pl-8 pr-3 h-8 rounded-[8px] text-sm outline-none"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              />
            </div>
          </div>
          <div className="p-1" style={{ maxHeight: 240, overflow: 'auto' }}>
            <button type="button" onClick={() => { onChange([]); setOpen(false); }}
              className={selectItemClass + ' w-full text-left flex items-center gap-2'}>
              <Users size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <span className="flex-1">全局通知（所有管理员）</span>
              {selectedIds.length === 0 && <Check size={12} className="text-green-400 flex-shrink-0" />}
            </button>
            <div className="mx-2 my-1" style={{ borderTop: '1px solid var(--nested-block-border)' }} />
            {filtered.map((user) => (
              <button key={user.userId} type="button" onClick={() => toggle(user.userId)}
                className={selectItemClass + ' w-full text-left flex items-center gap-2'}>
                <span className="flex-1 truncate">{user.displayName}</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>@{user.username}</span>
                {selectedIds.includes(user.userId) && <Check size={12} className="text-green-400 flex-shrink-0" />}
              </button>
            ))}
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>未找到匹配用户</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// 主页面
// ══════════════════════════════════════════════════════════════

interface EditState {
  id?: string;           // undefined = 新建
  triggerType: 'event' | 'incoming_webhook';
  name: string;
  eventType: string;
  hookId?: string;
  titleTemplate: string;
  contentTemplate: string;
  actions: AutomationAction[];
  enabled: boolean;
}

function emptyEdit(trigger: 'event' | 'incoming_webhook'): EditState {
  return { triggerType: trigger, name: '', eventType: '', titleTemplate: '', contentTemplate: '', actions: [], enabled: true };
}

function ruleToEdit(rule: RuleListItem): EditState {
  return {
    id: rule.id,
    triggerType: (rule.triggerType as 'event' | 'incoming_webhook') || 'event',
    name: rule.name,
    eventType: rule.eventType,
    hookId: rule.hookId ?? undefined,
    titleTemplate: rule.titleTemplate || '',
    contentTemplate: rule.contentTemplate || '',
    actions: rule.actions.map((a) => ({
      type: a.type,
      webhookUrl: a.webhookUrl,
      notifyLevel: a.notifyLevel,
      notifyUserIds: [],
    })),
    enabled: rule.enabled,
  };
}

export default function AutomationRulesPage() {
  const { isMobile } = useBreakpoint();
  const [rules, setRules] = useState<RuleListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventTypes, setEventTypes] = useState<EventTypeDef[]>([]);
  const [notifyTargets, setNotifyTargets] = useState<NotifyTarget[]>([]);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);

  // 编辑状态
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  // 手动触发
  const [triggerRuleId, setTriggerRuleId] = useState<string | null>(null);
  const [triggerTitle, setTriggerTitle] = useState('');
  const [triggerContent, setTriggerContent] = useState('');
  const [triggering, setTriggering] = useState(false);

  // 关闭新建菜单
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setShowNewMenu(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await automationsService.listRules(1, 100);
      setRules(data.items);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const [types, targets] = await Promise.all([
        automationsService.getEventTypes(),
        automationsService.getNotifyTargets(),
      ]);
      setEventTypes(types);
      setNotifyTargets(targets);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadRules(); loadMeta(); }, [loadRules, loadMeta]);

  // ── 事件处理 ──

  const handleSelectRule = (rule: RuleListItem) => {
    setEdit(ruleToEdit(rule));
  };

  const handleNew = (type: 'event' | 'incoming_webhook') => {
    setEdit(emptyEdit(type));
    setShowNewMenu(false);
  };

  const handleSave = async () => {
    if (!edit) return;
    if (!edit.name.trim()) { toast.error('请填写规则名称'); return; }
    if (edit.triggerType === 'event' && !edit.eventType) { toast.error('请选择触发事件'); return; }
    if (edit.actions.length === 0) { toast.error('至少添加一个执行动作'); return; }

    setSaving(true);
    try {
      if (edit.id) {
        await automationsService.updateRule(edit.id, {
          name: edit.name,
          eventType: edit.eventType || undefined,
          actions: edit.actions,
          titleTemplate: edit.titleTemplate || undefined,
          contentTemplate: edit.contentTemplate || undefined,
        });
        toast.success('已保存');
      } else {
        const req: CreateRuleRequest = {
          name: edit.name,
          enabled: true,
          triggerType: edit.triggerType,
          eventType: edit.triggerType === 'event' ? edit.eventType : undefined,
          actions: edit.actions,
          titleTemplate: edit.titleTemplate || undefined,
          contentTemplate: edit.contentTemplate || undefined,
        };
        const created = await automationsService.createRule(req);
        toast.success('已创建');
        setEdit(ruleToEdit({
          ...created,
          actions: created.actions.map((a) => ({
            type: a.type,
            webhookUrl: a.webhookUrl,
            notifyUserCount: a.notifyUserIds?.length ?? 0,
            notifyLevel: a.notifyLevel,
          })),
          createdByName: '我',
          createdBy: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          triggerCount: 0,
        }));
      }
      loadRules();
    } catch (err) {
      toast.error('保存失败', String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!edit?.id) { setEdit(null); return; }
    if (!confirm(`确定删除规则「${edit.name}」？`)) return;
    try {
      await automationsService.deleteRule(edit.id);
      toast.success('已删除');
      setEdit(null);
      loadRules();
    } catch (err) {
      toast.error('删除失败', String(err));
    }
  };

  const handleToggle = async (id: string) => {
    try {
      const res = await automationsService.toggleRule(id);
      toast.success(res.enabled ? '已启用' : '已禁用');
      if (edit?.id === id) setEdit((e) => e ? { ...e, enabled: res.enabled } : e);
      loadRules();
    } catch (err) {
      toast.error('操作失败', String(err));
    }
  };

  const handleRegenerateHook = async () => {
    if (!edit?.id) return;
    if (!confirm('重新生成后旧 URL 立即失效，确定？')) return;
    try {
      const res = await automationsService.regenerateHook(edit.id);
      setEdit((e) => e ? { ...e, hookId: res.hookId } : e);
      toast.success('已重新生成');
      loadRules();
    } catch (err) {
      toast.error('操作失败', String(err));
    }
  };

  const handleTrigger = async () => {
    if (!triggerRuleId) return;
    setTriggering(true);
    try {
      const result = await automationsService.triggerRule(triggerRuleId, {
        title: triggerTitle || '手动触发测试',
        content: triggerContent || '这是一条手动触发的测试通知',
      });
      if (result.allSucceeded) toast.success('触发成功');
      else toast.error('部分动作失败');
      setTriggerRuleId(null);
      loadRules();
    } catch (err) {
      toast.error('触发失败', String(err));
    } finally {
      setTriggering(false);
    }
  };

  // ── 编辑器辅助 ──

  const patchEdit = (patch: Partial<EditState>) => setEdit((e) => e ? { ...e, ...patch } : e);
  const addAction = (type: string) => {
    if (!edit) return;
    patchEdit({
      actions: [...edit.actions, {
        type,
        ...(type === 'webhook' ? { webhookUrl: '' } : {}),
        ...(type === 'admin_notification' ? { notifyUserIds: [], notifyLevel: 'info' } : {}),
      }],
    });
  };
  const removeAction = (idx: number) => patchEdit({ actions: edit!.actions.filter((_, i) => i !== idx) });
  const updateAction = (idx: number, patch: Partial<AutomationAction>) =>
    patchEdit({ actions: edit!.actions.map((a, i) => i === idx ? { ...a, ...patch } : a) });

  // ══════════════════ 渲染 ══════════════════

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-x-hidden">
      {/* 主从面板 */}
      <GlassCard animated glow className="flex-1 min-h-0 overflow-hidden">
        <div className="grid h-full" style={{ gridTemplateColumns: isMobile ? '1fr' : '280px minmax(0, 1fr)', gridTemplateRows: isMobile ? 'auto minmax(0, 1fr)' : undefined }}>

          {/* ── 左侧：规则列表 ── */}
          <div className="min-h-0 flex flex-col" style={{ borderRight: isMobile ? 'none' : '1px solid var(--nested-block-border)', borderBottom: isMobile ? '1px solid var(--nested-block-border)' : 'none', maxHeight: isMobile ? '40vh' : undefined, height: isMobile ? 'auto' : '100%' }}>
            {/* 列表头 */}
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--nested-block-border)' }}>
              <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                自动化规则 ({rules.length})
              </span>
              <div ref={newMenuRef} className="relative">
                <button
                  onClick={() => setShowNewMenu(!showNewMenu)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors hover:bg-white/8"
                  style={{ color: 'rgba(59,130,246,0.9)' }}
                >
                  <Plus size={14} /> 新建
                </button>
                {showNewMenu && (
                  <div className="absolute right-0 top-full mt-1 z-[120] w-48 rounded-[12px] overflow-hidden" style={selectContentStyle}>
                    <div className="p-1">
                      <button onClick={() => handleNew('event')}
                        className={selectItemClass + ' w-full text-left flex items-center gap-2'}
                        style={{ color: 'var(--text-primary)' }}>
                        <Zap size={14} style={{ color: 'rgba(59,130,246,0.8)' }} />
                        <div>
                          <div className="text-sm">事件触发</div>
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>系统事件自动触发</div>
                        </div>
                      </button>
                      <button onClick={() => handleNew('incoming_webhook')}
                        className={selectItemClass + ' w-full text-left flex items-center gap-2'}
                        style={{ color: 'var(--text-primary)' }}>
                        <Link size={14} style={{ color: 'rgba(34,197,94,0.8)' }} />
                        <div>
                          <div className="text-sm">传入 Webhook</div>
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>外部系统 POST 触发</div>
                        </div>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 列表内容 */}
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 size={18} className="animate-spin text-muted-foreground" />
              </div>
            ) : rules.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 px-4">
                <Zap size={24} className="opacity-30" />
                <p className="text-xs text-center">暂无规则，点击上方新建</p>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
                {rules.map((rule) => {
                  const selected = edit?.id === rule.id;
                  const isWebhook = rule.triggerType === 'incoming_webhook';
                  return (
                    <div
                      key={rule.id}
                      onClick={() => handleSelectRule(rule)}
                      className="w-full text-left px-3 py-2.5 rounded-[10px] transition-all cursor-pointer"
                      style={{
                        background: selected ? 'rgba(59,130,246,0.1)' : 'transparent',
                        border: selected ? '1px solid rgba(59,130,246,0.25)' : '1px solid transparent',
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex-shrink-0" style={{ color: isWebhook ? 'rgba(34,197,94,0.7)' : 'rgba(59,130,246,0.7)' }}>
                          {isWebhook ? <Link size={13} /> : <Zap size={13} />}
                        </span>
                        <span className="text-sm font-medium truncate flex-1" style={{ opacity: rule.enabled ? 1 : 0.45 }}>{rule.name}</span>
                        <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
                          <Switch checked={rule.enabled} onCheckedChange={() => handleToggle(rule.id)} ariaLabel="启用" />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 ml-[21px]">
                        {rule.actions.map((a, i) => (
                          <span key={i} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full"
                            style={{ background: 'var(--bg-input-hover)' }}>
                            {actionTypeIcons[a.type]}
                            {actionTypeLabels[a.type]}
                          </span>
                        ))}
                        <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                          {rule.triggerCount}次
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── 右侧：编辑面板 ── */}
          <div className="h-full min-h-0 flex flex-col">
            {!edit ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2">
                <Zap size={28} className="opacity-20" />
                <p className="text-sm opacity-60">选择规则或新建</p>
              </div>
            ) : (
              <>
                {/* 编辑器头部 */}
                <div className="flex items-center gap-3 px-5 py-3" style={{ borderBottom: '1px solid var(--nested-block-border)' }}>
                  <span className="flex-shrink-0" style={{ color: edit.triggerType === 'incoming_webhook' ? 'rgba(34,197,94,0.7)' : 'rgba(59,130,246,0.7)' }}>
                    {triggerTypeIcon[edit.triggerType]}
                  </span>
                  <input
                    value={edit.name}
                    onChange={(e) => patchEdit({ name: e.target.value })}
                    placeholder="规则名称"
                    className="flex-1 text-sm font-semibold bg-transparent outline-none"
                    style={{ color: 'var(--text-primary)' }}
                  />
                  <span className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0" style={{
                    background: edit.triggerType === 'incoming_webhook' ? 'rgba(34,197,94,0.08)' : 'rgba(59,130,246,0.08)',
                    color: edit.triggerType === 'incoming_webhook' ? 'rgba(34,197,94,0.8)' : 'rgba(59,130,246,0.8)',
                    border: `1px solid ${edit.triggerType === 'incoming_webhook' ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.15)'}`,
                  }}>
                    {triggerTypeLabel[edit.triggerType]}
                  </span>
                </div>

                {/* 编辑器内容 */}
                <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
                  {/* 流程预览 */}
                  <WorkflowProgressBar
                    steps={getFlowSteps(edit.triggerType, edit.actions)}
                    currentStep={3}
                    allCompleted
                  />

                  {/* ── 事件选择 ── */}
                  {edit.triggerType === 'event' && (
                    <div>
                      <SectionTitle>触发事件</SectionTitle>
                      <SearchableSelect
                        value={edit.eventType}
                        onValueChange={(v) => patchEdit({ eventType: v })}
                        placeholder="选择事件..."
                        leftIcon={<Zap size={14} />}
                        options={eventTypes.map((et) => ({
                          value: et.eventType,
                          label: `[${et.category}] ${et.label}`,
                          displayLabel: et.label,
                        }))}
                      />
                    </div>
                  )}

                  {/* ── Hook URL（传入 Webhook） ── */}
                  {edit.triggerType === 'incoming_webhook' && edit.hookId && (
                    <div>
                      <SectionTitle>Webhook URL</SectionTitle>
                      <HookUrlDisplay hookId={edit.hookId} onRegenerate={handleRegenerateHook} />
                    </div>
                  )}

                  {/* ── 消息模板（仅传入 Webhook） ── */}
                  {edit.triggerType === 'incoming_webhook' && (
                    <div>
                      <SectionTitle>消息模板</SectionTitle>
                      <div className="space-y-2">
                        <input
                          value={edit.titleTemplate}
                          onChange={(e) => patchEdit({ titleTemplate: e.target.value })}
                          placeholder="标题模板，如：{{username}} 触发了 {{action}}"
                          className={inputCls} style={inputStyle}
                        />
                        <textarea
                          value={edit.contentTemplate}
                          onChange={(e) => patchEdit({ contentTemplate: e.target.value })}
                          placeholder="内容模板，如：用户 {{username}} 在仓库 {{repo}} 推送了代码"
                          className={inputCls + ' h-20 resize-none'} style={inputStyle}
                        />
                      </div>
                      <div className="mt-2 p-2.5 rounded-[10px] text-xs" style={{ background: 'rgba(168,85,247,0.05)', border: '1px solid rgba(168,85,247,0.1)' }}>
                        <div className="font-medium mb-1" style={{ color: 'rgba(168,85,247,0.9)' }}>示例</div>
                        <div style={{ color: 'var(--text-muted)' }}>
                          POST <code className="px-1 py-0.5 rounded bg-white/5">{`{"username":"张三","repo":"my-project"}`}</code>
                        </div>
                        <div className="mt-0.5" style={{ color: 'rgba(34,197,94,0.8)' }}>
                          渲染 → 用户 张三 推送到 my-project
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── 执行动作 ── */}
                  <div>
                    <SectionTitle>执行动作</SectionTitle>
                    <div className="space-y-2">
                      {edit.actions.map((action, idx) => (
                        <div key={idx} className="p-3 rounded-[12px] space-y-2"
                          style={{ background: 'var(--list-item-bg)', border: '1px solid var(--border-subtle)' }}>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium flex items-center gap-1.5">
                              {actionTypeIcons[action.type]}
                              {actionTypeLabels[action.type]}
                            </span>
                            <button onClick={() => removeAction(idx)} className="text-muted-foreground hover:text-red-400 transition-colors">
                              <X size={14} />
                            </button>
                          </div>
                          {action.type === 'webhook' && (
                            <div className="space-y-2">
                              <input value={action.webhookUrl || ''} onChange={(e) => updateAction(idx, { webhookUrl: e.target.value })}
                                placeholder="https://example.com/webhook" className={inputCls} style={inputStyle} />
                              <input value={action.webhookSecret || ''} onChange={(e) => updateAction(idx, { webhookSecret: e.target.value })}
                                placeholder="Bearer 凭证（可选）" className={inputCls} style={inputStyle} />
                            </div>
                          )}
                          {action.type === 'admin_notification' && (
                            <div className="space-y-2">
                              <select value={action.notifyLevel || 'info'} onChange={(e) => updateAction(idx, { notifyLevel: e.target.value })}
                                className={inputCls} style={inputStyle}>
                                <option value="info">信息</option>
                                <option value="warning">警告</option>
                                <option value="error">错误</option>
                              </select>
                              <UserMultiSelect allUsers={notifyTargets} selectedIds={action.notifyUserIds || []}
                                onChange={(ids) => updateAction(idx, { notifyUserIds: ids })} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <Button variant="secondary" size="sm" onClick={() => addAction('webhook')}>
                        <ExternalLink size={12} /> 传出 Webhook
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => addAction('admin_notification')}>
                        <Bell size={12} /> 站内信
                      </Button>
                    </div>
                  </div>
                </div>

                {/* 底部操作栏 */}
                <div className="flex flex-wrap items-center gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--nested-block-border)' }}>
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    {edit.id ? '保存' : '创建'}
                  </Button>
                  {edit.id && (
                    <Button variant="secondary" size="sm" onClick={() => { setTriggerRuleId(edit.id!); setTriggerTitle(''); setTriggerContent(''); }}>
                      <Play size={14} /> 测试
                    </Button>
                  )}
                  <div className="flex-1" />
                  <Button variant="secondary" size="sm" onClick={handleDelete} className="text-red-400 hover:text-red-300">
                    <Trash2 size={14} /> {edit.id ? '删除' : '取消'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </GlassCard>

      {/* 手动触发浮层 */}
      {triggerRuleId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setTriggerRuleId(null); }}>
          <div className="w-[400px] max-w-[calc(100vw-2rem)] rounded-[16px] p-5 space-y-3" style={{
            ...glassPopoverCompact,
            background: 'rgba(25,25,30,0.95)', border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}>
            <div className="text-sm font-semibold">手动触发</div>
            <input value={triggerTitle} onChange={(e) => setTriggerTitle(e.target.value)}
              placeholder="标题（可选）" className={inputCls} style={inputStyle} />
            <textarea value={triggerContent} onChange={(e) => setTriggerContent(e.target.value)}
              placeholder="内容（可选）" className={inputCls + ' h-20 resize-none'} style={inputStyle} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setTriggerRuleId(null)}>取消</Button>
              <Button size="sm" onClick={handleTrigger} disabled={triggering}>
                {triggering ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} 触发
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
