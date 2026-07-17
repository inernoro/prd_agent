/**
 * 预览实例演示数据 seed（2026-07-15）。
 *
 * 预览实例是全新空库（容器内 JSON store），空 dashboard 什么都验收不了
 * （违反 guided-exploration「空状态必须有引导」）。首启时 seed 一个演示项目 +
 * 三条不同状态的分支 + 活动日志，让分支列表 / 拓扑 / 项目设置各页有真实形状的
 * 数据可看。所有条目都在名称 / 备注里写明「演示数据」，不冒充真实部署
 * （no-rootless-tree：虚构数据必须显式标注）。
 *
 * 只在满足全部条件时执行：预览实例模式 + 零项目 + 零分支。
 * 已有数据（例如挂了外部 mongo 的实例）一律不碰。
 */
import type { StateService } from './state.js';
import type { BranchEntry, BuildProfile, Project } from '../types.js';

export const PREVIEW_DEMO_PROJECT_ID = 'preview-demo';

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** 幂等 seed。执行了返回 true，条件不满足跳过返回 false。 */
export function seedPreviewInstanceDemoData(state: StateService): boolean {
  if (state.getProjects().length > 0) return false;
  if (state.getAllBranches().length > 0) return false;

  const now = new Date().toISOString();
  const project: Project = {
    id: PREVIEW_DEMO_PROJECT_ID,
    slug: PREVIEW_DEMO_PROJECT_ID,
    name: '演示项目（预览实例）',
    description: '预览实例自动生成的演示数据，用于验收 CDS 自身的界面与交互，不对应任何真实部署。',
    kind: 'git',
    createdAt: now,
    updatedAt: now,
  };
  state.addProject(project);

  const profiles: BuildProfile[] = [
    {
      id: 'demo-api',
      projectId: project.id,
      name: 'api（演示）',
      dockerImage: 'node:20-alpine',
      workDir: '.',
      command: 'echo demo-api',
      containerPort: 5000,
      pathPrefixes: ['/api/'],
    },
    {
      id: 'demo-web',
      projectId: project.id,
      name: 'web（演示）',
      dockerImage: 'node:20-alpine',
      workDir: '.',
      command: 'echo demo-web',
      containerPort: 5173,
    },
  ];
  for (const profile of profiles) state.addBuildProfile(profile);

  const branches: BranchEntry[] = [
    {
      id: `${project.id}-sample-running-feat`,
      projectId: project.id,
      branch: 'feat/sample-running',
      worktreePath: '/tmp/preview-demo/sample-running',
      status: 'running',
      createdAt: minutesAgoIso(180),
      lastAccessedAt: minutesAgoIso(6),
      notes: '演示数据：展示「运行中」状态的分支卡片，无真实容器。',
      services: {
        'demo-api': { profileId: 'demo-api', containerName: 'cds-demo-api-sample', hostPort: 10101, status: 'running' },
        'demo-web': { profileId: 'demo-web', containerName: 'cds-demo-web-sample', hostPort: 10102, status: 'running' },
      },
    },
    {
      id: `${project.id}-sample-error-fix`,
      projectId: project.id,
      branch: 'fix/sample-error',
      worktreePath: '/tmp/preview-demo/sample-error',
      status: 'error',
      errorMessage: '演示数据：构建失败示例（exit 1），用于查看错误态 UI。',
      createdAt: minutesAgoIso(90),
      notes: '演示数据：展示「错误」状态与错误信息展示。',
      services: {
        'demo-api': {
          profileId: 'demo-api',
          containerName: 'cds-demo-api-error',
          hostPort: 10103,
          status: 'error',
          errorMessage: '演示数据：dotnet build 退出码 1',
        },
      },
    },
    {
      id: `${project.id}-sample-idle-feat`,
      projectId: project.id,
      branch: 'feat/sample-idle',
      worktreePath: '/tmp/preview-demo/sample-idle',
      status: 'idle',
      createdAt: minutesAgoIso(30),
      notes: '演示数据：尚未部署的分支。',
      services: {},
    },
  ];
  for (const branch of branches) state.addBranch(branch);

  state.appendActivityLog(project.id, {
    type: 'branch-created',
    branchId: branches[0].id,
    branchName: branches[0].branch,
    actor: 'preview-instance-seed',
    note: '演示数据：分支创建',
    at: minutesAgoIso(180),
  });
  state.appendActivityLog(project.id, {
    type: 'deploy',
    branchId: branches[0].id,
    branchName: branches[0].branch,
    actor: 'preview-instance-seed',
    note: '演示数据：部署完成',
    at: minutesAgoIso(170),
  });
  state.appendActivityLog(project.id, {
    type: 'deploy-failed',
    branchId: branches[1].id,
    branchName: branches[1].branch,
    actor: 'preview-instance-seed',
    note: '演示数据：部署失败示例',
    at: minutesAgoIso(85),
  });

  state.save();
  return true;
}
