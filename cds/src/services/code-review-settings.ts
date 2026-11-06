import type { StateService } from './state.js';

/** Only references are persisted. Service credentials remain in the engine project's environment. */
export interface CodeReviewSettings {
  engineBaseUrl: string;
  engineProjectId: string;
}
export interface CodeReviewEngineConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  token?: string;
}

function engineUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('DeepAudit 服务地址无效');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('DeepAudit 服务地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('DeepAudit 服务地址仅支持无凭据、查询参数和片段的 HTTP(S) 地址');
  }
  return url.toString().replace(/\/$/, '');
}

export function validateCodeReviewSettings(state: StateService, input: unknown): CodeReviewSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['engineBaseUrl', 'engineProjectId'].includes(key))) {
    throw new Error('仅可提交审查引擎地址和项目引用，禁止提交凭据');
  }
  const { engineBaseUrl, engineProjectId } = input as Record<string, unknown>;
  if (typeof engineProjectId !== 'string' || !state.getProject(engineProjectId)) throw new Error('DeepAudit 项目不存在');
  const baseUrl = engineUrl(engineBaseUrl);
  const env = state.getCustomEnv(engineProjectId);
  if (!env.CDS_SERVICE_EMAIL?.trim() || !env.CDS_SERVICE_PASSWORD?.trim()) throw new Error('DeepAudit 项目尚未配置专用服务账号');
  return { engineBaseUrl: baseUrl, engineProjectId };
}

/** Read on every run, so a saved binding or rotated account takes effect without restarting CDS. */
export function resolveCodeReviewEngineConfig(state: StateService, env: NodeJS.ProcessEnv = process.env): CodeReviewEngineConfig | undefined {
  const binding = state.getCodeReviewSettings();
  if (binding) {
    try {
      const valid = validateCodeReviewSettings(state, binding);
      const account = state.getCustomEnv(valid.engineProjectId);
      return { baseUrl: valid.engineBaseUrl, username: account.CDS_SERVICE_EMAIL, password: account.CDS_SERVICE_PASSWORD };
    } catch { return undefined; }
  }
  if (!env.CDS_DEEPAUDIT_BASE_URL?.trim()
    || !(env.CDS_DEEPAUDIT_TOKEN?.trim() || (env.CDS_DEEPAUDIT_USERNAME?.trim() && env.CDS_DEEPAUDIT_PASSWORD?.trim()))) return undefined;
  try {
    return { baseUrl: engineUrl(env.CDS_DEEPAUDIT_BASE_URL), username: env.CDS_DEEPAUDIT_USERNAME,
      password: env.CDS_DEEPAUDIT_PASSWORD, token: env.CDS_DEEPAUDIT_TOKEN };
  } catch { return undefined; }
}
