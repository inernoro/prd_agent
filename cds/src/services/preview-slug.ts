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
  if (!branch) return project;
  // 第一个 `/` 切一刀；多级 `/` 在 tail 里走 slugify 变 `-`。
  const cutAt = branch.indexOf('/');
  if (cutAt < 0) {
    // 无 prefix：`${tail}-${project}`，中段省略
    const tail = slugifyForPreview(branch);
    return tail ? `${tail}-${project}` : project;
  }
  const prefix = slugifyForPreview(branch.slice(0, cutAt));
  const tail = slugifyForPreview(branch.slice(cutAt + 1));
  // prefix 被规范化后可能为空（如分支名以 `/` 开头），fallback 到无 prefix 形式
  if (!prefix) return tail ? `${tail}-${project}` : project;
  if (!tail) return `${prefix}-${project}`;
  return `${tail}-${prefix}-${project}`;
}
