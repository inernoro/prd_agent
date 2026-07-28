/**
 * 复制集模式 REST API（design.cds.replica-set，2026-07-23）。
 *
 * 挂载于 /api，全部路径带 branchId（项目归属经分支反查后走 assertProjectAccess）。
 * 控制面语义见 services/replica-set.ts；流量分配在 forwarder 数据面。
 */
import { Router, type Request } from 'express';
import { connect as tcpConnect } from 'node:net';
import type { DeploymentVersion, DeploymentVersionProfile } from '../types.js';
import type { StateService } from '../services/state.js';
import { ReplicaSetError, REPLICA_MEMBER_LIMIT, REPLICA_PLAN_MAX_STEPS, type ReplicaSetService } from '../services/replica-set.js';
import { LoadTestError, LOADTEST_LIMITS, ReplicaLoadTestService, type LoadTestHolder } from '../services/replica-loadtest.js';
import { resolveReplicaDbTarget } from '../services/replica-db-clone.js';
import { diskGuard } from '../services/disk-guard.js';
import { buildServiceGraph } from '../services/service-graph.js';
import { dnsSafeProfile } from '../services/forwarder-route-publisher.js';
import { resolveEffectiveProfile } from '../services/container.js';
import { runIsolationAudit } from '../services/replica-isolation-audit.js';
import { buildPreviewUrlForProject } from '../services/comment-template.js';
import type { VersionDispatchResult } from './deployment-versions.js';
import type { DeploymentVersionService } from '../services/deployment-version.js';

/**
 * promote 影响面计算（Codex 第十五轮 P1 + 第十六轮 P1，纯函数供单测）：
 * DeploymentVersion 是整分支快照，找出「提升 profileId 到 version」时会被连带
 * 改动的其他 profile。对照面必须覆盖 materializeProfiles 会恢复的**全部**运行时
 * 契约字段（镜像/kind/命令/端口/workDir/pathPrefixes/subdomain/dependsOn/
 * readinessProbe/startupSignal/deployedMode）——只比镜像会漏掉「仅探针或路由
 * 前缀不同」的历史契约被静默重放。任一侧缺失该 profile 也算改动。
 */
function materializedFingerprint(p: DeploymentVersionProfile): string {
  return JSON.stringify({
    image: p.artifactImage, kind: p.artifactKind, cmd: p.runtimeCommand ?? null,
    port: p.containerPort, workDir: p.containerWorkDir ?? null,
    prefixes: p.pathPrefixes ?? null, subdomain: p.subdomain ?? null,
    dependsOn: p.dependsOn ?? null, readiness: p.readinessProbe ?? null,
    startupSignal: p.startupSignal ?? null, mode: p.deployedMode ?? null,
  });
}

export function promoteAffectedProfiles(
  version: DeploymentVersion,
  currentVersion: DeploymentVersion | undefined,
  profileId: string,
): string[] {
  const otherIds = new Set([
    ...version.profiles.map((p) => p.profileId),
    ...(currentVersion?.profiles.map((p) => p.profileId) ?? []),
  ].filter((pid) => pid !== profileId));
  const affected: string[] = [];
  for (const pid of otherIds) {
    const target = version.profiles.find((p) => p.profileId === pid);
    const current = currentVersion?.profiles.find((p) => p.profileId === pid);
    if (!target || !current || materializedFingerprint(target) !== materializedFingerprint(current)) {
      affected.push(pid);
    }
  }
  return affected.sort();
}

/**
 * 该 POST 路径是否属于「会让磁盘增长」的复制集动作（Codex 第三十一轮 P1）。
 *
 * 纯函数导出以便把边界钉成回归测试：**拦错**和**漏拦**代价都很高——漏拦会让
 * 磁盘满的恢复期被一次几个 GB 的克隆彻底压垮；拦错则会在最需要自救的时候
 * 堵死退路（回切主库、删成员、解散都在释放空间）。
 */
export function isDiskGrowingReplicaAction(path: string): boolean {
  return /^\/branches\/[^/]+\/(db-guard|replica-plans|replica-sets\/[^/]+\/(isolate|members(\/[^/]+\/promote)?))\/?$/.test(path);
}

/** 计划步骤里会让磁盘增长的那几种（其余是删除/回切/调权重，都在释放或不占空间）。 */
const DISK_GROWING_STEP_KINDS = new Set(['add-replica', 'isolate-db']);

/**
 * 该请求是否真的会让磁盘增长（Codex 第三十二轮 P1）。
 *
 * 计划端点不能只看路径：面板的「删成员 / 解散 / 回切主库」这些**清理动作也全部
 * 经 POST /replica-plans 提交**。按路径一刀切等于在磁盘压力最大、最需要清理的
 * 时候，把 UI 上唯一的回收入口也堵死了——正是「拦错比漏拦更伤」的那一面。
 * 所以计划要看步骤种类：含 add-replica / isolate-db 才拦，纯清理计划放行。
 */
export function requestGrowsDisk(path: string, body: unknown): boolean {
  if (!isDiskGrowingReplicaAction(path)) return false;
  if (!/^\/branches\/[^/]+\/replica-plans\/?$/.test(path)) return true;
  const steps = (body as { steps?: Array<{ kind?: string }> } | null | undefined)?.steps;
  // 步骤读不出来（畸形 body）时保守当作会增长——真正的清理计划一定带得出 steps
  if (!Array.isArray(steps)) return true;
  return steps.some((step) => DISK_GROWING_STEP_KINDS.has(String(step?.kind || '')));
}

export interface ReplicaSetsRouterDeps {
  stateService: StateService;
  replicaSetService: ReplicaSetService;
  deploymentVersionService: DeploymentVersionService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
  dispatchVersion: (version: DeploymentVersion, trigger: 'manual' | 'rollback') => Promise<VersionDispatchResult>;
  /** 查部署 run 当前状态（promote 终态门用；running=成功终态，failed/cancelled=失败终态） */
  getDeploymentRunStatus: (runId: string) => string | undefined;
  /** CDS 公网根域清单（config.rootDomains）：分流探测 host 全量归属校验用 */
  rootDomains?: string[];
  /** 压测服务（省略时按 stateService + rootDomains + 磁盘刹车就地构造；测试可注入假执行器） */
  loadTestService?: ReplicaLoadTestService;
}

export function createReplicaSetsRouter(deps: ReplicaSetsRouterDeps): Router {
  const router = Router();

  /**
   * 压测占位者按项目脱敏。压测服务是全局单例（同时只允许一个任务），所以
   * activeHolders() 天然含别的项目的 branchId / profileId / runId / 起始时刻。
   * 项目级 Key 只该知道「共享槽位被占了、占了多久」，不该借此枚举别人的运行态
   * （Codex PR #1273 P1）。人类 cookie / 全局 Key（无 cdsProjectKey）照看全量。
   */
  const redactHolders = (
    req: Request,
    holders: LoadTestHolder[],
    branchProjectId: string | undefined,
  ): { active: LoadTestHolder[]; activeOtherProjects?: number } => {
    const scope = (req as unknown as { cdsProjectKey?: { projectId: string } }).cdsProjectKey?.projectId
      ?? null;
    if (!scope) return { active: holders };
    const own = holders.filter((h) => h.projectId === scope || h.projectId === branchProjectId);
    const others = holders.length - own.length;
    return others > 0 ? { active: own, activeOtherProjects: others } : { active: own };
  };

  const guard = (req: Request, branchId: string): { status: number; body: unknown } | null => {
    const branch = deps.stateService.getBranch(branchId);
    if (!branch) return { status: 404, body: { error: `分支不存在: ${branchId}` } };
    return deps.assertProjectAccess(req, branch.projectId);
  };

  /** 逐成员真实可达性探测：TCP 直连宿主端口，700ms 超时。
   * （验收 P1-2：死副本上游 ECONNREFUSED 仍显示绿色「运行中」并持续接流量——
   * 状态字段只反映控制面意图，健康必须实测。） */
  const tcpReachable = (port: number, timeoutMs = 700): Promise<boolean> =>
    new Promise((resolve) => {
      const sock = tcpConnect({ host: '127.0.0.1', port });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
    });

  // 磁盘刹车（Codex 第三十一轮 P1）：复制集是**独立挂载的路由器**，branches.ts 里的
  // 那道守卫罩不到这里——而这边恰恰是最能吃盘的：db-guard / isolate 走 mongodump +
  // restore（一次几个 GB），加成员要拉镜像起容器，promote 会派发一次真实部署。
  // 磁盘满的恢复期里，一个带认证的请求就能把最后的空间吃光，尽管部署那侧已经 507。
  //
  // 只罩**会让磁盘增长**的动作；revert-db / 删成员 / 解散 / 调权重 / 探测 / 审计
  // 一律放行——它们要么释放空间，要么是恢复期必须还能用的自救手段。
  router.use((req, res, next) => {
    if (req.method !== 'POST' || !requestGrowsDisk(req.path, req.body)) {
      next();
      return;
    }
    const blocked = diskGuard.blockReasonForDeploy();
    if (!blocked) { next(); return; }
    res.status(507).json({ error: 'disk_low', message: blocked });
  });

  router.get('/branches/:branchId/replica-sets', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const { replicaSets, candidates, snapshots } = deps.replicaSetService.list(req.params.branchId);
      const branch = deps.stateService.getBranch(req.params.branchId)!;
      const enriched = Object.fromEntries(await Promise.all(
        Object.entries(replicaSets).map(async ([profileId, rs]) => {
          const primaryPort = branch.services?.[profileId]?.hostPort;
          const [primaryReachable, members] = await Promise.all([
            primaryPort && branch.services?.[profileId]?.status === 'running'
              ? tcpReachable(primaryPort)
              : Promise.resolve(undefined),
            Promise.all(rs.members.map(async (m) => ({
              ...m,
              reachable: m.status === 'running' && m.hostPort ? await tcpReachable(m.hostPort) : undefined,
            }))),
          ]);
          return [profileId, { ...rs, members, primaryReachable }] as const;
        }),
      ));
      // 服务调用关系图（容器级画布数据源，两页签定案 2026-07-24）：
      // 边在服务端由 env 引用 + depends_on 推导，只暴露 env 键名，值绝不出网。
      // env 必须用**生效合并结果**（Codex P2）：CDS 自动供给的连接串通常写在
      // 项目级 customEnv（applyInfraPresets）、分支覆写在分支 scope——只看
      // profile.env 会让典型自动供给项目一条服务→infra 边都推不出来，画布拓扑
      // 残缺。合并顺序与运行时部署一致（project custom → 分支 scope → profile.env）；
      // 项目级 env 对所有服务可见 = 每个容器运行时确实都持有这些连接配置，
      // 由此推出的边是真实的。
      const projectEnvForGraph = deps.stateService.getCustomEnv(branch.projectId);
      const branchEnvForGraph = deps.stateService.getCustomEnvScope(branch.id);
      const profiles = deps.stateService.getEffectiveProfilesForBranch(branch)
        .map((p) => ({ ...p, env: { ...projectEnvForGraph, ...branchEnvForGraph, ...(p.env || {}) } }));
      const infraForProject = (deps.stateService.getState().infraServices || [])
        .filter((s) => s.projectId === branch.projectId && (s.scope ?? 'project') === 'project');
      const graph = buildServiceGraph(profiles, infraForProject);
      // 可隔离性由**后端**判定（Codex 第二十六轮 P2 + frontend-architecture「业务判断
      // 不下放前端」）：无状态服务（前端等，env 里没有任何数据库名家族键）走隔离步会在
      // resolveReplicaDbTarget 抛「没有数据库名」——统一战线把它们一并纳入，默认
      // 失败即停策略下后面的服务就再也隔离不了，「一次覆盖全部」的承诺无法兑现。
      // 与隔离执行路径同一个 SSOT（resolveReplicaDbTarget + resolveEffectiveProfile），
      // 前端据此收敛动作目标与「已隔离 N/M」的分母。
      const dbIsolatable: Record<string, { ok: boolean; reason?: string }> = {};
      for (const p of deps.stateService.getEffectiveProfilesForBranch(branch)) {
        const { target, reason } = resolveReplicaDbTarget(
          deps.stateService, branch, resolveEffectiveProfile(p, branch),
        );
        dbIsolatable[p.id] = target ? { ok: true } : { ok: false, reason };
      }
      // 存量分支（模式面世前的副本）按容器级报告：与 startPlan 的默认钉住兜底口径一致
      const totalMembers = Object.values(branch.replicaSets ?? {}).reduce((s, rs) => s + rs.members.length, 0);
      res.json({
        replicaSets: enriched, candidates, snapshots, memberLimit: REPLICA_MEMBER_LIMIT,
        planMaxSteps: REPLICA_PLAN_MAX_STEPS, dbIsolatable, graph,
        replicaMode: branch.replicaMode ?? (totalMembers > 0 ? 'container' : null),
      });
    } catch (err) {
      respondError(res, err);
    }
  });

  /**
   * 分流探测（强校验性）：CDS 服务端向真实入口（本机 forwarder，带预览 Host）
   * 发 N 个「无粘性」的独立请求，统计响应头 X-CDS-Replica 的真实落点分布。
   * 不是前端动画——每一条都是真实穿过 forwarder 加权选择的 HTTP 请求。
   */
  router.post('/branches/:branchId/replica-sets/:profileId/probe', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const host = typeof req.body?.host === 'string' ? req.body.host.trim().toLowerCase() : '';
    if (!host || !/^[a-z0-9.-]+$/.test(host)) { res.status(400).json({ error: '缺少合法的入口 host' }); return; }
    // 探测 host 必须属于本分支（Codex P2）：只做语法校验时，项目 A 的调用方可以
    // 拿自己分支的授权、填别的项目的预览 host——CDS 会替它经 loopback forwarder
    // 发起最多 50 个真实 GET，形成跨项目的内网请求/状态探针。host 首标签必须是
    // 本分支 previewSlug（或其 -子域派生：命名子域/成员直达域），或命中本分支的
    // 子域别名/自定义域。
    {
      const branchForHost = deps.stateService.getBranch(req.params.branchId)!;
      const projectForHost = deps.stateService.getProjects().find((p) => p.id === branchForHost.projectId);
      const previewSlug = buildPreviewUrlForProject('', branchForHost.branch, projectForHost, branchForHost.projectId).previewSlug || '';
      // 全 host 对照（Codex 第十九轮 P2）：只看首标签前缀会放行「首标签碰巧以本
      // 分支 slug- 开头」的**别家域名**（如别的项目的自定义域 team-other.example.com
      // 对 slug=team）——forwarder 会替调用方把探测打到别的项目。改为：host 的
      // 域名后缀必须命中 CDS 根域清单（缺配置时退分支 previewUrl 的实际后缀），
      // 且余下部分是单个标签、等于 slug / slug- 前缀 / 子域别名；自定义域仍走
      // 本分支 customDomains 全串精确匹配。
      const roots = (deps.rootDomains ?? []).map((r) => r.toLowerCase()).filter(Boolean);
      let labelOnRoot = '';
      for (const root of roots) {
        if (host.endsWith(`.${root}`)) {
          const rest = host.slice(0, host.length - root.length - 1);
          if (rest && !rest.includes('.')) { labelOnRoot = rest; break; }
        }
      }
      // 根域未配置（纯本地 dev，无公网路由面）时退回首标签语义，保持可用；
      // 生产/联网环境 rootDomains 恒有值，走全 host 对照
      if (!labelOnRoot && roots.length === 0) labelOnRoot = host.split('.')[0] || '';
      const aliasLabels = new Set((branchForHost.subdomainAliases ?? []).filter(Boolean).map((a) => String(a).toLowerCase()));
      const customDomains = new Set((branchForHost.customDomains ?? []).map((d) => String(d).toLowerCase()));
      // 精确枚举本分支真实发布的标签（Codex 第三十三轮 P2）：此前是
      // `startsWith(previewSlug + '-')` 前缀匹配——**另一个分支**只要 slug 以本分支
      // slug 加连字符开头（或有这样的别名），它的 host 就被当成本分支的，接着这个
      // 端点会替调用方向那个外部 host 打最多 50 次服务端 GET 并回报状态。改为按
      // 发布器同源规则列出：主入口 + 命名子域 + 成员直达，逐一精确比对。
      const allowedLabels = new Set<string>();
      if (previewSlug) {
        allowedLabels.add(previewSlug);
        for (const p of deps.stateService.getEffectiveProfilesForBranch(branchForHost)) {
          const sub = resolveEffectiveProfile(p, branchForHost).subdomain;
          if (sub) allowedLabels.add(`${previewSlug}-${String(sub).toLowerCase()}`);
        }
        for (const [profileId, rs] of Object.entries(branchForHost.replicaSets ?? {})) {
          for (const m of rs.members) {
            allowedLabels.add(`${previewSlug}-${dnsSafeProfile(profileId)}-${m.id}`.toLowerCase());
          }
        }
      }
      const hostAllowed =
        (Boolean(labelOnRoot) && allowedLabels.has(labelOnRoot))
        || (Boolean(labelOnRoot) && aliasLabels.has(labelOnRoot))
        || customDomains.has(host);
      if (!hostAllowed) {
        res.status(403).json({ error: '入口 host 不属于该分支的已发布域名，拒绝探测' });
        return;
      }
    }
    // 探测 path 必须命中「被复制集化的这个服务」的路由（验收 P1-1：写死 '/'
    // 会打在前端容器上，永远显示 100% 主版本）。未显式传 path 时按 profile
    // 的 pathPrefixes / api-convention 自动推导。
    let path = typeof req.body?.path === 'string' && req.body.path.startsWith('/') ? req.body.path : '';
    if (!path) {
      const branchEntry = deps.stateService.getBranch(req.params.branchId)!;
      // 与发布器同口径（Codex 第二十一轮 P2）：分支级 profileOverrides 改过
      // pathPrefixes 时，getEffectiveProfilesForBranch 不含该覆写——发布器发的
      // 是 resolveEffectiveProfile 之后的前缀，这里不解析就会拿旧前缀探测，
      // 打到别的服务出 untagged 误导分布
      const baseProbeProfile = deps.stateService.getEffectiveProfilesForBranch(branchEntry)
        .find((p) => p.id === req.params.profileId);
      const probeProfile = baseProbeProfile ? resolveEffectiveProfile(baseProbeProfile, branchEntry) : undefined;
      path = probeProfile?.pathPrefixes?.[0]
        || (req.params.profileId.includes('api') || req.params.profileId.includes('backend') ? '/api/' : '/');
    }
    // path 强校验（Codex 第十八轮 P1）：控制字符/空白/非 ASCII 会让 http.request
    // 同步抛 ERR_UNESCAPED_CHARACTERS——Promise executor 里同步抛 = promise 拒绝，
    // Express 4 异步 handler 接不住，未处理拒绝可拖垮 CDS 进程。只放行可打印
    // ASCII（不含空格），显式传入与自动推导的 path 一律过闸。
    if (!/^\/[\x21-\x7e]*$/.test(path)) {
      res.status(400).json({ error: '探测 path 含非法字符（仅允许可打印 ASCII、不含空白/控制字符）' });
      return;
    }
    const count = Math.max(1, Math.min(50, Number(req.body?.count) || 20));
    const forwarderPort = Number(process.env.CDS_FORWARDER_PORT) || 9090;
    const hits: Array<{ seq: number; servedBy: string; status: number }> = [];
    const tally: Record<string, number> = {};
    // 必须用原生 http.request：fetch(undici) 会静默忽略自定义 Host 头，
    // 请求匹配不到分支路由 → 全落 unknown-host 兜底被误记成 primary
    // （2026-07-23 用户实测「100% 主版本」抓到的真 bug）。
    const { request: httpRequest } = await import('node:http');
    const probeOnce = (seq: number): Promise<{ servedBy: string; status: number }> =>
      new Promise((resolve) => {
        try {
          const req2 = httpRequest({
            host: '127.0.0.1',
            port: forwarderPort,
            method: 'GET',
            path: `${path}${path.includes('?') ? '&' : '?'}__probe=${seq}`,
            headers: { Host: host, 'X-CDS-Probe': '1' },
            timeout: 8000,
          }, (resp) => {
            resp.resume();
            // 无 X-CDS-Replica 头 = 没有穿过复制集路由（不能伪装成 primary 落点）
            const tag = resp.headers['x-cds-replica'];
            resolve({ servedBy: tag ? String(tag) : 'untagged', status: resp.statusCode || 0 });
          });
          req2.on('timeout', () => { req2.destroy(); resolve({ servedBy: 'error', status: 0 }); });
          req2.on('error', () => resolve({ servedBy: 'error', status: 0 }));
          req2.end();
        } catch {
          // http.request 同步抛（如 ERR_UNESCAPED_CHARACTERS）不许逃出 executor
          // 变成未处理拒绝（Codex 第十八轮 P1）——按探测失败记一条
          resolve({ servedBy: 'error', status: 0 });
        }
      });
    for (let i = 0; i < count; i += 1) {
      const r = await probeOnce(i);
      hits.push({ seq: i + 1, servedBy: r.servedBy, status: r.status });
      tally[r.servedBy] = (tally[r.servedBy] || 0) + 1;
    }
    res.json({ count, host, path, tally, hits });
  });

  // ── 压测（负载测试）：复制集 = 现成的 A/B 负载对比台 ──
  //
  // 目标由服务端从分支状态解析（主实例 + 运行中副本，各自用 __rs 钉选），执行器
  // 只连本机 forwarder；调用方无法指定任意 URL。磁盘冻结档、并发上限、时长上限
  // 全部在服务层设闸，路由层只负责鉴权与错误映射。
  const loadTests = deps.loadTestService ?? new ReplicaLoadTestService({
    state: deps.stateService,
    rootDomains: deps.rootDomains,
    diskBlockReason: () => diskGuard.blockReasonForDeploy(),
  });

  /**
   * 周期收敛的驱动点（concurrency-gate-discipline 第 4 条）：每个压测端点先收割
   * 一次心跳过期的僵尸，保证「闸位泄漏」最多存活到下一次有人看这个面板为止，
   * 而不是要等 CDS 重启。收割是纯内存 O(n)，n ≤ 每分支 20 条，开销可忽略。
   */
  const withReap = <T>(fn: () => T): T => {
    loadTests.reapStale();
    return fn();
  };

  router.get('/branches/:branchId/replica-loadtests', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      withReap(() => {
        const branch = deps.stateService.getBranch(req.params.branchId);
        res.json({
          runs: loadTests.list(req.params.branchId),
          limits: LOADTEST_LIMITS,
          ...redactHolders(req, loadTests.activeHolders(), branch?.projectId),
          health: loadTests.health(),
        });
      });
    } catch (err) { respondError(res, err); }
  });

  router.post('/branches/:branchId/replica-loadtests', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : '';
    if (!profileId) { res.status(400).json({ error: '缺少 profileId（要压哪个服务）' }); return; }
    try {
      const run = withReap(() => loadTests.start(req.params.branchId, profileId, {
        memberIds: Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(String) : undefined,
        concurrency: req.body?.concurrency,
        durationSec: req.body?.durationSec,
        warmupSec: req.body?.warmupSec,
        method: typeof req.body?.method === 'string' ? req.body.method : undefined,
        path: typeof req.body?.path === 'string' ? req.body.path : undefined,
        host: typeof req.body?.host === 'string' ? req.body.host : undefined,
        headers: req.body?.headers && typeof req.body.headers === 'object' ? req.body.headers : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
        maxRequests: req.body?.maxRequests,
      }));
      res.status(202).json({ run });
    } catch (err) { respondError(res, err); }
  });

  router.get('/branches/:branchId/replica-loadtests/:runId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      res.json({ run: loadTests.get(req.params.branchId, req.params.runId) });
    } catch (err) { respondError(res, err); }
  });

  router.post('/branches/:branchId/replica-loadtests/:runId/cancel', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      res.json({ run: loadTests.cancel(req.params.branchId, req.params.runId) });
    } catch (err) { respondError(res, err); }
  });

  // ── 执行计划（草稿-保存模型）：保存即串行执行；执行中可调序/跳过/取消 ──
  router.get('/branches/:branchId/replica-plans', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      res.json({ plans: deps.replicaSetService.listPlans(req.params.branchId) });
    } catch (err) { respondError(res, err); }
  });

  router.post('/branches/:branchId/replica-plans', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const plan = deps.replicaSetService.startPlan(req.params.branchId, {
        onFailure: req.body?.onFailure === 'rollback' ? 'rollback' : 'stop',
        steps: Array.isArray(req.body?.steps) ? req.body.steps : [],
        mode: req.body?.mode === 'container' || req.body?.mode === 'project' ? req.body.mode : undefined,
      });
      res.status(202).json({ plan });
    } catch (err) { respondError(res, err); }
  });

  router.patch('/branches/:branchId/replica-plans/:planId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
      res.json({ plan: deps.replicaSetService.reorderPlan(req.params.branchId, req.params.planId, order) });
    } catch (err) { respondError(res, err); }
  });

  router.post('/branches/:branchId/replica-plans/:planId/steps/:stepId/skip', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      res.json({ plan: deps.replicaSetService.skipStep(req.params.branchId, req.params.planId, req.params.stepId) });
    } catch (err) { respondError(res, err); }
  });

  router.post('/branches/:branchId/replica-plans/:planId/cancel', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      res.json({ plan: deps.replicaSetService.cancelPlan(req.params.branchId, req.params.planId) });
    } catch (err) { respondError(res, err); }
  });

  // profile 级复制隔离：复制一次 → 全体副本切隔离库；回切主库快照保留
  /**
   * 隔离 MECE 审计（2026-07-26 用户点名「隔离测过有效吗 + 没有可观测性」）：
   * 五面实测（意图/配置/实例/数据/边界），数据面走双向金丝雀真写真查。
   * POST 语义：审计会向两侧库写入并清理金丝雀记录（cds_isolation_canary）。
   * 未隔离的服务退化为「连接观测」——逐容器 docker inspect 真实连接的库。
   */
  router.post('/branches/:branchId/replica-sets/:profileId/isolation-audit', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const report = await runIsolationAudit(deps.stateService, req.params.branchId, req.params.profileId);
      res.json({ report });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.post('/branches/:branchId/replica-sets/:profileId/isolate', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const result = deps.replicaSetService.isolateProfile(req.params.branchId, req.params.profileId);
    if (!result.accepted) { res.status(409).json({ error: result.reason }); return; }
    res.status(202).json({ accepted: true });
  });

  router.post('/branches/:branchId/replica-sets/:profileId/revert-db', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const result = deps.replicaSetService.revertProfile(req.params.branchId, req.params.profileId);
    if (!result.accepted) { res.status(409).json({ error: result.reason }); return; }
    res.status(202).json({ accepted: true });
  });

  // 隔离库快照删除（保留语义的唯一出口：显式删除才 drop 数据库）
  router.delete('/branches/:branchId/replica-db-snapshots/:snapshotId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const snapshot = await deps.replicaSetService.deleteDbSnapshot(req.params.branchId, req.params.snapshotId);
      res.json({ dropped: true, dbName: snapshot.dbName });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.post('/branches/:branchId/replica-sets/:profileId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const rs = deps.replicaSetService.enable(req.params.branchId, req.params.profileId);
      res.status(201).json({ replicaSet: rs });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.delete('/branches/:branchId/replica-sets/:profileId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      await deps.replicaSetService.dissolve(req.params.branchId, req.params.profileId);
      res.json({ dissolved: true });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.post('/branches/:branchId/replica-sets/:profileId/members', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const versionId = typeof req.body?.versionId === 'string' ? req.body.versionId.trim() : '';
    try {
      const member = deps.replicaSetService.addMember(req.params.branchId, req.params.profileId, {
        versionId: versionId || undefined,
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
        weight: typeof req.body?.weight === 'number' ? req.body.weight : undefined,
        dbMode: req.body?.dbMode === 'isolated' ? 'isolated' : 'shared',
        projectGroupId: typeof req.body?.projectGroupId === 'string' ? req.body.projectGroupId : undefined,
      });
      res.status(202).json({ member });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.patch('/branches/:branchId/replica-sets/:profileId/members/:memberId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      // 项目级整组守卫（Codex 第三十八轮 P2）：绕开变更计划直接改单个成员的权重，
      // 会让项目级组内分流当场不一致。纯改标签不影响分流，放行。
      if (typeof req.body?.weight === 'number' || typeof req.body?.primaryWeight === 'number') {
        deps.replicaSetService.assertDirectMemberMutationAllowed(
          req.params.branchId, req.params.profileId, req.params.memberId, 'weight',
        );
      }
      const rs = deps.replicaSetService.updateMember(
        req.params.branchId,
        req.params.profileId,
        req.params.memberId,
        {
          weight: typeof req.body?.weight === 'number' ? req.body.weight : undefined,
          label: typeof req.body?.label === 'string' ? req.body.label : undefined,
          primaryWeight: typeof req.body?.primaryWeight === 'number' ? req.body.primaryWeight : undefined,
        },
      );
      res.json({ replicaSet: rs });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.delete('/branches/:branchId/replica-sets/:profileId/members/:memberId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      // 同上：项目级组只能整组下线，单个成员从侧门删掉会留下残缺组
      deps.replicaSetService.assertDirectMemberMutationAllowed(
        req.params.branchId, req.params.profileId, req.params.memberId, 'remove',
      );
      await deps.replicaSetService.removeMember(
        req.params.branchId,
        req.params.profileId,
        req.params.memberId,
      );
      res.json({ removed: true });
    } catch (err) {
      respondError(res, err);
    }
  });

  /**
   * 提升成员为主版本：走既有 deploy {versionId} 回滚机制重建主容器，
   * 成功派发后解散复制集（成员使命完成，退回普通模式）。
   */
  router.post('/branches/:branchId/replica-sets/:profileId/members/:memberId/promote', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const branch = deps.stateService.getBranch(req.params.branchId)!;
    const rs = branch.replicaSets?.[req.params.profileId];
    const member = rs?.members.find((m) => m.id === req.params.memberId);
    if (!rs || !member) { res.status(404).json({ error: '成员不存在' }); return; }
    const version = deps.deploymentVersionService.get(member.versionId);
    if (!version) { res.status(404).json({ error: `部署版本不存在: ${member.versionId}` }); return; }
    try {
      deps.deploymentVersionService.assertReusable(version);
    } catch (err) {
      res.status(409).json({ error: 'deployment_version_not_reusable', message: (err as Error).message });
      return;
    }
    // 整分支回滚显式化（Codex 第十五轮 P1）：DeploymentVersion 是整分支快照，
    // dispatchVersion 会把版本里**所有** profile 一起物化——多服务分支上提升一个
    // 老版本成员，web/worker 等其他服务也会被拉回历史版本，版本里没有的服务
    // 还会被移除。逐 profile 对照当前版本，其他服务会被改动时拒绝静默执行，
    // 要求调用方显式确认（confirmWholeBranch: true）这是整分支回滚。
    const currentVersion = branch.currentVersionId
      ? deps.deploymentVersionService.get(branch.currentVersionId)
      : undefined;
    const affectedProfiles = promoteAffectedProfiles(version, currentVersion, req.params.profileId);
    if (affectedProfiles.length > 0 && req.body?.confirmWholeBranch !== true) {
      res.status(409).json({
        error: 'promote_affects_other_profiles',
        affected: affectedProfiles,
        message: `提升该成员会把整条分支回滚到历史版本 ${version.id}，同时改动其他服务: ${affectedProfiles.join(', ')}`
          + '——这是整分支回滚操作。确认要整分支回滚请在请求体携带 confirmWholeBranch: true 重试；'
          + '只想切换单个服务请改用该服务的复制集权重（把该成员权重调到 100、主实例调到 0）。',
      });
      return;
    }
    const result = await deps.dispatchVersion(version, 'rollback');
    if (!result.accepted) {
      res.status(result.status || 500).json({ error: result.error || '版本部署未被接受' });
      return;
    }
    // 终态门（Codex P1，2026-07-26）：dispatchVersion 的 accepted 只代表「后台部署
    // 已受理」，新主容器可能还要构建/启动数分钟——此刻解散会把唯一健康出口
    //（含刚被提升的成员本体）拆掉；部署最终失败时更是主副两空。改为后台盯
    // run 到终态：running（成功终态）才解散；failed/cancelled 保留复制集。
    const { branchId, profileId } = req.params;
    const promoteRunId = result.runId;
    // 代际栅栏（Codex P2 两连）：记下派发瞬间的成员集合 + 集的 createdAt。
    // 部署跑的几分钟里操作员可能解散旧集、另建新副本——res-N 顺位命名会让新集
    // 的成员 id 与旧集重合，仅比成员子集分不出「重建过的集」；createdAt 随
    // dissolve 后重建而刷新，是持久的代际标识。两者都对上才许终态 dissolve。
    // 栅栏用**不可复用的成员身份**（Codex 第二十九轮 P2）：成员 id 形如 res-1，
    // 删掉再加会复用同一个号，而复制集对象没被重建、rs.createdAt 也不变——只比
    // id 会把「部署期间新建的替身」误判成同一代，promote 成功后顺手解散掉它刚起的
    // 容器。改比 `id@成员自身的 createdAt`：新成员必然带新时间戳。
    const memberToken = (m: { id: string; createdAt?: string }): string => `${m.id}@${m.createdAt ?? ''}`;
    const promoteGenerationMembers = new Set(rs.members.map(memberToken));
    const promoteGenerationCreatedAt = rs.createdAt;
    void (async () => {
      const startedAt = Date.now();
      const timeoutMs = 30 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5_000));
        const status = promoteRunId ? deps.getDeploymentRunStatus(promoteRunId) : undefined;
        if (status === 'running') {
          const currentRs = deps.stateService.getBranch(branchId)?.replicaSets?.[profileId];
          if (!currentRs) return; // 已被解散/删除，无事可做
          const sameGeneration = currentRs.createdAt === promoteGenerationCreatedAt
            && currentRs.members.every((m) => promoteGenerationMembers.has(memberToken(m)));
          if (!sameGeneration) {
            console.warn(`[replica-set] promote 终态清理跳过：${branchId}/${profileId} 的复制集在部署期间已被重建（出现新成员），不动当前集`);
            return;
          }
          try {
            await deps.replicaSetService.dissolve(branchId, profileId);
            console.log(`[replica-set] promote 部署成功终态，已解散复制集 ${branchId}/${profileId}`);
          } catch (err) {
            console.warn(`[replica-set] promote 后解散复制集失败（可手动解散）: ${(err as Error).message}`);
          }
          return;
        }
        if (status === 'failed' || status === 'cancelled') {
          console.warn(`[replica-set] promote 部署终态 ${status}，保留复制集 ${branchId}/${profileId} 作为回退出口`);
          return;
        }
        if (!promoteRunId || Date.now() - startedAt > timeoutMs) {
          console.warn(`[replica-set] promote 部署 ${promoteRunId || '(无 runId)'} 超过 30 分钟未到终态，保留复制集 ${branchId}/${profileId}（可手动解散）`);
          return;
        }
      }
    })();
    res.status(202).json({
      accepted: true,
      promotedVersionId: version.id,
      runId: promoteRunId,
      streamUrl: promoteRunId ? `/api/deployment-runs/${promoteRunId}/stream` : undefined,
      replicaSetRetained: true,
      note: '复制集将在新主版本部署成功后自动解散；部署失败则保留作为回退出口',
    });
  });

  // ── 数据库保护罩（用户拍板：数据库芯片上的锁按钮，一键克隆隔离库 + 可查询进度） ──
  // 内存态运行表：branchId:infraId → 阶段。CDS 重启丢进度可接受（克隆本身幂等重跑）。
  const guardRuns = new Map<string, {
    stage: 'cloning' | 'done' | 'error';
    detail: string;
    dbName?: string;
    startedAt: string;
  }>();

  router.post('/branches/:branchId/db-guard', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const infraId = typeof req.body?.infraId === 'string' ? req.body.infraId.trim() : '';
    if (!infraId) { res.status(400).json({ error: '缺少 infraId' }); return; }
    const branch = deps.stateService.getBranch(req.params.branchId)!;
    const key = `${branch.id}:${infraId}`;
    if (guardRuns.get(key)?.stage === 'cloning') {
      res.status(409).json({ error: '该数据库正在克隆中' });
      return;
    }
    const result = deps.replicaSetService.startDbGuard(branch.id, infraId, (stage, detail, dbName) => {
      guardRuns.set(key, { stage, detail, dbName, startedAt: guardRuns.get(key)?.startedAt || new Date().toISOString() });
    });
    if (!result.accepted) { res.status(409).json({ error: result.reason }); return; }
    guardRuns.set(key, { stage: 'cloning', detail: '正在克隆…', startedAt: new Date().toISOString() });
    res.status(202).json({ accepted: true, infraId });
  });

  router.get('/branches/:branchId/db-guard/:infraId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const run = guardRuns.get(`${req.params.branchId}:${req.params.infraId}`);
    res.json({ run: run || null });
  });

  return router;
}

function respondError(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): void {
  if (err instanceof ReplicaSetError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof LoadTestError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}
