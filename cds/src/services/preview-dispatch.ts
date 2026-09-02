/**
 * preview-dispatch —— 「这次提交该给哪些预览地址」的唯一判据。
 *
 * ## 为什么把判定搬到服务端
 *
 * 命令行此前在本地推断「我这条分支属于哪个项目」：读 git 分支、读仓库根、拼项目
 * slug 提示，再拿去和 `/api/branches` 的结果对。一个仓库只喂一个项目时这套能凑合，
 * 一旦同一个仓库下有多个项目，同名分支天然可以同时属于好几个 —— 猜就必然要么猜错、
 * 要么硬失败。它里面已经长出一条「自托管项目专用」的特判分支，那是同一份判据开始
 * 分裂成两份的第一个症状；再拆一个项目就会有第三个特判。
 *
 * 所以客户端只交事实（仓库、分支、可选的改动清单），判定全在服务端，并且与 push
 * 分发**共用同一份作用域判据**（`project-scope.ts`）——否则会出现「部署了却说没波及」
 * 这种两处判据各自漂移的错答案，而且不会报错。
 *
 * ## 四种结论必须分得开
 *
 * | 结论 | 含义 | 下一步 |
 * |---|---|---|
 * | affected-deployed | 波及且已发布入口 | 点地址验收 |
 * | affected-not-deployed | 波及、分支在、但还没有已发布入口 | 等部署或去看构建 |
 * | affected-no-branch | 波及、但 CDS 上还没有这条分支 | 建分支（link 之后由 push 自动建） |
 * | not-affected | 本次改动不在该项目作用域内 | 无需动作，这不是错误 |
 *
 * 合并成一句「取不到地址」等于把可诊断的状态压成一个没用的报错，正是要避免的。
 *
 * 纯函数：不读 state、不查 docker，可直接单测。
 */

import { decideProjectScope, type ProjectScopeDecision } from './project-scope.js';

export type PreviewDispatchStatus =
  | 'affected-deployed'
  | 'affected-not-deployed'
  | 'affected-no-branch'
  | 'not-affected';

/** 一条已发布的用户可见入口（口径与 GET /api/branches 的 previewEntries 同源）。 */
export interface PreviewEntryFact {
  name: string;
  url: string;
}

/** 判定一个项目所需的全部事实。由路由从 state 组装。 */
export interface PreviewProjectFacts {
  projectId: string;
  projectSlug: string;
  projectName: string;
  /** 该项目的构建输入范围并集；空数组 = 未声明 = 全通配。 */
  scope: string[];
  /** CDS 上这条分支的 id；不存在时 undefined。 */
  branchId?: string;
  /** 该分支已发布的用户可见入口；未部署时为空。 */
  entries: PreviewEntryFact[];
}

export interface PreviewProjectResult {
  projectId: string;
  projectSlug: string;
  projectName: string;
  status: PreviewDispatchStatus;
  /** 人话结论，可直接展示 */
  summary: string;
  scope: string[];
  scopeReason: string;
  branchId?: string;
  entries: Array<PreviewEntryFact & { label: string }>;
}

export interface PreviewDispatchResult {
  branch: string;
  /** 每个可见项目一条，含未波及的 —— 缺席要能声明，不能悄悄消失。 */
  projects: PreviewProjectResult[];
  /**
   * 可直接打印的地址行，格式 `[项目名 · 入口名] URL`；某项目只有一个入口时
   * 收缩成 `[项目名] URL`。只包含真的有地址的项目。
   */
  lines: string[];
}

/**
 * 一条地址行的标签。
 *
 * 项目只有一个入口时收缩成 `[项目名]` —— 多入口时必须带上入口名，否则同一个项目
 * 会出现两行同名标签，看的人分不出该点哪个（这是格式定稿时点名要避免的）。
 */
export function formatEntryLabel(projectName: string, entryName: string, entryCount: number): string {
  return entryCount <= 1 ? `[${projectName}]` : `[${projectName} · ${entryName}]`;
}

function summarize(status: PreviewDispatchStatus, facts: PreviewProjectFacts, branch: string): string {
  switch (status) {
    case 'affected-deployed':
      return `已发布 ${facts.entries.length} 个入口`;
    case 'affected-not-deployed':
      return `分支 ${facts.branchId} 在 CDS 上，但还没有已发布的用户入口（多半正在构建，或该分支没有对外的 Web 服务）`;
    case 'affected-no-branch':
      return `本次改动波及该项目，但 CDS 上还没有分支 '${branch}'`;
    default:
      return '本次改动不在该项目的构建范围内，与它无关';
  }
}

/** 单个项目的判定。 */
export function decidePreviewForProject(
  facts: PreviewProjectFacts,
  changedPaths: readonly string[],
  branch: string,
): PreviewProjectResult {
  const decision: ProjectScopeDecision = decideProjectScope(facts.scope, changedPaths);
  let status: PreviewDispatchStatus;
  if (!decision.matched) status = 'not-affected';
  else if (!facts.branchId) status = 'affected-no-branch';
  else if (facts.entries.length === 0) status = 'affected-not-deployed';
  else status = 'affected-deployed';

  const entries = status === 'affected-deployed'
    ? facts.entries.map((entry) => ({
        ...entry,
        label: formatEntryLabel(facts.projectName, entry.name, facts.entries.length),
      }))
    : [];

  return {
    projectId: facts.projectId,
    projectSlug: facts.projectSlug,
    projectName: facts.projectName,
    status,
    summary: summarize(status, facts, branch),
    scope: facts.scope,
    scopeReason: decision.reason,
    ...(facts.branchId ? { branchId: facts.branchId } : {}),
    entries,
  };
}

/**
 * 主判据：给定一批项目事实与本次改动清单，算出每个项目的结论与可打印的地址行。
 */
export function resolvePreviewDispatch(
  branch: string,
  projects: readonly PreviewProjectFacts[],
  changedPaths: readonly string[],
): PreviewDispatchResult {
  const results = projects.map((facts) => decidePreviewForProject(facts, changedPaths, branch));
  const lines: string[] = [];
  for (const project of results) {
    for (const entry of project.entries) lines.push(`${entry.label} ${entry.url}`);
  }
  return { branch, projects: results, lines };
}
