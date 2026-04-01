import { useState, useEffect, useCallback } from 'react';
import { X, Plus, Trash2, TestTube, Bell, Pencil, Check } from 'lucide-react';
import {
  listReviewWebhooks,
  createReviewWebhook,
  updateReviewWebhook,
  deleteReviewWebhook,
  testReviewWebhook,
} from '@/services';
import type { ReviewWebhookConfig } from '@/services';
import { ReviewWebhookChannelLabels, ReviewEventLabels } from '@/services/real/reviewAgent';

interface Props {
  open: boolean;
  onClose: () => void;
}

const CHANNEL_OPTIONS = [
  { value: 'wecom', label: '企业微信' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'feishu', label: '飞书' },
  { value: 'custom', label: '自定义' },
];

const ALL_EVENTS = ['review_completed'];

export function ReviewAgentWebhookModal({ open, onClose }: Props) {
  const [webhooks, setWebhooks] = useState<ReviewWebhookConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [formChannel, setFormChannel] = useState('wecom');
  const [formUrl, setFormUrl] = useState('');
  const [formName, setFormName] = useState('');
  const [formMentionAll, setFormMentionAll] = useState(false);
  const [creating, setCreating] = useState(false);

  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await listReviewWebhooks();
    setLoading(false);
    if (res.success && res.data) setWebhooks(res.data.items);
    else setError(res.error?.message || '加载失败');
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleCreate = async () => {
    if (!formUrl.trim()) { setError('请输入 Webhook URL'); return; }
    setCreating(true);
    const res = await createReviewWebhook({
      channel: formChannel,
      webhookUrl: formUrl.trim(),
      triggerEvents: ALL_EVENTS,
      name: formName.trim() || undefined,
      mentionAll: formChannel === 'wecom' ? formMentionAll : undefined,
    });
    setCreating(false);
    if (res.success) {
      setShowForm(false);
      setFormUrl('');
      setFormName('');
      setFormMentionAll(false);
      void load();
    } else {
      setError(res.error?.message || '创建失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除此 Webhook？')) return;
    const res = await deleteReviewWebhook(id);
    if (res.success) void load();
  };

  const handleToggle = async (wh: ReviewWebhookConfig) => {
    await updateReviewWebhook(wh.id, { isEnabled: !wh.isEnabled });
    void load();
  };

  const handleTest = async (wh: ReviewWebhookConfig) => {
    setTestingId(wh.id);
    const res = await testReviewWebhook({ webhookUrl: wh.webhookUrl, channel: wh.channel, mentionAll: wh.mentionAll });
    setTestingId(null);
    if (res.success && res.data?.success) {
      setError('');
      alert('测试消息发送成功');
    } else {
      setError(res.data?.error || res.error?.message || '测试失败');
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="relative w-full max-w-lg mx-4 rounded-2xl border border-white/10 shadow-2xl"
        style={{ background: 'var(--bg-primary, #1a1a2e)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/8">
          <h2 className="text-base font-semibold text-white/90 flex items-center gap-2">
            <Bell className="w-4 h-4" />
            Webhook 通知配置
          </h2>
          <button onClick={onClose} className="text-white/40 hover:text-white/80 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
          <p className="text-xs text-white/40 mb-4">
            评审完成后自动推送评分结果到企微/钉钉/飞书群聊。
          </p>

          {error && (
            <div className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2 mb-3">{error}</div>
          )}

          {/* Webhook list */}
          {loading ? (
            <div className="text-center py-8 text-white/30 text-sm">加载中...</div>
          ) : webhooks.length === 0 && !showForm ? (
            <div className="text-center py-8 text-white/30 text-sm">暂未配置 Webhook</div>
          ) : (
            <div className="flex flex-col gap-2 mb-3">
              {webhooks.map((wh) => (
                <div
                  key={wh.id}
                  className="rounded-lg border border-white/8 bg-white/3 px-3 py-2.5"
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{
                          background: wh.isEnabled ? 'rgba(34, 197, 94, 0.15)' : 'rgba(156, 163, 175, 0.15)',
                          color: wh.isEnabled ? 'rgba(34, 197, 94, 0.9)' : 'rgba(156, 163, 175, 0.7)',
                        }}
                      >
                        {ReviewWebhookChannelLabels[wh.channel] || wh.channel}
                      </span>
                      {wh.name && <span className="text-xs text-white/70">{wh.name}</span>}
                      <span className="text-[10px]" style={{ color: wh.isEnabled ? 'rgba(34,197,94,0.6)' : 'rgba(156,163,175,0.5)' }}>
                        {wh.isEnabled ? '已启用' : '已禁用'}
                      </span>
                      {wh.channel === 'wecom' && wh.mentionAll && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400/80">@所有人</span>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5">
                      <button onClick={() => handleTest(wh)} disabled={testingId === wh.id}
                        className="p-1 rounded hover:bg-white/10 cursor-pointer" title="测试">
                        <TestTube className="w-3.5 h-3.5 text-white/40" />
                      </button>
                      <button onClick={() => handleToggle(wh)}
                        className="p-1 rounded hover:bg-white/10 cursor-pointer" title={wh.isEnabled ? '禁用' : '启用'}>
                        <Bell className="w-3.5 h-3.5" style={{ color: wh.isEnabled ? 'rgba(34,197,94,0.7)' : 'rgba(156,163,175,0.5)' }} />
                      </button>
                      <button onClick={() => handleDelete(wh.id)}
                        className="p-1 rounded hover:bg-white/10 cursor-pointer" title="删除">
                        <Trash2 className="w-3.5 h-3.5 text-red-400/60" />
                      </button>
                    </div>
                  </div>
                  <div className="text-[10px] text-white/30 truncate">{wh.webhookUrl}</div>
                  <div className="flex gap-1 mt-1">
                    {wh.triggerEvents.map((evt) => (
                      <span key={evt} className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400/70">
                        {ReviewEventLabels[evt] || evt}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Create form */}
          {showForm && (
            <div className="rounded-lg border border-white/10 bg-white/3 p-3 mb-3 flex flex-col gap-2.5">
              <div className="text-xs font-medium text-white/70">新建 Webhook</div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-white/40">渠道</label>
                <select
                  className="text-xs px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-white/80"
                  value={formChannel}
                  onChange={(e) => setFormChannel(e.target.value)}
                >
                  {CHANNEL_OPTIONS.map((ch) => (
                    <option key={ch.value} value={ch.value}>{ch.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-white/40">备注名称（可选）</label>
                <input
                  type="text"
                  className="text-xs px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-white/80"
                  placeholder="如：产品群"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-white/40">Webhook URL</label>
                <input
                  type="url"
                  className="text-xs px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-white/80"
                  placeholder="粘贴群机器人的 Webhook URL"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                />
              </div>
              {formChannel === 'wecom' && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formMentionAll}
                    onChange={(e) => setFormMentionAll(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-[11px] text-white/60">@所有人（需群主身份，开启后消息改为纯文本格式）</span>
                </label>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 cursor-pointer"
                >
                  <Check className="w-3 h-3" /> 创建
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="text-xs px-3 py-1.5 rounded-md text-white/50 hover:text-white/80 cursor-pointer"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-white/8">
          {!showForm ? (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 border border-white/10 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> 添加 Webhook
            </button>
          ) : <div />}
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-md text-white/50 hover:text-white/80 cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
