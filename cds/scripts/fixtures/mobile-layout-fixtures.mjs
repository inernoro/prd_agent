/*
 * 窄屏布局冒烟的离线数据。
 *
 * 为什么是手写而不是抓真实响应快照：快照里带着真实的项目名、仓库地址、内部
 * 主机名和容量数字，存进仓库等于把一份生产实例的截面公开。这里的每个字段都是
 * 合成的，只为把页面渲染成「有内容的样子」——布局判据要量的是元素怎么排，
 * 不是数据对不对。
 *
 * 漂移风险与它的兜底：后端换了响应形状，这份数据就喂不动页面，页面会退化成
 * 空状态——此时冒烟的 textLength 判据会红，而不是静默放行。所以形状漂移是
 * 会被抓到的，只是报错信息指向「页面没渲染出内容」而不是「fixture 过期了」。
 *
 * 覆盖面按需增长：未列出的路径一律回 {}，页面自己会走空态或 catch。加页面时
 * 先跑一次看哪里空，再往这里补，别照着类型定义把字段写满。
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
  [/^\/api\/projects\/[^/]+\/env/, () => ({ env: {}, entries: [] })],
  [/^\/api\/projects\/[^/]+\/profiles$/, () => ({ profiles: [] })],
  [/^\/api\/profiles/, () => ({ profiles: [] })],
  [/^\/api\/infra\//, () => ({ services: [] })],
  [/^\/api\/branches\/[^/]+/, () => branches[0]],
];

/** 返回该路径的响应体；没有登记的一律 {}，让页面走自己的空态。 */
export function resolveFixture(pathname) {
  if (Object.prototype.hasOwnProperty.call(DYNAMIC, pathname)) return DYNAMIC[pathname]();
  if (Object.prototype.hasOwnProperty.call(EXACT, pathname)) return EXACT[pathname];
  for (const [re, make] of PREFIX) {
    if (re.test(pathname)) return make({ pathname });
  }
  return {};
}

/** SSE 端点：必须回 text/event-stream，否则浏览器直接 abort 并刷控制台错误。 */
export function isEventStream(pathname) {
  return /\/(cds-events|stream|events)$/.test(pathname) || pathname.includes('/stream');
}

export const FIXTURE_PROJECT_ID = PROJECT_ID;
