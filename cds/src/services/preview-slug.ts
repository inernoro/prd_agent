import crypto from 'node:crypto';

/**
 * Preview-slug 计算与解析的唯一来源（Single Source of Truth）。
 *
 * 历史背景（务必读完再改这个文件）：
 *
 * v1：分支预览 URL 是 `${branchSlug}.miduo.org`
 *     问题：CDS 多项目改造（PR #498，2026-04-24）后，非 legacy 项目的
 *     entry 存到 canonical id `${projectSlug}-${branchSlug}` 下；裸 slug
 *     URL 在 proxy 里查不到 → auto-build 死循环 → 用户看到 HTTP 400。
 *
 * v2（2026-04-26 ceb2c01）：URL 改成 `${projectSlug}-${branchSlug}.miduo.org`
 *     问题：项目名（`prd-agent`）放在最前面，"我现在在干啥"反而排到后面，
 *     用户体验上重要的信息被埋住。
 *
 * v3（本文件）：URL 改成 `${tail}-${prefix}-${projectSlug}.miduo.org`
 *     - tail 是分支名第一个 `/` 后的部分（"在干啥"）
 *     - prefix 是 `/` 前的 agent/类型前缀（claude / cursor / feat / fix）
 *     - projectSlug 在最后（项目身份信息，最不需要常看）
 *     - 重要信息靠前，全小写，唯一来源
 *
 *     v1/v2 的旧 URL 还能解析（双兼容），但 generator 一律产出 v3 格式。
 *
 * 解析逻辑（在 proxy.ts 里）：
 *     ① 前向匹配：遍历每个 entry，调 computePreviewSlug 算它的 v3 slug，
 *        和输入比，等就命中（无歧义、最权威）
 *     ② v1 兼容：state.branches[slug] 直查（legacy 项目）
 *     ③ v2 兼容：state.branches[`${project.slug}-${slug}`] 拼接查
 *
 *     三档都没命中才走 auto-build。
 */

/**
 * 把任意字符串规范化成 DNS-friendly 的 slug。
 * 规则与 cds/src/services/state.ts 的 slugify 保持一致：
 *   - 转小写
 *   - 非 [a-z0-9-] 字符替换为 `-`
 *   - 合并连续 `-`
 *   - 去掉头尾 `-`
 */
export function slugifyForPreview(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const DNS_LABEL_MAX_LENGTH = 63;
const PREVIEW_SLUG_HASH_LENGTH = 8;

function capPreviewSlug(slug: string): string {
  if (slug.length <= DNS_LABEL_MAX_LENGTH) return slug;
  const hash = crypto.createHash('sha1').update(slug).digest('hex').slice(0, PREVIEW_SLUG_HASH_LENGTH);
  const prefixLength = DNS_LABEL_MAX_LENGTH - PREVIEW_SLUG_HASH_LENGTH - 1;
  const prefix = slug.slice(0, prefixLength).replace(/-+$/g, '');
  return `${prefix || slug.slice(0, prefixLength)}-${hash}`;
}

export interface PreviewProjectIdentity {
  id?: string | null;
  slug?: string | null;
  aliasSlug?: string | null;
  name?: string | null;
  gitRepoUrl?: string | null;
  githubRepoFullName?: string | null;
  legacyFlag?: boolean | null;
}

export type PreviewProjectIdentitySource = 'aliasSlug' | 'slug' | 'repo' | 'fallback' | 'id' | 'name' | 'default';

export interface ResolvedPreviewProjectIdentity {
  slug: string;
  source: PreviewProjectIdentitySource;
  degraded: boolean;
  reason?: string;
}

export const GENERIC_PREVIEW_PROJECT_SLUGS = new Set([
  'workspace',
  'cursor-workspace',
  'codex-workspace',
  'project',
  'repo',
  'repository',
  'source',
  'src',
  'app',
]);

export function isGenericPreviewProjectSlug(slug: string | undefined | null): boolean {
  return GENERIC_PREVIEW_PROJECT_SLUGS.has(slugifyForPreview(String(slug || '')));
}

/**
 * 从 Git remote / owner/repo 里取仓库名，避免把本地目录名（如 workspace）
 * 错当成项目身份拼进 preview URL。
 */
export function repoNameFromGitRef(raw: string | undefined | null): string {
  const value = String(raw || '').trim();
  if (!value) return '';

  const withoutQuery = value.replace(/[?#].*$/, '').replace(/\/+$/, '');
  let pathPart = withoutQuery;

  if (/^[^@\s]+@[^:\s]+:.+/.test(withoutQuery)) {
    pathPart = withoutQuery.slice(withoutQuery.indexOf(':') + 1);
  } else {
    try {
      const parsed = new URL(withoutQuery);
      pathPart = parsed.pathname;
    } catch {
      pathPart = withoutQuery;
    }
  }

  const last = pathPart
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop() || '';
  return slugifyForPreview(last.replace(/\.git$/i, ''));
}

/**
 * Preview URL 里的项目段必须优先代表 CDS 项目身份，而不是 Git 仓库。
 *
 * 同一个 CDS 实例里允许多个项目绑定同一个 Git repo；如果把 repo 名作为
 * preview 项目段，两个项目的 `main` 都会生成 `main-prd-agent` 这类冲突
 * 域名。Git repo 名只能作为旧链接解析候选，不能作为新链接生成依据。
 */
export function previewProjectSlug(
  project: PreviewProjectIdentity | undefined | null,
  fallback?: string | null,
): string {
  return resolvePreviewProjectIdentity(project, fallback).slug;
}

/**
 * Resolve the project identity segment used in generated preview URLs.
 *
 * This is the SSOT for "what project name goes into preview hostnames".
 * Callers that need diagnostics should use the full return value; legacy
 * call sites can keep using previewProjectSlug(), which delegates here.
 */
export function resolvePreviewProjectIdentity(
  project: PreviewProjectIdentity | undefined | null,
  fallback?: string | null,
): ResolvedPreviewProjectIdentity {
  const alias = slugifyForPreview(project?.aliasSlug || '');
  if (alias) {
    return { slug: alias, source: 'aliasSlug', degraded: false };
  }

  const slug = slugifyForPreview(project?.slug || '');
  if (slug) {
    if (project?.legacyFlag && isGenericPreviewProjectSlug(slug)) {
      return {
        slug,
        source: 'slug',
        degraded: true,
        reason: `legacy project slug '${slug}' is generic; keeping it unless a collision-checked aliasSlug is persisted`,
      };
    }
    return { slug, source: 'slug', degraded: false };
  }

  const fallbackSlug = slugifyForPreview(fallback || '');
  if (fallbackSlug) {
    return {
      slug: fallbackSlug,
      source: 'fallback',
      degraded: true,
      reason: 'project slug missing; using caller fallback',
    };
  }

  const id = slugifyForPreview(project?.id || '');
  if (id) {
    return {
      slug: id,
      source: 'id',
      degraded: true,
      reason: 'project slug missing; using project id',
    };
  }

  const name = slugifyForPreview(project?.name || '');
  if (name) {
    return {
      slug: name,
      source: 'name',
      degraded: true,
      reason: 'project slug missing; using project name',
    };
  }

  const repo = repoNameFromGitRef(project?.gitRepoUrl) || repoNameFromGitRef(project?.githubRepoFullName);
  if (repo) {
    return {
      slug: repo,
      source: 'repo',
      degraded: true,
      reason: 'project identity missing; using repository slug',
    };
  }

  return {
    slug: 'default',
    source: 'default',
    degraded: true,
    reason: 'project identity missing; using default preview identity',
  };
}

/**
 * 解析 preview host 时保留历史 project.slug / aliasSlug 兼容；新链接只用
 * previewProjectSlug() 生成。
 */
export function previewProjectSlugCandidates(
  project: PreviewProjectIdentity | undefined | null,
  fallback?: string | null,
): string[] {
  const candidates = [
    previewProjectSlug(project, fallback),
    project?.slug,
    project?.aliasSlug,
    fallback,
    project?.id,
    repoNameFromGitRef(project?.gitRepoUrl),
    repoNameFromGitRef(project?.githubRepoFullName),
  ]
    .map((s) => slugifyForPreview(String(s || '')))
    .filter(Boolean);
  return Array.from(new Set(candidates));
}

export function previewSlugMatchPercent(
  targetSlug: string,
  candidatePreviewSlug: string,
  branchName = '',
): number {
  const normalize = (s: string): string[] => (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .split('-')
      .filter((p) => p.length >= 2)
  );
  const targetTokens = normalize(targetSlug);
  const candidateTokens = normalize(`${candidatePreviewSlug}-${branchName}`);
  if (targetTokens.length === 0 || candidateTokens.length === 0) return 0;

  const targetSet = new Set(targetTokens);
  const candidateSet = new Set(candidateTokens);
  let overlap = 0;
  for (const token of targetSet) {
    if (candidateSet.has(token)) overlap += 1;
  }

  const containment = overlap / targetSet.size;
  const union = new Set([...targetSet, ...candidateSet]).size || 1;
  const jaccard = overlap / union;
  const compactTarget = targetTokens.join('-');
  const compactCandidate = candidateTokens.join('-');
  const substringBonus = compactCandidate.includes(compactTarget) || compactTarget.includes(compactCandidate)
    ? 0.18
    : 0;
  return Math.max(1, Math.min(100, Math.round((containment * 0.72 + jaccard * 0.28 + substringBonus) * 100)));
}

/**
 * 根据 git 分支名 + 项目 slug 计算 v3 预览 slug。
 *
 * 例：
 *   computePreviewSlug('claude/fix-refresh-error-handling-2Xayx', 'prd-agent')
 *   → 'fix-refresh-error-handling-2xayx-claude-prd-agent'
 *
 *   computePreviewSlug('main', 'prd-agent')
 *   → 'main-prd-agent'                          // 无 prefix，省略中段
 *
 *   computePreviewSlug('feat/auth/login', 'prd-agent')
 *   → 'auth-login-feat-prd-agent'               // 多级路径剩余 / 走 slugify
 *
 *   computePreviewSlug('Feature/UI-Refactor', 'My_Project')
 *   → 'ui-refactor-feature-my-project'           // 大小写归一
 *
 * 纯函数，无副作用。所有 generator 都走这个；测试覆盖见 preview-slug.test.ts。
 */
export function computePreviewSlug(branch: string, projectSlug: string): string {
  const project = slugifyForPreview(projectSlug);
  if (!branch) return capPreviewSlug(project);
  // 第一个 `/` 切一刀；多级 `/` 在 tail 里走 slugify 变 `-`。
  const cutAt = branch.indexOf('/');
  let slug = project;
  if (cutAt < 0) {
    // 无 prefix：`${tail}-${project}`，中段省略
    const tail = slugifyForPreview(branch);
    slug = tail ? `${tail}-${project}` : project;
    return capPreviewSlug(slug);
  }
  const prefix = slugifyForPreview(branch.slice(0, cutAt));
  const tail = slugifyForPreview(branch.slice(cutAt + 1));
  // prefix 被规范化后可能为空（如分支名以 `/` 开头），fallback 到无 prefix 形式
  if (!prefix) slug = tail ? `${tail}-${project}` : project;
  else if (!tail) slug = `${prefix}-${project}`;
  else slug = `${tail}-${prefix}-${project}`;
  return capPreviewSlug(slug);
}
