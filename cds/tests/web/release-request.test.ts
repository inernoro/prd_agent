import { describe, expect, it } from 'vitest';
import { correlateRelease, releaseAccountIdentity, readReleaseRequests, releaseRequestStorageKey, type ReleaseRequest } from '../../web/src/lib/releaseRequest';
import { ApiError } from '../../web/src/lib/api';
import { isConfirmedReleaseRejection } from '../../web/src/pages/ReleaseConsolePage';
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

describe('保留请求依真实主体隔离', () => {
  it('相同全局模式下同名本地和GitHub主体不混用', () => {
    expect(releaseAccountIdentity({ enabled: true, activeProvider: 'local', user: { id: 'local-a', authProvider: 'local', username: 'alice' } })).not.toBe(releaseAccountIdentity({ enabled: true, activeProvider: 'github', user: { id: 'github-a', authProvider: 'github', githubLogin: 'alice' } }));
  });
  it('同一持久id换登录provider仍承接原请求', () => {
    expect(releaseAccountIdentity({ enabled: true, activeProvider: 'local', user: { id: 'same', username: 'alice' } })).toBe(releaseAccountIdentity({ enabled: true, activeProvider: 'github', user: { id: 'same', githubLogin: 'alice' } }));
  });
  it('同provider同名但不同稳定id也隔离', () => {
    expect(releaseAccountIdentity({ enabled: true, activeProvider: 'local', user: { id: 'a', username: 'alice' } })).not.toBe(releaseAccountIdentity({ enabled: true, activeProvider: 'local', user: { id: 'b', username: 'alice' } }));
  });
  it('无稳定id的legacy仍依真实provider隔离，未知provider不读取缓存', () => {
    expect(releaseAccountIdentity({ enabled: true, activeProvider: 'legacy', user: { username: 'alice' } })).not.toBe(releaseAccountIdentity({ enabled: true, activeProvider: 'github', user: { githubLogin: 'alice' } }));
    expect(releaseAccountIdentity({ enabled: true, user: { username: 'alice' } })).toBeNull();
    expect(releaseAccountIdentity(null)).toBeNull();
  });
});


describe('发布拒绝必须有服务端写前契约和本次编号', () => {
  it('同编号的明确写前409才允许解除待核对锁', () => {
    expect(isConfirmedReleaseRejection(new ApiError(409, { releaseOutcome: 'not-started', requestId: request.requestId }, '版本已前进'), request.requestId)).toBe(true);
  });
  it.each([400, 401, 403, 408, 409, 422, 429, 500, 503])('裸HTTP%s不证明命令没有开始', status => {
    expect(isConfirmedReleaseRejection(new ApiError(status, { error: '服务拒绝' }, '服务拒绝'), request.requestId)).toBe(false);
  });
  it('编号不匹配或非409响应仍保持未知', () => {
    expect(isConfirmedReleaseRejection(new ApiError(409, { releaseOutcome: 'not-started', requestId: 'another-request' }, '拒绝'), request.requestId)).toBe(false);
    expect(isConfirmedReleaseRejection(new ApiError(503, { releaseOutcome: 'not-started', requestId: request.requestId }, '中断'), request.requestId)).toBe(false);
    expect(isConfirmedReleaseRejection(new Error('409 not-started'), request.requestId)).toBe(false);
  });
});
