import { branchSubmitter, parseBranchViewMode, type BranchSubmitterInput } from './branchSubmitters';

export const BRANCH_VIEW_LIMIT = 12;
export const BRANCH_VIEW_NAME_LIMIT = 24;
export const BRANCH_VIEW_PREFIX_LIMIT = 40;

export const BRANCH_VIEW_SOURCES = {
  status: { name: '按状态', description: '区分活跃分支与未运行分支。' },
  groups: { name: '按分组', description: '查看项目已有的自定义分组。' },
  submitters: { name: '按提交者', description: '按最近的 GitHub 推送账号归类，缺少账号时使用提交作者信息。' },
  tags: { name: '按标签', description: '按分支标签归类；有多个标签的分支会出现在多个组里。' },
  tasks: { name: '按任务类型', description: '使用“任务:修复”等标签，或 feat/、fix/、release/ 等分支前缀归类。' },
  agents: { name: '按 Agent', description: '使用“Agent:Codex”等标签，或 codex/、claude/、cursor/ 分支前缀归类。' },
  roles: { name: '按角色', description: '使用“角色:开发”“角色:测试”等分支标签归类。' },
  'tag-prefix': { name: '自定义标签分类', description: '例如前缀“模块:”，会把“模块:登录”归到“登录”组。' },
} as const;

export type BranchViewSource = keyof typeof BRANCH_VIEW_SOURCES;
export interface BranchView {
  id: string;
  name: string;
  source: BranchViewSource;
  tagPrefix?: string;
}
export interface BranchViewsSettings { views: BranchView[]; selectedId: string }

export function defaultBranchViews(selectedId = 'status'): BranchViewsSettings {
  return {
    views: (['status', 'groups', 'submitters'] as const).map((source) => ({ id: source, name: BRANCH_VIEW_SOURCES[source].name, source })),
    selectedId: ['status', 'groups', 'submitters'].includes(selectedId) ? selectedId : 'status',
  };
}

/** 本机 UI 偏好按账号与项目隔离，不写项目共享配置。 */
export function branchViewsStorageKey(account: string, projectId: string): string {
  return `cds_branch_views:v1:${encodeURIComponent(account)}:${encodeURIComponent(projectId)}`;
}

export function normalizeBranchViews(input: unknown): BranchViewsSettings {
  if (!input || typeof input !== 'object') return defaultBranchViews();
  const raw = input as { views?: unknown; selectedId?: unknown };
  if (!Array.isArray(raw.views)) return defaultBranchViews();
  const ids = new Set<string>();
  const views: BranchView[] = [];
  for (const item of raw.views) {
    if (!item || typeof item !== 'object') continue;
    const view = item as Partial<BranchView>;
    if (typeof view.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(view.id) || ids.has(view.id)) continue;
    if (typeof view.source !== 'string' || !Object.hasOwn(BRANCH_VIEW_SOURCES, view.source)) continue;
    const name = typeof view.name === 'string' ? view.name.trim().slice(0, BRANCH_VIEW_NAME_LIMIT) : '';
    if (!name) continue;
    const tagPrefix = typeof view.tagPrefix === 'string' ? view.tagPrefix.trim().slice(0, BRANCH_VIEW_PREFIX_LIMIT) : '';
    if (view.source === 'tag-prefix' && !tagPrefix) continue;
    ids.add(view.id);
    views.push({ id: view.id, name, source: view.source, ...(view.source === 'tag-prefix' ? { tagPrefix } : {}) });
    if (views.length >= BRANCH_VIEW_LIMIT) break;
  }
  if (views.length === 0) return defaultBranchViews();
  return { views, selectedId: typeof raw.selectedId === 'string' && ids.has(raw.selectedId) ? raw.selectedId : views[0].id };
}

export function readBranchViews(storage: Pick<Storage, 'getItem'>, key: string, projectId: string): BranchViewsSettings {
  try {
    const raw = storage.getItem(key);
    return raw === null
      ? defaultBranchViews(parseBranchViewMode(storage.getItem(`cds_branch_view_mode:${projectId}`)))
      : normalizeBranchViews(JSON.parse(raw));
  } catch { return defaultBranchViews(); }
}

export function removeBranchView(settings: BranchViewsSettings, id: string): BranchViewsSettings {
  if (settings.views.length <= 1) return settings;
  const views = settings.views.filter((view) => view.id !== id);
  return { views, selectedId: views.some((view) => view.id === settings.selectedId) ? settings.selectedId : views[0].id };
}

export function newBranchViewId(): string { return `v-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`; }

export interface CategorizedBranch extends BranchSubmitterInput { id: string; branch: string; tags?: string[] }
export interface BranchViewGroup { id: string; name: string; unknown: boolean }
export interface BranchViewSection<T> { group: BranchViewGroup; branches: T[] }

const TASK_PREFIX_NAMES: Record<string, string> = {
  feat: '新功能', feature: '新功能', fix: '修复', hotfix: '热修', refactor: '重构',
  perf: '性能优化', release: '发布', docs: '文档', test: '测试', chore: '日常维护',
};
const AGENT_PREFIX_NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor' };

function taggedValues(branch: CategorizedBranch, prefix: string): string[] {
  return [...new Set((branch.tags ?? []).filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length).trim()).filter(Boolean))];
}

/** 分类与搜索定位共用判定；标签允许多组展示，状态/自定义分组仍走各自原有判定。 */
export function branchViewGroups(view: BranchView, branch: CategorizedBranch): BranchViewGroup[] {
  let values: string[] = [];
  let unknownName = '未分类';
  if (view.source === 'submitters') {
    const submitter = branchSubmitter(branch);
    return [{ ...submitter, id: `view:${view.id}:${submitter.id}` }];
  }
  if (view.source === 'tags') {
    values = [...new Set((branch.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
    unknownName = '无标签';
  } else if (view.source === 'roles') {
    values = taggedValues(branch, '角色:');
    unknownName = '未指定角色';
  } else if (view.source === 'tag-prefix') {
    values = view.tagPrefix ? taggedValues(branch, view.tagPrefix) : [];
    unknownName = '未分类';
  } else if (view.source === 'tasks' || view.source === 'agents') {
    values = taggedValues(branch, view.source === 'tasks' ? '任务:' : 'Agent:');
    const prefix = branch.branch.includes('/') ? branch.branch.slice(0, branch.branch.indexOf('/')) : '';
    const names = view.source === 'tasks' ? TASK_PREFIX_NAMES : AGENT_PREFIX_NAMES;
    const label = Object.hasOwn(names, prefix) ? names[prefix] : undefined;
    if (values.length === 0 && label) values = [label];
    unknownName = view.source === 'tasks' ? '未指定任务类型' : '未指定 Agent';
  }
  return values.length > 0
    ? values.map((name) => ({ id: `view:${view.id}:value:${encodeURIComponent(name)}`, name, unknown: false }))
    : [{ id: `view:${view.id}:unknown`, name: unknownName, unknown: true }];
}

export function groupBranchesByView<T extends CategorizedBranch>(view: BranchView, branches: T[]): BranchViewSection<T>[] {
  const sections = new Map<string, BranchViewSection<T>>();
  for (const branch of branches) {
    for (const group of branchViewGroups(view, branch)) {
      let section = sections.get(group.id);
      if (!section) { section = { group, branches: [] }; sections.set(group.id, section); }
      section.branches.push(branch);
    }
  }
  return [...sections.values()].sort((a, b) => Number(a.group.unknown) - Number(b.group.unknown));
}
