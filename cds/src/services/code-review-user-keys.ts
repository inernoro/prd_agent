import { reviewJsonRequest, type CodeReviewAudit } from './code-review-audit.js';
import type { ReviewUserKeyInput, ReviewUserKeyBinding, ReviewKeyUsage } from '../shared/code-review-user-key.js';
export type { ReviewUserKeyInput } from '../shared/code-review-user-key.js';
/** Only authenticated server-side identities may call this trusted-issuer client. */
export class CodeReviewUserKeys {
  constructor(private readonly env: () => NodeJS.ProcessEnv = () => process.env, private readonly fetchImpl: typeof fetch = fetch) {}
  configured(): boolean { const env = this.env(); return Boolean(env.CDS_CODE_REVIEW_GATEWAY_URL && env.CDS_CODE_REVIEW_GATEWAY_SERVICE_KEY); }
  private base(): string {
    const url = new URL(this.env().CDS_CODE_REVIEW_GATEWAY_URL || '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('用户 Key 网关地址无效');
    return url.origin;
  }
  private async request(operation: string, path: string, init: RequestInit, audit: CodeReviewAudit = async () => {}): Promise<unknown> {
    if (!this.configured()) throw new Error('用户 Key 网关尚未配置');
    return reviewJsonRequest(operation, `${this.base()}/internal/code-review/user-keys${path}`, {
      ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'X-Code-Review-Service-Key': this.env().CDS_CODE_REVIEW_GATEWAY_SERVICE_KEY!, ...init.headers },
    }, audit, this.fetchImpl);
  }
  async bind(input: ReviewUserKeyInput, identity: { owner: string; projectId: string; taskId: string }, audit: CodeReviewAudit): Promise<ReviewUserKeyBinding> {
    if (!input || !['openai', 'anthropic', 'openrouter', 'deepseek'].includes(input.provider)
      || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200
      || typeof input.apiKey !== 'string' || input.apiKey.length < 8 || input.apiKey.length > 4096 || /\s/.test(input.apiKey)
      || input.tokenLimit !== undefined && (!Number.isSafeInteger(input.tokenLimit) || input.tokenLimit < 4096 || input.tokenLimit > 10000000)) throw new Error('供应商、模型、Key 或 Token 额度无效');
    const value = await this.request('user_key.bind', '/bind', { method: 'POST', body: JSON.stringify({ ...identity, ...input, model: input.model.trim(), tokenLimit: input.tokenLimit ?? 200000 }) }, audit) as {
      bindingId: string; keyId: string; provider: string; model: string; fingerprint: string; tokenLimit: number };
    if (!value?.bindingId || !value.keyId || !value.model || !value.provider || !Number.isSafeInteger(value.tokenLimit)) throw new Error('用户 Key 绑定响应无效');
    return { id: value.bindingId, owner: identity.owner, keyId: value.keyId, provider: value.provider, model: value.model, fingerprint: value.fingerprint, tokenLimit: value.tokenLimit };
  }
  private query(binding: ReviewUserKeyBinding, projectId: string): string { return new URLSearchParams({ owner: binding.owner, projectId }).toString(); }
  async engineConfig(binding: ReviewUserKeyBinding, projectId: string, audit: CodeReviewAudit): Promise<{ baseUrl: string; token: string; model: string }> {
    const value = await this.request('user_key.task_binding', `/${binding.id}?${this.query(binding, projectId)}&binding=1`, {}, audit) as { token?: string; model?: string };
    if (!value?.token?.startsWith('cruk_') || value.model !== binding.model) throw new Error('用户 Key 任务绑定无效；未使用平台凭据');
    return { baseUrl: `${this.base()}/byok/v1`, token: value.token, model: value.model };
  }
  usage(binding: ReviewUserKeyBinding, projectId: string): Promise<ReviewKeyUsage> {
    return this.request('user_key.usage', `/${binding.id}?${this.query(binding, projectId)}`, {}) as Promise<ReviewKeyUsage>;
  }
}
