import { describe, expect, it } from 'vitest';
import { classifyDockerLifecycleEvent } from '../../src/services/docker-lifecycle-classifier.js';

const base = {
  containerName: 'cds-prd-agent-main-api-prd-agent',
  attrs: {},
};

// reason 是人在分支面板上读到的那句话，契约见 .claude/rules/external-cause-first.md：
// 外因（谁做了什么、要不要紧）在前，内因（signal / exitCode / operation / requestId）
// 一个不少地排在「技术细节：」之后。所以这里既断言内因字段还在（可追溯性），
// 也断言它们排在外因之后（次序本身就是契约）—— 只测「包含 requestId=」的话，
// 把文案退回旧格式测试照样绿。
function assertExternalCauseFirst(reason: string): void {
  const marker = reason.indexOf('技术细节：');
  expect(marker).toBeGreaterThan(0);
  const lead = reason.slice(0, marker);
  expect(lead).not.toMatch(/exitCode=|signal=|requestId=|operation=/);
}

describe('classifyDockerLifecycleEvent', () => {
  it('classifies CDS lifecycle intent as intentional and traceable', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 137,
      attrs: { signal: '9' },
      branchName: 'main',
      lifecycleIntent: {
        containerName: base.containerName,
        kind: 'cds-pre-run-replace',
        reason: '部署前替换同名旧容器',
        requestedAt: new Date().toISOString(),
        requestId: 'req-123',
        operationId: 'op-123',
        actor: 'system:webhook',
        trigger: 'webhook',
        operation: 'deploy-pre-run-replace',
        source: 'container.runService',
      },
    });

    expect(result.source).toBe('cds');
    expect(result.unexpected).toBe(false);
    expect(result.nextServiceStatus).toBe('stopped');
    expect(result.stopClass).toBe('cds-pre-run-replace');

    // 外因：谁 + 怎么触发的 + 做了什么 + 影响了谁 + 要不要紧，全在第一句里。
    expect(result.reason.startsWith('由 GitHub webhook 代码推送自动触发部署')).toBe(true);
    expect(result.reason).toContain('分支 main');
    expect(result.reason).toContain('无需处理');
    // 内因：一个都没丢，只是排到了后面。
    assertExternalCauseFirst(result.reason);
    expect(result.reason).toContain('requestId=req-123');
    expect(result.reason).toContain('operationId=op-123');
    expect(result.reason).toContain('operation=deploy-pre-run-replace');
    expect(result.reason).toContain('source=container.runService');
    expect(result.reason).toContain('trigger=webhook');
    expect(result.reason).toContain('signal=9');
  });

  it('names an unmapped actor verbatim instead of inventing one', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'kill',
      lifecycleIntent: {
        containerName: base.containerName,
        kind: 'cds-stop',
        reason: '用户在分支面板停止服务',
        requestedAt: new Date().toISOString(),
        actor: 'alice@example.com',
        trigger: 'manual',
      },
    });

    expect(result.reason.startsWith('由 alice@example.com 手动触发停止这个服务')).toBe(true);
    expect(result.reason).toContain('无需处理');
  });

  it('says the initiator is unrecorded when the intent carries no actor or trigger', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'destroy',
      lifecycleIntent: {
        containerName: base.containerName,
        kind: 'cds-stale-cleanup',
        reason: '清理残留容器',
        requestedAt: new Date().toISOString(),
      },
    });

    expect(result.reason).toContain('未记录触发者');
    expect(result.stopClass).toBe('cds-stale-cleanup');
  });

  it('falls back to the container name when no branch name is supplied', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 2,
      attrs: {},
    });

    expect(result.reason).toContain(`${base.containerName} 这个容器`);
    expect(result.reason).not.toContain('分支 ');
  });

  it('classifies OOM evidence as oom even when exit code is 137', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 137,
      oomKilled: true,
      attrs: {},
    });

    expect(result.source).toBe('oom');
    expect(result.unexpected).toBe(true);
    expect(result.nextServiceStatus).toBe('error');
    expect(result.stopClass).toBe('oom-kill');
    // 外因是「内存超限」而不是「某个函数出错」，并且要给出下一步。
    expect(result.reason).toContain('内存');
    expect(result.reason).toContain('不是任何人在 CDS 上的操作');
    expect(result.reason).toContain('需要处理');
    assertExternalCauseFirst(result.reason);
    expect(result.reason).toContain('OOMKilled=true');
  });

  it('classifies SIGKILL without OOM or CDS intent as external', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 137,
      attrs: { signal: '9' },
    });

    expect(result.source).toBe('external');
    expect(result.unexpected).toBe(true);
    expect(result.nextBranchStatus).toBe('error');
    expect(result.stopClass).toBe('sigkill-no-oom-evidence');
    // 外因追不到时必须如实说追不到，并给出接着查哪儿，不许拿内因冒充原因。
    expect(result.reason).toContain('没有匹配到');
    expect(result.reason).toContain('追不到是谁干的');
    expect(result.reason).toContain('下一步');
    expect(result.reason).toContain('没有 OOMKilled 证据');
    assertExternalCauseFirst(result.reason);
  });

  it('classifies docker kill events without intent as external docker kill', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'kill',
      exitCode: 137,
      attrs: { signal: '9' },
    });

    expect(result.source).toBe('external');
    expect(result.unexpected).toBe(true);
    expect(result.stopClass).toBe('external-docker-kill');
    expect(result.reason).toContain('没有匹配到');
    expect(result.reason).toContain('下一步');
  });

  it('classifies nonzero die events as application crash', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 2,
      attrs: {},
      branchName: 'feature/x',
    });

    expect(result.source).toBe('crash');
    expect(result.unexpected).toBe(true);
    expect(result.nextServiceStatus).toBe('error');
    expect(result.stopClass).toBe('process-exit-error');
    expect(result.reason).toContain('分支 feature/x');
    expect(result.reason).toContain('不是任何人在 CDS 上的操作');
    expect(result.reason).toContain('看容器日志');
    assertExternalCauseFirst(result.reason);
  });

  it('classifies normal exit as system stop, not crash', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 0,
      attrs: {},
    });

    expect(result.source).toBe('system');
    expect(result.unexpected).toBe(false);
    expect(result.nextBranchStatus).toBe('idle');
    expect(result.stopClass).toBe('normal-exit');
    expect(result.reason).toContain('这不是崩溃');
    expect(result.reason).toContain('没有人在 CDS 上停它');
    assertExternalCauseFirst(result.reason);
  });

  it('tells a SIGTERM stop apart from a plain exit-0 stop', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 143,
      attrs: {},
    });

    expect(result.stopClass).toBe('normal-exit');
    expect(result.unexpected).toBe(false);
    expect(result.reason).toContain('收到停止信号后正常退出');
    expect(result.reason).toContain('exitCode=143');
  });
});
