import { describe, expect, it } from 'vitest';
import { correlateRelease, readReleaseRequests, releaseRequestStorageKey, type ReleaseRequest } from '../../web/src/lib/releaseRequest';
import type { ReleaseRun } from '../../web/src/pages/release-center/types';
const request: ReleaseRequest = { requestId: 'once-only-request', projectId: 'p', targetId: 't', branchId: 'b', commitSha: 'a'.repeat(40), kind: 'deploy', requestedAt: '2026-11-15T10:00:00Z' };
const run = (overrides: Partial<ReleaseRun> = {}): ReleaseRun => ({ releaseId: 'r1', requestId: request.requestId, projectId: 'p', targetId: 't', branchId: 'b', commitSha: request.commitSha, status: 'running', startedAt: request.requestedAt, logs: [], ...overrides } as ReleaseRun);
describe('发布未知结果只做唯一正向关联', () => {
  it('同请求、对象与完整来源版本才可接续', () => expect(correlateRelease(request, [run()]).kind).toBe('found'));
  it('查无记录保持未知', () => expect(correlateRelease(request, []).kind).toBe('missing'));
  it('相同目标版本的旧历史不能证明本次已执行', () => expect(correlateRelease(request, [run({ requestId: 'old' })]).kind).toBe('missing'));
  it('同编号多个结果不可选择第一条', () => expect(correlateRelease(request, [run(), run({ releaseId: 'r2' })]).kind).toBe('ambiguous'));
  it.each([{ projectId: 'other' }, { targetId: 'other' }, { branchId: 'other' }, { commitSha: 'a'.repeat(7) }, { rollbackOf: 'other' }])('不同对象或动作不接续 %j', overrides => expect(correlateRelease(request, [run(overrides)]).kind).toBe('mismatch'));
  it('回滚必须对上原记录和目标版本', () => {
    const rollback = { ...request, kind: 'rollback' as const, sourceReleaseId: 'from', rollbackTargetReleaseId: 'to' };
    expect(correlateRelease(rollback, [run({ rollbackOf: 'from', rollbackTargetReleaseId: 'to' })]).kind).toBe('found');
    expect(correlateRelease(rollback, [run({ rollbackOf: 'from', rollbackTargetReleaseId: 'old' })]).kind).toBe('mismatch');
  });
  it('浏览器恢复仅保留完整原对象，按账号隔离', () => {
    expect(releaseRequestStorageKey('account-a')).not.toBe(releaseRequestStorageKey('account-b'));
    expect(readReleaseRequests({ getItem: () => JSON.stringify([request, { requestId: 'broken' }]) }, 'key')).toEqual([request]);
  });
});
