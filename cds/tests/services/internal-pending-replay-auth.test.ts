import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createInternalPendingReplayAuth } from '../../src/services/internal-pending-replay-auth.js';
import { BranchOperationCoordinator, pendingDeployBody, pendingDeployRoute } from '../../src/services/branch-operation-coordinator.js';

function fixture(profileId?: string) {
  const coordinator = new BranchOperationCoordinator();
  const active = coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'manual' });
  coordinator.begin({ projectId: 'p', branchId: 'b', profileId, kind: profileId ? 'deploy-profile' : 'deploy', trigger: 'webhook',
    actor: 'original', source: 'original', commitSha: 'b'.repeat(40), commitPinned: true });
  const pending = coordinator.completeAll(active.lease!, 'completed')[0];
  const auth = createInternalPendingReplayAuth();
  const gate = auth.middleware({ coordinator, projectForBranch: id => id === 'b' ? 'p' : undefined });
  const route = pendingDeployRoute(pending);
  const req = { method: 'POST', originalUrl: route, headers: auth.headersFor(`http://127.0.0.1:9900${route}`, pending, 'p'),
    body: JSON.parse(JSON.stringify(pendingDeployBody(pending))), socket: { remoteAddress: '127.0.0.1', localPort: 9900 } } as unknown as Request;
  const check = (request = req) => {
    const next = vi.fn(); const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    gate.gate(request, res as any, next);
    return { next: next.mock.calls.length, trusted: gate.isTrusted(request), denied: res.status.mock.calls[0]?.[0] };
  };
  return { coordinator, pending, req, check, auth };
}

describe('排队重派专用能力', () => {
  it.each([undefined, 'api'])('原领取精确范围 %s 通过，消费后相同签名失效', profileId => {
    const f = fixture(profileId); expect(f.check()).toEqual({ next: 1, trusted: true, denied: undefined });
    expect(f.coordinator.begin({ ...f.pending.request, pendingReplay: f.req.body.pendingReplay }).status).toBe('started');
    expect(f.check({ ...f.req } as Request).denied).toBe(401);
  });
  it.each(['project', 'branch', 'profile', 'target', 'generation', 'operation', 'trigger', 'requestId', 'query', 'options', 'mac', 'remote', 'port'])('篡改 %s 不授予部署权限', change => {
    const f = fixture('api'); const req = f.req as any;
    if (change === 'project') req.headers['x-cds-source-project-id'] = 'other';
    if (change === 'branch') req.originalUrl = '/api/branches/other/deploy/api';
    if (change === 'profile') req.originalUrl = '/api/branches/b/deploy/web';
    if (change === 'target') req.body.commitSha = 'c'.repeat(40);
    if (change === 'generation') req.body.pendingReplay.generation++;
    if (change === 'operation') req.body.pendingReplay.operationId = 'other';
    if (change === 'trigger') req.headers['x-cds-trigger'] = 'manual';
    if (change === 'requestId') req.headers['x-cds-request-id'] = 'other';
    if (change === 'query') req.originalUrl += '?force=1';
    if (change === 'options') req.body.targetExecutorId = 'other';
    if (change === 'mac') req.headers.authorization = req.headers.authorization.slice(0, -64) + '0'.repeat(64);
    if (change === 'remote') req.socket.remoteAddress = '192.0.2.10';
    if (change === 'port') req.socket.localPort = 9901;
    expect(f.check()).toEqual({ next: 0, trusted: false, denied: 401 });
    expect(f.coordinator.getClaimedPendingReplay(f.req.body.pendingReplay)?.operationId === f.pending.operationId || ['generation', 'operation'].includes(change)).toBe(true);
  });
  it.each(['expired', 'future', 'released', 'superseded', 'owner', 'restart'])('失效 %s 不能重派', change => {
    const f = fixture(); const now = Date.now();
    if (change === 'expired' || change === 'future') vi.spyOn(Date, 'now').mockReturnValue(now + (change === 'expired' ? 31_000 : -1_000));
    if (change === 'released') f.coordinator.releasePendingReplay(f.pending, 'transport');
    if (change === 'superseded') f.coordinator.begin({ ...f.pending.request, commitSha: 'c'.repeat(40) });
    if (change === 'owner') f.req.headers = f.auth.headersFor('http://127.0.0.1:9900/api/branches/b/deploy', f.pending, 'p');
    if (change === 'restart' || change === 'owner') {
      const auth = change === 'restart' ? createInternalPendingReplayAuth() : f.auth;
      const gate = auth.middleware({ coordinator: f.coordinator, projectForBranch: () => change === 'owner' ? 'other' : 'p' });
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }, next = vi.fn();
      gate.gate(f.req, res as any, next); expect(res.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
    } else expect(f.check().denied).toBe(401);
    vi.restoreAllMocks();
  });
  it('普通内部标记没有能力；签名绝不发给外部地址或其他路径', () => {
    const f = fixture(); delete f.req.headers.authorization;
    expect(f.check()).toEqual({ next: 1, trusted: false, denied: undefined });
    for (const url of ['https://example.test/api/branches/b/deploy', 'http://127.0.0.1:9900/api/projects', 'http://127.0.0.1:9900/api/branches/b/deploy?force=1']) {
      expect(() => f.auth.headersFor(url, f.pending, 'p')).toThrow();
    }
  });
});
