import { useEffect, useState } from 'react';
import { Mic, X, CheckCircle2, AlertCircle, KeyRound } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getAsrSetupStatus, setupOpenRouterAsr } from '@/services';
import { toast } from '@/lib/toast';

const PRESET_MODELS: { id: string; label: string; hint: string }[] = [
  {
    id: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    hint: '默认推荐 · 中文识别质量好 · 单价低',
  },
  {
    id: 'google/gemini-2.0-flash-001',
    label: 'Gemini 2.0 Flash',
    hint: '上一代旗舰 · 略快但中文偶有漏听',
  },
  {
    id: 'openai/gpt-4o-audio-preview',
    label: 'GPT-4o Audio Preview',
    hint: 'OpenAI 多模态音频 · 英语最佳',
  },
  {
    id: 'openai/gpt-4o-mini-audio-preview',
    label: 'GPT-4o Mini Audio',
    hint: '英语最便宜 · 中文一般',
  },
];

export function AsrSetupDialog({ onClose, onConfigured }: {
  onClose: () => void;
  onConfigured?: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState(PRESET_MODELS[0].id);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ configured: boolean; hasOpenRouter: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      const res = await getAsrSetupStatus();
      if (res.success) setStatus({ configured: res.data.configured, hasOpenRouter: res.data.hasOpenRouter });
    })();
  }, []);

  const handleSubmit = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) { setError('请填写 OpenRouter API Key'); return; }
    if (!trimmed.startsWith('sk-')) {
      setError('API Key 通常以 sk- 开头，请确认格式无误');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await setupOpenRouterAsr({ apiKey: trimmed, modelName });
    setSubmitting(false);
    if (res.success) {
      toast.success('ASR 已就绪', res.data.message);
      onConfigured?.();
      onClose();
    } else {
      setError(res.error?.message ?? '配置失败');
    }
  };

  const dialog = (
    <div
      className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="surface-popover rounded-[16px] p-6"
        style={{ width: 480, maxWidth: '92vw' }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Mic size={15} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">配置 AI 录音转写</span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6"
          >
            <X size={15} />
          </button>
        </div>

        {/* 状态指示 */}
        {status && (
          <div className="mb-4 flex items-center gap-2 rounded-[10px] px-3 py-2"
            style={{
              background: status.configured ? 'rgba(34,197,94,0.08)' : 'rgba(234,179,8,0.08)',
              border: `1px solid ${status.configured ? 'rgba(34,197,94,0.18)' : 'rgba(234,179,8,0.18)'}`,
            }}>
            {status.configured ? <CheckCircle2 size={13} style={{ color: 'rgba(74,222,128,0.95)' }} /> : <AlertCircle size={13} style={{ color: 'rgba(250,204,21,0.95)' }} />}
            <span className="text-[12px] text-token-primary">
              {status.configured
                ? '当前已绑定 ASR 模型池，可直接上传音频转写。下方表单用于追加/替换为 OpenRouter。'
                : '当前没有任何 ASR 模型池绑定到知识库，请填一个 API Key 让转写跑起来。'}
            </span>
          </div>
        )}

        <p className="mb-3 text-[12px] text-token-muted leading-relaxed">
          OpenRouter 是聚合上游平台的 LLM 网关，下方默认模型经多模态 chat 协议接收音频做转写。
          只需填一个 API Key，后端会自动配好平台 + 模型 + 调度池。
          <br />
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent-primary,#a78bfa)] underline-offset-2 hover:underline"
          >
            前往 OpenRouter 控制台获取 Key →
          </a>
        </p>

        <label className="mb-1.5 block text-[12px] text-token-muted">
          <KeyRound size={11} className="inline mr-1" />
          OpenRouter API Key
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setError(null); }}
          placeholder="sk-or-v1-..."
          autoComplete="new-password"
          className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none transition-colors duration-200 mb-4"
        />

        <label className="mb-1.5 block text-[12px] text-token-muted">选择 ASR 模型</label>
        <div className="space-y-1.5 mb-4">
          {PRESET_MODELS.map((m) => (
            <label
              key={m.id}
              className="flex items-start gap-2 cursor-pointer rounded-[10px] px-3 py-2 transition-colors"
              style={{
                background: modelName === m.id ? 'rgba(168,85,247,0.10)' : 'transparent',
                border: `1px solid ${modelName === m.id ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.06)'}`,
              }}
            >
              <input
                type="radio"
                name="asr-model"
                checked={modelName === m.id}
                onChange={() => setModelName(m.id)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-semibold text-token-primary">{m.label}</div>
                <div className="text-[10px] text-token-muted">{m.id} · {m.hint}</div>
              </div>
            </label>
          ))}
        </div>

        {error && (
          <p className="mb-3 text-[12px] text-token-error">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose} disabled={submitting}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleSubmit} disabled={submitting}>
            {submitting ? <MapSpinner size={11} /> : null}
            {submitting ? '配置中…' : '保存并启用'}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
