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
 * 路由记录生成规则（每个 running 分支一条）：
 *   - host = `${previewSlug}.${rootDomain}` （v3 公式，preview-slug.ts SSOT）
 *   - 别名（subdomainAliases）每个再插一条
 *   - upstreamHost = '127.0.0.1'
 *   - upstreamPort = primary running service.hostPort
 *   - branchId 反查用
 *
 * 不发布的分支：status !== 'running'（building / error / stopped 等不入表，
 * forwarder 找不到就走 ProxyHandler 内置的等候页 503）。
 *
 * 原子写：tmp 文件 + rename，保证 forwarder fs.watch 永远读到完整 JSON。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { StateService } from './state.js';
import type { BranchEntry, BuildProfile } from '../types.js';
import { computePreviewSlug } from './preview-slug.js';
import type { RouteRecord } from '../forwarder/types.js';

/**
 * 复刻 master ProxyService.detectProfileFromRequest 的默认 profile 选择优先级:
 *   1. id 含 web/frontend/admin → 走前端容器(/ 默认)
 *   2. 排除 api/backend 后剩下的第一个
 *   3. profileIds[0]
 *
 * 必须与 cds/src/services/proxy.ts:detectProfileFromRequest 同步;否则切流后
 * `/` 路径会路由到 api 容器返回 404(2026-05-08 实战教训)。
 */
function pickDefaultProfile(profileIds: string[]): string {
  const webProfile = profileIds.find((id) => /web|frontend|admin/i.test(id));
  if (webProfile) return webProfile;
  const nonApi = profileIds.find((id) => !/api|backend/i.test(id));
  if (nonApi) return nonApi;
  return profileIds[0];
}

export interface ForwarderRoutePublisherOptions {
  state: StateService;
  /** 输出 JSON 路径（绝对路径推荐，相对路径基于 process.cwd() 解析） */
  outputPath: string;
  /** 根域名列表（CDS_ROOT_DOMAINS 解析结果），不能为空 */
  rootDomains: string[];
  /** 周期性发布间隔（ms），默认 2000 */
  intervalMs?: number;
  /** 注入 logger，便于 daemon 集成 activity 流 */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export class ForwarderRoutePublisher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPublishedJson: string = '';
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
      if (json === this.lastPublishedJson) return false;
      this.writeAtomic(this.opts.outputPath, json);
      this.lastPublishedJson = json;
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

  /** 当前发布次数（健康度可视化用）。 */
  getStats(): { publishCount: number; lastSize: number } {
    return { publishCount: this.publishCount, lastSize: this.lastPublishedJson.length };
  }

  private buildRoutes(): RouteRecord[] {
    const records: RouteRecord[] = [];
    const projects = this.opts.state.getProjects();
    const projectSlugById = new Map<string, string>();
    for (const p of projects) projectSlugById.set(p.id, p.slug);

    const buildProfiles = this.opts.state.getBuildProfiles();
    const profileById = new Map<string, BuildProfile>();
    for (const bp of buildProfiles) profileById.set(bp.id, bp);

    const branches = this.opts.state.getAllBranches();
    for (const branch of branches) {
      if (branch.status !== 'running') continue;

      const projectSlug = projectSlugById.get(branch.projectId);
      if (!projectSlug) continue;
      const previewSlug = computePreviewSlug(branch.branch, projectSlug);
      if (!previewSlug) continue;

      // 收集所有 running profile + 它们的 hostPort
      const runningServices: Array<{ profileId: string; hostPort: number }> = [];
      for (const [profileId, svc] of Object.entries(branch.services ?? {})) {
        if (svc?.status === 'running') {
          runningServices.push({ profileId, hostPort: svc.hostPort });
        }
      }
      if (runningServices.length === 0) continue;

      const defaultProfile = pickDefaultProfile(runningServices.map((s) => s.profileId));
      const defaultPort = runningServices.find((s) => s.profileId === defaultProfile)!.hostPort;

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
        for (const svc of runningServices) {
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
              healthState: 'running',
              updatedAt: new Date().toISOString(),
            });
          }
        }
        // 2) Convention:`/api/*` → 含 api/backend 的 profile(若 BuildProfile 没显式配)
        if (!writtenPrefixes.has('/api/')) {
          const apiSvc = runningServices.find((s) => /api|backend/i.test(s.profileId));
          if (apiSvc && apiSvc.profileId !== defaultProfile) {
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
              healthState: 'running',
              updatedAt: new Date().toISOString(),
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
          healthState: 'running',
          updatedAt: new Date().toISOString(),
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
