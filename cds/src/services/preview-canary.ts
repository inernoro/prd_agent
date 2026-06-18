import { cdsEventsBus } from './cds-events-bus.js';

export interface PreviewCanaryTarget {
  url: string;
  label?: string;
}

export interface PreviewCanaryResult {
  url: string;
  label: string;
  ok: boolean;
  status: number;
  durationMs: number;
  bodyBytes: number;
  requestId?: string;
  error?: string;
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
}

export interface PreviewCanaryAlert {
  failures: number;
  total: number;
  failureRatio: number;
  results: PreviewCanaryResult[];
}

export class PreviewCanaryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetch;

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
    const sampleLimit = Math.max(1, this.opts.sampleLimit ?? 3);
    const targets = this.uniqueTargets(this.opts.getTargets()).slice(0, sampleLimit);
    if (!targets.length) return [];

    const results = await Promise.all(targets.map((target) => this.probe(target)));
    const failures = results.filter((r) => !r.ok).length;
    const failureRatio = failures / results.length;
    const minFailures = Math.max(1, this.opts.minFailuresToAlert ?? 1);
    const maxRatio = Math.max(0, this.opts.maxFailureRatio ?? 0);
    if (failures >= minFailures && failureRatio > maxRatio) {
      const payload: PreviewCanaryAlert = {
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

  private async probe(target: PreviewCanaryTarget): Promise<PreviewCanaryResult> {
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
      const requestId = res.headers.get('x-cds-request-id') || undefined;
      const bodyBytes = body.byteLength;
      const ok = status >= 200 && status < 400 && bodyBytes > 0;
      return {
        url: target.url,
        label: target.label || target.url,
        ok,
        status,
        durationMs: Date.now() - started,
        bodyBytes,
        requestId,
        ...(ok ? {} : { error: status >= 400 ? `HTTP ${status}` : 'empty body' }),
      };
    } catch (err) {
      return {
        url: target.url,
        label: target.label || target.url,
        ok: false,
        status: 0,
        durationMs: Date.now() - started,
        bodyBytes: 0,
        error: (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
