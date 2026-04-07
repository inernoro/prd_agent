import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Plus, Trash2, TestTube, Pencil, Check, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  listReportTeams,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
} from '@/services';
import type { ReportTeam, ReportWebhookConfig } from '@/services/contracts/reportAgent';
import {
  WebhookChannelLabels,
  ReportEventLabels,
  ReportEventTypes,
  WebhookChannels,
} from '@/services/contracts/reportAgent';

const CHANNEL_OPTIONS = [
  { value: WebhookChannels.WeCom, label: '企业微信' },
  { value: WebhookChannels.DingTalk, label: '钉钉' },
  { value: WebhookChannels.Feishu, label: '飞书' },
  { value: WebhookChannels.Custom, label: '自定义' },
];

const ALL_EVENTS = Object.values(ReportEventTypes);

function pickManageableTeams(items: ReportTeam[]): ReportTeam[] {
  const manageable = items.filter((team) =>
    team.canManageMembers
    || team.relationType === 'managed'
    || team.myRole === 'leader'
    || team.myRole === 'deputy'
  );
  return manageable.length > 0 ? manageable : items;
}

export function WebhookSettingsPanel() {
  const [loadingTeams, setLoadingTeams] = useState(true);
  const [teams, setTeams] = useState<ReportTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');

  const [webhooks, setWebhooks] = useState<ReportWebhookConfig[]>([]);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);

  // Create form state
  const [showForm, setShowForm] = useState(false);
  const [formChannel, setFormChannel] = useState(WebhookChannels.WeCom);
  const [formUrl, setFormUrl] = useState('');
  const [formName, setFormName] = useState('');
  const [formEvents, setFormEvents] = useState<string[]>([...ALL_EVENTS]);
  const [creating, setCreating] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEvents, setEditEvents] = useState<string[]>([]);

  const [testingUrl, setTestingUrl] = useState<string | null>(null);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.id === selectedTeamId) ?? null,
    [selectedTeamId, teams]
  );

  const loadTeams = useCallback(async () => {
    setLoadingTeams(true);
    const res = await listReportTeams();
    setLoadingTeams(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '加载团队失败');
      return;
    }
    const items = pickManageableTeams(res.data.items ?? []);
    setTeams(items);
    setSelectedTeamId((prev) => {
      if (prev && items.some((t) => t.id === prev)) return prev;
      return items[0]?.id ?? '';
    });
  }, []);

  const loadWebhooks = useCallback(async (teamId: string) => {
    if (!teamId) return;
    setLoadingWebhooks(true);
    const res = await listWebhooks({ teamId });
    setLoadingWebhooks(false);
    if (res.success && res.data) setWebhooks(res.data.items);
  }, []);

  useEffect(() => { void loadTeams(); }, [loadTeams]);
  useEffect(() => { void loadWebhooks(selectedTeamId); }, [selectedTeamId, loadWebhooks]);

  const handleCreate = async () => {
    if (!formUrl.trim()) { toast.error('请输入 Webhook URL'); return; }
    if (formEvents.length === 0) { toast.error('请至少选择一个事件'); return; }
    setCreating(true);
    const res = await createWebhook({
      teamId: selectedTeamId,
      channel: formChannel,
      webhookUrl: formUrl.trim(),
      triggerEvents: formEvents,
      name: formName.trim() || undefined,
    });
    setCreating(false);
    if (res.success) {
      toast.success('Webhook 创建成功');
      setShowForm(false);
      setFormUrl('');
      setFormName('');
      setFormEvents([...ALL_EVENTS]);
      void loadWebhooks(selectedTeamId);
    } else {
      toast.error(res.error?.message || '创建失败');
    }
  };

  const handleDelete = async (wh: ReportWebhookConfig) => {
    const ok = await systemDialog.confirm({
      title: '确认删除此 Webhook？',
      message: `删除后将不再推送到 ${WebhookChannelLabels[wh.channel] || wh.channel}`,
      tone: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteWebhook({ teamId: selectedTeamId, webhookId: wh.id });
    if (res.success) {
      toast.success('已删除');
      void loadWebhooks(selectedTeamId);
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const handleToggle = async (wh: ReportWebhookConfig) => {
    const res = await updateWebhook({
      teamId: selectedTeamId,
      webhookId: wh.id,
      isEnabled: !wh.isEnabled,
    });
    if (res.success) {
      toast.success(wh.isEnabled ? '已禁用' : '已启用');
      void loadWebhooks(selectedTeamId);
    }
  };

  const handleTest = async (wh: ReportWebhookConfig) => {
    setTestingUrl(wh.id);
    const res = await testWebhook({
      teamId: selectedTeamId,
      webhookUrl: wh.webhookUrl,
      channel: wh.channel,
    });
    setTestingUrl(null);
    if (res.success && res.data?.success) {
      toast.success('测试消息发送成功');
    } else {
      toast.error(res.data?.error || res.error?.message || '测试失败');
    }
  };

  const handleSaveEvents = async (wh: ReportWebhookConfig) => {
    const res = await updateWebhook({
      teamId: selectedTeamId,
      webhookId: wh.id,
      triggerEvents: editEvents,
    });
    if (res.success) {
      toast.success('事件配置已更新');
      setEditingId(null);
      void loadWebhooks(selectedTeamId);
    } else {
      toast.error(res.error?.message || '更新失败');
    }
  };

  const toggleEvent = (event: string) => {
    setEditEvents((prev) =>
      prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event]
    );
  };

  const toggleFormEvent = (event: string) => {
    setFormEvents((prev) =>
      prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event]
    );
  };

  if (loadingTeams) {
    return <div className="flex items-center justify-center py-20"><MapSpinner size={32} /></div>;
  }
  if (teams.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        暂无可管理的团队
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Team selector */}
      {teams.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>团队</span>
          <select
            className="text-[13px] px-2 py-1 rounded-md border"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-primary)',
            }}
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell size={16} style={{ color: 'var(--text-secondary)' }} />
          <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Webhook 通知 {selectedTeam ? `— ${selectedTeam.name}` : ''}
          </span>
        </div>
        {!showForm && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus size={14} /> 添加
          </Button>
        )}
      </div>

      <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        配置 Webhook 后，周报事件（提交、审阅、截止提醒等）将自动推送到企微/钉钉/飞书群聊。
      </div>

      {/* Create form */}
      {showForm && (
        <GlassCard padding="md">
          <div className="flex flex-col gap-3">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              新建 Webhook
            </div>

            {/* Channel */}
            <div className="flex flex-col gap-1">
              <label className="text-[12px]" style={{ color: 'var(--text-muted)' }}>渠道</label>
              <select
                className="text-[13px] px-2 py-1.5 rounded-md border"
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)',
                }}
                value={formChannel}
                onChange={(e) => setFormChannel(e.target.value as typeof formChannel)}
              >
                {CHANNEL_OPTIONS.map((ch) => (
                  <option key={ch.value} value={ch.value}>{ch.label}</option>
                ))}
              </select>
            </div>

            {/* Name */}
            <div className="flex flex-col gap-1">
              <label className="text-[12px]" style={{ color: 'var(--text-muted)' }}>备注名称（可选）</label>
              <input
                type="text"
                className="text-[13px] px-2 py-1.5 rounded-md border"
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)',
                }}
                placeholder="如：前端群、管理群"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>

            {/* URL */}
            <div className="flex flex-col gap-1">
              <label className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Webhook URL</label>
              <input
                type="url"
                className="text-[13px] px-2 py-1.5 rounded-md border"
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)',
                }}
                placeholder="粘贴群机器人的 Webhook URL"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
              />
            </div>

            {/* Events */}
            <div className="flex flex-col gap-1">
              <label className="text-[12px]" style={{ color: 'var(--text-muted)' }}>触发事件</label>
              <div className="flex flex-wrap gap-1.5">
                {ALL_EVENTS.map((evt) => (
                  <button
                    key={evt}
                    type="button"
                    className="px-2 py-0.5 rounded-full text-[11px] border cursor-pointer transition-colors"
                    style={{
                      borderColor: formEvents.includes(evt) ? 'rgba(59, 130, 246, 0.5)' : 'var(--border-primary)',
                      background: formEvents.includes(evt) ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                      color: formEvents.includes(evt) ? 'rgba(59, 130, 246, 0.9)' : 'var(--text-muted)',
                    }}
                    onClick={() => toggleFormEvent(evt)}
                  >
                    {ReportEventLabels[evt] || evt}
                  </button>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={handleCreate} disabled={creating}>
                {creating ? <MapSpinner size={14} /> : <Check size={14} />}
                创建
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                取消
              </Button>
            </div>
          </div>
        </GlassCard>
      )}

      {/* Webhook list */}
      {loadingWebhooks ? (
        <div className="flex items-center justify-center py-10"><MapSpinner size={24} /></div>
      ) : webhooks.length === 0 && !showForm ? (
        <GlassCard padding="md">
          <div className="text-center py-6 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            暂未配置 Webhook，点击「添加」创建
          </div>
        </GlassCard>
      ) : (
        <div className="flex flex-col gap-2">
          {webhooks.map((wh) => (
            <GlassCard key={wh.id} padding="md">
              <div className="flex flex-col gap-2">
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="px-1.5 py-0.5 rounded text-[11px] font-medium"
                      style={{
                        background: wh.isEnabled ? 'rgba(34, 197, 94, 0.1)' : 'rgba(156, 163, 175, 0.1)',
                        color: wh.isEnabled ? 'rgba(34, 197, 94, 0.9)' : 'rgba(156, 163, 175, 0.7)',
                      }}
                    >
                      {WebhookChannelLabels[wh.channel] || wh.channel}
                    </span>
                    {wh.name && (
                      <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {wh.name}
                      </span>
                    )}
                    <span
                      className="text-[11px]"
                      style={{ color: wh.isEnabled ? 'rgba(34, 197, 94, 0.7)' : 'rgba(156, 163, 175, 0.6)' }}
                    >
                      {wh.isEnabled ? '已启用' : '已禁用'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className="p-1 rounded hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                      title="测试"
                      onClick={() => handleTest(wh)}
                      disabled={testingUrl === wh.id}
                    >
                      {testingUrl === wh.id ? <MapSpinner size={14} /> : <TestTube size={14} style={{ color: 'var(--text-muted)' }} />}
                    </button>
                    <button
                      className="p-1 rounded hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                      title={wh.isEnabled ? '禁用' : '启用'}
                      onClick={() => handleToggle(wh)}
                    >
                      <Bell size={14} style={{ color: wh.isEnabled ? 'rgba(34, 197, 94, 0.7)' : 'var(--text-muted)' }} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                      title="编辑事件"
                      onClick={() => { setEditingId(wh.id); setEditEvents([...wh.triggerEvents]); }}
                    >
                      <Pencil size={14} style={{ color: 'var(--text-muted)' }} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                      title="删除"
                      onClick={() => handleDelete(wh)}
                    >
                      <Trash2 size={14} style={{ color: 'rgba(239, 68, 68, 0.7)' }} />
                    </button>
                  </div>
                </div>

                {/* URL */}
                <div
                  className="text-[11px] truncate"
                  style={{ color: 'var(--text-muted)', maxWidth: '100%' }}
                  title={wh.webhookUrl}
                >
                  {wh.webhookUrl}
                </div>

                {/* Events */}
                {editingId === wh.id ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      {ALL_EVENTS.map((evt) => (
                        <button
                          key={evt}
                          type="button"
                          className="px-2 py-0.5 rounded-full text-[11px] border cursor-pointer transition-colors"
                          style={{
                            borderColor: editEvents.includes(evt) ? 'rgba(59, 130, 246, 0.5)' : 'var(--border-primary)',
                            background: editEvents.includes(evt) ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                            color: editEvents.includes(evt) ? 'rgba(59, 130, 246, 0.9)' : 'var(--text-muted)',
                          }}
                          onClick={() => toggleEvent(evt)}
                        >
                          {ReportEventLabels[evt] || evt}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => handleSaveEvents(wh)}>
                        <Check size={12} /> 保存
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X size={12} /> 取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {wh.triggerEvents.map((evt) => (
                      <span
                        key={evt}
                        className="px-1.5 py-0.5 rounded text-[10px]"
                        style={{
                          background: 'rgba(59, 130, 246, 0.08)',
                          color: 'rgba(59, 130, 246, 0.7)',
                        }}
                      >
                        {ReportEventLabels[evt] || evt}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
