/**
 * Forwarder 路由发布器（B'.2-forwarder MVP, 2026-05-08）
 *
 * 职责：cds-master daemon 在内存里维护 BranchEntry 全集，本服务把它转成
 * forwarder 进程能消费的 RouteRecord 列表，原子地写到 JSON 文件。
 *
 * 由 cds-master 启动时挂上，挂完即跑：
 *   1. 立即发布一次（fresh start 后 forwarder 不要等下次心跳）
 *   2. 每 intervalMs（默认 2s）周期性发布
 *   3. 暴露 publishNow() 供分支变更钩子主动触发（可选，MVP 不强制）
 *
 * 文件路径：`<cdsRoot>/.cds/forwarder-routes.json`，与 forwarder-main 默认值
 * 一致。两边都通过 CDS_FORWARDER_ROUTES_JSON 覆盖。
 *
 * 路由记录生成规则（每个可路由分支一条）：
 *   - host = `${previewSlug}.${rootDomain}` （v3 公式，preview-slug.ts SSOT）
 *   - 别名（subdomainAliases）每个再插一条
 *   - upstreamHost = '127.0.0.1'
 *   - upstreamPort = primary running service.hostPort
 *   - branchId 反查用
 *
 * 不发布的分支：没有可路由服务端口的分支。building / starting 分支如果
 * 已有 hostPort，也必须保留 host route，避免 preview host 从 forwarder
 * 路由表里消失后落到 unknown-host fallback。
 *
 * 原子写：tmp 文件 + rename，保证 forwarder fs.watch 永远读到完整 JSON。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { StateService } from './state.js';
import type { BranchEntry, BuildProfile } from '../types.js';
import { buildPreviewUrlForProject } from './comment-template.js';
import { resolveEffectiveProfile } from './container.js';
import { namedServiceLabel, occupiedHostOwners, publishedServiceLabels, subdomainWithLegacyAliases } from './preview-entrypoints.js';
import { isOperationalProbePrefix, pickApiConventionProfile, pickDefaultProfile } from './route-conventions.js';
import type { RouteRecord } from '../forwarder/types.js';

/**
 * 复刻 master ProxyService.detectProfileFromRequest 的默认 profile 选择优先级:
 *   1. id 含 web/frontend/admin(case-sensitive includes,跟 master 完全一致)
 *   2. profileIds[0]
 *
 * 必须与 cds/src/services/proxy.ts:detectProfileFromRequest 严格同步:
 * Cursor Bugbot 抓到 (PR #541):case-insensitive `/i` + 多余 nonApi fallback
 * 让 ['api', 'reporting'] 分支的 master 选 api,publisher 选 reporting,
 * 切流时路由不一致。已对齐为 master 的 case-sensitive includes + 直接 profileIds[0]。
 */
// 可路由服务状态(SSOT)：forwarder 命名/前缀路由与 proxy.ts master 命名子域兜底共用同一口径，
// 避免「停止/错误的服务仍被强制为上游」这类两条路径漂移(Cursor Bugbot)。
export const ROUTABLE_SERVICE_STATUSES = new Set(['running', 'starting', 'building', 'restarting']);

export interface ForwarderRoutePublisherOptions {
  state: StateService;
  /** 输出 JSON 路径（绝对路径推荐，相对路径基于 process.cwd() 解析） */
  outputPath: string;
  /** 根域名列表（CDS_ROOT_DOMAINS 解析结果），不能为空 */
  rootDomains: string[];
  /** 周期性发布间隔（ms），默认 2000 */
  intervalMs?: number;
  /**
   * 连续看到同一份变更 N 次后才写盘。默认 1(测试/手动 publishNow 保持即时);
   * 生产可设 2,把部署过程中的中间态 route 表合并掉,减少 forwarder reload 抖动。
   */
  stableSamplesRequired?: number;
  /** 注入 logger，便于 daemon 集成 activity 流 */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

/**
 * 成员直达子域的 profile 段清洗（发布器与探测白名单共用的 SSOT）。
 *
 * 防撞编码（Codex 第十四轮 P2）：清洗**有损**（api_v2 与 api.v2 同归 api-v2）时
 * 追加原始 id 的确定性短哈希（djb2-xor，base36），保证不同 profile 落到不同 DNS 段；
 * 已是合法 DNS 段的 id 原样保留（既有直达域名不变）。与前端 memberDirectUrl 同款
 * 算法，三处必须同步改。
 */
export function dnsSafeProfile(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'svc';
  if (cleaned === id) return cleaned;
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
  return `${cleaned}-${h.toString(36)}`;
}

export class ForwarderRoutePublisher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPublishedJson: string = '';
  private pendingJson: string = '';
  private pendingStableSamples: number = 0;
  private publishCount: number = 0;
  /**
   * 已经报过的「历史别名被显式声明占走」冲突（`branchId:label:owner`）。
   *
   * buildRoutes 每 2 秒重跑一次，不去重就会把同一条配置错误刷满日志；
   * 冲突消失后要从这里移除，否则改回来再改错就再也不会提示了。
   */
  private warnedAliasCollisions = new Set<string>();

  constructor(private opts: ForwarderRoutePublisherOptions) {
    if (!opts.rootDomains?.length) {
      throw new Error('ForwarderRoutePublisher: rootDomains required');
    }
  }

  start(): void {
    this.publishNow();
    const interval = this.opts.intervalMs ?? 2000;
    this.timer = setInterval(() => this.publishNow(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 立即发布一次。返回是否真写盘（unchanged 则跳过）。 */
  publishNow(): boolean {
    try {
      const records = this.buildRoutes();
      const json = JSON.stringify(records, null, 2);
      // Codex P1 (PR #541):原本用 `${records.length}:${json.length}` 做 hash,
      // port 41000 → 41001 同 length 会被误判 unchanged → forwarder 保留 stale
      // 路由,流量打错容器。改用真 string 比对(json 几 KB,O(n) 很快)。
      if (json === this.lastPublishedJson) {
        this.pendingJson = '';
        this.pendingStableSamples = 0;
        return false;
      }
      const stableSamplesRequired = Math.max(1, this.opts.stableSamplesRequired ?? 1);
      if (this.lastPublishedJson && stableSamplesRequired > 1) {
        if (json === this.pendingJson) {
          this.pendingStableSamples += 1;
        } else {
          this.pendingJson = json;
          this.pendingStableSamples = 1;
        }
        if (this.pendingStableSamples < stableSamplesRequired) {
          this.opts.logger?.info?.(
            `[forwarder-publisher] route change pending ${this.pendingStableSamples}/${stableSamplesRequired} (${records.length} routes)`,
          );
          return false;
        }
      }
      this.writeAtomic(this.opts.outputPath, json);
      this.lastPublishedJson = json;
      this.pendingJson = '';
      this.pendingStableSamples = 0;
      this.publishCount += 1;
      this.opts.logger?.info?.(
        `[forwarder-publisher] wrote ${records.length} routes to ${this.opts.outputPath} (publishCount=${this.publishCount})`,
      );
      return true;
    } catch (err) {
      this.opts.logger?.error?.(
        `[forwarder-publisher] publish failed: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** 最近一次写盘的路由表（路由判定查询用；未发布过返回空）。 */
  getPublishedRoutes(): RouteRecord[] {
    if (!this.lastPublishedJson) return [];
    try {
      const parsed = JSON.parse(this.lastPublishedJson) as { routes?: RouteRecord[] } | RouteRecord[];
      return Array.isArray(parsed) ? parsed : (parsed.routes ?? []);
    } catch {
      return [];
    }
  }

  private buildRoutes(): RouteRecord[] {
    const records: RouteRecord[] = [];
    // 全部分支已保存的子域别名标签 → 拥有它的分支 id。
    //
    // 兼容别名（`llmgw` 展开出的 `llmgw-web`）发布前必须查这张表：保存期的撞名检查
    // 只拦「新保存的别名」，管不了两种情况——① 本次改名之前就已经存在的别名恰好等于
    // `<slug>-llmgw-web`；② 别名先保存、声明 `llmgw` 的 profile 后来才加。两种都会让
    // forwarder 收到同 host 两条路由，route-resolver 按路由 id 静默选一条，用户可能
    // 被路由到别的分支（Codex P1）。
    // **按完整 host** 的占位表：别名（按根域展开）+ 完整自定义域名。自定义域名存的是整条
    // host、不是标签，只按 label 判会漏掉「一条自定义域名恰好等于 <slug>-llmgw.<root>」
    // —— 那条路由在本函数更早处就已发出，命名服务再发同一 host 就是两个上游（Codex P1）。
    const occupiedHosts = occupiedHostOwners(this.opts.state.getAllBranches(), this.opts.rootDomains);
    // 本轮实际存在的别名冲突。收在这里是为了在末尾把已经消失的冲突从
    // warnedAliasCollisions 里剪掉——否则「改错 → 报警 → 改对 → 再改错」的第二次
    // 就永远静默了（去重不能变成一次性静音）。
    const seenAliasCollisions = new Set<string>();
    const projects = this.opts.state.getProjects();
    const projectById = new Map(projects.map((p) => [p.id, p]));

    const branches = this.opts.state.getAllBranches();
    for (const branch of branches) {
      // 用分支**有效** profiles（项目 profiles + 分支级额外服务）建本分支 profile 查找。原先全局只取
      // getBuildProfiles()（项目级），分支级额外服务的 pathPrefixes（只存在 branch.extraProfiles）发不进
      // forwarder-routes.json → CDS_USE_FORWARDER=1 时转发流量回退默认/约定路由、额外服务不可达
      // （Codex P2「Publish extra-service path prefixes to the forwarder」）。
      // 每个有效 profile 再过 resolveEffectiveProfile 应用 profileOverrides（Codex P2「Resolve overrides
      // before routing path prefixes」/ mirror）：经 PUT /profile-overrides 配的 pathPrefixes 只由
      // resolveEffectiveProfile 合并,不在 getEffectiveProfilesForBranch 里;不解析则 override 前缀发不进
      // forwarder-routes.json,与 proxy.ts 的解析口径保持一致。
      const profileById = new Map<string, BuildProfile>();
      for (const bp of this.opts.state.getEffectiveProfilesForBranch(branch)) {
        profileById.set(bp.id, resolveEffectiveProfile(bp, branch));
      }

      const project = projectById.get(branch.projectId);
      const previewSlug = buildPreviewUrlForProject('', branch.branch, project, branch.projectId).previewSlug;
      if (!previewSlug) continue;

      // 收集所有可路由 profile + 它们的 hostPort。分支顶层状态可能因并发
      // deploy / check-run 事件短暂回退到 building，但容器端口仍可用；
      // 这时删除 host route 会让用户看到 unknown-host 503。
      const routableServices: Array<{ profileId: string; hostPort: number; status: string }> = [];
      for (const [profileId, svc] of Object.entries(branch.services ?? {})) {
        if (svc?.hostPort && ROUTABLE_SERVICE_STATUSES.has(String(svc.status))) {
          routableServices.push({ profileId, hostPort: svc.hostPort, status: String(svc.status) });
        }
      }

      // 复制集（design.cds.replica-set）:每个启用复制集且有 running 成员的 profile,
      // 主入口路由扩展成一组同 host 同 prefix 的兄弟路由（primary + members,
      // replicaGroup 标记）,由 resolver 按权重/粘性选择;成员另获直达子域
      // `<previewSlug>-<memberId>.<root>`（整套路由,仅该 profile 的端口钉到成员）。
      // 主容器不可路由（error/stopped）但成员还活着时（Codex P1，2026-07-26）:
      // 不能整组跳过——那会连健康成员的路由和直达子域一起蒸发,单服务分支 host
      // 直接消失。此时以成员身份把该 profile 补进可路由集合,组内只发成员路由
      //（不发 primary 记录）,resolver 权重全零时的兜底会自动落到组内成员。
      const replicaByProfile = new Map<string, {
        group: string;
        primaryWeight: number;
        primaryRoutable: boolean;
        members: Array<{ id: string; hostPort: number; weight: number }>;
      }>();
      for (const rs of Object.values(branch.replicaSets ?? {})) {
        if (!rs.enabled) continue;
        // 数据面保险（Codex P1）：profile 已被删除（不在分支生效 profiles 里）时，
        // 成员兜底不许把它的副本再抬进可路由集合——控制面删 profile 已级联解散
        // 复制集，这里防的是任何绕过级联的路径让「被删的服务」继续公网可达。
        if (!profileById.has(rs.profileId)) continue;
        const members = rs.members
          .filter((m) => m.status === 'running' && typeof m.hostPort === 'number' && m.hostPort > 0)
          .map((m) => ({ id: m.id, hostPort: m.hostPort as number, weight: m.weight }));
        if (members.length === 0) continue;
        const primarySvc = routableServices.find((s) => s.profileId === rs.profileId);
        replicaByProfile.set(rs.profileId, {
          group: `${branch.id}:${rs.profileId}`,
          primaryWeight: rs.primaryWeight,
          primaryRoutable: !!primarySvc,
          members,
        });
        if (!primarySvc) {
          routableServices.push({ profileId: rs.profileId, hostPort: members[0].hostPort, status: 'running' });
        }
      }

      if (routableServices.length === 0) continue;

      // 可路由服务按 profileId 排序后再发前缀路由（plan.cds.service-relations 第二批）：
      // 此前按 branch.services 的对象键序去重，键序随容器启动先后变化，两个服务声明同一前缀时
      // 赢家会随部署翻转（「A 入口偶发进 B 端口」的机制之一）。排序后同一份配置永远发同一份路由。
      routableServices.sort((a, b) => a.profileId.localeCompare(b.profileId));

      // 默认站（承载主域名上未被任何前缀命中的路径）：按名兜底在**全部**可路由服务里选，不再只看
      // running——否则 web 重建期间默认站会落到第一个 running 的服务（往往是 API 端口），用户打开 /
      // 看到的是另一个应用。默认站没在跑时路由照发但 healthState 不是 running，forwarder 见状转 master
      // 出该服务的等待页（proxy-handler），host 不消失、也不落到别的服务。
      const defaultProfile = pickDefaultProfile(routableServices.map((s) => s.profileId));
      const defaultSvc = routableServices.find((s) => s.profileId === defaultProfile)!;
      const defaultPort = defaultSvc.hostPort;

      const hosts: string[] = [];
      for (const root of this.opts.rootDomains) {
        hosts.push(`${previewSlug}.${root}`);
        for (const alias of branch.subdomainAliases ?? []) {
          if (!alias) continue;
          hosts.push(`${alias}.${root}`);
        }
      }
      for (const domain of branch.customDomains ?? []) {
        const host = String(domain || '').trim().toLowerCase();
        if (host) hosts.push(host);
      }

      // 单条路由入账:普通 profile 原样;复制集 profile 主入口展开成组;
      // override（成员直达 host）把该 profile 的上游钉到成员端口,不展开组。
      const pushRoute = (
        base: RouteRecord,
        profileId: string,
        override?: { profileId: string; hostPort: number; replicaGroup?: string; replicaMemberId?: string },
      ): void => {
        // 每条路由都带上它把流量交给谁：响应头 X-CDS-Profile 与路由判定查询据此回答「落到了谁」
        base = { ...base, profileId };
        if (override) {
          // 成员直达路由必须带上副本身份（Codex 第二十八轮 P2）：第二十四轮把
          // X-CDS-Replica 改成「以路由为准」后，proxy 对**非副本路由**会显式删掉
          // 这两个响应头——直达链接若只钉上游端口不带身份，用户点开就拿不到
          // 「这条请求落在哪个副本」，而这正是直达链接与观测流承诺的东西。
          // 成员直达路由的健康态看成员自己：成员只在 running 时才被收进来，主容器正在
          // building / restarting 不该把它的等待态贴到健康成员上，否则副本在主容器重建期间
          // 全被 forwarder 转去等待页，副本的意义就没了（Codex 三轮 P1）
          records.push(profileId === override.profileId
            ? {
              ...base,
              upstreamPort: override.hostPort,
              ...(override.replicaGroup ? { replicaGroup: override.replicaGroup } : {}),
              ...(override.replicaMemberId ? { replicaMemberId: override.replicaMemberId } : {}),
              ...(override.replicaMemberId && override.replicaMemberId !== 'primary' ? { healthState: 'running' as const } : {}),
            }
            : base);
          return;
        }
        const replica = replicaByProfile.get(profileId);
        if (!replica) {
          records.push(base);
          return;
        }
        // 主容器不可路由时只发成员路由（Codex P1）:不发 primary 记录,
        // resolver 的「全组权重为零 → 回落非摘除成员」兜底保证仍有出口。
        if (replica.primaryRoutable) {
          records.push({
            ...base,
            weight: replica.primaryWeight,
            replicaGroup: replica.group,
            replicaMemberId: 'primary',
          });
        }
        for (const member of replica.members) {
          records.push({
            ...base,
            _id: `${base._id}:m:${member.id}`,
            upstreamPort: member.hostPort,
            weight: member.weight,
            replicaGroup: replica.group,
            replicaMemberId: member.id,
            // 成员健康态看成员自己（上面已按 running 过滤），不继承主容器的重建态
            healthState: 'running',
          });
        }
      };

      let idx = 0;
      const emitHostRouteSet = (
        host: string,
        override?: { profileId: string; hostPort: number; replicaGroup?: string; replicaMemberId?: string },
      ): void => {
        // 同一 host 下避免给同一 prefix 重复发布(BuildProfile.pathPrefixes 与
        // convention 兜底可能冲突,前者优先)
        const writtenPrefixes = new Set<string>();

        // 1) BuildProfile.pathPrefixes 配置驱动(显式覆盖,优先)。routableServices 已按 profileId 排序，
        //    重复前缀确定性地归 id 最小者；探活前缀不发布（探活只打容器端口，公网不该有这条路由）。
        for (const svc of routableServices) {
          const bp = profileById.get(svc.profileId);
          for (const prefix of bp?.pathPrefixes ?? []) {
            if (isOperationalProbePrefix(prefix)) continue;
            if (writtenPrefixes.has(prefix)) continue;
            writtenPrefixes.add(prefix);
            pushRoute({
              _id: `${branch.id}:${svc.profileId}:bp:${idx++}`,
              host,
              pathPrefix: prefix,
              upstreamHost: '127.0.0.1',
              upstreamPort: svc.hostPort,
              branchId: branch.id,
              branchName: branch.branch,
              weight: 100,
              healthState: svc.status === 'running' ? 'running' : 'unknown',
              // 注意:不写 updatedAt(每次 buildRoutes 都生成新时间戳会让 dedup 永远失效,
              // 每 2s 重写盘 + 触发 forwarder fs.watch 风暴。Cursor Bugbot 抓到。
              // mongo change-stream 触发依据是 design 文档预留字段,JSON file 模式不用)。
            }, svc.profileId, override);
          }
        }
        // 2) Convention:`/api/*` → 含 api/backend 的 profile(若 BuildProfile 没显式配)
        if (!writtenPrefixes.has('/api/')) {
          // Case-sensitive includes 与 master detectProfileFromRequest(proxy.ts:884)对齐
          const apiConventionId = pickApiConventionProfile(routableServices.map((s) => s.profileId));
          const apiSvc = routableServices.find((s) => s.profileId === apiConventionId);
          // master detectProfileFromRequest(proxy.ts:884)无条件让 /api/* 走 api/backend
          // profile,即使它正好是 profileIds[0](= default profile)。删 apiSvc.profileId !==
          // defaultProfile guard,总是显式写 /api/ prefix route 与 master 一致(Cursor Bugbot Medium):
          // 即使 port 跟 default 一样,显式 prefix 给 resolver 清晰 SSOT,防止未来 resolver 行为
          // 变化导致 /api/* 与 / 路由分叉。
          if (apiSvc) {
            writtenPrefixes.add('/api/');
            pushRoute({
              _id: `${branch.id}:${apiSvc.profileId}:apiconv:${idx++}`,
              host,
              pathPrefix: '/api/',
              upstreamHost: '127.0.0.1',
              upstreamPort: apiSvc.hostPort,
              branchId: branch.id,
              branchName: branch.branch,
              weight: 100,
              healthState: apiSvc.status === 'running' ? 'running' : 'unknown',
              // 注意:不写 updatedAt(每次 buildRoutes 都生成新时间戳会让 dedup 永远失效,
              // 每 2s 重写盘 + 触发 forwarder fs.watch 风暴。Cursor Bugbot 抓到。
              // mongo change-stream 触发依据是 design 文档预留字段,JSON file 模式不用)。
            }, apiSvc.profileId, override);
          }
        }
        // 3) 默认 fallback:无 pathPrefix → 所有未匹配 path 走默认 profile(admin/web/frontend)
        pushRoute({
          _id: `${branch.id}:${defaultProfile}:default:${idx++}`,
          host,
          upstreamHost: '127.0.0.1',
          upstreamPort: defaultPort,
          branchId: branch.id,
          branchName: branch.branch, // widget injection 需要 branchName,默认 route 也得带,否则 / 页面 widget 消失
          weight: 100,
          healthState: defaultSvc.status === 'running' ? 'running' : 'unknown',
          // 不写 updatedAt(理由同前两处:dedup 失效防御)
        }, defaultProfile, override);
      };

      for (const host of hosts) {
        emitHostRouteSet(host);
      }

      // 复制集成员直达子域:`<previewSlug>-<profileId>-<memberId>.<root>` 整套路由,
      // 仅复制集 profile 的上游钉到该成员端口,其余服务仍走主容器 ——
      // 用户拿直达链能浏览整个应用,只有该服务是成员版本。63 字符守卫同命名子域。
      // host 带 profile 段（Codex P1）:res-N 按 profile 顺位命名,两个服务都有
      // res-1 时旧格式 `<slug>-res-1` 撞同一 host,两套整组路由互相覆盖,至少
      // 一个服务的直达链钉不住自己宣传的版本。
      // profile 段 DNS 清洗（Codex P2）：profile id 允许 `_`/`.`（compose 服务名
      // 导入），但单 DNS 标签不许下划线、点会多出一级域逃出通配证书。清洗成
      // [a-z0-9-]；清洗后撞名（api_v2 与 api.v2 同归 api-v2）时保留首个、跳过
      // 后续并 warn——与前端 memberDirectUrl 的同款清洗保持一致（两端必须同步改）。
      // 防撞编码（Codex 第十四轮 P2）：清洗**有损**（api_v2 与 api.v2 同归 api-v2）
      // 时追加原始 id 的确定性短哈希（djb2-xor，base36），保证不同 profile 落到
      // 不同 DNS 段；已是合法 DNS 段的 id 原样保留（既有直达域名不变）。撞名
      // skip+warn 仍保留为最后防线。与前端 memberDirectUrl 同款算法，两端必须同步改。
      const emittedMemberHosts = new Set<string>();
      for (const [profileId, replica] of replicaByProfile) {
        for (const member of replica.members) {
          const memberLabel = `${previewSlug}-${dnsSafeProfile(profileId)}-${member.id}`;
          if (emittedMemberHosts.has(memberLabel)) {
            this.opts.logger?.warn?.(
              `[forwarder-publisher] 复制集成员直达子域撞名跳过 ${memberLabel}.*（profile id DNS 清洗后重合）；成员仍可经主入口 ?__rs=${profileId}:${member.id} 钉选直达`,
            );
            continue;
          }
          emittedMemberHosts.add(memberLabel);
          if (memberLabel.length > 63) {
            this.opts.logger?.warn?.(
              `[forwarder-publisher] 跳过复制集成员直达子域 ${memberLabel}.*（第一 DNS 标签超 63 octet 上限）；成员仍可经主入口 ?__rs=${member.id} 粘性直达`,
            );
            continue;
          }
          for (const root of this.opts.rootDomains) {
            emitHostRouteSet(`${memberLabel}.${root}`, {
              profileId, hostPort: member.hostPort,
              replicaGroup: replica.group, replicaMemberId: member.id,
            });
          }
        }
      }

      // 4) 命名子域路由:声明了 subdomain 的服务获得自己的命名 URL
      //    `<previewSlug>-<subdomain>.<root>`,根路径直达该容器(无 pathPrefix)。
      //    让「可被别人调用」的独立服务(如 LLM 网关 llmgw-serve → <slug>-llmgw.<root>)
      //    拥有区别于主应用域名的命名入口,而不是埋在主应用的 /gw/v1 路径下。
      //    单标签(<previewSlug>-<subdomain>)以匹配 *.<root> 通配证书;subdomain 合法性
      //    由 branch-extra-services.isValidServiceSubdomain / compose cds.subdomain 入口保证。
      //    见 .claude/rules/navigation-registry 同源思路 + doc/design.platform.llm-gateway.physical-isolation.md。
      // 同一 subdomain 在一个分支内只发一条命名 host 路由：若两个服务复用同一 subdomain（理论上
      // 入口校验已拒，这里作数据面兜底），保留首个、跳过后续,避免同 host 不同上游端口的撞车路由
      // 命中错容器(Cursor Bugbot)。
      // 按 profileId 排序后再去重,保证「保留首个」在 branch.services 对象键序变化时仍确定性命中
      // 同一容器(否则两次发布可能因键序不同把同名 subdomain 指向不同端口)。
      const subdomainCandidates = [...routableServices].sort((a, b) => a.profileId.localeCompare(b.profileId));
      const writtenSubdomains = new Set<string>();
      const claims: Array<{ svc: typeof subdomainCandidates[number]; sub: string }> = [];
      for (const svc of subdomainCandidates) {
        const bp = profileById.get(svc.profileId);
        const sub = bp?.subdomain;
        if (!sub) continue;
        if (writtenSubdomains.has(sub)) continue;
        writtenSubdomains.add(sub);
        claims.push({ svc, sub });
        // DNS label 上限守卫(Codex P2):命名 host 第一标签必须 ≤63 octet(RFC 1035),否则
        // 无法可靠解析,且单标签通配证书 `*.<root>` 不覆盖 → 该命名 URL 对长分支名**静默失效**。
        // namedServiceLabel 已按段截断 + 摘要压到上限内;仍超限(subdomain 自身过长)的由
        // publishedServiceLabels 过滤掉,这里对被滤掉的名字 warn —— 服务仍可经主域名的路径访问。
        const publishable = publishedServiceLabels(previewSlug, sub);
        for (const dropped of subdomainWithLegacyAliases(sub)) {
          const label = namedServiceLabel(previewSlug, dropped);
          if (publishable.includes(label)) continue;
          this.opts.logger?.warn?.(
            `[forwarder-publisher] 跳过命名子域路由 ${label}.*（第一 DNS 标签 ${label.length} 字符 > 63 octet 上限，无法解析且通配证书不覆盖）；该服务仍可经主域名 ${previewSlug}.* 的路径访问`,
          );
        }
      }

      // 规范名 + 历史别名一起发（preview-entrypoints.publishedServiceLabels）：
      // 子域改名（llmgw-web → llmgw）时别的分支还挂在旧地址上，只发新名会让那些
      // 链接一起失效。两个 host 指同一个上游，旧链接照常可达。
      //
      // **两趟发，且按最终 label 去重**（Codex P1）：去重键此前是原始 subdomain，
      // 同一分支里若一个 profile 声明 `llmgw`、另一个声明 `llmgw-web`，两者原始名不同、
      // 都会放行，但前者展开出的别名 host 与后者的规范 host 完全相同 —— forwarder 于是
      // 拿到两条 host 相同、上游端口不同的路由，按路由 id 定死选一条，另一个服务直接不可达。
      // 先发全部规范名、再发别名，保证「显式声明」永远压过「兼容别名」。
      // label → 写它的那个 profileId。用 Map 而不是 Set：只有知道「是谁占的」，
      // 才能把「另一个 profile 显式声明占走了这个别名」（真冲突，要报）与
      // 「这个 label 就是本 profile 刚发的规范名」（正常，别报）区分开。
      const writtenLabels = new Map<string, string>();
      /**
       * 写一条命名子域路由。**已保存别名的检查放在这里单点**，规范名与兼容别名两趟
       * 都必然经过它。
       *
       * 上一版只在别名那一趟查 aliasOwners，规范名那一趟无条件写 —— 于是一个早于
       * 改名就存在的别名 `<slug>-llmgw`（它已经为自己的主应用发了一条路由）会与
       * 规范服务 host 撞成同 host 两个上游，resolver 按路由 id 静默选一条，用户可能
       * 打开另一个分支的应用（Codex P1）。同一个判断分两趟各写一遍正是判据分裂的
       * 温床，故收进 emit。
       *
       * 撞上就**跳过并告警**，与本文件既有的「第一标签超 63 octet 则跳过」同一处理：
       * 命名入口丢掉后服务仍可经主域名的路径访问，而同 host 两条路由是静默错路由。
       */
      const emit = (svc: typeof subdomainCandidates[number], namedLabel: string): void => {
        if (writtenLabels.has(namedLabel)) return;
        writtenLabels.set(namedLabel, svc.profileId);
        {
          for (const root of this.opts.rootDomains) {
            // 逐根域判占位：别名是标签（每个根域都占），自定义域名只占它自己那一条 host，
            // 所以判定必须在这一层而不是标签层，否则一条自定义域名会连带掐掉其它根域的路由。
            const host = `${namedLabel}.${root}`.toLowerCase();
            const hostOwner = occupiedHosts.get(host);
            if (hostOwner !== undefined) {
              const key = `${branch.id}:${host}:occupied:${hostOwner}`;
              if (!this.warnedAliasCollisions.has(key)) {
                this.warnedAliasCollisions.add(key);
                this.opts.logger?.warn?.(
                  `[forwarder-publisher] 命名子域 host ${host} 已被分支 ${hostOwner} 的子域别名或自定义域名占用，跳过该命名路由（已保存的占位优先）；该服务仍可经主域名 ${previewSlug}.* 的路径访问`,
                );
              }
              seenAliasCollisions.add(key);
              continue;
            }
            // 命名子域也必须走复制集展开（Codex P1）：直接 records.push 会让命名入口
            //（如 LLM 网关 <slug>-llmgw）永远单发 primary 路由——配置了分流权重的
            // 生产消费方 100% 流量仍打主容器，实验失真且绕过被动健康摘除。
            pushRoute({
              _id: `${branch.id}:${svc.profileId}:subdom:${idx++}`,
              // 必须用 namedLabel（可能已按 63 上限截断+摘要），不能再拼一遍原始 slug ——
              // 否则发布的 host 与入口表/白名单算出来的不是同一个。
              host: `${namedLabel}.${root}`,
              upstreamHost: '127.0.0.1',
              upstreamPort: svc.hostPort,
              branchId: branch.id,
              branchName: branch.branch,
              weight: 100,
              healthState: svc.status === 'running' ? 'running' : 'unknown',
              // 不写 updatedAt(理由同前:dedup 失效防御)
            }, svc.profileId);
          }
        }
      };
      for (const { svc, sub } of claims) {
        emit(svc, namedServiceLabel(previewSlug, sub));
      }
      for (const { svc, sub } of claims) {
        for (const label of publishedServiceLabels(previewSlug, sub)) {
          // 已保存别名的检查在 emit 里单点做（规范名那一趟同样要过），这里不再重复。
          const owner = writtenLabels.get(label);
          if (owner === undefined) {
            emit(svc, label); // 别名没人占，静默发出去——这是绝大多数情况
            continue;
          }
          // 本 profile 自己刚在规范名那趟发过这个 label，不是冲突。
          if (owner === svc.profileId) continue;
          // 真冲突：另一个 profile 显式声明了这个 host。显式声明优先，别名让路。
          // 去重上报：buildRoutes 每 2 秒重跑一次，不去重会把同一条配置错误刷满日志。
          const warnKey = `${branch.id}:${label}:${owner}`;
          if (!this.warnedAliasCollisions.has(warnKey)) {
            this.warnedAliasCollisions.add(warnKey);
            this.opts.logger?.warn?.(
              `[forwarder-publisher] 命名子域 ${sub} 的历史别名 host ${label}.* 已被同分支 profile ${owner} 的显式声明占用，跳过别名路由（显式声明优先）`,
            );
          }
          seenAliasCollisions.add(warnKey);
        }
      }
    }
    for (const key of [...this.warnedAliasCollisions]) {
      if (!seenAliasCollisions.has(key)) this.warnedAliasCollisions.delete(key);
    }
    return records;
  }

  private writeAtomic(target: string, content: string): void {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
  }
}
