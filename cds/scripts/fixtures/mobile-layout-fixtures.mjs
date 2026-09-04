/*
 * 窄屏布局冒烟的离线数据。
 *
 * 为什么是手写而不是抓真实响应快照：快照里带着真实的项目名、仓库地址、内部
 * 主机名和容量数字，存进仓库等于把一份生产实例的截面公开。这里的每个字段都是
 * 合成的，只为把页面渲染成「有内容的样子」——布局判据要量的是元素怎么排，
 * 不是数据对不对。
 *
 * 漂移怎么被抓到——这一段原来写错过，留着当反面例子。
 *
 * 原话是「后端换了响应形状，页面退化成空状态，此时 textLength 判据会红」。
 * 不成立：那条判据的门槛是 60 字，而空状态的页面光常驻导航就有一百五十多字，
 * 轻松满足。也就是说 fixture 一旦过期，冒烟会在「页面根本没渲染出它声称要保护的
 * 内容」的情况下照常绿（Codex P2）。给假安全感的注释比没有注释更糟。
 *
 * 现在靠两道判据抓漂移，都在 mobile-layout-smoke 里：
 *   1. 未登记路径——resolveFixture 认不出的路径被收集起来，跑完一并报错；
 *   2. 页面内容锚点——每个页面断言一段只有喂对数据才会出现的文字。
 * 第二道才是根本的：它证明量到的布局是「有数据的那一版」，不是空态。
 *
 * 覆盖面按需增长：加页面时先跑一次，让未登记路径的报错告诉你缺哪些。
 */

const PROJECT_ID = 'fixture-project';

const project = {
  id: PROJECT_ID,
  slug: 'fixture-project',
  name: '窄屏样例项目',
  aliasName: '窄屏样例项目',
  description: '布局冒烟用的合成项目，不对应任何真实部署。',
  cloneStatus: 'ready',
  gitRepoUrl: 'https://example.invalid/fixture/repo.git',
  gitDefaultBranch: 'main',
  defaultBranch: 'main',
  branchCount: 3,
  runningBranchCount: 2,
  runningServiceCount: 4,
};

const service = (name, status) => ({
  status,
  containerName: `fixture-${name}`,
  port: 8080,
  url: `https://fixture-${name}.example.invalid/`,
});

const branch = (suffix, status, extra = {}) => ({
  id: `fixture-branch-${suffix}`,
  projectId: PROJECT_ID,
  branch: `feature/${suffix}`,
  status,
  services: { api: service('api', status), web: service('web', status) },
  createdAt: '2026-09-01T02:00:00.000Z',
  lastPushAt: '2026-09-02T09:30:00.000Z',
  lastDeployAt: '2026-09-02T09:34:00.000Z',
  commitSha: '0'.repeat(39) + suffix.slice(-1),
  subject: `合成提交 ${suffix}：用于窄屏布局取样`,
  builder: { name: '合成构建者', email: 'fixture@example.invalid' },
  previewSlug: `fixture-${suffix}`,
  deployCount: 5,
  tags: ['样例'],
  ...extra,
});

const branches = [
  branch('alpha', 'running'),
  branch('beta', 'building'),
  branch('gamma', 'idle', { services: {} }),
];

/*
 * 定时任务：三条，各自落进「需要注意 / 即将触发 / 正常运行」一组。
 *
 * 分组判据看的是相对当下的时刻（连续失败、是否已过点、离下次触发多久），所以
 * 时间必须在读取时按 now 现算——写死时间戳的话，fixture 放几天就会整体漂进
 * 「需要注意」，桌面那四档判据里「三组标题首屏全露」会莫名其妙地红。
 */
function scheduledJobs() {
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const base = {
    projectId: PROJECT_ID,
    enabled: true,
    timeoutSeconds: 300,
    retryCount: 1,
    schedule: { type: 'interval', intervalMinutes: 60 },
    target: { type: 'http', method: 'GET', url: 'https://example.invalid/health' },
  };
  return [
    {
      ...base,
      id: 'fixture-job-attention',
      name: '合成任务：连续失败',
      description: '用于让「需要注意」分组有内容。',
      consecutiveFailureCount: 2,
      lastRunAt: iso(-30 * 60 * 1000),
      lastRunStatus: 'failed',
      nextRunAt: iso(30 * 60 * 1000),
      nextRuns: [iso(30 * 60 * 1000), iso(90 * 60 * 1000)],
    },
    {
      ...base,
      id: 'fixture-job-soon',
      name: '合成任务：即将触发',
      lastRunAt: iso(-60 * 60 * 1000),
      lastRunStatus: 'success',
      nextRunAt: iso(20 * 60 * 1000),
      nextRuns: [iso(20 * 60 * 1000), iso(80 * 60 * 1000)],
    },
    {
      ...base,
      id: 'fixture-job-normal',
      name: '合成任务：正常运行',
      schedule: { type: 'daily', timeOfDay: '03:00', timezone: 'Asia/Shanghai' },
      lastRunAt: iso(-6 * 60 * 60 * 1000),
      lastRunStatus: 'success',
      nextRunAt: iso(6 * 60 * 60 * 1000),
      nextRuns: [iso(6 * 60 * 60 * 1000)],
    },
  ];
}

function scheduledRuns() {
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const run = (id, jobId, status, offsetMin) => ({
    id, jobId, projectId: PROJECT_ID, trigger: 'schedule', status,
    queuedAt: iso(-offsetMin * 60 * 1000),
    startedAt: iso(-offsetMin * 60 * 1000 + 500),
    finishedAt: iso(-offsetMin * 60 * 1000 + 4200),
    durationMs: 3700,
    httpStatus: status === 'success' ? 200 : 502,
  });
  return [
    run('fixture-run-1', 'fixture-job-attention', 'failed', 30),
    run('fixture-run-2', 'fixture-job-attention', 'failed', 90),
    run('fixture-run-3', 'fixture-job-soon', 'success', 60),
    run('fixture-run-4', 'fixture-job-normal', 'success', 360),
  ];
}

/*
 * 路径 → 响应体。键是 pathname（不含 query）；值是对象或一个拿到 URL 的函数。
 * 顺序无关，精确匹配优先于前缀匹配。
 */
const EXACT = {
  '/api/auth/status': { authenticated: true, user: { name: '布局冒烟' } },
  '/api/instance-mode': { mode: 'master' },
  '/api/notices': { notices: [] },
  '/api/projects': { projects: [project] },
  '/api/config': { previewDomain: 'example.invalid', version: 'fixture' },
  '/api/legacy-cleanup/status': { pending: false },
  '/api/access-requests': { requests: [] },
  '/api/pending-imports': { imports: [] },
  '/api/infra/catalog': { services: [] },
  '/api/cds-system/operator/requests': { requests: [] },
  '/api/cds-system/perf-health': { status: 'ok', samples: [] },
  '/api/releases/targets': { targets: [] },
  '/api/github/app': { configured: false },
  '/api/github/installations': { installations: [] },
  '/api/cache/status': { entries: [] },
  '/api/global-agent-keys': { keys: [] },
  '/api/perf/overview': { routes: [], totals: {} },
  // 下面这批是 2026-09-04 靠「未登记路径」判据扫出来的：此前它们静默回 {}，
  // 页面走空态，而冒烟照常绿。
  '/api/infra': { services: [] },
  '/api/build-profiles': { profiles: [] },
  '/api/remote-branches': { branches: [], fetched: false, cachedAt: null },
  '/api/env': {
    entries: [
      { key: 'FIXTURE_SAMPLE_KEY', value: '合成值', isSecret: false, scope: 'project' },
    ],
    env: { FIXTURE_SAMPLE_KEY: '合成值' },
    inheritGlobal: false,
  },
  '/api/activity-stream': { events: [] },
  '/api/self-update-history': { history: [] },
  /*
   * 这里的分支名故意起得不像真名：它是 cds-settings 那一页的内容锚点。
   * 锚点必须是「只有喂对这一页自己的数据才会出现」的字符串——用 'main'
   * 或页面上硬编码的标题都不行，那种锚点在响应挂掉时照样能过（Codex P2）。
   */
  '/api/self-branches': {
    branches: ['fixture-self-branch'],
    current: 'fixture-self-branch',
    recommended: 'fixture-self-branch',
  },
  '/api/mirror': { configured: false },
  '/api/tab-title': { title: 'CDS' },
  '/api/auth/public-status': { authenticated: true, mode: 'password' },
  /*
   * 发布中心那一页的内容锚点来源。
   *
   * 顶层键是 rows 不是 targets——上一轮我照着「targets」猜，页面直接渲染异常，
   * 于是误判成「造一条数据成本太高」，把这一页记成了已知边界。真正的成本很低：
   * CenterRow 必填只有 target / currentVersion / currentCommit / healthStatus /
   * canRollback 五个，ReleaseTarget 必填五个，其余全可选。猜键名的代价是一次
   * 错误的成本估计，不是形状本身复杂（Codex 连着两轮点了同一处）。
   */
  '/api/releases/center': {
    rows: [{
      target: {
        id: 'fixture-release-target',
        projectId: PROJECT_ID,
        name: 'fixture-release-target',
        type: 'site',
        isEnabled: true,
        environment: 'staging',
      },
      currentVersion: 'fixture-version-001',
      currentCommit: '0'.repeat(40),
      healthStatus: 'unknown',
      canRollback: false,
    }],
    runs: [],
    environments: [],
  },
  '/api/deployment-runs': { runs: [] },
  '/api/deployment-versions': { versions: [] },
};

const DYNAMIC = {
  '/api/scheduled-jobs': () => ({ jobs: scheduledJobs() }),
  '/api/scheduled-jobs/runs': () => ({ runs: scheduledRuns() }),
};

/*
 * 分支详情抽屉里的关系卡直接解 data.lint.summary，缺了就整棵树崩，
 * 而抽屉恰恰是这套冒烟唯一测到「浮层压在页面上」的那一屏。图给空的，
 * 布局判据要的是卡片本身排得对不对，不是图里有几个节点。
 */
const serviceGraph = (branchId) => ({
  branchId,
  projectId: PROJECT_ID,
  branch: 'feature/alpha',
  status: 'running',
  graph: { nodes: [], edges: [], layers: [], sites: [], internal: [] },
  lint: { findings: [], summary: { errors: 0, warnings: 0, infos: 0 } },
  references: [],
});

const PREFIX = [
  [/^\/api\/branches\/([^/]+)\/service-graph$/, (url) => serviceGraph(
    decodeURIComponent(url.pathname.split('/')[3] || 'fixture-branch-alpha'))],
  [/^\/api\/branches\/[^/]+\/references$/, () => ({ references: [] })],
  [/^\/api\/branches\/[^/]+\/replica-loadtests$/, () => ({ runs: [] })],
  [/^\/api\/branches\/[^/]+\/web-entry-config$/, () => ({ config: null })],
  [/^\/api\/branches$/, () => ({
    branches,
    capacity: { maxContainers: 40, runningContainers: 9, totalMemGB: 96 },
  })],
  [/^\/api\/projects\/[^/]+$/, () => project],
  [/^\/api\/projects\/[^/]+\/preview-mode$/, () => ({ mode: 'auto' })],
  [/^\/api\/projects\/[^/]+\/agent-keys$/, () => ({ keys: [] })],
  [/^\/api\/projects\/[^/]+\/env$/, () => ({ env: {}, entries: [] })],
  [/^\/api\/projects\/[^/]+\/profiles$/, () => ({ profiles: [] })],
  [/^\/api\/profiles$/, () => ({ profiles: [] })],
  [/^\/api\/infra\/[^/]+$/, () => ({ services: [] })],
  /*
   * 分支子路由逐条登记，末尾那条**必须锚定**。
   *
   * 原来这里是 /^\/api\/branches\/[^/]+/（没有 $），于是 /logs、/metrics、
   * /resources、/subdomain-aliases 这些子路由全被它吞下去、拿到一个分支对象，
   * resolveFixture 永远不返回 null，上面那道「未登记路径」判据就被绕过了
   * （Codex P2）。一条为了省事写宽的正则，正好废掉了刚加的守卫。
   *
   * 这 6 条是把 catch-all 摘掉之后，让判据自己报出来的——它该有的用法。
   */
  [/^\/api\/branches\/[^/]+\/logs$/, () => ({ logs: [], lines: [] })],
  [/^\/api\/branches\/[^/]+\/metrics$/, () => ({ cpu: null, memory: null, samples: [] })],
  [/^\/api\/branches\/[^/]+\/metrics\/series$/, () => ({ series: [] })],
  /*
   * 键名是 `profiles` 不是 `overrides`——抽屉读的是 `profilesRes.profiles`，
   * 回错键名会被 `|| []` 吞成空列表：请求成功、判据全绿、profile 卡却永远
   * 是空的，冒烟声称覆盖了那块布局其实没有（Codex P2）。
   * 形状对齐 GET /branches/:id/profile-overrides 的真实返回。
   */
  [/^\/api\/branches\/[^/]+\/profile-overrides$/, () => ({
    branchId: 'fixture-branch-alpha',
    profiles: [
      {
        profileId: 'api',
        profileName: '窄屏样例 API',
        baseline: { id: 'api', name: '窄屏样例 API', activeDeployMode: 'docker', dbScope: 'shared' },
        override: null,
        effective: { dockerImage: 'fixture/api:latest', containerPort: 8080 },
        cdsEnvKeys: [],
        hasOverride: false,
      },
      {
        profileId: 'web',
        profileName: '窄屏样例 Web',
        baseline: { id: 'web', name: '窄屏样例 Web', activeDeployMode: 'docker', dbScope: 'shared' },
        override: { notes: '合成覆盖，用于让 profile 卡渲染出「已覆盖」那一态' },
        effective: { dockerImage: 'fixture/web:latest', containerPort: 5173 },
        cdsEnvKeys: [],
        hasOverride: true,
      },
    ],
  })],
  [/^\/api\/branches\/[^/]+\/resources$/, () => ({ resources: [] })],
  [/^\/api\/branches\/[^/]+\/subdomain-aliases$/, () => ({ aliases: [] })],
  [/^\/api\/branches\/[^/]+$/, () => branches[0]],
];

/*
 * 明知会空、也应该空的端点。登记在这里表示「回 {} 是对的」，
 * 与「忘了登记」区分开——后者要报错，前者不该。
 */
const INTENTIONALLY_EMPTY = [
  /^\/api\/notices$/,
  /^\/api\/access-requests$/,
  /^\/api\/pending-imports$/,
  /^\/api\/legacy-cleanup\//,
  /^\/api\/cds-system\/operator\/requests$/,
];

/**
 * 返回该路径的响应体；认不出就返回 null。
 *
 * 认不出时**不要**默默回 {}：页面会退化成空态，而空态照样满足冒烟原来那条
 * 「文字够多」的判据，于是漏登记的端点静默放行。调用方拿到 null 要记下这条
 * 路径，跑完一并报错。
 */
export function resolveFixture(pathname) {
  if (Object.prototype.hasOwnProperty.call(DYNAMIC, pathname)) return DYNAMIC[pathname]();
  if (Object.prototype.hasOwnProperty.call(EXACT, pathname)) return EXACT[pathname];
  for (const [re, make] of PREFIX) {
    if (re.test(pathname)) return make({ pathname });
  }
  if (INTENTIONALLY_EMPTY.some((re) => re.test(pathname))) return {};
  return null;
}

/** SSE 端点：必须回 text/event-stream，否则浏览器直接 abort 并刷控制台错误。 */
export function isEventStream(pathname) {
  return /\/(cds-events|stream|events)$/.test(pathname) || pathname.includes('/stream');
}

export const FIXTURE_PROJECT_ID = PROJECT_ID;
