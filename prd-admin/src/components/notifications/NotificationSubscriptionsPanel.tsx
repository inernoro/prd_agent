import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, Info, Save, Settings2 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  getAdminPushSubscriptions,
  testAdminPushSubscription,
  updateAdminPushSubscription,
} from '@/services';
import type {
  AdminPushPresetDefinition,
  AdminPushResourceDefinition,
  AdminPushSubscription,
  AdminPushTopicDefinition,
  UpdateAdminPushSubscriptionRequest,
} from '@/services/contracts/notifications';

type DraftMap = Record<string, UpdateAdminPushSubscriptionRequest>;

export const DEFAULT_NOTIFICATION_PUSH_DRAFT: UpdateAdminPushSubscriptionRequest = {
  enabled: false,
  channelType: 'url',
  method: 'GET',
  urlTemplate: '',
  bodyTemplate: '',
  contentType: 'application/json',
  barkKey: '',
  barkServerUrl: 'https://api.day.app',
  barkGroup: 'MAP System-{{appname}}',
  barkSound: '',
  barkLevel: '',
  barkIcon: '',
  barkImageTemplate: '{{imageUrl}}',
  barkUrlTemplate: '{{actionUrl}}',
  barkCall: false,
};

function toDraft(subscription: AdminPushSubscription): UpdateAdminPushSubscriptionRequest {
  return {
    enabled: subscription.enabled,
    channelType: subscription.channelType || 'url',
    method: subscription.method || 'GET',
    urlTemplate: subscription.urlTemplate || '',
    bodyTemplate: subscription.bodyTemplate || '',
    contentType: subscription.contentType || 'application/json',
    barkKey: subscription.barkKey || '',
    barkServerUrl: subscription.barkServerUrl || 'https://api.day.app',
    barkGroup: subscription.barkGroup || 'MAP System-{{appname}}',
    barkSound: subscription.barkSound || '',
    barkLevel: subscription.barkLevel || '',
    barkIcon: subscription.barkIcon || '',
    barkImageTemplate: subscription.barkImageTemplate || '{{imageUrl}}',
    barkUrlTemplate: subscription.barkUrlTemplate || '{{actionUrl}}',
    barkCall: Boolean(subscription.barkCall),
  };
}

export function buildNotificationPushDraftFromPreset(preset: AdminPushPresetDefinition, enabled: boolean): UpdateAdminPushSubscriptionRequest {
  return {
    enabled,
    channelType: preset.channelType,
    method: preset.method,
    urlTemplate: preset.urlTemplate,
    bodyTemplate: preset.bodyTemplate || '',
    contentType: preset.contentType || 'application/json',
    barkKey: '',
    barkServerUrl: 'https://api.day.app',
    barkGroup: 'MAP System-{{appname}}',
    barkSound: '',
    barkLevel: '',
    barkIcon: '',
    barkImageTemplate: '{{imageUrl}}',
    barkUrlTemplate: '{{actionUrl}}',
    barkCall: false,
  };
}

export function getSelectedNotificationPushPresetKey(draft: UpdateAdminPushSubscriptionRequest, presets: AdminPushPresetDefinition[]) {
  const matched = presets.find(
    (preset) =>
      preset.channelType === draft.channelType &&
      preset.method === draft.method &&
      preset.urlTemplate === draft.urlTemplate &&
      (preset.bodyTemplate || '') === (draft.bodyTemplate || '')
  );
  return matched?.key ?? 'custom';
}

export function NotificationSubscriptionsPanel() {
  const [topics, setTopics] = useState<AdminPushTopicDefinition[]>([]);
  const [presets, setPresets] = useState<AdminPushPresetDefinition[]>([]);
  const [resources, setResources] = useState<AdminPushResourceDefinition[]>([]);
  const [placeholders, setPlaceholders] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setLoading(true);
    const res = await getAdminPushSubscriptions();
    if (loadSeqRef.current !== seq) return;
    if (res.success) {
      setTopics(res.data.topics ?? []);
      setPresets(res.data.presets ?? []);
      setResources(res.data.resources ?? []);
      setPlaceholders(res.data.placeholders ?? []);
      const next: DraftMap = {};
      for (const sub of res.data.subscriptions ?? []) {
        next[sub.topicKey] = toDraft(sub);
      }
      setDrafts(next);
    } else {
      setMessage(res.error?.message || '加载推送订阅失败');
    }
    if (loadSeqRef.current === seq) setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateDraft = useCallback((topicKey: string, patch: Partial<UpdateAdminPushSubscriptionRequest>) => {
    setDrafts((prev) => ({
      ...prev,
      [topicKey]: {
        ...DEFAULT_NOTIFICATION_PUSH_DRAFT,
        ...(prev[topicKey] ?? {}),
        ...patch,
      },
    }));
  }, []);

  const saveTopic = useCallback(async (topicKey: string) => {
    const draft = drafts[topicKey];
    if (!draft) return;
    setSavingKey(topicKey);
    setMessage(null);
    const res = await updateAdminPushSubscription(topicKey, draft);
    if (res.success) {
      setDrafts((prev) => ({ ...prev, [topicKey]: toDraft(res.data.subscription) }));
      setMessage('推送订阅已保存');
    } else {
      setMessage(res.error?.message || '保存失败');
    }
    setSavingKey(null);
  }, [drafts]);

  const testTopic = useCallback(async (topicKey: string) => {
    const draft = drafts[topicKey];
    if (!draft) return;
    setTestingKey(topicKey);
    setMessage(null);
    const res = await testAdminPushSubscription(topicKey, draft);
    if (res.success) {
      const delivery = res.data.delivery;
      setMessage(delivery.success ? `测试发送成功，HTTP ${delivery.statusCode ?? 'OK'}` : delivery.errorMessage || '测试发送失败');
    } else {
      setMessage(res.error?.message || '测试发送失败');
    }
    setTestingKey(null);
  }, [drafts]);

  const firstPreset = presets[0];
  const resourcesByKey = useMemo(() => new Map(resources.map((x) => [x.key, x])), [resources]);
  const placeholderText = useMemo(() => placeholders.map((x) => `{{${x}}}`).join('  '), [placeholders]);

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <MapSpinner size={22} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div
        className="rounded-[12px] border px-3 py-2 text-[12px] leading-relaxed"
        style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
      >
        <div className="flex items-start gap-2">
          <Info size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div style={{ color: 'var(--text-primary)' }}>支持 URL 请求、通用 Webhook、企业微信、飞书、钉钉等推送方式。</div>
            <div className="mt-1 break-words">可用占位符：{placeholderText}</div>
          </div>
        </div>
      </div>

      {resources.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {resources.map((resource) => (
            <div
              key={resource.key}
              className="flex min-w-0 items-center gap-2 rounded-[10px] border px-2.5 py-2"
              style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)' }}
            >
              <img src={resource.iconUrl} alt="" className="h-8 w-8 shrink-0 rounded-[8px] object-cover" />
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{resource.appName}</div>
                <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{resource.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {message && (
        <div
          className="rounded-[10px] border px-3 py-2 text-[12px]"
          style={{ borderColor: 'rgba(99,102,241,0.35)', background: 'rgba(99,102,241,0.1)', color: 'var(--text-primary)' }}
        >
          {message}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto pr-2 space-y-3" style={{ overscrollBehavior: 'contain' }}>
        {topics.map((topic) => {
          const draft = drafts[topic.key] ?? (firstPreset ? buildNotificationPushDraftFromPreset(firstPreset, false) : DEFAULT_NOTIFICATION_PUSH_DRAFT);
          const selectedPresetKey = getSelectedNotificationPushPresetKey(draft, presets);
          const isBark = draft.channelType === 'bark';
          const isPost = String(draft.method).toUpperCase() === 'POST';
          const resource = resourcesByKey.get(topic.resourceKey);
          return (
            <section
              key={topic.key}
              className="rounded-[14px] border px-4 py-3"
              style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.045)' }}
            >
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Settings2 size={15} style={{ color: 'var(--accent-gold)' }} />
                      <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {topic.label}
                      </div>
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px]"
                        style={{
                          background: draft.enabled ? 'rgba(34,197,94,0.14)' : 'rgba(255,255,255,0.06)',
                          color: draft.enabled ? '#86efac' : 'var(--text-muted)',
                        }}
                      >
                        {draft.enabled ? '已启用' : '未启用'}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {topic.description}
                    </div>
                    {resource && (
                      <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]" style={{ borderColor: 'rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}>
                        <img src={resource.iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-[4px] object-cover" />
                        <span className="truncate">{resource.appName}</span>
                      </div>
                    )}
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-indigo-400"
                      checked={draft.enabled}
                      onChange={(e) => updateDraft(topic.key, { enabled: e.target.checked })}
                    />
                    接收外部推送
                  </label>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1.2fr_0.7fr_0.8fr]">
                  <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    推送方式
                    <select
                      className="h-9 rounded-[8px] border px-2 text-[12px] outline-none"
                      style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                      value={selectedPresetKey}
                      onChange={(e) => {
                        const preset = presets.find((item) => item.key === e.target.value);
                        if (preset) updateDraft(topic.key, buildNotificationPushDraftFromPreset(preset, draft.enabled));
                      }}
                    >
                      {selectedPresetKey === 'custom' && <option value="custom">自定义模板</option>}
                      {presets.map((preset) => (
                        <option key={preset.key} value={preset.key}>{preset.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    请求方式
                    <select
                      className="h-9 rounded-[8px] border px-2 text-[12px] outline-none"
                      style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                      value={draft.method}
                      disabled={isBark}
                      onChange={(e) => updateDraft(topic.key, { method: e.target.value as 'GET' | 'POST' })}
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </select>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Content-Type
                    <input
                      className="h-9 rounded-[8px] border px-2 text-[12px] outline-none"
                      style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                      value={draft.contentType}
                      disabled={isBark}
                      onChange={(e) => updateDraft(topic.key, { contentType: e.target.value })}
                    />
                  </label>
                </div>

                {isBark ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                      <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Bark Key
                        <input
                          className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                          style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                          placeholder="只填写 Bark 推送 Key"
                          value={draft.barkKey || ''}
                          onChange={(e) => updateDraft(topic.key, { barkKey: e.target.value })}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Bark 服务地址
                        <input
                          className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                          style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                          value={draft.barkServerUrl || 'https://api.day.app'}
                          onChange={(e) => updateDraft(topic.key, { barkServerUrl: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[1fr_0.8fr_0.8fr]">
                      <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        分组模板
                        <input
                          className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                          style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                          value={draft.barkGroup || ''}
                          onChange={(e) => updateDraft(topic.key, { barkGroup: e.target.value })}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        声音
                        <input
                          className="h-9 rounded-[8px] border px-2 text-[12px] outline-none"
                          style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                          placeholder="默认"
                          value={draft.barkSound || ''}
                          onChange={(e) => updateDraft(topic.key, { barkSound: e.target.value })}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        时效级别
                        <select
                          className="h-9 rounded-[8px] border px-2 text-[12px] outline-none"
                          style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                          value={draft.barkLevel || ''}
                          onChange={(e) => updateDraft(topic.key, { barkLevel: e.target.value })}
                        >
                          <option value="">默认</option>
                          <option value="active">active</option>
                          <option value="timeSensitive">timeSensitive</option>
                          <option value="passive">passive</option>
                          <option value="critical">critical</option>
                        </select>
                      </label>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                      <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        跳转 URL 模板
                        <input
                          className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                          style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                          value={draft.barkUrlTemplate || ''}
                          onChange={(e) => updateDraft(topic.key, { barkUrlTemplate: e.target.value })}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        图标 URL 模板
                        <input
                          className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                          style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                          value={draft.barkIcon || ''}
                          onChange={(e) => updateDraft(topic.key, { barkIcon: e.target.value })}
                        />
                      </label>
                    </div>
                    <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      图片 URL 模板
                      <input
                        className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                        style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                        value={draft.barkImageTemplate || ''}
                        onChange={(e) => updateDraft(topic.key, { barkImageTemplate: e.target.value })}
                      />
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-indigo-400"
                        checked={Boolean(draft.barkCall)}
                        onChange={(e) => updateDraft(topic.key, { barkCall: e.target.checked })}
                      />
                      发送响铃通知
                    </label>
                  </>
                ) : (
                  <>
                    <label className="flex flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      URL 模板
                      <input
                        className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                        style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                        placeholder="https://api.day.app/YOUR_KEY/MAP System-{{appname}}/{{message}}"
                        value={draft.urlTemplate}
                        onChange={(e) => updateDraft(topic.key, { urlTemplate: e.target.value })}
                      />
                    </label>

                    {isPost && (
                      <label className="flex flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Body 模板
                        <textarea
                          className="min-h-[82px] resize-y rounded-[8px] border px-2 py-2 font-mono text-[12px] leading-relaxed outline-none"
                          style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                          value={draft.bodyTemplate || ''}
                          onChange={(e) => updateDraft(topic.key, { bodyTemplate: e.target.value })}
                        />
                      </label>
                    )}
                  </>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <CheckCircle2 size={12} />
                    模板保存后会对新站内通知自动去重投递
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-all hover:bg-white/15 active:scale-[0.97] disabled:opacity-60"
                      style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
                      onClick={() => testTopic(topic.key)}
                      disabled={testingKey === topic.key || savingKey === topic.key}
                    >
                      {testingKey === topic.key ? <MapSpinner size={12} /> : <FlaskConical size={13} />}
                      测试
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-all hover:brightness-110 active:scale-[0.97] disabled:opacity-60"
                      style={{ background: 'var(--accent-gold)', color: '#1a1a1a' }}
                      onClick={() => saveTopic(topic.key)}
                      disabled={savingKey === topic.key || testingKey === topic.key}
                    >
                      {savingKey === topic.key ? <MapSpinner size={12} color="#1a1a1a" /> : <Save size={13} />}
                      保存
                    </button>
                  </div>
                </div>
              </div>
            </section>
          );
        })}

        {topics.length === 0 && (
          <div className="rounded-[14px] border border-dashed border-white/10 px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            还没有可订阅的通知来源
          </div>
        )}
      </div>
    </div>
  );
}
