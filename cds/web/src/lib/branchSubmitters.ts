/** 提交者自动归类：优先 GitHub 推送账号，缺少账号时使用提交作者身份。 */
export interface BranchSubmitterInput {
  githubSenderLogin?: string;
  builder?: { name?: string; email?: string; login?: string };
}

export interface BranchSubmitter {
  id: string;
  name: string;
  unknown: boolean;
}

export type BranchViewMode = 'status' | 'groups' | 'submitters';

export function parseBranchViewMode(value: string | null): BranchViewMode {
  return value === 'groups' || value === 'submitters' ? value : 'status';
}

export function branchSubmitter(branch: BranchSubmitterInput): BranchSubmitter {
  const login = branch.githubSenderLogin?.trim() || branch.builder?.login?.trim();
  const email = branch.builder?.email?.trim();
  const name = branch.builder?.name?.trim();
  // 命名空间隔离账号、邮箱与名字；同名不同邮箱不能误合并。
  const kind = login ? 'login' : email ? 'email' : name ? 'name' : 'unknown';
  const value = login || email || name || '';
  return {
    id: `submitter:${kind}:${encodeURIComponent(value.toLowerCase())}`,
    name: login ? `@${login}` : name || email || '未知提交者',
    unknown: kind === 'unknown',
  };
}

export function groupBranchesBySubmitter<T extends BranchSubmitterInput>(branches: T[]): Array<{
  submitter: BranchSubmitter;
  branches: T[];
}> {
  const sections = new Map<string, { submitter: BranchSubmitter; branches: T[] }>();
  for (const branch of branches) {
    const submitter = branchSubmitter(branch);
    let section = sections.get(submitter.id);
    if (!section) {
      section = { submitter, branches: [] };
      sections.set(submitter.id, section);
    }
    section.branches.push(branch);
  }
  // 保留页面现有的异常 / 收藏 / 活跃排序，未知提交者放在最后。
  return [...sections.values()].sort((a, b) => Number(a.submitter.unknown) - Number(b.submitter.unknown));
}
