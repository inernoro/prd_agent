import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, Info, Save, Settings2, SlidersHorizontal, Wrench } from 'lucide-react';
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
  const [placeholders, setPlaceholders] = useState<string[]>([]);
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
      setPlaceholders(res.data.placeholders ?? []);
      setDefaultProfileDraft(toProfileDraft(res.data.defaultProfile));
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

  const firstPreset = presets[0];
  const resourcesByKey = useMemo(() => new Map(resources.map((x) => [x.key, x])), [resources]);
  const placeholderText = useMemo(() => placeholders.map((x) => `{{${x}}}`).join('  '), [placeholders]);
  const orderedTopics = useMemo(() => sortNotificationPushTopicsByWorkflow(topics), [topics]);
  const selectedTopic = useMemo(
    () => orderedTopics.find((topic) => topic.key === selectedTopicKey) ?? orderedTopics[0],
    [orderedTopics, selectedTopicKey]
  );
  const selectedDraft = selectedTopic
    ? drafts[selectedTopic.key] ?? (firstPreset ? buildNotificationPushDraftFromPreset(firstPreset, false) : DEFAULT_NOTIFICATION_PUSH_DRAFT)
    : null;
  const selectedResource = selectedTopic ? resourcesByKey.get(selectedTopic.resourceKey) : undefined;
  const enabledCount = orderedTopics.reduce((sum, topic) => sum + (drafts[topic.key]?.enabled ? 1 : 0), 0);
  const overrideCount = orderedTopics.reduce((sum, topic) => sum + (drafts[topic.key]?.useDefaultProfile === false ? 1 : 0), 0);

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
      const request = baseDraft.useDefaultProfile === false
        ? baseDraft
        : {
            ...defaultProfileDraft,
            enabled: baseDraft.enabled,
            useDefaultProfile: true,
          };
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div
        className="rounded-[12px] border px-3 py-2 text-[12px] leading-relaxed"
        style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
      >
        <div className="flex items-start gap-2">
          <Info size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div style={{ color: 'var(--text-primary)' }}>先配置当前用户的默认推送通道，再选择哪些通知进入外部推送；少数类型可单独覆盖。</div>
            <div className="mt-1 break-words">可用占位符：{placeholderText}</div>
          </div>
        </div>
      </div>

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
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              <Settings2 size={15} style={{ color: 'var(--accent-gold)' }} />
              默认推送通道
            </div>
            <div className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              当前用户有效，接收范围默认共用这套 Bark、Webhook 或机器人配置。
            </div>
          </div>
          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'rgba(129,140,248,0.16)', color: '#c7d2fe' }}>
            默认
          </span>
        </div>
        {renderChannelFields(defaultProfileDraft, (patch) => setDefaultProfileDraft((prev) => ({ ...prev, ...patch })))}
      </section>

      <div className="grid flex-1 min-h-0 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside
          className="flex min-h-0 flex-col rounded-[14px] border"
          style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.035)' }}
        >
          <div className="shrink-0 border-b px-3 py-2.5" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                <SlidersHorizontal size={13} />
                接收范围
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{enabledCount}/{orderedTopics.length} 已选</div>
            </div>
            {overrideCount > 0 && (
              <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {overrideCount} 个单独配置
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2" style={{ overscrollBehavior: 'contain' }}>
            {orderedTopics.map((topic) => {
              const draft = drafts[topic.key] ?? (firstPreset ? buildNotificationPushDraftFromPreset(firstPreset, false) : DEFAULT_NOTIFICATION_PUSH_DRAFT);
              const resource = resourcesByKey.get(topic.resourceKey);
              const selected = selectedTopic?.key === topic.key;
              return (
                <div
                  key={topic.key}
                  role="button"
                  tabIndex={0}
                  className="group flex min-w-0 cursor-pointer items-center gap-2 rounded-[10px] border px-2.5 py-2 outline-none transition-all"
                  style={{
                    borderColor: selected ? 'rgba(129,140,248,0.55)' : 'rgba(255,255,255,0.08)',
                    background: selected ? 'rgba(99,102,241,0.16)' : 'rgba(255,255,255,0.025)',
                  }}
                  onClick={() => setSelectedTopicKey(topic.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedTopicKey(topic.key);
                    }
                  }}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-indigo-400"
                    checked={draft.enabled}
                    aria-label={`${topic.label}接收外部推送`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      setSelectedTopicKey(topic.key);
                      updateDraft(topic.key, { enabled: e.target.checked });
                    }}
                  />
                  {resource && <img src={resource.iconUrl} alt="" className="h-8 w-8 shrink-0 rounded-[8px] object-cover" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
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
                      {draft.useDefaultProfile === false ? '单独配置' : '默认通道'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        <div className="min-h-0 overflow-auto pr-2" style={{ overscrollBehavior: 'contain' }}>
          {selectedTopic && selectedDraft ? (
            <section
              className="rounded-[14px] border px-4 py-3"
              style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.045)' }}
            >
              <div className="flex min-h-0 flex-col gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Wrench size={15} style={{ color: 'var(--accent-gold)' }} />
                      <div className="truncate text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {selectedTopic.label}
                      </div>
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
                        style={{
                          background: selectedDraft.enabled ? 'rgba(34,197,94,0.14)' : 'rgba(255,255,255,0.06)',
                          color: selectedDraft.enabled ? '#86efac' : 'var(--text-muted)',
                        }}
                      >
                        {selectedDraft.enabled ? '已接收' : '已关闭'}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {selectedTopic.description}
                    </div>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-indigo-400"
                      checked={selectedDraft.enabled}
                      onChange={(e) => updateDraft(selectedTopic.key, { enabled: e.target.checked })}
                    />
                    接收此类推送
                  </label>
                </div>

                {selectedResource && (
                  <div
                    className="flex min-w-0 items-center gap-2 rounded-[10px] border px-2.5 py-2"
                    style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.035)' }}
                  >
                    <img src={selectedResource.iconUrl} alt="" className="h-8 w-8 shrink-0 rounded-[8px] object-cover" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>
                        {selectedResource.appName} · {selectedResource.knowledgeStoreName}
                      </div>
                      <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {selectedResource.defaultGroup}
                        {selectedResource.knowledgeTemplateKey ? ` · ${selectedResource.knowledgeTemplateKey}` : ''}
                      </div>
                    </div>
                  </div>
                )}

                <div
                  className="rounded-[10px] border px-3 py-2"
                  style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.025)' }}
                >
                  <label className="inline-flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-indigo-400"
                      checked={selectedDraft.useDefaultProfile === false}
                      onChange={(e) => {
                        if (e.target.checked) {
                          updateDraft(selectedTopic.key, {
                            ...defaultProfileDraft,
                            enabled: selectedDraft.enabled,
                            useDefaultProfile: false,
                          });
                        } else {
                          updateDraft(selectedTopic.key, { useDefaultProfile: true });
                        }
                      }}
                    />
                    此类型单独配置推送通道
                  </label>
                  {selectedDraft.useDefaultProfile !== false && (
                    <div className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      当前使用上方默认推送通道，保存后只记录此类型是否接收外部推送。
                    </div>
                  )}
                </div>

                {selectedDraft.useDefaultProfile === false && renderChannelFields(selectedDraft, (patch) => updateDraft(selectedTopic.key, patch))}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                  <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <CheckCircle2 size={12} />
                    保存后对新站内通知去重投递
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
            </section>
          ) : (
            <div className="rounded-[14px] border border-dashed border-white/10 px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              还没有可订阅的通知来源
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
