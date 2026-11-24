import { describe, it, expect, vi } from 'vitest';
import { diagnoseCiImage, ciDiagnosisSnapshot, type CiDiagnosisInput } from '../../src/services/ci-image-diagnosis.js';
import type { BranchEntry } from '../../src/types.js';

const sha = 'a'.repeat(40);
const run = { id: 42, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: sha,
  head_branch: 'feature/test', status: 'completed', conclusion: 'cancelled' };
function fixture(replies: Array<[number, unknown]>) {
  const audit = { record: vi.fn(), recordImmediate: vi.fn(async () => {}) };
  const fetchImpl = vi.fn(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error('network unavailable');
    return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
  });
  const input: CiDiagnosisInput = { repository: 'owner/repo', branch: 'feature/test', targetSha: sha,
    branchId: 'b', projectId: 'p', authorization: 'Bearer must-not-be-logged', waitedMs: 20 * 60_000,
    timeoutMs: 15 * 60_000, audit, fetchImpl: fetchImpl as typeof fetch, now: () => 1_000_000 };
  return { input, audit, fetchImpl };
}
const source = (text: string) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') });

describe('CI 镜像原因对账', () => {
  it('从检查注释确认取消身份，保留 run 并先持久化脱敏证据', async () => {
    const { input, audit } = fixture([[200, { workflow_runs: [run] }], [200, { jobs: [{ id: 9, conclusion: 'cancelled' }] }],
      [200, [{ message: 'The run was canceled by @inernoro.' }]]]);
    const patch = await diagnoseCiImage(input);
    expect(patch).toMatchObject({ ciImageStatus: 'failed', ciWorkflowConclusion: 'cancelled',
      ciWorkflowRunUrl: 'https://github.com/owner/repo/actions/runs/42', ciDiagnosis: { code: 'cancelled' } });
    expect(patch.ciImageError).toContain('@inernoro 身份');
    expect(audit.recordImmediate).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(audit.recordImmediate.mock.calls)).not.toContain('must-not-be-logged');
    expect(JSON.stringify(audit.recordImmediate.mock.calls)).toContain('The run was canceled by @inernoro.');
  });

  it('取消者查询无权限不丢失已确认的取消终态', async () => {
    const { input } = fixture([[200, { workflow_runs: [run] }], [403, { message: 'Forbidden' }]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciWorkflowConclusion: 'cancelled',
      ciDiagnosis: { code: 'cancelled', message: expect.stringContaining('尚未确认') } });
  });

  it('仅验证的手动工作流直接说明未触发，提供配置入口', async () => {
    const { input } = fixture([[200, { workflow_runs: [] }], [200, source('name: Branch Image\non:\n  workflow_dispatch:\njobs:\n  config-only:\n    steps:\n      - run: echo no-images')]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciImageStatus: 'failed', ciWorkflowRunUrl: '',
      ciDiagnosis: { code: 'not_triggered', actionLabel: '查看工作流', message: expect.stringContaining('仅验证分支') } });
  });

  it('BuildFailed 启动异常即使没有 workflow 名称和 job 也可定位', async () => {
    const { input } = fixture([[200, { workflow_runs: [{ ...run, path: 'BuildFailed', name: '', conclusion: 'startup_failure' }] }]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciDiagnosis: { code: 'startup_failed', actionLabel: '查看构建' } });
  });

  it.each([['queued', 'queued'], ['in_progress', 'building']])('真实 %s 不会被15分钟看门狗误判', async (status, code) => {
    const { input } = fixture([[200, { workflow_runs: [{ ...run, status, conclusion: null }] }]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciImageStatus: 'waiting', ciDiagnosis: { code } });
  });

  it('忽略其他分支、其他工作流的成功，不误认镜像就绪', async () => {
    const { input } = fixture([[200, { workflow_runs: [{ ...run, conclusion: 'success', head_branch: 'other' },
      { ...run, id: 44, conclusion: 'success', path: '.github/workflows/ci.yml' }] }], [404, { message: 'Not Found' }]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciImageStatus: 'failed', ciWorkflowRunUrl: '', ciDiagnosis: { code: 'workflow_missing' } });
  });

  it('GitHub 工作流成功仅诊断结果未同步，不越过镜像准入自动部署', async () => {
    const { input } = fixture([[200, { workflow_runs: [{ ...run, conclusion: 'success' }] }]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciImageStatus: 'failed', ciDiagnosis: { code: 'result_unsynced' } });
  });

  it('限流不是构建失败，也不能解释成未触发', async () => {
    const { input, audit } = fixture([[429, { message: 'rate limit' }]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciWorkflowConclusion: 'status_unknown', ciDiagnosis: { code: 'unknown' } });
    expect(audit.recordImmediate).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ status: 429,
      snapshot: expect.objectContaining({ upstreamMessage: 'rate limit' }) }) }));
  });

  it('拒绝无法解析的工作流，且不保存源码', async () => {
    const { input, audit } = fixture([[200, { workflow_runs: [] }], [200, source('on: [broken\nsecret: dont-store-source')]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciDiagnosis: { code: 'startup_failed' } });
    expect(JSON.stringify(audit.recordImmediate.mock.calls)).not.toContain('dont-store-source');
  });

  it('没有权限查询工作流不能推断其不存在', async () => {
    const { input } = fixture([[200, { workflow_runs: [] }], [403, { message: 'Forbidden' }]]);
    expect(await diagnoseCiImage(input)).toMatchObject({ ciDiagnosis: { code: 'unknown' } });
  });

  it('审计无法持久化时不发布看似已确认的诊断', async () => {
    const { input, audit } = fixture([[200, { workflow_runs: [run] }]]);
    audit.recordImmediate.mockRejectedValue(new Error('audit unavailable'));
    await expect(diagnoseCiImage(input)).rejects.toThrow('ci-diagnosis-audit-unavailable');
  });

  it('GitHub App 授权失败也会归为状态未确认并留下失败阶段', async () => {
    const { input, audit, fetchImpl } = fixture([]);
    input.authorization = async () => { throw new Error('installation token unavailable'); };
    expect(await diagnoseCiImage(input)).toMatchObject({ ciDiagnosis: { code: 'unknown' } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(audit.recordImmediate).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ phase: 'authorization', status: null }) }));
  });

  it('无法解析的响应保留长度和摘要，不泄漏正文或误报没有构建', async () => {
    const { input, audit } = fixture([]);
    input.fetchImpl = vi.fn(async () => new Response('<html>unexpected upstream</html>', { status: 200 })) as typeof fetch;
    expect(await diagnoseCiImage(input)).toMatchObject({ ciDiagnosis: { code: 'unknown' } });
    expect(audit.recordImmediate).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ parse: 'invalid-json',
      snapshot: expect.objectContaining({ responseBytes: 32, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }) }));
    expect(JSON.stringify(audit.recordImmediate.mock.calls)).not.toContain('unexpected upstream');
  });

  it('新 push、同 SHA 重试和真正完成事件都会使在途诊断过期', () => {
    const branch = { projectId: 'p', branch: 'feature/test', ciTargetSha: sha, ciImageStatus: 'waiting', ciWaitingSince: 'old' } as BranchEntry;
    const before = ciDiagnosisSnapshot(branch);
    for (const update of [{ ciTargetSha: 'b'.repeat(40) }, { ciWaitingSince: 'new' }, { ciImageStatus: 'ready' }, { ciWorkflowRunUrl: 'new-run' }]) {
      expect(ciDiagnosisSnapshot({ ...branch, ...update } as BranchEntry)).not.toBe(before);
    }
  });
});
