import { describe, expect, it, vi } from 'vitest';
import type { BranchEntry } from '../../src/types.js';
import { SelfUpdateDeferredError, resumeMaintenanceDeploys, unresolvedWebhookDispatches } from '../../src/services/webhook-maintenance-retry.js';
import { defaultLocalhostDeploy } from '../../src/routes/github-webhook.js';

const now = Date.parse('2026-09-20T15:00:00Z');
const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
function fixture() {
  const branch = { id: 'b', projectId: 'p', githubCommitSha: 'abc', lastDeployDispatchCommitSha: 'abc',
    lastDeployDispatchAt: iso(-5), lastDeployDispatchSource: 'webhook', lastDeployDispatchStatus: 'failed',
    maintenanceDeferredDeploy: { commitSha: 'abc', createdAt: iso(-5), attempts: 0 },
  } as BranchEntry;
  const state = { getAllBranches: () => [branch], getBranch: () => branch, getProject: () => ({ paused: false }), save: vi.fn(), flush: vi.fn(async () => {}) };
  const deps = { draining: () => false, dispatch: vi.fn(async () => {}), now: () => now };
  return { branch, state, deps };
}
describe('自更新明确拒绝后的有界补发', () => {
  it('排空时不发；排空结束先持久化领取再发；成功后不重发', async () => {
    const { branch, state, deps } = fixture();
    await resumeMaintenanceDeploys(state, { ...deps, draining: () => true }); expect(deps.dispatch).not.toHaveBeenCalled();
    deps.dispatch.mockImplementation(async () => { expect(state.flush).toHaveBeenCalled(); expect(branch.maintenanceDeferredDeploy?.claimed).toBe(true); });
    await resumeMaintenanceDeploys(state, deps);
    expect(branch.lastDeployDispatchStatus).toBe('accepted'); expect(branch.maintenanceDeferredDeploy).toBeUndefined();
    await resumeMaintenanceDeploys(state, deps); expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });
  it('最多 3 次，仅明确的自更新拒绝允许等待后重发', async () => {
    const { branch, state, deps } = fixture(); deps.dispatch.mockRejectedValue(new SelfUpdateDeferredError('draining'));
    for (let i = 0; i < 4; i++) await resumeMaintenanceDeploys(state, deps);
    expect(deps.dispatch).toHaveBeenCalledTimes(3); expect(branch.maintenanceDeferredDeploy).toBeUndefined();
    expect(unresolvedWebhookDispatches([branch])).toBe(1);
  });
  it('超时/结果不明、过期、重启前已领取都不自动重试', async () => {
    for (const mode of ['ambiguous', 'expired', 'claimed']) {
      const { branch, state, deps } = fixture();
      if (mode === 'expired') branch.maintenanceDeferredDeploy!.createdAt = iso(-31);
      if (mode === 'claimed') branch.maintenanceDeferredDeploy!.claimed = true;
      deps.dispatch.mockRejectedValue(new Error('timeout'));
      await resumeMaintenanceDeploys(state, deps); await resumeMaintenanceDeploys(state, deps);
      expect(deps.dispatch).toHaveBeenCalledTimes(mode === 'ambiguous' ? 1 : 0);
      expect(branch.maintenanceDeferredDeploy).toBeUndefined(); expect(unresolvedWebhookDispatches([branch])).toBe(1);
    }
  });
  it('新提交/已成功部署取消旧补发，暂停项目不启动部署', async () => {
    const a = fixture(); a.branch.githubCommitSha = 'new'; await resumeMaintenanceDeploys(a.state, a.deps); expect(a.deps.dispatch).not.toHaveBeenCalled(); expect(unresolvedWebhookDispatches([a.branch])).toBe(0);
    const b = fixture(); b.branch.lastDeployAt = iso(-1); await resumeMaintenanceDeploys(b.state, b.deps); expect(b.deps.dispatch).not.toHaveBeenCalled();
    expect(unresolvedWebhookDispatches([b.branch])).toBe(0);
    const c = fixture(); c.state.getProject = () => ({ paused: true }); await resumeMaintenanceDeploys(c.state, c.deps); expect(c.deps.dispatch).not.toHaveBeenCalled();
  });
  it('并发收敛不重复领取，执行中被新提交替代不覆盖新状态', async () => {
    const { branch, state, deps } = fixture(); let done!: () => void;
    deps.dispatch.mockImplementation(() => new Promise<void>(r => { done = r; }));
    const run = resumeMaintenanceDeploys(state, deps); await vi.waitFor(() => expect(done).toBeDefined());
    await resumeMaintenanceDeploys(state, deps); expect(deps.dispatch).toHaveBeenCalledTimes(1);
    branch.maintenanceDeferredDeploy = undefined; branch.lastDeployDispatchCommitSha = 'new'; branch.lastDeployDispatchStatus = 'dispatching';
    done(); await run; expect(branch.lastDeployDispatchStatus).toBe('dispatching');
  });
  it('持久化失败不派发网络请求', async () => {
    const { state, deps } = fixture(); state.flush.mockRejectedValue(new Error('store down'));
    await expect(resumeMaintenanceDeploys(state, deps)).rejects.toThrow('store down'); expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it('HTTP 503 只识别结构化 self_update_draining，其它拒绝不会被重试', async () => {
    let body = { error: 'self_update_draining' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 503 })));
    try {
      const dispatch = defaultLocalhostDeploy({ masterPort: 7000 } as any, { getBranch: () => undefined } as any);
      await expect(dispatch('b', 'abc')).rejects.toBeInstanceOf(SelfUpdateDeferredError);
      body = { error: 'unavailable' }; await expect(dispatch('b', 'abc')).rejects.not.toBeInstanceOf(SelfUpdateDeferredError);
    } finally { vi.unstubAllGlobals(); }
  });
});
