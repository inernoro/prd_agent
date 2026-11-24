import { describe, it, expect, vi } from 'vitest';
import { verifyPrebuiltWorkflowRun } from '../../src/services/prebuilt-image-claim.js';

const input = { repository: 'acme/demo', branch: 'feature', commitSha: 'a'.repeat(40), workflowRunUrl: 'https://github.com/acme/demo/actions/runs/123', authorization: 'Bearer private-token' };
const success = { repository: { full_name: 'acme/demo' }, head_sha: input.commitSha, head_branch: input.branch,
  path: '.github/workflows/branch-image.yml', status: 'completed', conclusion: 'success' };
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

describe('手动认领镜像的真实 CI 证据', () => {
  it('只向固定 GitHub API 核对绑定仓库、分支、提交及 Branch Image 成功结果', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(success));
    expect(await verifyPrebuiltWorkflowRun({ ...input, fetchImpl: fetcher })).toEqual({ ok: true, workflowRunUrl: input.workflowRunUrl });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/demo/actions/runs/123');
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });
  it.each(['failure', 'cancelled', null])('未成功的 CI %s 不能改写为 ready', async conclusion => {
    const result = await verifyPrebuiltWorkflowRun({ ...input, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ ...success, conclusion })) });
    expect(result).toMatchObject({ ok: false, status: 409, error: 'ci_not_successful' });
  });
  it.each([
    { head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { repository: { full_name: 'other/demo' } }, { path: '.github/workflows/ci.yml' },
  ])('仓库、分支、提交或工作流不匹配时拒绝', async patch => {
    const result = await verifyPrebuiltWorkflowRun({ ...input, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ ...success, ...patch })) });
    expect(result).toMatchObject({ ok: false, status: 409, error: 'ci_evidence_mismatch' });
  });
  it.each(['https://evil.example/acme/demo/actions/runs/123', 'https://github.com/other/demo/actions/runs/123', 'https://github.com/acme/demo/actions/runs/123?token=secret'])('无效链接不发送项目凭据', async workflowRunUrl => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await verifyPrebuiltWorkflowRun({ ...input, workflowRunUrl, fetchImpl: fetcher })).toMatchObject({ ok: false, status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('GitHub 不可核对时保持未知，不泄露异常或凭据', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-token'));
    const result = await verifyPrebuiltWorkflowRun({ ...input, fetchImpl: fetcher });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
  it('显式非镜像工作流不能借同名 Branch Image 绕过路径核验', async () => {
    const result = await verifyPrebuiltWorkflowRun({ ...input, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ ...success, path: '.github/workflows/ci.yml', name: 'Branch Image' })) });
    expect(result).toMatchObject({ ok: false, status: 409, error: 'ci_evidence_mismatch' });
  });
  it('缺少工作流路径的旧回执仍可按名称核对', async () => {
    expect(await verifyPrebuiltWorkflowRun({ ...input, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ ...success, path: undefined, name: 'Branch Image' })) })).toMatchObject({ ok: true });
  });
  it('省略链接时自动定位精确仓库、分支和提交的工作流并复核实际运行', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ workflow_runs: [{ ...success, id: 123 }] }))
      .mockResolvedValueOnce(response(success));
    expect(await verifyPrebuiltWorkflowRun({ ...input, workflowRunUrl: '', fetchImpl: fetcher })).toEqual({ ok: true, workflowRunUrl: input.workflowRunUrl });
    const query = new URL(String(fetcher.mock.calls[0][0]));
    expect(query.pathname).toBe('/repos/acme/demo/actions/workflows/branch-image.yml/runs');
    expect(query.searchParams.get('head_sha')).toBe(input.commitSha);
    expect(query.searchParams.get('branch')).toBe(input.branch);
    expect(fetcher.mock.calls[1][0]).toBe('https://api.github.com/repos/acme/demo/actions/runs/123');
  });
  it.each([
    { workflow_runs: [] },
    { workflow_runs: [{ ...success, id: 123, head_branch: 'other' }] },
    { workflow_runs: [{ ...success, id: 123, path: '.github/workflows/ci.yml', name: 'Branch Image' }] },
  ])('自动查询没有精确镜像回执时拒绝，不猜成功', async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body));
    expect(await verifyPrebuiltWorkflowRun({ ...input, workflowRunUrl: '', fetchImpl: fetcher })).toMatchObject({ ok: false, status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('自动定位后复核发现运行失败仍拒绝认领', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ workflow_runs: [{ ...success, id: 123 }] }))
      .mockResolvedValueOnce(response({ ...success, conclusion: 'failure' }));
    expect(await verifyPrebuiltWorkflowRun({ ...input, workflowRunUrl: '', fetchImpl: fetcher })).toMatchObject({ ok: false, status: 409, error: 'ci_not_successful' });
  });

  it.each(['main', 'feature/branch'])('带引用后缀的真实工作流路径仍能核验：%s', async ref => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...success, path: `.github/workflows/branch-image.yml@${ref}` }));
    expect(await verifyPrebuiltWorkflowRun({ ...input, fetchImpl: fetcher })).toMatchObject({ ok: true });
  });
  it('带引用后缀的其他工作流仍不能借同名通过', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...success, path: '.github/workflows/ci.yml@main', name: 'Branch Image' }));
    expect(await verifyPrebuiltWorkflowRun({ ...input, fetchImpl: fetcher })).toMatchObject({ ok: false, error: 'ci_evidence_mismatch' });
  });

});
