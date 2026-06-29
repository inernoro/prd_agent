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
function pickDefaultProfile(profileIds: string[]): string {
  const webProfile = profileIds.find(
    (id) => id.includes('web') || id.includes('frontend') || id.includes('admin'),
  );
  if (webProfile) return webProfile;
  return profileIds[0];
}

const ROUTABLE_SERVICE_STATUSES = new Set(['running', 'starting', 'building', 'restarting']);

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

export class ForwarderRoutePublisher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPublishedJson: string = '';
  private pendingJson: string = '';
  private pendingStableSamples: number = 0;
  private publishCount: number = 0;

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

  private buildRoutes(): RouteRecord[] {
    const records: RouteRecord[] = [];
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
      if (routableServices.length === 0) continue;

      // 默认入口优先挑 running 服务。若全部仍在 building/starting，则保留
      // 路由到候选端口，让 forwarder 给出等待页/上游错误，而不是 host 消失。
      const defaultCandidates = routableServices.some((s) => s.status === 'running')
        ? routableServices.filter((s) => s.status === 'running')
        : routableServices;
      const defaultProfile = pickDefaultProfile(defaultCandidates.map((s) => s.profileId));
      const defaultPort = defaultCandidates.find((s) => s.profileId === defaultProfile)!.hostPort;

      const hosts: string[] = [];
      for (const root of this.opts.rootDomains) {
        hosts.push(`${previewSlug}.${root}`);
        for (const alias of branch.subdomainAliases ?? []) {
          if (!alias) continue;
          hosts.push(`${alias}.${root}`);
        }
      }

      let idx = 0;
      for (const host of hosts) {
        // 同一 host 下避免给同一 prefix 重复发布(BuildProfile.pathPrefixes 与
        // convention 兜底可能冲突,前者优先)
        const writtenPrefixes = new Set<string>();

        // 1) BuildProfile.pathPrefixes 配置驱动(显式覆盖,优先)
        for (const svc of routableServices) {
          const bp = profileById.get(svc.profileId);
          for (const prefix of bp?.pathPrefixes ?? []) {
            if (writtenPrefixes.has(prefix)) continue;
            writtenPrefixes.add(prefix);
            records.push({
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
            });
          }
        }
        // 2) Convention:`/api/*` → 含 api/backend 的 profile(若 BuildProfile 没显式配)
        if (!writtenPrefixes.has('/api/')) {
          // Case-sensitive includes 与 master detectProfileFromRequest(proxy.ts:884)对齐
          const apiSvc = routableServices.find(
            (s) => s.profileId.includes('api') || s.profileId.includes('backend'),
          );
          // master detectProfileFromRequest(proxy.ts:884)无条件让 /api/* 走 api/backend
          // profile,即使它正好是 profileIds[0](= default profile)。删 apiSvc.profileId !==
          // defaultProfile guard,总是显式写 /api/ prefix route 与 master 一致(Cursor Bugbot Medium):
          // 即使 port 跟 default 一样,显式 prefix 给 resolver 清晰 SSOT,防止未来 resolver 行为
          // 变化导致 /api/* 与 / 路由分叉。
          if (apiSvc) {
            writtenPrefixes.add('/api/');
            records.push({
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
            });
          }
        }
        // 3) 默认 fallback:无 pathPrefix → 所有未匹配 path 走默认 profile(admin/web/frontend)
        records.push({
          _id: `${branch.id}:${defaultProfile}:default:${idx++}`,
          host,
          upstreamHost: '127.0.0.1',
          upstreamPort: defaultPort,
          branchId: branch.id,
          branchName: branch.branch, // widget injection 需要 branchName,默认 route 也得带,否则 / 页面 widget 消失
          weight: 100,
          healthState: defaultCandidates.find((s) => s.profileId === defaultProfile)?.status === 'running' ? 'running' : 'unknown',
          // 不写 updatedAt(理由同前两处:dedup 失效防御)
        });
      }
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
