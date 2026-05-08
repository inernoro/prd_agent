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
import type { BranchEntry, ServiceState } from '../types.js';
import { computePreviewSlug } from './preview-slug.js';
import type { RouteRecord } from '../forwarder/types.js';

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
  private lastPublishedHash: string = '';
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
      const hash = `${records.length}:${json.length}`;
      if (hash === this.lastPublishedHash) return false;
      this.writeAtomic(this.opts.outputPath, json);
      this.lastPublishedHash = hash;
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
  getStats(): { publishCount: number; lastHash: string } {
    return { publishCount: this.publishCount, lastHash: this.lastPublishedHash };
  }

  private buildRoutes(): RouteRecord[] {
    const records: RouteRecord[] = [];
    const projects = this.opts.state.getProjects();
    const projectSlugById = new Map<string, string>();
    for (const p of projects) projectSlugById.set(p.id, p.slug);

    const branches = this.opts.state.getAllBranches();
    for (const branch of branches) {
      if (branch.status !== 'running') continue;
      const port = this.pickUpstreamPort(branch);
      if (port == null) continue;

      const projectSlug = projectSlugById.get(branch.projectId);
      if (!projectSlug) continue;
      const previewSlug = computePreviewSlug(branch.branch, projectSlug);
      if (!previewSlug) continue;

      const hosts: string[] = [];
      for (const root of this.opts.rootDomains) {
        hosts.push(`${previewSlug}.${root}`);
        for (const alias of branch.subdomainAliases ?? []) {
          if (!alias) continue;
          hosts.push(`${alias}.${root}`);
        }
      }
      let aliasIdx = 0;
      for (const host of hosts) {
        records.push({
          _id: `${branch.id}:${aliasIdx++}`,
          host,
          upstreamHost: '127.0.0.1',
          upstreamPort: port,
          branchId: branch.id,
          weight: 100,
          healthState: 'running',
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return records;
  }

  private pickUpstreamPort(branch: BranchEntry): number | null {
    const running: ServiceState[] = [];
    for (const svc of Object.values(branch.services ?? {})) {
      if (svc.status === 'running') running.push(svc);
    }
    if (running.length === 0) return null;
    return running[0].hostPort;
  }

  private writeAtomic(target: string, content: string): void {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
  }
}
