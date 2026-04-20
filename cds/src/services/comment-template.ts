/**
 * GitHub PR preview comment template service.
 *
 * The comment that CDS posts on every PR (and refreshes on every
 * deploy) used to be hard-coded in github-webhook.ts. This module
 * exposes two things the rest of the system needs:
 *
 *   1. `renderTemplate(body, vars)` — replace `{{name}}` placeholders
 *      with `vars[name]`. Unknown placeholders stay as-is so a typo
 *      in the template is visible in the rendered comment rather
 *      than silently eating the literal text.
 *
 *   2. `buildPrReviewDeeplink(previewUrl, prUrl)` — assemble the URL
 *      that jumps a user into the internal PR-review Agent with a PR
 *      URL pre-filled + autoStart flag so the review kicks off
 *      without a second click.
 *
 *      PR审查 Agent 本身就是随分支一起部署的前端应用的一部分(路由
 *      `/pr-review`),所以跳转地址 = 当前分支的 previewUrl + 该路由。
 *      不需要额外配置"prd-admin 根域名"——每条 PR 的评论里贴的深链
 *      自然落回该 PR 自己那条分支的预览,用户登录状态由目标页面的
 *      RequireAuth 经 returnUrl 接管。
 *
 * The default template deliberately mirrors the pre-customisation
 * format (🚀 CDS Deploy Preview + Preview link + Branch + Dashboard)
 * plus a new "PR Review" line so existing users who never open the
 * Settings panel don't notice a regression.
 *
 * The list of supported variables lives in VARIABLE_DEFS and doubles
 * as the source that drives the settings-panel "available variables"
 * sidebar — one definition site to keep the template author and the
 * renderer in sync.
 */

export interface TemplateVariableDef {
  /** `{{name}}` as it appears inside template bodies. */
  key: string;
  /** One-line Chinese label shown in the settings panel. */
  label: string;
  /** Short example so the author knows what the value looks like. */
  example: string;
}

/**
 * Fixed set of variables exposed to template authors. Keep this in
 * sync with the `TemplateVariables` interface below — compile-time
 * type safety is useful; parity with the UI sidebar is critical.
 */
export const VARIABLE_DEFS: readonly TemplateVariableDef[] = [
  { key: 'branch', label: '分支名', example: 'feature/login-fix' },
  { key: 'shortSha', label: 'commit SHA 前 7 位', example: 'a1b2c3d' },
  { key: 'commitSha', label: '完整 commit SHA', example: 'a1b2c3d4e5f6...' },
  { key: 'previewUrl', label: '预览地址', example: 'https://feature-login-fix.miduo.org' },
  { key: 'dashboardUrl', label: 'CDS 分支面板 URL', example: 'https://cds.miduo.org/branch-panel?id=...' },
  { key: 'repoFullName', label: 'owner/repo', example: 'inernoro/prd_agent' },
  { key: 'prNumber', label: 'PR 号', example: '123' },
  { key: 'prUrl', label: 'PR 完整 URL', example: 'https://github.com/inernoro/prd_agent/pull/123' },
  {
    key: 'prReviewUrl',
    label: '一键跳转 PR 审查 Agent（= 本分支预览地址 + /pr-review）',
    example: 'https://<branch>.miduo.org/pr-review?prUrl=...&autoStart=1',
  },
] as const;

export interface TemplateVariables {
  branch: string;
  shortSha: string;
  commitSha: string;
  previewUrl: string;
  dashboardUrl: string;
  repoFullName: string;
  prNumber: string;
  prUrl: string;
  prReviewUrl: string;
}

/**
 * Default template body — kept byte-identical to the pre-feature
 * hard-coded markdown in github-webhook.ts so an upgrade without
 * touching settings is a no-op visually, then a new "PR Review"
 * deeplink line to surface the new capability.
 *
 * Using a conditional fragment for previewUrl / prReviewUrl would
 * need a real template engine. Instead we rely on the fact that an
 * unset variable renders to an empty string (see renderTemplate's
 * vars normalisation), so lines like `- **Preview**: [](…)` look a
 * bit ugly but still post. Users can edit the template if they
 * want cleaner fallbacks.
 */
export const DEFAULT_TEMPLATE_BODY = [
  '## 🚀 CDS Deploy Preview',
  '',
  '- **Preview**: [{{previewUrl}}]({{previewUrl}})',
  '- **Branch**: `{{branch}}` @ {{shortSha}}',
  '- **CDS Dashboard**: [{{branch}}]({{dashboardUrl}})',
  '- **PR Review**: [一键进入 PR 审查 Agent]({{prReviewUrl}}) — 免手动粘贴链接，登录后自动发起审查',
  '',
  '<sub>push 到此分支会自动触发新部署, 本条评论会在每次部署后原地刷新。可在 CDS Settings → 评论模板 中自定义。</sub>',
].join('\n');

/**
 * Replace `{{name}}` occurrences in `body` with `vars[name]`.
 *
 * Unknown placeholders are left intact (visible in the rendered
 * output) so template typos surface immediately instead of becoming
 * a silent "why is my variable gone" bug. Whitespace inside braces
 * (`{{ branch }}`) is tolerated.
 *
 * Also guards against infinite recursion: `vars` values that happen
 * to contain `{{something}}` are NOT re-rendered — we scan the body
 * exactly once.
 */
export function renderTemplate(
  body: string,
  vars: Partial<TemplateVariables>,
): string {
  return body.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g, (match, name: string) => {
    const value = (vars as Record<string, unknown>)[name];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

/**
 * Assemble the PR-review Agent deeplink from the current branch's
 * preview URL.
 *
 * The PR-review page is served by the frontend that rides on the
 * preview subdomain (path `/pr-review`), so we reuse `previewUrl`
 * as-is — no separate configuration for a standalone prd-admin host.
 * Returns empty string when either `previewUrl` or `prUrl` is missing
 * so the default template's `{{prReviewUrl}}` placeholder produces
 * an empty link (harmless) rather than a broken one.
 *
 * The target page (prd-admin PrReviewPage) reads `prUrl` +
 * `autoStart=1` from the query string on mount; the wrapping
 * RequireAuth guard appends a `returnUrl` if the user is not
 * logged in, so this URL works for both logged-in and logged-out
 * visitors.
 */
export function buildPrReviewDeeplink(
  previewUrl: string | undefined | null,
  prUrl: string,
): string {
  if (!previewUrl || !prUrl) return '';
  const trimmed = previewUrl.replace(/\/$/, '');
  const encoded = encodeURIComponent(prUrl);
  return `${trimmed}/pr-review?prUrl=${encoded}&autoStart=1`;
}

/**
 * Variable builder shared between the real webhook path and the
 * settings panel's "preview" action. Centralises the "what goes in
 * vars" logic so the preview always matches what the live webhook
 * would render.
 */
export interface BuildVariablesInput {
  branch: string;
  commitSha: string;
  previewUrl: string;
  dashboardUrl: string;
  repoFullName: string;
  prNumber: number | string;
  prUrl: string;
}

export function buildTemplateVariables(input: BuildVariablesInput): TemplateVariables {
  const commitSha = input.commitSha || '';
  return {
    branch: input.branch || '',
    shortSha: commitSha.slice(0, 7),
    commitSha,
    previewUrl: input.previewUrl || '',
    dashboardUrl: input.dashboardUrl || '',
    repoFullName: input.repoFullName || '',
    prNumber: input.prNumber != null ? String(input.prNumber) : '',
    prUrl: input.prUrl || '',
    prReviewUrl: buildPrReviewDeeplink(input.previewUrl || '', input.prUrl || ''),
  };
}

