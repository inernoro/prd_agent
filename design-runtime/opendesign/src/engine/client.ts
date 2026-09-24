// 驱动 OpenDesign daemon 的 HTTP 客户端。
// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts 的 odJson / waitForRun / cancelRun /
// waitForHealth / captureRunTranscriptDigest（第 1 阶段：只改归属、不改行为）。原来经 docker 网络访问
// 容器地址，现在访问同容器的 127.0.0.1；请求、判据与错误码逐字不变。
import { setTimeout as delay } from 'node:timers/promises';

import { redactDigestLeaves, summarizeRunEventStream } from '../diagnostics.js';
import { AgentWorkspaceRuntimeError, type StageReporter } from '../errors.js';
import { MAX_PACKAGE_OVERHEAD_BYTES, readResponseLimited } from '../workspace/transfer.js';

export interface OpenDesignRunOutcome {
  deliverableValid: boolean;
  deliverableValidation?: string;
  /** OpenDesign 自己认定的这一轮交付文件（相对工作区根）。见 DELIVERABLE_ENTRY_NOTE。 */
  deliverableEntryFile?: string;
}

export interface DaemonHealth {
  ok: boolean;
  version: string | null;
  /** 不健康时的原始观测（HTTP 状态或网络错误），给技术细节用。 */
  observation: string;
}

/** 一次性探测 daemon 的 /api/health。能力自检与任务起步都走它，判据只有这一份。 */
export async function probeDaemonHealth(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  timeoutMs = 3_000,
): Promise<DaemonHealth> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, version: null, observation: `HTTP ${response.status}` };
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      ok: body.ok !== false,
      version: typeof body.version === 'string' ? body.version : null,
      observation: `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, version: null, observation: error instanceof Error ? error.message : String(error) };
  }
}

export class OpenDesignClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly pollIntervalMs: number,
  ) {}

  async waitForHealth(timeoutSeconds: number): Promise<void> {
    const deadline = Date.now() + Math.min(Math.max(timeoutSeconds, 10), 180) * 1000;
    let last = 'connection pending';
    while (Date.now() < deadline) {
      const health = await probeDaemonHealth(this.fetchImpl, this.baseUrl, this.token);
      if (health.ok) return;
      last = health.observation;
      await delay(this.pollIntervalMs);
    }
    throw new AgentWorkspaceRuntimeError('open_design_not_ready', `OpenDesign health check timed out: ${last}`, true);
  }

  async odJson(
    apiPath: string,
    options: {
      method: 'GET' | 'POST';
      body?: Record<string, unknown>;
      signal?: AbortSignal;
      acceptedStatuses?: number[];
    },
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const bytes = await readResponseLimited(response, MAX_PACKAGE_OVERHEAD_BYTES);
    let body: Record<string, unknown> = {};
    try {
      body = bytes.length ? JSON.parse(bytes.toString('utf8')) as Record<string, unknown> : {};
    } catch {
      throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', `OpenDesign ${apiPath} returned invalid JSON`);
    }
    const accepted = options.acceptedStatuses || [200];
    if (!accepted.includes(response.status)) {
      const nestedError = body.error && typeof body.error === 'object'
        ? body.error as Record<string, unknown>
        : null;
      const message = typeof nestedError?.message === 'string'
        ? nestedError.message
        : typeof body.message === 'string'
          ? body.message
          : `OpenDesign ${apiPath} failed with status ${response.status}`;
      throw new AgentWorkspaceRuntimeError(
        'open_design_request_failed',
        message,
        response.status >= 500,
        { status: response.status, upstreamCode: nestedError?.code || null },
      );
    }
    return body;
  }

  async cancelRun(runId: string): Promise<void> {
    await this.odJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: {},
      signal: AbortSignal.timeout(3_000),
      acceptedStatuses: [200, 202, 404, 409],
    }).catch(() => undefined);
  }

  async waitForRun(
    runId: string,
    deadline: number,
    signal: AbortSignal | undefined,
    onStage: StageReporter,
    onPoll?: () => Promise<void>,
  ): Promise<OpenDesignRunOutcome> {
    const startedAt = Date.now();
    let lastStatus = '';
    let lastProgressAt = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancelRun(runId);
        throw new AgentWorkspaceRuntimeError('open_design_run_cancelled', 'OpenDesign run was cancelled');
      }
      const deadlineSignal = signalForDeadline(deadline, signal);
      let status: Record<string, unknown>;
      try {
        status = await this.odJson(`/api/runs/${encodeURIComponent(runId)}`, {
          method: 'GET',
          signal: deadlineSignal,
        });
      } catch (error) {
        if (signal?.aborted) {
          await this.cancelRun(runId);
          throw new AgentWorkspaceRuntimeError('open_design_run_cancelled', 'OpenDesign run was cancelled');
        }
        if (deadlineSignal.aborted || Date.now() >= deadline) {
          await this.cancelRun(runId);
          throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
        }
        throw error;
      }
      const value = typeof status.status === 'string' ? status.status : '';
      const now = Date.now();
      if (value && (value !== lastStatus || now - lastProgressAt >= 3_000)) {
        lastStatus = value;
        lastProgressAt = now;
        onStage('open_design_running', {
          status: value,
          runId,
          elapsedSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
        });
      }
      if (onPoll) await onPoll();
      if (value === 'succeeded') {
        return {
          deliverableValid: status.deliverableValid !== false,
          deliverableValidation: typeof status.deliverableValidation === 'string'
            ? status.deliverableValidation
            : undefined,
          deliverableEntryFile: typeof status.deliverableEntryFile === 'string'
            ? status.deliverableEntryFile
            : undefined,
        };
      }
      if (value === 'failed' || value === 'canceled') {
        throw new AgentWorkspaceRuntimeError(
          value === 'failed' ? 'open_design_run_failed' : 'open_design_run_cancelled',
          typeof status.error === 'string' ? status.error : `OpenDesign run ended with status ${value}`,
        );
      }
      await delay(this.pollIntervalMs, undefined, { signal: deadlineSignal }).catch((error) => {
        if (deadlineSignal.aborted) return;
        throw error;
      });
    }
    await this.cancelRun(runId);
    throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
  }

  /**
   * 失败取证用：把这一轮 OpenDesign run 的事件流拉回来压成一份有界摘要。
   * 这是整条链路缺了很久的第一手记录——「模型这 15 分钟到底干了什么、说了什么、
   * 调了哪些工具、写了哪些路径」。没有它，每次失败都只能猜（2026-09-20 连猜了四次）。
   *
   * 取证失败绝不顶替原始故障：拿不到就返回 `{ available: false, reason }`。
   * 内容先过 runtimeDiagnosticPreview（去掉 daemon 令牌、脱敏、截断）。
   */
  async captureRunTranscriptDigest(runIds: string[], remainingMs: () => number): Promise<Record<string, unknown>> {
    try {
      const digests: Record<string, unknown>[] = [];
      for (const runId of [...new Set(runIds.filter(Boolean))].slice(0, 3)) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            Math.max(3_000, Math.min(remainingMs(), 20_000)),
          );
          let raw = '';
          try {
            const response = await this.fetchImpl(
              `${this.baseUrl}/api/runs/${encodeURIComponent(runId)}/events`,
              { headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal: controller.signal },
            );
            if (response.status !== 200) {
              digests.push({ runId, available: false, reason: `HTTP ${response.status}` });
              continue;
            }
            raw = (await readResponseLimited(response, MAX_PACKAGE_OVERHEAD_BYTES)).toString('utf8');
          } finally {
            clearTimeout(timer);
          }
          digests.push({ runId, available: true, ...summarizeRunEventStream(raw) });
        } catch (error) {
          digests.push({
            runId,
            available: false,
            reason: error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'fetch failed',
          });
        }
      }
      return { runs: redactDigestLeaves(digests, [this.token]) as unknown[] };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'capture failed',
      };
    }
  }
}

export function signalForDeadline(deadline: number, signal?: AbortSignal): AbortSignal {
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  return signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
}
