import { createHash, randomUUID } from 'node:crypto';
import { cdsEventsBus } from './cds-events-bus.js';

export interface PreviewCanaryTarget {
  url: string;
  label?: string;
}

export interface PreviewCanaryResult {
  probeId: string;
  runId: string;
  url: string;
  label: string;
  ok: boolean;
  status: number;
  durationMs: number;
  bodyBytes: number;
  consecutiveFailures: number;
  suspectedLayer?: PreviewCanaryLayer;
  failureKind?: PreviewCanaryFailureKind;
  headers?: PreviewCanaryHeaders;
  bodySha256?: string;
  requestId?: string;
  error?: string;
}

export type PreviewCanaryLayer = 'network' | 'edge-or-nginx' | 'forwarder' | 'branch-app' | 'unknown';

export type PreviewCanaryFailureKind =
  | 'timeout'
  | 'network-error'
  | 'http-error'
  | 'empty-body'
  | 'empty-edge-400'
  | 'empty-success';

export interface PreviewCanaryHeaders {
  contentType?: string;
  server?: string;
  via?: string;
  cfRay?: string;
  cdsRequestId?: string;
  cdsUpstream?: string;
  cdsBranch?: string;
  cdsRouteId?: string;
}

export interface PreviewCanaryOptions {
  getTargets: () => PreviewCanaryTarget[];
  intervalMs?: number;
  timeoutMs?: number;
  sampleLimit?: number;
  maxFailureRatio?: number;
  minFailuresToAlert?: number;
  fetchImpl?: typeof fetch;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  onAlert?: (payload: PreviewCanaryAlert) => void;
  onRecovery?: (payload: PreviewCanaryRecovery) => void;
}

export interface PreviewCanaryAlert {
  runId: string;
  failures: number;
  total: number;
  failureRatio: number;
  results: PreviewCanaryResult[];
}

export interface PreviewCanaryRecovery {
  runId: string;
  recovered: PreviewCanaryResult[];
}

export class PreviewCanaryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly targetState = new Map<string, { consecutiveFailures: number; wasFailing: boolean }>();

  constructor(private readonly opts: PreviewCanaryOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(): void {
    void this.runOnce();
    const intervalMs = Math.max(5_000, this.opts.intervalMs ?? 30_000);
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<PreviewCanaryResult[]> {
    const runId = randomUUID();
    const sampleLimit = Math.max(1, this.opts.sampleLimit ?? 3);
    const targets = this.uniqueTargets(this.opts.getTargets()).slice(0, sampleLimit);
    if (!targets.length) return [];

    const results = await Promise.all(targets.map((target) => this.probe(target, runId)));
    const recovered = results.filter((r) => r.ok && (this.targetState.get(r.url)?.wasFailing ?? false));
    for (const result of results) {
      this.targetState.set(result.url, {
        consecutiveFailures: result.ok ? 0 : result.consecutiveFailures,
        wasFailing: !result.ok,
      });
    }
    if (recovered.length) {
      const payload: PreviewCanaryRecovery = { runId, recovered };
      this.opts.logger?.info?.(
        `[preview-canary] ${recovered.length}/${results.length} preview probe(s) recovered`,
      );
      cdsEventsBus.publish('preview.canary.recovered', payload);
      this.opts.onRecovery?.(payload);
    }
    const failures = results.filter((r) => !r.ok).length;
    const failureRatio = failures / results.length;
    const minFailures = Math.max(1, this.opts.minFailuresToAlert ?? 1);
    const maxRatio = Math.max(0, this.opts.maxFailureRatio ?? 0);
    if (failures >= minFailures && failureRatio > maxRatio) {
      const payload: PreviewCanaryAlert = {
        runId,
        failures,
        total: results.length,
        failureRatio,
        results,
      };
      this.opts.logger?.warn?.(
        `[preview-canary] ${failures}/${results.length} preview probe(s) failed`,
      );
      cdsEventsBus.publish('preview.canary.alert', payload);
      this.opts.onAlert?.(payload);
    }
    return results;
  }

  private uniqueTargets(targets: PreviewCanaryTarget[]): PreviewCanaryTarget[] {
    const seen = new Set<string>();
    const out: PreviewCanaryTarget[] = [];
    for (const target of targets) {
      const url = target.url.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ ...target, url });
    }
    return out;
  }

  private async probe(target: PreviewCanaryTarget, runId: string): Promise<PreviewCanaryResult> {
    const probeId = randomUUID();
    const started = Date.now();
    const timeoutMs = Math.max(1_000, this.opts.timeoutMs ?? 8_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const res = await this.fetchImpl(target.url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'CDS-Preview-Canary/1.0',
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        },
      });
      const body = Buffer.from(await res.arrayBuffer());
      const status = res.status;
      const headers = this.extractHeaders(res.headers);
      const requestId = headers.cdsRequestId;
      const bodyBytes = body.byteLength;
      const ok = status >= 200 && status < 400 && bodyBytes > 0;
      const failureKind = ok ? undefined : this.classifyFailureKind(status, bodyBytes);
      const suspectedLayer = ok ? undefined : this.classifyLayer(status, bodyBytes, headers);
      const previousFailures = this.targetState.get(target.url)?.consecutiveFailures ?? 0;
      return {
        probeId,
        runId,
        url: target.url,
        label: target.label || target.url,
        ok,
        status,
        durationMs: Date.now() - started,
        bodyBytes,
        consecutiveFailures: ok ? 0 : previousFailures + 1,
        headers,
        ...(bodyBytes > 0 ? { bodySha256: createHash('sha256').update(body).digest('hex') } : {}),
        ...(failureKind ? { failureKind } : {}),
        ...(suspectedLayer ? { suspectedLayer } : {}),
        requestId,
        ...(ok ? {} : { error: status >= 400 ? `HTTP ${status}` : 'empty body' }),
      };
    } catch (err) {
      const isTimeout = (err as Error).name === 'AbortError';
      const previousFailures = this.targetState.get(target.url)?.consecutiveFailures ?? 0;
      return {
        probeId,
        runId,
        url: target.url,
        label: target.label || target.url,
        ok: false,
        status: 0,
        durationMs: Date.now() - started,
        bodyBytes: 0,
        consecutiveFailures: previousFailures + 1,
        failureKind: isTimeout ? 'timeout' : 'network-error',
        suspectedLayer: 'network',
        error: isTimeout ? 'timeout' : (err as Error).message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractHeaders(headers: Headers): PreviewCanaryHeaders {
    return {
      contentType: headers.get('content-type') || undefined,
      server: headers.get('server') || undefined,
      via: headers.get('via') || undefined,
      cfRay: headers.get('cf-ray') || undefined,
      cdsRequestId: headers.get('x-cds-request-id') || undefined,
      cdsUpstream: headers.get('x-cds-upstream') || undefined,
      cdsBranch: headers.get('x-cds-branch') || undefined,
      cdsRouteId: headers.get('x-cds-route-id') || undefined,
    };
  }

  private classifyFailureKind(status: number, bodyBytes: number): PreviewCanaryFailureKind {
    if (status === 400 && bodyBytes === 0) return 'empty-edge-400';
    if (status >= 400) return 'http-error';
    if (status >= 200 && status < 400 && bodyBytes === 0) return 'empty-success';
    return 'empty-body';
  }

  private classifyLayer(status: number, bodyBytes: number, headers: PreviewCanaryHeaders): PreviewCanaryLayer {
    if (!headers.cdsRequestId && status === 400 && bodyBytes === 0) return 'edge-or-nginx';
    if (headers.cdsUpstream) return 'forwarder';
    if (headers.cdsRequestId) return 'branch-app';
    return 'unknown';
  }
}
