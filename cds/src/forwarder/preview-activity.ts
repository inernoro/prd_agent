import http from 'node:http';
import { createHash } from 'node:crypto';
import { PROBE_MARKER_HEADER } from '../services/probe-marker.js';

const MAX_BRANCHES = 1024;
const MAX_MARKERS_PER_BRANCH = 8;
const MARKER_SHAPE = /^[a-f0-9]{48}$/;
const FINGERPRINT_SHAPE = /^[a-f0-9]{64}$/;

interface BranchActivity {
  branchId: string;
  userAt?: number;
  markers: Array<{ fingerprint: string; at: number }>;
  markerOverflowAt?: number;
}

export interface PreviewActivitySnapshot {
  version: 1;
  startedAt: number;
  generatedAt: number;
  overflowAt?: number;
  branches: BranchActivity[];
}

export type PreviewActivityUnknownReason = 'read-failed' | 'invalid-receipt' | 'overflow' | 'historical-marker';

/** 每分支合并时间，不保存 URL、原始令牌或请求体；数据面只做本地内存写。 */
export class PreviewActivityCollector {
  private readonly startedAt: number;
  private readonly branches = new Map<string, BranchActivity>();
  private readonly omittedBranches = new Map<string, number>();
  private unattributedOverflowAt?: number;

  constructor(private readonly now: () => number = Date.now) { this.startedAt = now(); }

  record(branchId: string | undefined, headers: http.IncomingHttpHeaders): void {
    if (!branchId) return; // master passthrough / 未命中分支路由不是预览业务访问。
    const at = this.now();
    let branch = this.branches.get(branchId);
    if (!branch) {
      if (this.branches.size >= MAX_BRANCHES || branchId.length > 512) {
        if (this.omittedBranches.has(branchId) || this.omittedBranches.size < MAX_BRANCHES) this.omittedBranches.set(branchId, at);
        else this.unattributedOverflowAt = at;
        return;
      }
      branch = { branchId, markers: [] };
      this.branches.set(branchId, branch);
    }
    const raw = headers[PROBE_MARKER_HEADER];
    const marker = Array.isArray(raw) ? raw[0] : raw;
    if (typeof marker !== 'string' || !MARKER_SHAPE.test(marker)) {
      branch.userAt = Math.max(branch.userAt ?? 0, at);
      // 后来的明确用户时间覆盖了早先丢失观察可能代表的最晚用户时间。
      if (branch.userAt >= (this.omittedBranches.get(branchId) ?? Infinity)) this.omittedBranches.delete(branchId);
      if (branch.userAt >= (branch.markerOverflowAt ?? Infinity)) branch.markerOverflowAt = undefined;
      return;
    }
    // forwarder 不掌握 master 的探针身份，只上报不可回放的指纹供原进程核验。
    const fingerprint = createHash('sha256').update(marker).digest('hex');
    const previous = branch.markers.find(item => item.fingerprint === fingerprint);
    if (previous) previous.at = Math.max(previous.at, at);
    else if (branch.markers.length < MAX_MARKERS_PER_BRANCH) branch.markers.push({ fingerprint, at });
    else {
      // 原 master 只排除一个本代指纹；最近两个不同指纹已保住最大非探针时间。
      // 原容量八项保留最近观察，不能因公开 marker 更换制造全局覆盖丢失。
      const oldest = branch.markers.reduce((left, right) => right.at < left.at ? right : left);
      if (at >= oldest.at) branch.markers[branch.markers.indexOf(oldest)] = { fingerprint, at };
    }
  }

  /** 只由可信路由表更新调用；读取失败、未知路由或时间到期都不是退出证明。 */
  retainBranches(active: ReadonlySet<string>): void {
    for (const id of this.branches.keys()) if (!active.has(id)) this.branches.delete(id);
    for (const id of this.omittedBranches.keys()) if (!active.has(id)) this.omittedBranches.delete(id);
    if (active.size === 0) this.unattributedOverflowAt = undefined;
  }

  snapshot(): PreviewActivitySnapshot {
    const overflowAt = Math.max(this.unattributedOverflowAt ?? 0, ...this.omittedBranches.values()) || undefined;
    return { version: 1, startedAt: this.startedAt, generatedAt: this.now(), overflowAt,
      branches: [...this.branches.values()].map(branch => ({ ...branch,
        markers: branch.markers.map(marker => ({ ...marker })) })) };
  }
}

/** 与既有诊断入口同门：不信任 XFF，也不允许 nginx 转来的公网预览 Host。 */
export function isPrivateForwarderDiagnostic(req: http.IncomingMessage): boolean {
  return /^(127\.|::1$|::ffff:127\.)/.test(req.socket?.remoteAddress ?? '')
    && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host ?? '');
}

/** 原回环 GET 只请求有限活动投影；旧 forwarder 忽略 query 时仍受相同体积和时限约束。 */
export function readForwarderPreviewActivity(port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      reject(new Error('预览活动诊断端口无效'));
      return;
    }
    const req = http.get({ host: '127.0.0.1', port, path: '/__forwarder/stats?view=preview-activity' }, res => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) req.destroy(new Error('预览活动收据过大'));
        else chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('预览活动收据中断')));
      res.once('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error();
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).previewActivity);
        } catch { reject(new Error('预览活动收据无效')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('预览活动收据读取超时')), 1000);
    timer.unref();
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
  });
}

export function resolvePreviewActivity(value: unknown, now: number, masterStartedAt: number,
  isProbe: (fingerprint: string) => boolean, historicalBoundarySettled = false):
  { observations: Array<{ branchId: string; at: number }>; unknown: boolean; reason?: PreviewActivityUnknownReason } {
  const invalid = () => ({ observations: [], unknown: true, reason: 'invalid-receipt' as const });
  if (!value || typeof value !== 'object') return invalid();
  const snapshot = value as PreviewActivitySnapshot;
  const time = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at)
    && at >= snapshot.startedAt && at <= snapshot.generatedAt;
  if (snapshot.version !== 1 || !Number.isFinite(snapshot.startedAt) || snapshot.startedAt <= 0
    || !Number.isFinite(snapshot.generatedAt) || snapshot.generatedAt < snapshot.startedAt
    || snapshot.generatedAt > now || now - snapshot.generatedAt > 30_000
    || !Array.isArray(snapshot.branches) || snapshot.branches.length > MAX_BRANCHES
    || (snapshot.overflowAt !== undefined && !time(snapshot.overflowAt))) return invalid();
  const observations: Array<{ branchId: string; at: number }> = [];
  let unknown = snapshot.overflowAt !== undefined;
  let reason: PreviewActivityUnknownReason | undefined = unknown ? 'overflow' : undefined;
  for (const branch of snapshot.branches) {
    if (!branch || typeof branch.branchId !== 'string' || !branch.branchId || branch.branchId.length > 512
      || !Array.isArray(branch.markers) || branch.markers.length > MAX_MARKERS_PER_BRANCH
      || (branch.userAt !== undefined && !time(branch.userAt))
      || (branch.markerOverflowAt !== undefined && !time(branch.markerOverflowAt))) return invalid();
    let at = branch.userAt ?? 0;
    if (branch.markerOverflowAt !== undefined && branch.markerOverflowAt > at
      && (branch.markerOverflowAt >= masterStartedAt || !historicalBoundarySettled)) {
      unknown = true;
      reason ??= branch.markerOverflowAt >= masterStartedAt ? 'overflow' : 'historical-marker';
    }
    for (const marker of branch.markers) {
      if (!marker || typeof marker.fingerprint !== 'string' || !FINGERPRINT_SHAPE.test(marker.fingerprint)
        || !time(marker.at)) return invalid();
      if (isProbe(marker.fingerprint)) continue;
      if (marker.at < masterStartedAt) {
        if (!historicalBoundarySettled) { unknown = true; reason ??= 'historical-marker'; }
      }
      else at = Math.max(at, marker.at); // 本代不匹配的公开伪令牌仍按原代理 SSOT 算用户。
    }
    if (at > 0) observations.push({ branchId: branch.branchId, at });
  }
  return { observations, unknown, ...(reason ? { reason } : {}) };
}
