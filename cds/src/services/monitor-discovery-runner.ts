/**
 * 自发现的执行面：定时打一遍登记的端点，把它们自报的监控项对进台账。
 *
 * 判据全在 monitor-discovery（解析）与 monitor-reconcile（对账）两个纯函数里，
 * 这里只负责「什么时候打、打完写哪」，以及一件纯函数管不了的事：
 * **端点打不通与端点说「我一条都不报」必须传成两个不同的值**。
 * 混成一个空数组，一次网络抖动就会把一整个项目的监控删干净。
 */

import crypto from 'node:crypto';

import type { Project, UptimeCustomMonitor } from '../types.js';
import { discoverMonitors, type DiscoveryRejection } from './monitor-discovery.js';
import { reconcileDiscoveredMonitors } from './monitor-reconcile.js';

/** 端点自检响应最多读多少：够读完 checks，又不会被一个无限流吃光内存。 */
const BODY_LIMIT_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export interface EndpointProbeResult {
  url: string;
  /** undefined = 这一轮没读到（打不通 / 不是合法 JSON）。与「读到了但没有声明」不同。 */
  doc: unknown | undefined;
  err?: string;
}

export type EndpointFetcher = (url: string) => Promise<EndpointProbeResult>;

export const defaultEndpointFetcher: EndpointFetcher = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'manual',
      // 与其它自定义探测同款：探测令牌绝不发给外部地址。
      headers: { 'user-agent': 'cds-monitor-discovery', 'x-cds-poll': 'true', accept: 'application/health+json, application/json' },
    });
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => undefined);
      return { url, doc: undefined, err: `自检端点返回 HTTP ${res.status}` };
    }
    const reader = res.body?.getReader();
    if (!reader) return { url, doc: undefined, err: '自检端点没有响应体' };
    const decoder = new TextDecoder();
    let text = '';
    let received = 0;
    try {
      while (received < BODY_LIMIT_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    try {
      return { url, doc: JSON.parse(text) };
    } catch {
      return { url, doc: undefined, err: '自检端点返回的不是合法 JSON' };
    }
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return {
      url,
      doc: undefined,
      err: aborted ? `自检端点超时（${FETCH_TIMEOUT_MS}ms）` : ((err as Error & { cause?: Error }).cause?.message || (err as Error).message),
    };
  }
};

export interface EndpointOutcome {
  url: string;
  /** true = 这一轮读到了它的声明 */
  reachable: boolean;
  err?: string;
  discovered: number;
  rejected: DiscoveryRejection[];
  added: number;
  updated: number;
  removed: number;
  /** true = 因为打不通，刻意一条都没下线 */
  heldBecauseUnreachable: boolean;
}

export interface DiscoveryRunSummary {
  at: string;
  endpoints: EndpointOutcome[];
}

export interface DiscoveryRunnerDeps {
  listProjects(): Project[];
  listUptimeMonitors(projectId?: string): UptimeCustomMonitor[];
  upsertUptimeMonitor(monitor: UptimeCustomMonitor): unknown;
  removeUptimeMonitor(id: string): unknown;
  fetchEndpoint?: EndpointFetcher;
  now?: () => Date;
  logger?: { warn?: (m: string) => void; info?: (m: string) => void };
}

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

/**
 * 跑一轮自发现。返回这一轮每个端点发生了什么——面板要照实展示，
 * 包括被拒的声明与原因：静默跳过等于那条监控凭空消失，没人会发现。
 */
export async function runMonitorDiscovery(deps: DiscoveryRunnerDeps): Promise<DiscoveryRunSummary> {
  const fetchEndpoint = deps.fetchEndpoint || defaultEndpointFetcher;
  const now = deps.now ? deps.now() : new Date();
  const endpoints: EndpointOutcome[] = [];

  for (const project of deps.listProjects()) {
    const urls = project.monitorEndpoints || [];
    if (urls.length === 0) continue;
    const mine = deps.listUptimeMonitors(project.id).filter((m) => m.origin === 'discovered');

    for (const url of urls) {
      const probe = await fetchEndpoint(url);
      const parsed = probe.doc === undefined ? undefined : discoverMonitors(probe.doc, url);
      const plan = reconcileDiscoveredMonitors({
        endpointUrl: url,
        projectId: project.id,
        discovered: parsed?.monitors,
        existing: mine.filter((m) => (m.discoveryKey || '').startsWith(`${url}#`)),
        hash: sha1,
        now: () => now.toISOString(),
      });

      const existingIds = new Set(mine.map((m) => m.id));
      let added = 0;
      let updated = 0;
      for (const monitor of plan.upsert) {
        if (existingIds.has(monitor.id)) updated += 1; else added += 1;
        deps.upsertUptimeMonitor(monitor);
      }
      for (const id of plan.remove) deps.removeUptimeMonitor(id);

      if (probe.err) deps.logger?.warn?.(`[discovery] ${url}: ${probe.err}`);
      else if (added || updated || plan.remove.length) {
        deps.logger?.info?.(`[discovery] ${url}: 新增 ${added} / 更新 ${updated} / 下线 ${plan.remove.length}`);
      }

      endpoints.push({
        url,
        reachable: probe.doc !== undefined,
        ...(probe.err ? { err: probe.err } : {}),
        discovered: parsed?.monitors.length ?? 0,
        rejected: parsed?.rejected ?? [],
        added,
        updated,
        removed: plan.remove.length,
        heldBecauseUnreachable: plan.heldBecauseUnreachable,
      });
    }
  }

  return { at: now.toISOString(), endpoints };
}
