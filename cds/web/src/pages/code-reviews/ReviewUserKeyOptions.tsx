import { useId, useState } from 'react';
import type { ReviewUserKeyInput } from '../../../../src/shared/code-review-user-key';

export type UserKeyOptions = Omit<ReviewUserKeyInput, 'apiKey'> & { apiKey: string };

// Public provider catalogs checked on 2026-11-18. Custom IDs support new models
// and accounts with different model access. Never silently change a submitted model.
const PROVIDERS = {
  openai: { name: 'OpenAI', models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna'] },
  anthropic: { name: 'Anthropic / Claude', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] },
  openrouter: { name: 'OpenRouter', models: ['openai/gpt-6.2-sol', 'openai/gpt-6.2-astra', 'anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4.1-flash'] },
  deepseek: { name: 'DeepSeek', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
} as const;
const LIMITS = [50000, 200000, 1000000, 5000000];
export const reviewProviderName = (provider: UserKeyOptions['provider']): string => PROVIDERS[provider].name;
export const reviewLimitLabel = (limit = 200000): string => `${(limit / 10000).toLocaleString('zh-CN')} 万 Token`;

export function ReviewUserKeyOptions({ value, onChange, configured }: { value: UserKeyOptions | null; onChange: (value: UserKeyOptions | null) => void; configured: boolean }): JSX.Element {
  const id = useId();
  const [customModel, setCustomModel] = useState(false), [customLimit, setCustomLimit] = useState(false);
  const models: readonly string[] = PROVIDERS[value?.provider || 'openai'].models;
  const isCustomModel = customModel || Boolean(value && !models.includes(value.model));
  const isCustomLimit = customLimit || Boolean(value && !LIMITS.includes(value.tokenLimit ?? 200000));
  return <section className="cr-stack cr-key-options" aria-label="模型使用配置">
    <label className="cr-label"><span>模型使用方式</span><select className="cr-input cr-full" value={value ? 'user' : 'platform'} onChange={e => {
      setCustomModel(false); setCustomLimit(false);
      onChange(e.target.value === 'user' ? { provider: 'openai', model: PROVIDERS.openai.models[0], apiKey: '', tokenLimit: 200000 } : null);
    }}><option value="platform">使用平台模型</option><option value="user" disabled={!configured}>使用自己的 API Key{configured ? '' : '（暂不可用）'}</option></select></label>
    {value ? <>
      <label className="cr-label"><span>模型供应商</span><select className="cr-input cr-full" value={value.provider} onChange={e => {
        const provider = e.target.value as UserKeyOptions['provider']; setCustomModel(false);
        onChange({ ...value, provider, model: PROVIDERS[provider].models[0], apiKey: '' });
      }}>{Object.entries(PROVIDERS).map(([key, provider]) => <option key={key} value={key}>{provider.name}</option>)}</select></label>
      <label className="cr-label"><span>审查模型</span><select className="cr-input cr-full" value={isCustomModel ? 'custom' : value.model} onChange={e => {
        const custom = e.target.value === 'custom'; setCustomModel(custom); onChange({ ...value, model: custom ? '' : e.target.value });
      }}>{models.map((model, index) => <option key={model} value={model}>{model}{index === 0 ? '（默认）' : ''}</option>)}<option value="custom">自定义模型…</option></select></label>
      {isCustomModel ? <label className="cr-label"><span>自定义模型名称</span><input className="cr-input cr-full" required maxLength={200} value={value.model} onChange={e => onChange({ ...value, model: e.target.value })} placeholder="填写供应商提供的模型 ID" /></label> : null}
      <p className="cr-form-note">请选择你的 API Key 可用的模型；新型号可通过“自定义模型”填写。</p>
      <label className="cr-label"><span>API Key</span><input className="cr-input cr-full" type="password" autoComplete="new-password" spellCheck={false} value={value.apiKey} required maxLength={4096} onChange={e => onChange({ ...value, apiKey: e.target.value })} placeholder="粘贴所选供应商的 API Key" /></label>
      <label className="cr-label"><span>本次审查用量上限</span><select aria-describedby={`${id}-limit-help`} className="cr-input cr-full" value={isCustomLimit ? 'custom' : String(value.tokenLimit ?? 200000)} onChange={e => {
        const custom = e.target.value === 'custom'; setCustomLimit(custom);
        if (!custom) onChange({ ...value, tokenLimit: Number(e.target.value) });
      }}>{LIMITS.map(limit => <option key={limit} value={limit}>{reviewLimitLabel(limit)}{limit === 200000 ? '（默认）' : ''}</option>)}<option value="custom">自定义上限…</option></select></label>
      {isCustomLimit ? <label className="cr-label"><span>自定义用量上限（Token）</span><input className="cr-input cr-full" type="number" min={4096} max={10000000} step={1} required value={value.tokenLimit ?? 200000} onChange={e => onChange({ ...value, tokenLimit: Number(e.target.value) })} aria-describedby={`${id}-limit-help`} /></label> : null}
      <p id={`${id}-limit-help`} className="cr-form-note">控制本次审查最多可使用的额度。Token 是 AI 读写内容的计量单位，不是金额或账户余额。系统按每次请求的最大可能用量预留；剩余额度不足时停止，可能无法审完整个项目。</p>
      <details className="cr-form-note"><summary>费用与密钥说明</summary><p>API Key 加密保存，仅供当前账号与项目使用。失败或额度不足时不会切换到平台模型。实际用量单独统计，费用以供应商账单为准。</p></details>
    </> : <p className="cr-form-note">由平台管理模型，无需填写 API Key。</p>}
  </section>;
}
