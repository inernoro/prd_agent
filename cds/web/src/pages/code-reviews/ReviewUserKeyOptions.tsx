import type { ReviewUserKeyInput } from '../../../../src/shared/code-review-user-key';
export type UserKeyOptions = Omit<ReviewUserKeyInput, 'apiKey'> & { apiKey: string };
const MODELS = { openai: 'gpt-4.1-mini', anthropic: 'claude-sonnet-4-5', openrouter: 'openai/gpt-4.1-mini', deepseek: 'deepseek-chat' } as const;
export function ReviewUserKeyOptions({ value, onChange, configured }: { value: UserKeyOptions | null; onChange: (value: UserKeyOptions | null) => void; configured: boolean }): JSX.Element {
  return <section className="cr-stack" aria-label="审查模型凭据"><label className="cr-label"><span>模型额度来源</span><select aria-label="模型额度来源" className="cr-input cr-full" value={value ? 'user' : 'platform'} onChange={e => onChange(e.target.value === 'user' ? { provider: 'openai', model: MODELS.openai, apiKey: '', tokenLimit: 200000 } : null)}><option value="platform">平台默认</option><option value="user" disabled={!configured}>使用自己的 API Key{configured ? '' : '（尚未启用）'}</option></select></label>{value ? <>
    <label className="cr-label"><span>供应商</span><select aria-label="供应商" className="cr-input cr-full" value={value.provider} onChange={e => { const provider = e.target.value as UserKeyOptions['provider']; onChange({ ...value, provider, model: MODELS[provider], apiKey: '' }); }}>{Object.entries({ openai: 'OpenAI', anthropic: 'Anthropic / Claude', openrouter: 'OpenRouter', deepseek: 'DeepSeek' }).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <label className="cr-label"><span>模型名称</span><input aria-label="模型名称" className="cr-input cr-full" value={value.model} required maxLength={200} onChange={e => onChange({ ...value, model: e.target.value })} /></label>
    <label className="cr-label"><span>API Key</span><input aria-label="API Key" className="cr-input cr-full" type="password" autoComplete="new-password" spellCheck={false} value={value.apiKey} required maxLength={4096} onChange={e => onChange({ ...value, apiKey: e.target.value })} placeholder="仅在本次提交时发送，不在页面回显" /></label>
    <label className="cr-label"><span>本任务 Token 保护额度</span><input aria-label="本任务 Token 保护额度" className="cr-input cr-full" type="number" min={4096} max={10000000} step={1} required value={value.tokenLimit ?? 200000} onChange={e => onChange({ ...value, tokenLimit: Number(e.target.value) })} /></label>
    <p className="cr-form-note">Key 在网关加密保存，只供当前账号与项目使用。任务失败或额度不足会停止，不会改用平台额度。额度按每次请求的输入与输出上限保守预留，实际 Token 另行统计。</p>
    <p className="cr-form-note">仅统计经本系统产生的用量，不代表供应商账号余额。没有可靠单价时费用显示“未知”。</p>
  </> : null}</section>;
}
