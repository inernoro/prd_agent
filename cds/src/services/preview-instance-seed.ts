/**
 * 预览实例演示数据 seed（2026-07-15）。
 *
 * 预览实例是全新空库（容器内 JSON store），空 dashboard 什么都验收不了
 * （违反 guided-exploration「空状态必须有引导」）。首启时 seed 一个演示项目 +
 * 五条不同状态的分支 + 活动日志 + 三个定时任务 + 三份验收报告，让分支列表 /
 * 拓扑 / 项目设置 / 任务调度 / 验收报告各页都有真实形状的数据可看。所有条目
 * 都在名称 / 备注里写明「演示数据」，不冒充真实部署
 * （no-rootless-tree：虚构数据必须显式标注）。
 *
 * 首播只在「预览实例模式 + 零项目 + 零分支」时执行；后续新增的演示数据分节补播
 * （见 seedPreviewInstanceDemoData 的注释）。已有真实数据（例如挂了外部 mongo
 * 的实例）一律不碰。
 */
import type { StateService } from './state.js';
import type { BranchEntry, BuildProfile, Project } from '../types.js';

export const PREVIEW_DEMO_PROJECT_ID = 'preview-demo';

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * 幂等 seed。执行了返回 true，条件不满足跳过返回 false。
 *
 * **分节幂等**，不是全有或全无：预览实例的 state 跨部署保留，如果只用
 * 「零项目才播」一个总守卫，以后往演示数据里加的任何东西都永远到不了
 * 已经播过的实例——升级了 CDS，新页面还是空的。所以首播（项目 + 构建配置 +
 * 活动日志）和补播（缺的演示分支 / 定时任务 / 验收报告）各自判各自的，
 * 补播还要按 id 逐条比对，不能只判「这一类有没有」。
 */
export function seedPreviewInstanceDemoData(state: StateService): boolean {
  const core = seedCoreDemoData(state);
  const extras = seedDemoExtras(state);
  if (core || extras) state.save();
  return core || extras;
}

/** 首播：项目 + 构建配置 + 分支 + 活动日志。只在完全空库时执行。 */
function seedCoreDemoData(state: StateService): boolean {
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

  const branches = demoBranches(project.id);
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

  return true;
}

/**
 * 演示分支清单。首播与补播共用这一份。
 *
 * 分成独立函数不是为了整洁，是为了补播能按 id 逐条比对「少了哪几条」——
 * 两处各写一份，加一条分支就只有新实例看得到（这个洞已经真的发生过一次：
 * 清单从 3 条扩到 5 条，跑着的预览实例始终停在 3 条）。
 */
function demoBranches(projectId: string): BranchEntry[] {
  return [
    {
      id: `${projectId}-sample-running-feat`,
      projectId,
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
      id: `${projectId}-sample-error-fix`,
      projectId,
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
      id: `${projectId}-sample-idle-feat`,
      projectId,
      branch: 'feat/sample-idle',
      worktreePath: '/tmp/preview-demo/sample-idle',
      status: 'idle',
      createdAt: minutesAgoIso(30),
      notes: '演示数据：尚未部署的分支。',
      services: {},
    },
    {
      id: `${projectId}-sample-building-chore`,
      projectId,
      branch: 'chore/sample-building',
      worktreePath: '/tmp/preview-demo/sample-building',
      status: 'building',
      createdAt: minutesAgoIso(12),
      lastAccessedAt: minutesAgoIso(1),
      notes: '演示数据：构建中状态，用于查看进度与排队 UI。',
      services: {
        'demo-api': { profileId: 'demo-api', containerName: 'cds-demo-api-building', hostPort: 10105, status: 'building' },
      },
    },
    {
      id: `${projectId}-sample-stopped-docs`,
      projectId,
      branch: 'docs/sample-stopped',
      worktreePath: '/tmp/preview-demo/sample-stopped',
      status: 'idle',
      createdAt: minutesAgoIso(600),
      lastAccessedAt: minutesAgoIso(240),
      notes: '演示数据：被调度器按 LRU 停掉后回到空闲的冷分支。',
      services: {
        'demo-web': { profileId: 'demo-web', containerName: 'cds-demo-web-stopped', hostPort: 10106, status: 'stopped' },
      },
    },
  ];
}

/**
 * 补播：缺的演示分支 + 定时任务 + 验收报告。
 *
 * 只认演示项目——库里是真项目时一律不碰（和首播同一条底线）。
 * 各自判各自的，所以对已经播过首播的老实例也能补上。
 */
function seedDemoExtras(state: StateService): boolean {
  const project = state.getProject(PREVIEW_DEMO_PROJECT_ID);
  if (!project) return false;
  const now = new Date().toISOString();
  let seeded = false;

  // 分支按 id 逐条补：老实例只播过前三条，清单扩到五条之后它永远差两条状态
  // （用户看到的就是「构建中 / 冷分支这两种卡片在预览实例里根本不存在」）。
  // 只补自己名下缺的那几条，已存在的（含用户改过的）一律不动。
  const existing = new Set(state.getAllBranches().map((b) => b.id));
  for (const branch of demoBranches(project.id)) {
    if (existing.has(branch.id)) continue;
    state.addBranch(branch);
    seeded = true;
  }

  const demoBranch = state.getAllBranches().find((b) => b.projectId === project.id);

  // 三种 schedule 各来一条，把「每天 / 间隔 / 手动」三个分段和列表卡片都撑起来。
  //
  // 三条全部 enabled=false。调度器在预览实例上照样启动，enabled=true 的演示任务
  // 会被它真的执行——实机验到过：「每 30 分钟同步」的 lastRunAt 从 seed 写的值
  // 变成了当天的真实执行时间，nextRunAt 也排上了。后果有两层：一是把 seed 精心
  // 摆出来的成功/失败两种示例状态覆盖掉（演示数据自己把自己改了），二是往运行
  // 历史里灌真实噪音。演示数据的本分是「长得像真的给人看」，不是自己跑起来。
  // lastRunAt / lastRunStatus 仍然照写，列表上「上次运行」那一列该有内容。
  if (state.listScheduledJobs(project.id).length === 0) {
    const jobBase = {
      projectId: project.id,
      timeoutSeconds: 60,
      retryCount: 0,
      concurrencyPolicy: 'skip' as const,
      createdAt: now,
      updatedAt: now,
      createdBy: 'preview-instance-seed',
    };
    state.upsertScheduledJob({
      ...jobBase,
      id: `${project.id}-job-daily`,
      name: '演示数据：每天巡检',
      description: '预览实例演示任务，不会真的发出请求。',
      enabled: false,
      schedule: { type: 'daily', timeOfDay: '09:30' },
      actions: [{ id: 'a1', name: '健康检查', type: 'http', method: 'GET', url: 'https://example.invalid/healthz' }],
      lastRunAt: minutesAgoIso(600),
      lastRunStatus: 'success',
    });
    state.upsertScheduledJob({
      ...jobBase,
      id: `${project.id}-job-interval`,
      name: '演示数据：每 30 分钟同步',
      description: '预览实例演示任务，展示「间隔」类型与失败态。',
      enabled: false,
      schedule: { type: 'interval', intervalMinutes: 30 },
      actions: [{ id: 'a1', name: '同步脚本', type: 'command', command: 'echo demo-sync' }],
      lastRunAt: minutesAgoIso(25),
      lastRunStatus: 'failed',
    });
    state.upsertScheduledJob({
      ...jobBase,
      id: `${project.id}-job-manual`,
      name: '演示数据：手动触发的清理',
      description: '预览实例演示任务，只能手动跑。',
      enabled: false,
      schedule: { type: 'manual' },
      actions: [{ id: 'a1', name: '清理', type: 'command', command: 'echo demo-cleanup' }],
    });
    seeded = true;
  }

  // 验收报告页同理：三种 verdict 各来一份，报告正文自带「演示数据」抬头。
  if (state.listAcceptanceReports(project.id).length === 0) {
    const reportBody = (verdict: string): string =>
      `<h1>演示数据：${verdict} 示例报告</h1><p>预览实例自动生成，用于查看验收报告列表与详情的界面形状，不对应任何真实验收。</p>`;
    for (const [verdict, title, tier] of [
      ['pass', '演示数据：分支预览冒烟（通过）', 'smoke'],
      ['conditional', '演示数据：发布前走查（有条件通过）', 'visual'],
      ['fail', '演示数据：回归验收（未通过）', 'regression'],
    ] as const) {
      state.createAcceptanceReport({
        title,
        format: 'html',
        content: reportBody(verdict),
        projectId: project.id,
        branchId: demoBranch?.id ?? null,
        branch: demoBranch?.branch ?? null,
        verdict,
        tier,
        createdBy: 'preview-instance-seed',
      });
    }
    seeded = true;
  }

  return seeded;
}
