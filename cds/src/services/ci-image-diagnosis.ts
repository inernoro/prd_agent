import { load } from 'js-yaml';
import { createHash, randomUUID } from 'node:crypto';
import type { BranchEntry, CiImageDiagnosis } from '../types.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

type Run = { id: number; name?: string; path?: string; head_sha: string; head_branch: string; status: string; conclusion: string | null };
export interface CiDiagnosisInput {
  repository: string;
  branch: string;
  targetSha: string;
  projectId: string;
  branchId: string;
  authorization: string | (() => Promise<string>);
  waitedMs: number;
  timeoutMs: number;
  audit: ServerEventLogSink;
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestId?: string;
}
export type CiDiagnosisPatch = Pick<BranchEntry, 'ciImageStatus' | 'ciWorkflowConclusion' | 'ciWorkflowRunUrl' | 'ciImageError' | 'ciDiagnosis'>;

export function ciDiagnosisSnapshot(branch: BranchEntry): string {
  return JSON.stringify([branch.projectId, branch.branch, branch.ciTargetSha, branch.githubCommitSha,
    branch.ciImageStatus, branch.ciWaitingSince, branch.ciWorkflowConclusion, branch.ciWorkflowRunUrl]);
}

async function persistAudit(input: CiDiagnosisInput, event: Parameters<ServerEventLogSink['record']>[0]): Promise<void> {
  try {
    if (input.audit.recordImmediate) await input.audit.recordImmediate(event);
    else { input.audit.record(event); await input.audit.flush?.(); }
  } catch {
    console.warn('[ci-image-diagnosis] 审计写入失败，本轮证据不完整');
    throw new Error('ci-diagnosis-audit-unavailable');
  }
}

/** 只读对账；成功回执不代替镜像存在性与部署准入检查。 */
export async function diagnoseCiImage(input: CiDiagnosisInput): Promise<CiDiagnosisPatch> {
  const requestId = input.requestId || randomUUID();
  const patch = await readCiImageDiagnosis({ ...input, requestId });
  const event = { category: 'system' as const, severity: 'info' as const,
    source: 'ci-image-diagnosis', action: 'github.ci-diagnosis.result', requestId,
    projectId: input.projectId, branchId: input.branchId, commitSha: input.targetSha,
    details: { diagnosis: patch.ciDiagnosis, conclusion: patch.ciWorkflowConclusion,
      recovery: 'diagnosis-only; image admission and deployment remain separate' } };
  await persistAudit(input, event);
  return patch;
}

async function readCiImageDiagnosis(input: CiDiagnosisInput): Promise<CiDiagnosisPatch> {
  const now = input.now || Date.now;
  const requestId = input.requestId!;
  const root = `https://api.github.com/repos/${input.repository}`;
  const actionsUrl = `https://github.com/${input.repository}/actions?query=${encodeURIComponent(`branch:${input.branch}`)}`;
  const workflowUrl = `https://github.com/${input.repository}/blob/${input.targetSha}/.github/workflows/branch-image.yml`;
  let runUrl = '';
  const result = (code: CiImageDiagnosis['code'], title: string, message: string, conclusion = '', waiting = false,
    actionUrl = runUrl || actionsUrl, actionLabel = runUrl ? '查看构建' : '查看 Actions'): CiDiagnosisPatch => ({
    ciImageStatus: waiting ? 'waiting' : 'failed',
    ciWorkflowConclusion: conclusion,
    ciWorkflowRunUrl: runUrl,
    ciImageError: message,
    ciDiagnosis: { code, title, message, targetSha: input.targetSha, checkedAt: new Date(now()).toISOString(), actionUrl, actionLabel },
  });
  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const started = now();
    let status: number | undefined;
    let snapshot: unknown = null;
    let parse = 'no-response';
    let phase = 'authorization';
    let contentType: string | null = null;
    let upstreamRequestId: string | null = null;
    try {
      const authorization = typeof input.authorization === 'function' ? await input.authorization() : input.authorization;
      phase = 'request';
      const response = await (input.fetchImpl || fetch)(root + path, {
        headers: { Authorization: authorization, Accept: 'application/vnd.github+json', 'User-Agent': 'CDS-CI-Diagnosis' },
        signal: AbortSignal.timeout(8_000), redirect: 'error',
      });
      status = response.status;
      contentType = response.headers.get('content-type');
      upstreamRequestId = response.headers.get('x-github-request-id');
      parse = 'reading-body';
      // 响应流有硬上限，避免大型仓库列表或异常正文耗尽内存。
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 1024 * 1024) {
              snapshot = { responseBytes: size, truncated: true, omitted: 'response exceeds 1 MiB limit' };
              await reader.cancel(); throw new Error('response-too-large');
            }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      snapshot = { responseBytes: size, sha256: createHash('sha256').update(text).digest('hex'),
        omitted: 'unparsed response body' };
      parse = 'invalid-json';
      const body = text ? JSON.parse(text) : null;
      parse = 'parsed';
      // 仅保存本次判定需要的字段，源码、日志正文、凭据和个人信息不入审计。
      const rows = body?.workflow_runs || body?.jobs || (Array.isArray(body) ? body : []);
      snapshot = {
        status, upstreamMessage: status >= 400 ? String(body?.message || '').slice(0, 300) : undefined,
        totalCount: body?.total_count, type: body?.type, encoding: body?.encoding,
        sourceBytes: typeof body?.content === 'string' ? body.content.length : undefined,
        items: rows.slice(0, 100).map((x: any) => ({ id: x.id, name: x.name, path: x.path, headSha: x.head_sha,
          headBranch: x.head_branch, status: x.status, conclusion: x.conclusion,
          cancellation: typeof x.message === 'string' ? /^The run was canceled by @[A-Za-z0-9-]+\.$/.exec(x.message)?.[0] : undefined })),
        omitted: 'workflow source, build logs and unrelated response fields', responseBytes: size,
      };
      return { status, body };
    } finally {
      const event = { category: 'system' as const, severity: (status && status < 400 && parse === 'parsed' ? 'info' : 'warn') as 'info' | 'warn',
        source: 'ci-image-diagnosis', action: 'github.ci-diagnosis.response', requestId,
        projectId: input.projectId, branchId: input.branchId, commitSha: input.targetSha,
        details: { method: 'GET', path, startedAt: new Date(started).toISOString(), durationMs: now() - started,
          status: status ?? null, contentType, upstreamRequestId, phase, parse, snapshot, timeoutMs: 8_000, maxResponseBytes: 1024 * 1024 } };
      await persistAudit(input, event);
    }
  };
  try {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || !/^[a-f0-9]{40}$/i.test(input.targetSha)) throw new Error('invalid-target');
    const query = new URLSearchParams({ branch: input.branch, head_sha: input.targetSha, per_page: '100' });
    const listed = await get(`/actions/runs?${query}`);
    if (listed.status !== 200 || !Array.isArray(listed.body?.workflow_runs)) throw new Error('runs-unavailable');
    const runs = (listed.body.workflow_runs as Run[]).filter(r => Number.isSafeInteger(r.id) && r.id > 0
      && r.head_branch === input.branch && r.head_sha === input.targetSha);
    const imageRuns = runs.filter(r => (r.path || '').split('@')[0] === '.github/workflows/branch-image.yml');
    const run = imageRuns.sort((a, b) => b.id - a.id)[0];
    if (run) {
      runUrl = `https://github.com/${input.repository}/actions/runs/${run.id}`;
      if (run.status !== 'completed') {
        return run.status === 'in_progress'
          ? result('building', 'CI 正在构建', '镜像正在构建，完成后自动部署。', '', true)
          : result('queued', 'CI 等待执行', '构建正在排队或等待批准，请查看构建运行记录。', '', true);
      }
      if (run.conclusion === 'cancelled') {
        let cancelledBy = '';
        try {
          const jobs = await get(`/actions/runs/${run.id}/jobs?per_page=100`);
          for (const job of (jobs.body?.jobs || []).filter((j: any) => j.conclusion === 'cancelled').slice(0, 3)) {
            if (!Number.isSafeInteger(job.id)) continue;
            const annotations = await get(`/check-runs/${job.id}/annotations?per_page=100`);
            if (annotations.status !== 200 || !Array.isArray(annotations.body)) continue;
            for (const annotation of annotations.body) {
              const match = /^The run was canceled by @([A-Za-z0-9-]+)\.$/.exec(annotation.message || '');
              if (match) { cancelledBy = match[1]; break; }
            }
            if (cancelledBy) break;
          }
        } catch { /* 归因查询失败仍保留已确认的 cancelled 终态。 */ }
        return result('cancelled', 'CI 已取消', `${cancelledBy ? `构建被 @${cancelledBy} 身份取消。` : '构建已取消，取消来源尚未确认。'}确认仍需预览后重新运行镜像构建。`, 'cancelled');
      }
      if (run.conclusion === 'success') return result('result_unsynced', 'CI 结果待同步', '镜像工作流已成功，但 CDS 尚未确认镜像可用。请重新认领该提交的镜像后部署。', 'success');
      if (run.conclusion === 'timed_out') return result('build_timed_out', 'CI 构建超时', 'GitHub 已终止超时构建，请查看耗时步骤后重试。', 'timed_out');
      if (run.conclusion === 'startup_failure') return result('startup_failed', 'CI 启动失败', '工作流在启动阶段失败，请查看 GitHub 运行页的诊断。', 'startup_failure');
      return result('build_failed', 'CI 构建未成功', '镜像构建未成功，请查看失败步骤后重试。', run.conclusion || 'unknown');
    }
    // 启动失败可能只有 BuildFailed 记录，没有工作流名、正常路径或任何 job。
    const startup = runs.find(r => r.conclusion === 'startup_failure' && r.path === 'BuildFailed');
    if (startup) {
      runUrl = `https://github.com/${input.repository}/actions/runs/${startup.id}`;
      return result('startup_failed', 'CI 启动失败', '该提交的 push 工作流未能启动，尚未产生镜像构建回执。请查看 GitHub 启动诊断。', 'startup_failure');
    }
    const file = await get(`/contents/.github/workflows/branch-image.yml?ref=${input.targetSha}`);
    if (file.status === 404) return result('workflow_missing', '未配置镜像构建', '该提交缺少镜像工作流，请补齐配置后重新推送。', 'workflow_missing', false, workflowUrl, '查看工作流');
    if (file.status !== 200 || file.body?.encoding !== 'base64' || typeof file.body.content !== 'string') throw new Error('workflow-unavailable');
    let workflow: any;
    try { workflow = load(Buffer.from(file.body.content, 'base64').toString('utf8')); }
    catch { return result('startup_failed', '工作流配置无效', '镜像工作流无法解析，请修正配置后重新推送。', 'startup_failure', false, workflowUrl, '查看工作流'); }
    const triggers = workflow?.on;
    const hasPush = typeof triggers === 'string' ? triggers === 'push'
      : Array.isArray(triggers) ? triggers.includes('push')
        : triggers && typeof triggers === 'object' && Object.hasOwn(triggers, 'push');
    if (!hasPush) return result('not_triggered', '镜像构建未触发', '该提交的镜像工作流未配置 push 触发。若为仅验证分支，无需等待镜像；需要预览时恢复有效镜像构建配置。', 'not_triggered', false, workflowUrl, '查看工作流');
    const expired = input.waitedMs >= input.timeoutMs;
    return result('not_triggered', expired ? '未找到镜像构建' : '等待 CI 触发', '尚未找到该分支和提交的镜像构建记录，请检查触发条件或手动运行镜像工作流。', expired ? 'not_triggered' : '', !expired);
  } catch {
    return result('unknown', 'CI 状态未确认', '暂时无法核对 GitHub 状态，请稍后重试或打开 Actions 查看；这不代表构建失败。', 'status_unknown', input.waitedMs < input.timeoutMs);
  }
}
