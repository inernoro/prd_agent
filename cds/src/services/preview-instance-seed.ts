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
import { readFileSync } from 'node:fs';
import type { StateService } from './state.js';
import type { BranchEntry, BuildProfile, Project } from '../types.js';
import type { PreviewMirrorFile } from './preview-mirror.js';

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
export function seedPreviewInstanceDemoData(state: StateService, mirror?: PreviewMirrorFile | null): boolean {
  const core = seedCoreDemoData(state);
  const extras = seedDemoExtras(state);
  // 父实例镜像在手时静态形状快照退役：镜像是真实数据的脱敏副本，快照只是它的替身
  const snap = mirror ? false : seedPreviewInstanceSnapshot(state);
  const mirrored = mirror ? seedPreviewInstanceMirror(state, mirror) : false;
  if (core || extras || snap || mirrored) state.save();
  return core || extras || snap || mirrored;
}

/* ============================ 父实例镜像 ============================
   2026-09-16。SSOT 与三条底线见 services/preview-mirror.ts 头注释。

   幂等规则：
   - 同一份镜像（capturedAt 相同）已播过 → 一条不动；
   - 新镜像 → 先把旧镜像播下的条目整体删掉（项目级联分支 / 构建配置 / 日志），再按新镜像加，
     镜像里消失的条目自然不再出现；
   - 库里出现既不是演示、不是快照、也不带 mirror 标记的项目 → 说明挂着真实数据，一条不播。 */

export const PREVIEW_MIRROR_CREATED_BY = 'preview-mirror';

/**
 * 库里有真实数据（既非演示、非快照、也不带 mirror 标记的项目）时镜像整份不播。
 * 摘要与指标回放的登记也要看这一个判据（Codex P2）：不播却登记，/api/instance-mode 会说
 * 「已镜像 N 个项目」，同名容器还会回放一份从没落库的快照的指标。
 */
export function previewMirrorBlockedByRealData(state: StateService): boolean {
  return state.getProjects().some((p) => p.id !== PREVIEW_DEMO_PROJECT_ID && !isSnapshotProjectId(p.id) && !p.mirror);
}

export function seedPreviewInstanceMirror(state: StateService, mirror: PreviewMirrorFile): boolean {
  if (previewMirrorBlockedByRealData(state)) return false;
  let changed = false;

  // 1. 静态快照退役：只退快照播下的那批（项目按 snap- 前缀，报告按标题在快照里），
  //    演示项目自己的三份报告不动——它们和快照共用 createdBy，按 createdBy 删会把演示报告
  //    每次启动删一遍、补播再加一遍（实机验到：重启后报告清零、日志每次都说「已播种」）。
  const snapshotTitles = new Set((snapshot.reports as Array<{ title: string }>).map((r) => r.title));
  for (const p of state.getProjects()) {
    if (isSnapshotProjectId(p.id)) { state.removeProject(p.id); changed = true; }
  }
  for (const r of state.listAcceptanceReports(null)) {
    if (r.createdBy === 'preview-instance-seed' && snapshotTitles.has(r.title)) { state.deleteAcceptanceReport(r.id); changed = true; }
  }

  // 2. 同一份镜像已播过：不动
  const stampedProjects = state.getProjects().filter((p) => p.mirror);
  const stampedBranches = state.getAllBranches().filter((b) => b.mirror);
  const sameCapture = stampedProjects.length > 0
    && stampedProjects.every((p) => p.mirror?.capturedAt === mirror.capturedAt)
    && stampedBranches.every((b) => b.mirror?.capturedAt === mirror.capturedAt)
    && stampedProjects.length === mirror.projects.length
    && stampedBranches.length === mirror.branches.length;
  if (sameCapture) return changed;

  // 3. 旧镜像整体退场（项目级联分支 / 构建配置 / 日志；部署 run 要单独删——
  //    removeBranch / removeProject 不动 run 账本，留着会让同 id 的新 run 被「已存在」跳过、
  //    旧记录一直挂在重建出来的项目下，Codex P2）
  for (const b of stampedBranches) state.removeDeploymentRunsForBranch(b.id);
  for (const p of stampedProjects) state.removeProject(p.id);
  for (const b of state.getAllBranches()) if (b.mirror) { state.removeDeploymentRunsForBranch(b.id); state.removeBranch(b.id); }
  for (const r of state.listAcceptanceReports(null)) {
    if (r.createdBy === PREVIEW_MIRROR_CREATED_BY) state.deleteAcceptanceReport(r.id);
  }

  // 4. 按新镜像加。单条失败只记日志不中断：一条怪配置不该让整份镜像消失
  const warn = (what: string, err: unknown): void => console.warn(`  [preview-mirror] ${what}: ${(err as Error).message}`);
  const existingSlugs = new Set(state.getProjects().map((p) => p.slug));
  for (const p of mirror.projects) {
    try {
      const slug = existingSlugs.has(p.slug) ? `${p.slug}-mirror` : p.slug;
      state.addProject({ ...p, slug, legacyFlag: undefined } as Project);
      existingSlugs.add(slug);
    } catch (err) { warn(`项目 ${p.id}`, err); }
  }
  const projectIds = new Set(state.getProjects().filter((p) => p.mirror).map((p) => p.id));
  for (const profile of mirror.buildProfiles) {
    if (!projectIds.has(profile.projectId)) continue;
    try { state.addBuildProfile({ ...profile } as BuildProfile); } catch (err) { warn(`构建配置 ${profile.id}`, err); }
  }
  const branchIds = new Set<string>();
  for (const b of mirror.branches) {
    if (!projectIds.has(b.projectId)) continue;
    try {
      state.addBranch({ ...b } as BranchEntry);
      branchIds.add(b.id);
      for (const log of mirror.logs?.[b.id] ?? []) state.appendLog(b.id, log);
    } catch (err) { warn(`分支 ${b.id}`, err); }
  }
  for (const run of mirror.deploymentRuns ?? []) {
    if (!branchIds.has(run.branchId) || state.getDeploymentRun(run.id)) continue;
    try { state.addDeploymentRun(run); } catch (err) { warn(`部署 run ${run.id}`, err); }
  }
  const origin = `镜像自${mirror.source?.label || '父实例'}（采集于 ${mirror.capturedAt}）：只读，本实例上没有对应容器。`;
  for (const r of mirror.reports ?? []) {
    try {
      state.createAcceptanceReport({
        title: r.title,
        format: r.format,
        content: r.format === 'md' ? `# ${r.title}\n\n${origin}\n\n本页只保留标题、结论与归档时刻；原始正文不在镜像内。` : `<h1>${r.title}</h1><p>${origin}</p><p>本页只保留标题、结论与归档时刻；原始正文不在镜像内。</p>`,
        projectId: r.projectId ?? null,
        branchId: r.branchId && branchIds.has(r.branchId) ? r.branchId : null,
        branch: r.branch ?? null,
        commitSha: r.commitSha ?? null,
        prNumber: r.prNumber ?? null,
        verdict: r.verdict ?? null,
        tier: r.tier ?? null,
        defectCounts: r.defectCounts ?? null,
        createdBy: PREVIEW_MIRROR_CREATED_BY,
        createdAt: r.createdAt,
      });
    } catch (err) { warn(`报告「${r.title}」`, err); }
  }
  return true;
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
 *
 * 三档都按身份逐条补，不按「这一类有没有」：分支比 id、任务比 id、报告比标题
 * （报告的 id 是创建时生成的，没有稳定标识可比）。整类守卫会让老实例永远拿不到
 * 后来新增的演示条目——那正是这个函数存在的理由，用整类守卫等于自己废掉自己。
 * 手动删掉其中一条也能补回来。
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
  const existingJobIds = new Set(state.listScheduledJobs(project.id).map((job) => job.id));
  const jobBase = {
    projectId: project.id,
    timeoutSeconds: 60,
    retryCount: 0,
    concurrencyPolicy: 'skip' as const,
    createdAt: now,
    updatedAt: now,
    createdBy: 'preview-instance-seed',
  };
  const demoJobs = [
    {
      ...jobBase,
      id: `${project.id}-job-daily`,
      name: '演示数据：每天巡检',
      description: '预览实例演示任务。已停用，不会被调度器执行；手动点「立即执行」仍会真的发起请求（打不到 example.invalid，必然失败）。',
      enabled: false,
      schedule: { type: 'daily' as const, timeOfDay: '09:30' },
      actions: [{ id: 'a1', name: '健康检查', type: 'http' as const, method: 'GET' as const, url: 'https://example.invalid/healthz' }],
      lastRunAt: minutesAgoIso(600),
      lastRunStatus: 'success' as const,
    },
    {
      ...jobBase,
      id: `${project.id}-job-interval`,
      name: '演示数据：每 30 分钟同步',
      description: '预览实例演示任务，展示「间隔」类型与失败态。已停用；手动执行会真的跑一次这条命令。',
      enabled: false,
      schedule: { type: 'interval' as const, intervalMinutes: 30 },
      actions: [{ id: 'a1', name: '同步脚本', type: 'command' as const, command: 'echo demo-sync' }],
      lastRunAt: minutesAgoIso(25),
      lastRunStatus: 'failed' as const,
    },
    {
      ...jobBase,
      id: `${project.id}-job-manual`,
      name: '演示数据：手动触发的清理',
      description: '预览实例演示任务，只能手动跑；跑起来会真的执行这条命令。',
      enabled: false,
      schedule: { type: 'manual' as const },
      actions: [{ id: 'a1', name: '清理', type: 'command' as const, command: 'echo demo-cleanup' }],
    },
  ];
  for (const job of demoJobs) {
    if (existingJobIds.has(job.id)) continue;
    state.upsertScheduledJob(job);
    seeded = true;
  }

  // 验收报告页同理：三种 verdict 各来一份，报告正文自带「演示数据」抬头。
  const existingReportTitles = new Set(state.listAcceptanceReports(project.id).map((r) => r.title));
  const reportBody = (verdict: string): string =>
    `<h1>演示数据：${verdict} 示例报告</h1><p>预览实例自动生成，用于查看验收报告列表与详情的界面形状，不对应任何真实验收。</p>`;
  for (const [verdict, title, tier] of [
    ['pass', '演示数据：分支预览冒烟（通过）', 'smoke'],
    ['conditional', '演示数据：发布前走查（原则性通过）', 'visual'],
    ['fail', '演示数据：回归验收（未通过）', 'regression'],
  ] as const) {
    // 报告的 id 是创建时生成的，没有稳定标识可比——用标题当身份。
    // 三个标题都写死在这里，改标题等于换一份新的演示报告，语义上说得通。
    if (existingReportTitles.has(title)) continue;
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
    seeded = true;
  }

  return seeded;
}

/* ============================ 形状快照 ============================
   2026-09-14 补播。

   起因：验收报告首页加了走向折线之后，预览实例上只有 5 条改动 / 3 份报告，
   曲线是三条贴零的直线——这一屏的形状（稀疏、爆发、三档交叉）在演示数据上
   一点都看不出来，等于没法验收。所以把主实例 2026-09-09 的形状原样搬过来。

   两件事必须说清：

   1. **这是快照，不是这台实例上的真实部署**。项目描述、分支备注、报告正文
      三处都写明了，且项目 id 一律带 snap- 前缀，与真实项目不可能撞。
      （no-rootless-tree：不属于本实例的数据必须标出来源与时点。）
   2. **时间存的是相对值**。快照里每条记的是「距播种时刻多少天」，播种时才
      换算成绝对时刻。存绝对日期的话，几个月后 90 天窗口会把整批数据甩到窗外，
      页面又变回空的——演示数据会自己腐烂，而且没人会发现。 */

/** 快照项目的 id 前缀。补播只认它，真实项目一律不碰。 */
const SNAPSHOT_PREFIX = 'snap-';

interface SnapBranch {
  id: string;
  projectId: string | null;
  branch: string;
  createdAgo: number | null;
  deployed: boolean;
  deployAgo: number | null;
}
interface SnapReport {
  title: string;
  projectId: string | null;
  branch: string | null;
  commitSha: string | null;
  prNumber: number | null;
  verdict: string | null;
  tier: string | null;
  defectCounts: Record<string, number> | null;
  createdAgo: number | null;
}

interface PreviewDemoSnapshot {
  capturedAt: string;
  projects: Array<{ id: string; name: string }>;
  branches: SnapBranch[];
  reports: SnapReport[];
}

/*
 * 不用 JSON ESM import：生产环境的 TypeScript 编译曾把 `with { type: 'json' }`
 * 从输出里剥掉，Node 22 启动时因此直接报 ERR_IMPORT_ATTRIBUTE_MISSING。
 * 这个相对路径从 src/services 与 dist/services 出发都会落到同一个源 JSON，
 * 所以运行不依赖 tsc 是否复制非 TypeScript 资产。
 */
const snapshot = JSON.parse(
  readFileSync(new URL('../../src/services/preview-demo-snapshot.json', import.meta.url), 'utf8'),
) as PreviewDemoSnapshot;

const daysAgoIso = (base: number, days: number | null): string | null =>
  days == null ? null : new Date(base - days * 86_400_000).toISOString();

/**
 * 补播形状快照。已经播过的逐条跳过，所以升级 CDS 之后跑着的实例也补得上。
 *
 * 分支按 id 比对，报告按标题比对（报告 id 是创建时生成的，没有稳定标识）。
 */
export function seedPreviewInstanceSnapshot(state: StateService): boolean {
  const snapProjects = snapshot.projects as Array<{ id: string; name: string }>;
  const snapBranches = snapshot.branches as SnapBranch[];
  const snapReports = snapshot.reports as SnapReport[];
  if (!snapProjects.length) return false;

  // 和首播同一条底线：库里出现任何一个既不是演示项目、也不是快照项目的项目，
  // 就说明这台实例挂着真实数据（例如指到了外部 mongo），一条都不许播。
  // 首播靠「零项目」守这条，补播不能照抄那个判据（它永远为假），得自己判。
  const foreign = state
    .getProjects()
    .some((p) => p.id !== PREVIEW_DEMO_PROJECT_ID && !isSnapshotProjectId(p.id));
  if (foreign) return false;

  const base = Date.now();
  const nowIso = new Date(base).toISOString();
  const captured = String(snapshot.capturedAt).slice(0, 10);
  // 标记词沿用「演示数据」四个字，不另起一套：已有守卫扫的就是它，
  // 换个说法等于让那条守卫对这批新数据视而不见（形状 1：判据比范围窄）。
  const origin = `演示数据（形状快照）：取自主实例 ${captured} 的真实形状，`
    + '用于验收界面在真实数据量下的样子，不对应本实例上的任何部署。';

  let seeded = false;

  const existingProjects = new Set(state.getProjects().map((p) => p.id));
  for (const p of snapProjects) {
    if (existingProjects.has(p.id)) continue;
    state.addProject({
      id: p.id,
      slug: p.id,
      name: p.name,
      description: origin,
      kind: 'git',
      createdAt: nowIso,
      updatedAt: nowIso,
    } as Project);
    seeded = true;
  }

  const existingBranches = new Set(state.getAllBranches().map((b) => b.id));
  for (const b of snapBranches) {
    if (!b.projectId || existingBranches.has(b.id)) continue;
    const createdAt = daysAgoIso(base, b.createdAgo) ?? nowIso;
    // 起过预览的记成 idle 而不是 running：这台实例上没有任何容器，
    // 标成 running 会让分支列表显示一排点不开的「运行中」，那才是骗人。
    state.addBranch({
      id: b.id,
      projectId: b.projectId,
      branch: b.branch,
      worktreePath: `/tmp/preview-snapshot/${b.id}`,
      status: 'idle',
      createdAt,
      lastDeployAt: daysAgoIso(base, b.deployAgo) ?? undefined,
      deployCount: b.deployed ? 1 : 0,
      notes: origin,
      services: {},
    } as BranchEntry);
    existingBranches.add(b.id);
    seeded = true;
  }

  // 补一遍已经播过、但当时播错的那些。
  //
  // 补播是「按 id 比对、缺了才加」，它天生修不了已经落库的错数据——而预览实例的
  // state 跨部署保留，所以一次播错就会一直错下去，改了抽取端也没用（实机验到过：
  // 页面上「没起预览 39」在修完抽取端、重新部署之后纹丝不动）。
  // 修复面刻意开得极窄：只认快照项目名下的分支，只补「快照说起过预览、库里却没有
  // 部署时刻」这一种，其余字段一律不碰，用户改过的备注之类也不动。
  for (const b of snapBranches) {
    if (!b.projectId || b.deployAgo == null) continue;
    const stored = state.getBranch(b.id);
    if (!stored || !isSnapshotProjectId(stored.projectId) || stored.lastDeployAt) continue;
    stored.lastDeployAt = daysAgoIso(base, b.deployAgo)!;
    seeded = true;
  }

  // 已经播过的那批：把时间重新按相对天数锚到「现在」。
  //
  // 相对天数本来就是为了防腐烂，但它此前只在**首播**那一刻换算一次。预览实例的
  // state 跨部署保留，于是那批报告的 createdAt 永远停在第一次播种的时刻，
  // 90 天之后整批滑出 buildPipelineSeries 的窗口，演示走向变回空图——正是这套
  // 设计要防的那件事，只是换了个地方发生（Codex review 抓到）。
  //
  // 只动快照自己播的那批（createdBy 认领 + 标题在快照里），且只在漂移超过一天时
  // 才改，避免每次启动都把整库写一遍。
  // 标题在快照里不唯一（同一验收目标多次归档）。插入时按 existingTitles 只落**第一条**，
  // 所以这里也必须取第一条：用 new Map(...) 直接建会保留最后一条，它的 createdAgo 与
  // 实际落库的那条不同，于是每次启动都判成「漂移了」，把整库重写一遍。
  const snapReportByTitle = new Map<string, SnapReport>();
  for (const r of snapReports) if (!snapReportByTitle.has(r.title)) snapReportByTitle.set(r.title, r);
  for (const meta of state.listAcceptanceReports(null)) {
    if (meta.createdBy !== 'preview-instance-seed') continue;
    const snap = snapReportByTitle.get(meta.title);
    if (!snap) continue;
    const want = daysAgoIso(base, snap.createdAgo);
    if (!want) continue;
    const driftMs = Math.abs(Date.parse(meta.createdAt || '') - Date.parse(want));
    if (!Number.isFinite(driftMs) || driftMs < 86_400_000) continue;
    meta.createdAt = want;
    meta.updatedAt = want;
    seeded = true;
  }
  for (const b of snapBranches) {
    if (!b.projectId || b.createdAgo == null) continue;
    const stored = state.getBranch(b.id);
    if (!stored || !isSnapshotProjectId(stored.projectId)) continue;
    const want = daysAgoIso(base, b.createdAgo);
    if (!want) continue;
    const driftMs = Math.abs(Date.parse(stored.createdAt || '') - Date.parse(want));
    if (!Number.isFinite(driftMs) || driftMs < 86_400_000) continue;
    stored.createdAt = want;
    if (b.deployAgo != null) stored.lastDeployAt = daysAgoIso(base, b.deployAgo)!;
    seeded = true;
  }

  /*
   * 演示正文按标题确定性生成——快照才是它的权威副本，容器本地盘只是那份副本的落地。
   * 这跟「账在哪货就在哪」不冲突：那条规则的判据是「把容器删了重建，这条记录还取得出
   * 货吗」，而这里每次启动都能从快照原样重算出来，所以重建之后取得出——**前提是真的
   * 重算一遍**。此前只按标题判重，元数据跨部署留在库里、正文随容器没了，于是判重
   * 直接跳过，那批报告点开永远 404（Codex review 抓到）。
   * 所以这里不能只看「有没有这条记录」，还要看「它的正文还在不在」。
   */
  const bodyOf = (title: string): string =>
    `<h1>${title}</h1><p>${origin}</p><p>本页只保留标题、结论与归档时刻，用于呈现列表与统计的形状；原始正文不在快照内。</p>`;
  const seededByTitle = new Map<string, string>();
  for (const r of state.listAcceptanceReports(null)) {
    // 只认自己播的那批：别人写的报告正文丢了是另一回事，不许在这里替他重写。
    if (r.createdBy !== 'preview-instance-seed') continue;
    if (!seededByTitle.has(r.title)) seededByTitle.set(r.title, r.id);
  }
  for (const r of snapReports) {
    const existingId = seededByTitle.get(r.title);
    if (existingId) {
      if (state.readAcceptanceReportContent(existingId) === undefined) {
        state.updateAcceptanceReport(existingId, { content: bodyOf(r.title) });
        seeded = true;
      }
      continue;
    }
    const createdAt = daysAgoIso(base, r.createdAgo) ?? nowIso;
    const created = state.createAcceptanceReport({
      title: r.title,
      format: 'html',
      content: bodyOf(r.title),
      projectId: r.projectId,
      branchId: null,
      branch: r.branch,
      commitSha: r.commitSha,
      prNumber: r.prNumber,
      verdict: (r.verdict as 'pass' | 'conditional' | 'fail' | null) ?? null,
      tier: r.tier,
      defectCounts: r.defectCounts,
      createdBy: 'preview-instance-seed',
      createdAt,
    });
    seededByTitle.set(r.title, created.id);
    seeded = true;
  }

  return seeded;
}

/** 快照项目判定，给守卫与调用方共用，别在别处再写一遍前缀比较。 */
export function isSnapshotProjectId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(SNAPSHOT_PREFIX);
}
