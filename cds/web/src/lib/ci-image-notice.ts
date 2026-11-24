export interface CiDiagnosisView {
  code: string;
  title: string;
  message: string;
  targetSha: string;
  checkedAt: string;
  actionUrl: string;
  actionLabel: string;
}

export interface CiImageNoticeInput {
  ciImageStatus?: string;
  ciTargetSha?: string;
  ciWorkflowConclusion?: string;
  ciWorkflowRunUrl?: string;
  ciImageError?: string;
  ciDiagnosis?: CiDiagnosisView | null;
  githubRepoFullName?: string;
  branch?: string;
}

export function ciImageNotice(branch: CiImageNoticeInput) {
  const diagnosis = branch.ciDiagnosis?.targetSha === branch.ciTargetSha ? branch.ciDiagnosis : null;
  const legacy: Record<string, [string, string]> = {
    cancelled: ['CI 已取消', '构建已取消；确认仍需预览后重新运行镜像构建。'],
    failure: ['CI 构建失败', '请查看失败步骤，修复后重新运行镜像构建。'],
    timed_out: ['CI 构建超时', '请查看耗时步骤后重试。'],
    startup_failure: ['CI 启动失败', '工作流未能启动，请查看 GitHub 启动诊断。'],
    timed_out_no_run: ['CI 状态待核对', '未收到匹配的完成回执，正在核对 GitHub 实际状态。'],
    status_unknown: ['CI 状态未确认', '暂时无法核对 GitHub，请打开 Actions 查看。'],
  };
  const fallback = legacy[branch.ciWorkflowConclusion || '']
    || (branch.ciImageStatus === 'waiting' ? ['等待 CI 镜像', '正在等待镜像构建结果。'] : ['CI 镜像未就绪', branch.ciImageError || '请查看 GitHub 镜像工作流。']);
  const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(branch.githubRepoFullName || '') ? branch.githubRepoFullName : '';
  const candidate = diagnosis?.actionUrl || branch.ciWorkflowRunUrl
    || (repository ? `https://github.com/${repository}/actions?query=${encodeURIComponent(`branch:${branch.branch || ''}`)}` : '');
  let actionUrl = '';
  try {
    const url = new URL(candidate);
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password) actionUrl = url.href;
  } catch { /* 没有关联仓库时不构造未知地址。 */ }
  return { title: diagnosis?.title || fallback[0], message: diagnosis?.message || fallback[1], actionUrl,
    actionLabel: diagnosis?.actionLabel || (branch.ciWorkflowRunUrl ? '查看构建' : '查看 Actions'),
    checkedAt: diagnosis?.checkedAt };
}
