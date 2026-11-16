import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import type { DtsEngineBinding } from '../shared/dts.js';
import { SEATUNNEL_VERSION } from '../shared/dts.js';
import { createExternalResponseAudit } from './standby-response-audit.js';
import { DtsError, dtsReject } from './dts-policy.js';

export function parseDtsEngine(projectId: string, value: unknown): DtsEngineBinding {
  const v = value as DtsEngineBinding;
  let url: URL;
  try { url = new URL(v.baseUrl); } catch { return dtsReject('invalid_engine', '请选择有效的传输服务地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || v.version !== SEATUNNEL_VERSION || !/^[A-Z][A-Z0-9_]{0,127}$/.test(v.usernameEnv) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(v.passwordEnv)) {
    dtsReject('invalid_engine', '请使用已验证版本的传输服务及已有服务账号配置');
  }
  return { projectId, baseUrl: url.href.replace(/\/$/, ''), version: SEATUNNEL_VERSION, usernameEnv: v.usernameEnv, passwordEnv: v.passwordEnv };
}

export class DtsSeaTunnel {
  constructor(private readonly state: StateService, private readonly sink: ServerEventLogSink | undefined | null) {}
  async call(binding: DtsEngineBinding, operation: 'overview' | 'submit' | 'status' | 'stop', jobId?: string, body?: unknown, requestId?: string): Promise<Record<string, unknown>> {
    const env = this.state.getCustomEnv(binding.projectId);
    const username = env[binding.usernameEnv], password = env[binding.passwordEnv];
    if (!username || !password) dtsReject('engine_account_unavailable', '传输服务账号尚未配置，请联系管理员', 503);
    if (jobId && (!/^[0-9]{1,16}$/.test(jobId) || !Number.isSafeInteger(Number(jobId)))) dtsReject('invalid_job', '同步任务编号无效');
    const route = operation === 'overview' ? '/overview' : operation === 'status' ? `/job-info/${jobId}`
      : operation === 'stop' ? '/stop-job' : `/submit-job?jobId=${jobId}&jobName=${encodeURIComponent('cds-dts-' + (requestId || jobId))}`;
    const method = operation === 'submit' || operation === 'stop' ? 'POST' : 'GET';
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const audit = createExternalResponseAudit(this.sink, { projectId: binding.projectId, remoteProjectId: binding.projectId,
      policy: 'dts-seatunnel', dryRun: operation === 'overview', businessRequestId: requestId },
      { source: 'dts', action: 'dts.engine.response', message: '数据传输服务响应' });
    audit.assertAvailable();
    const started = Date.now(); let response: Response | undefined, raw = '', parsed: Record<string, unknown> | undefined, parseState = 'no-response';
    let decision = 'network-error';
    const endpoint = binding.baseUrl + route;
    const requestBody = operation === 'stop' ? { jobId: Number(jobId), isStopWithSavePoint: false, force: false } : body;
    try {
      response = await fetch(endpoint, { method, redirect: 'error', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody), signal: AbortSignal.timeout(20_000) });
      parseState = 'body-read-failed';
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
        if (size > 1024 * 1024) { await reader.cancel(); dtsReject('engine_response_too_large', '传输服务返回内容超过容量限制，请查看任务诊断', 502); }
        chunks.push(next.value); }
      raw = Buffer.concat(chunks).toString('utf8'); parseState = 'invalid-json';
      const result: unknown = JSON.parse(raw); parseState = 'json';
      if (!result || typeof result !== 'object' || Array.isArray(result)) dtsReject('invalid_engine_response', '传输服务返回格式不兼容，请核对服务版本', 502);
      parsed = result as Record<string, unknown>;
      if (!response.ok || parsed.code === 'ERROR' || parsed.status === 'fail' || parsed.errorMsg || parsed.error) {
        decision = 'upstream-rejected'; dtsReject('engine_rejected', '传输服务未接受操作，请查看同步任务后再重试', 502);
      }
      if (operation === 'submit' && String(parsed.jobId) !== jobId) dtsReject('engine_job_mismatch', '传输服务返回了不同的任务编号，请核对任务状态', 502);
      if (operation === 'status' && (String(parsed.jobId) !== jobId || typeof parsed.jobStatus !== 'string' || (requestId && parsed.jobName !== 'cds-dts-' + requestId))) {
        dtsReject('engine_job_mismatch', '传输任务状态尚未核实，请稍后刷新', 502);
      }
      decision = 'success'; return parsed;
    } catch (e) {
      if (e instanceof DtsError) throw e;
      return dtsReject('engine_unavailable', '暂时无法确认传输服务状态，请稍后刷新，勿重复发起任务', 503);
    } finally {
      // Native job-info can contain the original credential-bearing job config. Audit only a safe projection.
      await audit.record({ peerId: 'seatunnel', url: endpoint, method, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
        timeoutMs: 20_000, responseReceived: Boolean(response), httpStatus: response?.status ?? null, contentType: response?.headers.get('content-type') ?? null,
        upstreamRequestId: response?.headers.get('x-request-id') ?? null, text: raw, json: { jobId: parsed?.jobId, status: parsed?.jobStatus ?? parsed?.status,
          code: parsed?.code, message: parsed?.message ?? parsed?.errorMsg ?? parsed?.error, decision }, parseState, localDecision: decision,
        secrets: [username, password, auth, ...Object.values(env).filter(v => typeof v === 'string' && v.length > 3)] });
    }
  }
}
