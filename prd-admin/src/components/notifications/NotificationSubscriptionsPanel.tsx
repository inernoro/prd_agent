import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, Save, Settings2, SlidersHorizontal } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  getAdminPushSubscriptions,
  testAdminPushSubscription,
  updateAdminPushProfile,
  updateAdminPushSubscription,
} from '@/services';
import type {
  AdminPushPresetDefinition,
  AdminPushProfile,
  AdminPushResourceDefinition,
  AdminPushSubscription,
  AdminPushTopicDefinition,
  UpdateAdminPushProfileRequest,
  UpdateAdminPushSubscriptionRequest,
} from '@/services/contracts/notifications';

type DraftMap = Record<string, UpdateAdminPushSubscriptionRequest>;

const TOPIC_WORKFLOW_ORDER = [
  'defect-management',
  'system-alert',
  'admin-message',
  'server-expiry',
  'user-voice',
  'api-request-alert',
  'report-agent',
];

export const DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT: UpdateAdminPushProfileRequest = {
  channelType: 'bark',
  method: 'GET',
  urlTemplate: '',
  bodyTemplate: '',
  contentType: 'application/json',
  barkKey: '',
  barkServerUrl: 'https://api.day.app',
  barkGroup: 'MAP System-{{appname}}',
  barkSound: '',
  barkLevel: '',
  barkIcon: '{{iconUrl}}',
  barkImageTemplate: '{{imageUrl}}',
  barkUrlTemplate: '{{actionUrl}}',
  barkCall: false,
};

export const DEFAULT_NOTIFICATION_PUSH_DRAFT: UpdateAdminPushSubscriptionRequest = {
  enabled: false,
  useDefaultProfile: true,
  ...DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT,
};

function toProfileDraft(profile?: AdminPushProfile | null): UpdateAdminPushProfileRequest {
  return {
    ...DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT,
    channelType: profile?.channelType || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.channelType,
    method: profile?.method || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.method,
    urlTemplate: profile?.urlTemplate || '',
    bodyTemplate: profile?.bodyTemplate || '',
    contentType: profile?.contentType || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.contentType,
    barkKey: profile?.barkKey || '',
    barkServerUrl: profile?.barkServerUrl || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkServerUrl,
    barkGroup: profile?.barkGroup || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkGroup,
    barkSound: profile?.barkSound || '',
    barkLevel: profile?.barkLevel || '',
    barkIcon: profile?.barkIcon || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkIcon,
    barkImageTemplate: profile?.barkImageTemplate || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkImageTemplate,
    barkUrlTemplate: profile?.barkUrlTemplate || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkUrlTemplate,
    barkCall: Boolean(profile?.barkCall),
  };
}

function toDraft(subscription: AdminPushSubscription): UpdateAdminPushSubscriptionRequest {
  return {
    enabled: subscription.enabled,
    useDefaultProfile: Boolean(subscription.useDefaultProfile),
    channelType: subscription.channelType || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.channelType,
    method: subscription.method || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.method,
    urlTemplate: subscription.urlTemplate || '',
    bodyTemplate: subscription.bodyTemplate || '',
    contentType: subscription.contentType || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.contentType,
    barkKey: subscription.barkKey || '',
    barkServerUrl: subscription.barkServerUrl || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkServerUrl,
    barkGroup: subscription.barkGroup || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkGroup,
    barkSound: subscription.barkSound || '',
    barkLevel: subscription.barkLevel || '',
    barkIcon: subscription.barkIcon || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkIcon,
    barkImageTemplate: subscription.barkImageTemplate || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkImageTemplate,
    barkUrlTemplate: subscription.barkUrlTemplate || DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT.barkUrlTemplate,
    barkCall: Boolean(subscription.barkCall),
  };
}

export function buildNotificationPushProfileDraftFromPreset(preset: AdminPushPresetDefinition): UpdateAdminPushProfileRequest {
  return {
    ...DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT,
    channelType: preset.channelType,
    method: preset.method,
    urlTemplate: preset.urlTemplate,
    bodyTemplate: preset.bodyTemplate || '',
    contentType: preset.contentType || 'application/json',
  };
}

export function buildNotificationPushDraftFromPreset(preset: AdminPushPresetDefinition, enabled: boolean): UpdateAdminPushSubscriptionRequest {
  return {
    enabled,
    useDefaultProfile: true,
    ...buildNotificationPushProfileDraftFromPreset(preset),
  };
}

export function getSelectedNotificationPushPresetKey(
  draft: UpdateAdminPushProfileRequest | UpdateAdminPushSubscriptionRequest,
  presets: AdminPushPresetDefinition[]
) {
  const matched = presets.find(
    (preset) =>
      preset.channelType === draft.channelType &&
      preset.method === draft.method &&
      preset.urlTemplate === draft.urlTemplate &&
      (preset.bodyTemplate || '') === (draft.bodyTemplate || '')
  );
  return matched?.key ?? 'custom';
}

function normalizeChannelValue(value: unknown) {
  return String(value ?? '').trim();
}

export function isSameNotificationPushChannel(
  a: UpdateAdminPushProfileRequest | UpdateAdminPushSubscriptionRequest,
  b: UpdateAdminPushProfileRequest | UpdateAdminPushSubscriptionRequest
) {
  const keys: Array<keyof UpdateAdminPushProfileRequest> = [
    'channelType',
    'method',
    'urlTemplate',
    'bodyTemplate',
    'contentType',
    'barkKey',
    'barkServerUrl',
    'barkGroup',
    'barkSound',
    'barkLevel',
    'barkIcon',
    'barkImageTemplate',
    'barkUrlTemplate',
  ];
  return keys.every((key) => normalizeChannelValue(a[key]) === normalizeChannelValue(b[key]))
    && Boolean(a.barkCall) === Boolean(b.barkCall);
}

export function sortNotificationPushTopicsByWorkflow<T extends { key: string }>(items: T[]): T[] {
  const rank = new Map(TOPIC_WORKFLOW_ORDER.map((key, index) => [key, index]));
  return [...items].sort((a, b) => {
    const ai = rank.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const bi = rank.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.key.localeCompare(b.key);
  });
}

export function NotificationSubscriptionsPanel() {
  const [topics, setTopics] = useState<AdminPushTopicDefinition[]>([]);
  const [presets, setPresets] = useState<AdminPushPresetDefinition[]>([]);
  const [resources, setResources] = useState<AdminPushResourceDefinition[]>([]);
  const [defaultProfileDraft, setDefaultProfileDraft] = useState<UpdateAdminPushProfileRequest>(DEFAULT_NOTIFICATION_PUSH_PROFILE_DRAFT);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedTopicKey, setSelectedTopicKey] = useState<string | null>(null);
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
      const nextDefaultProfileDraft = toProfileDraft(res.data.defaultProfile);
      setDefaultProfileDraft(nextDefaultProfileDraft);
      const next: DraftMap = {};
      for (const sub of res.data.subscriptions ?? []) {
        const draft = toDraft(sub);
        next[sub.topicKey] = draft.useDefaultProfile === false && isSameNotificationPushChannel(draft, nextDefaultProfileDraft)
          ? { ...draft, useDefaultProfile: true }
          : draft;
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

  const firstPreset = presets[0];
  const resourcesByKey = useMemo(() => new Map(resources.map((x) => [x.key, x])), [resources]);
  const orderedTopics = useMemo(() => sortNotificationPushTopicsByWorkflow(topics), [topics]);
  const selectedTopic = useMemo(
    () => orderedTopics.find((topic) => topic.key === selectedTopicKey) ?? orderedTopics[0],
    [orderedTopics, selectedTopicKey]
  );
  const selectedDraft = selectedTopic
    ? drafts[selectedTopic.key] ?? (firstPreset ? buildNotificationPushDraftFromPreset(firstPreset, false) : DEFAULT_NOTIFICATION_PUSH_DRAFT)
    : null;
  const enabledCount = orderedTopics.reduce((sum, topic) => sum + (drafts[topic.key]?.enabled ? 1 : 0), 0);

  const toggleTopicEnabled = useCallback((topicKey: string) => {
    setSelectedTopicKey(topicKey);
    setDrafts((prev) => {
      const current = prev[topicKey] ?? (firstPreset ? buildNotificationPushDraftFromPreset(firstPreset, false) : DEFAULT_NOTIFICATION_PUSH_DRAFT);
      return {
        ...prev,
        [topicKey]: {
          ...DEFAULT_NOTIFICATION_PUSH_DRAFT,
          ...current,
          enabled: !current.enabled,
        },
      };
    });
  }, [firstPreset]);

  const saveAllTopics = useCallback(async () => {
    if (orderedTopics.length === 0) return;
    setSavingKey('__all__');
    setMessage(null);

    const profileRes = await updateAdminPushProfile(defaultProfileDraft);
    if (!profileRes.success) {
      setMessage(`默认推送通道保存失败：${profileRes.error?.message || '保存失败'}`);
      setSavingKey(null);
      return;
    }
    setDefaultProfileDraft(toProfileDraft(profileRes.data.defaultProfile));

    const saved: AdminPushSubscription[] = [];
    for (const topic of orderedTopics) {
      const baseDraft = drafts[topic.key] ?? (firstPreset ? buildNotificationPushDraftFromPreset(firstPreset, false) : DEFAULT_NOTIFICATION_PUSH_DRAFT);
      const shouldUseDefault = baseDraft.useDefaultProfile !== false || isSameNotificationPushChannel(baseDraft, defaultProfileDraft);
      const request = shouldUseDefault
        ? {
            ...defaultProfileDraft,
            enabled: baseDraft.enabled,
            useDefaultProfile: true,
          }
        : baseDraft;
      const res = await updateAdminPushSubscription(topic.key, request);
      if (!res.success) {
        setSelectedTopicKey(topic.key);
        setMessage(`${topic.label}保存失败：${res.error?.message || '保存失败'}`);
        setSavingKey(null);
        return;
      }
      saved.push(res.data.subscription);
    }
    setDrafts((prev) => {
      const next = { ...prev };
      for (const subscription of saved) {
        next[subscription.topicKey] = toDraft(subscription);
      }
      return next;
    });
    setMessage('默认推送通道和接收范围已保存');
    setSavingKey(null);
  }, [defaultProfileDraft, drafts, firstPreset, orderedTopics]);

  const testTopic = useCallback(async (topicKey: string) => {
    const draft = drafts[topicKey];
    if (!draft) return;
    const request = draft.useDefaultProfile === false
      ? draft
      : {
          ...defaultProfileDraft,
          enabled: draft.enabled,
          useDefaultProfile: false,
        };
    setTestingKey(topicKey);
    setMessage(null);
    const res = await testAdminPushSubscription(topicKey, request);
    if (res.success) {
      const delivery = res.data.delivery;
      setMessage(delivery.success ? `测试发送成功，HTTP ${delivery.statusCode ?? 'OK'}` : delivery.errorMessage || '测试发送失败');
    } else {
      setMessage(res.error?.message || '测试发送失败');
    }
    setTestingKey(null);
  }, [defaultProfileDraft, drafts]);

  useEffect(() => {
    if (orderedTopics.length === 0) {
      if (selectedTopicKey) setSelectedTopicKey(null);
      return;
    }
    if (!selectedTopicKey || !orderedTopics.some((topic) => topic.key === selectedTopicKey)) {
      setSelectedTopicKey(orderedTopics[0].key);
    }
  }, [orderedTopics, selectedTopicKey]);

  function renderChannelFields(
    draft: UpdateAdminPushProfileRequest,
    update: (patch: Partial<UpdateAdminPushProfileRequest>) => void
  ) {
    const selectedPresetKey = getSelectedNotificationPushPresetKey(draft, presets);
    const isBark = draft.channelType === 'bark';
    const isPost = String(draft.method ?? 'GET').toUpperCase() === 'POST';

    return (
      <div className="flex min-h-0 flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[1.2fr_0.7fr_0.8fr]">
          <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            推送方式
            <select
              className="h-9 rounded-[8px] border px-2 text-[12px] outline-none"
              style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
              value={selectedPresetKey}
              onChange={(e) => {
                const preset = presets.find((item) => item.key === e.target.value);
                if (preset) update(buildNotificationPushProfileDraftFromPreset(preset));
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
              onChange={(e) => update({ method: e.target.value as 'GET' | 'POST' })}
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
              onChange={(e) => update({ contentType: e.target.value })}
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
                  onChange={(e) => update({ barkKey: e.target.value })}
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Bark 服务地址
                <input
                  className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                  style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                  value={draft.barkServerUrl || 'https://api.day.app'}
                  onChange={(e) => update({ barkServerUrl: e.target.value })}
                />
              </label>
            </div>
            <details className="rounded-[10px] border px-3 py-2" style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.025)' }}>
              <summary className="cursor-pointer text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                高级参数
              </summary>
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_0.8fr_0.8fr]">
                  <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    分组模板
                    <input
                      className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                      style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                      value={draft.barkGroup || ''}
                      onChange={(e) => update({ barkGroup: e.target.value })}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    声音
                    <input
                      className="h-9 rounded-[8px] border px-2 text-[12px] outline-none"
                      style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                      placeholder="默认"
                      value={draft.barkSound || ''}
                      onChange={(e) => update({ barkSound: e.target.value })}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    时效级别
                    <select
                      className="h-9 rounded-[8px] border px-2 text-[12px] outline-none"
                      style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                      value={draft.barkLevel || ''}
                      onChange={(e) => update({ barkLevel: e.target.value })}
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
                      onChange={(e) => update({ barkUrlTemplate: e.target.value })}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    图标 URL 模板
                    <input
                      className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                      style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                      value={draft.barkIcon || ''}
                      onChange={(e) => update({ barkIcon: e.target.value })}
                    />
                  </label>
                </div>
                <label className="flex min-w-0 flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  图片 URL 模板
                  <input
                    className="h-9 rounded-[8px] border px-2 font-mono text-[12px] outline-none"
                    style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                    value={draft.barkImageTemplate || ''}
                    onChange={(e) => update({ barkImageTemplate: e.target.value })}
                  />
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-indigo-400"
                    checked={Boolean(draft.barkCall)}
                    onChange={(e) => update({ barkCall: e.target.checked })}
                  />
                  发送响铃通知
                </label>
              </div>
            </details>
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
                onChange={(e) => update({ urlTemplate: e.target.value })}
              />
            </label>
            {isPost && (
              <label className="flex flex-col gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Body 模板
                <textarea
                  className="min-h-[82px] resize-y rounded-[8px] border px-2 py-2 font-mono text-[12px] leading-relaxed outline-none"
                  style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(10,10,14,0.55)', color: 'var(--text-primary)' }}
                  value={draft.bodyTemplate || ''}
                  onChange={(e) => update({ bodyTemplate: e.target.value })}
                />
              </label>
            )}
          </>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <MapSpinner size={22} />
      </div>
    );
  }

  const defaultChannelName = defaultProfileDraft.channelType === 'bark'
    ? 'Bark'
    : defaultProfileDraft.channelType === 'webhook'
      ? 'Webhook'
      : defaultProfileDraft.channelType === 'wechat-work'
        ? '企业微信'
        : defaultProfileDraft.channelType === 'feishu'
          ? '飞书'
          : defaultProfileDraft.channelType === 'dingtalk'
            ? '钉钉'
            : 'URL';
  const defaultChannelConfigured = defaultProfileDraft.channelType === 'bark'
    ? Boolean((defaultProfileDraft.barkKey || '').trim())
    : Boolean((defaultProfileDraft.urlTemplate || '').trim());
  const channelChips = [
    { key: 'bark', label: 'Bark', configured: defaultProfileDraft.channelType === 'bark' && defaultChannelConfigured },
    { key: 'webhook', label: 'Webhook', configured: defaultProfileDraft.channelType !== 'bark' && defaultChannelConfigured },
    { key: 'wechat-work', label: '企业微信', configured: defaultProfileDraft.channelType === 'wechat-work' && defaultChannelConfigured },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {message && (
        <div
          className="rounded-[10px] border px-3 py-2 text-[12px]"
          style={{ borderColor: 'rgba(99,102,241,0.35)', background: 'rgba(99,102,241,0.1)', color: 'var(--text-primary)' }}
        >
          {message}
        </div>
      )}

      <section
        className="rounded-[14px] border px-4 py-3"
        style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.045)' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              <Settings2 size={15} style={{ color: 'var(--accent-gold)' }} />
              推送通道
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {channelChips.map((item) => (
                <span
                  key={item.key}
                  className="rounded-full border px-2.5 py-1 text-[12px]"
                  style={{
                    borderColor: item.configured ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.1)',
                    background: item.configured ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.045)',
                    color: item.configured ? '#86efac' : 'var(--text-muted)',
                  }}
                >
                  {item.label} · {item.configured ? '已配置' : '未配置'}
                </span>
              ))}
            </div>
          </div>
          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'rgba(129,140,248,0.16)', color: '#c7d2fe' }}>{defaultChannelName}</span>
        </div>
        <details className="mt-3 rounded-[10px] border px-3 py-2" style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.025)' }}>
          <summary className="cursor-pointer text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            配置默认推送通道
          </summary>
          <div className="mt-3">
            {renderChannelFields(defaultProfileDraft, (patch) => setDefaultProfileDraft((prev) => ({ ...prev, ...patch })))}
          </div>
        </details>
      </section>

      <section
        className="flex min-h-0 flex-1 flex-col rounded-[14px] border"
        style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.035)' }}
      >
        <div className="shrink-0 border-b px-4 py-3" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              <SlidersHorizontal size={14} />
              接收范围
            </div>
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {enabledCount}/{orderedTopics.length} 已选
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3 pr-2" style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}>
          <div className="grid gap-2 md:grid-cols-2">
            {orderedTopics.map((topic) => {
              const draft = drafts[topic.key] ?? (firstPreset ? buildNotificationPushDraftFromPreset(firstPreset, false) : DEFAULT_NOTIFICATION_PUSH_DRAFT);
              const resource = resourcesByKey.get(topic.resourceKey);
              const selected = Boolean(draft.enabled);
              const advancedSelected = selectedTopic?.key === topic.key;
              const statusText = draft.enabled
                ? draft.useDefaultProfile === false
                  ? `单独配置 ${draft.channelType === 'bark' ? 'Bark' : draft.channelType}`
                  : `使用默认 ${defaultChannelName}`
                : '关闭';
              return (
                <div
                  key={topic.key}
                  role="button"
                  aria-pressed={draft.enabled}
                  tabIndex={0}
                  className="grid min-h-[86px] min-w-0 cursor-pointer grid-cols-[40px_minmax(0,1fr)] items-center gap-3 rounded-[12px] border px-3 py-3 text-left outline-none transition-all hover:border-indigo-300/50 hover:bg-white/[0.055] focus-visible:ring-2 focus-visible:ring-indigo-300/50 active:scale-[0.995]"
                  style={{
                    borderColor: selected ? 'rgba(129,140,248,0.62)' : advancedSelected ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)',
                    background: selected ? 'rgba(99,102,241,0.16)' : 'rgba(255,255,255,0.025)',
                    boxShadow: selected ? 'inset 0 0 0 1px rgba(129,140,248,0.18)' : 'none',
                  }}
                  onClick={() => toggleTopicEnabled(topic.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleTopicEnabled(topic.key);
                    }
                  }}
                >
                  {resource && <img src={resource.iconUrl} alt="" className="h-10 w-10 rounded-[10px] object-cover" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{topic.label}</span>
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                        style={{
                          background: draft.enabled ? 'rgba(34,197,94,0.14)' : 'rgba(255,255,255,0.06)',
                          color: draft.enabled ? '#86efac' : 'var(--text-muted)',
                        }}
                      >
                        {draft.enabled ? '接收' : '关闭'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {topic.description}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="truncate text-[11px]" style={{ color: draft.enabled ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                        {statusText}
                      </span>
                      {draft.enabled && <CheckCircle2 size={14} className="shrink-0" style={{ color: '#a5b4fc' }} />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {selectedTopic && selectedDraft && (
          <div className="shrink-0 border-t px-4 py-3" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                当前测试：<span style={{ color: 'var(--text-secondary)' }}>{selectedTopic.label}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-all hover:bg-white/15 active:scale-[0.97] disabled:opacity-60"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
                  onClick={() => testTopic(selectedTopic.key)}
                  disabled={testingKey === selectedTopic.key || savingKey !== null}
                >
                  {testingKey === selectedTopic.key ? <MapSpinner size={12} /> : <FlaskConical size={13} />}
                  测试当前类型
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-all hover:brightness-110 active:scale-[0.97] disabled:opacity-60"
                  style={{ background: 'var(--accent-gold)', color: '#1a1a1a' }}
                  onClick={() => saveAllTopics()}
                  disabled={savingKey !== null || testingKey === selectedTopic.key}
                >
                  {savingKey ? <MapSpinner size={12} color="#1a1a1a" /> : <Save size={13} />}
                  保存默认通道和接收范围
                </button>
              </div>
            </div>
          </div>
          )}
      </section>
    </div>
  );
}
