import fs from 'node:fs';
import path from 'node:path';
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

// 「要不要紧」必须落在第一个句号之前：只读到第一句的人（截断展示、通知摘要）
// 否则只看得到「某个容器停了」，正常替换会被当成事故。
function assertVerdictInFirstSentence(reason: string, verdictFragment: string): void {
  const firstStop = reason.indexOf('。');
  expect(firstStop).toBeGreaterThan(0);
  expect(reason.slice(0, firstStop)).toContain(verdictFragment);
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
    assertVerdictInFirstSentence(result.reason, '无需处理');
    // 上游记录的原因原文不许被固定文案盖掉。
    expect(result.reason).toContain('CDS 记录的原因：部署前替换同名旧容器');
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
    assertVerdictInFirstSentence(result.reason, '不是崩溃');
  });

  it('does not call a failure-driven stop routine maintenance', () => {
    // replica-set.ts:994 就绪失败后走的正是 cds-stop，reason 带着 replica-member-not-ready。
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 0,
      lifecycleIntent: {
        containerName: base.containerName,
        kind: 'cds-stop',
        reason: 'replica-member-not-ready',
        requestedAt: new Date().toISOString(),
        actor: 'replica-set',
        trigger: 'replica-set-readiness-failed',
      },
    });

    expect(result.reason).toContain('CDS 记录的原因：replica-member-not-ready');
    // 说成「无需处理」会把一次就绪失败盖掉（Codex P2）。
    expect(result.reason).not.toContain('无需处理');
    expect(result.reason).toContain('重启前先看容器日志');
    // 施动者与触发方式都不在翻译表里，必须原样带出，让人看得出这是就绪失败。
    expect(result.reason).toContain('replica-set');
    expect(result.reason).toContain('replica-set-readiness-failed');
  });

  it('tells an infra stop apart from an infra recreate', () => {
    const stopped = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 0,
      lifecycleIntent: {
        containerName: base.containerName,
        kind: 'cds-infra-stop',
        reason: 'infra 停止/删除，不重建',
        requestedAt: new Date().toISOString(),
        actor: 'ai',
        trigger: 'manual',
      },
    });
    const recreated = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 0,
      lifecycleIntent: {
        containerName: base.containerName,
        kind: 'cds-infra-recreate',
        reason: 'infra stop/rm 后重建',
        requestedAt: new Date().toISOString(),
        actor: 'ai',
        trigger: 'manual',
      },
    });

    // 停止 / 删除路径不会起新容器，说「等新容器」就是让人干等（Codex P2）。
    expect(stopped.reason).toContain('不会自动重建');
    expect(stopped.reason).not.toContain('等新容器');
    expect(recreated.reason).toContain('等新容器');
    expect(stopped.stopClass).toBe('cds-infra-stop');
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
    // 外因是「内存不够」而不是「某个函数出错」，并且要给出下一步。
    expect(result.reason).toContain('OOM killer');
    expect(result.reason).toContain('下一步');
    // 「没匹配到停止意图」只能这么说，不能反推成「CDS 什么都没做」——
    // 自动重启走的是 docker start，同样不留停止意图（Codex P2）。
    expect(result.reason).toContain('没有匹配到任何停止');
    expect(result.reason).not.toContain('不是任何人在 CDS 上的操作');
    // CDS 默认不给分支服务容器下发 --memory（container.ts 2026-05-28 起删除），
    // 所以不许断言成「超过了它自己的内存上限、调大即可」——那会把宿主级内存压力指错地方。
    // 这条守卫锁住「两种可能都点名、并要求去查宿主」，改回单一归因就会红。
    expect(result.reason).toContain('宿主整体内存');
    expect(result.reason).not.toMatch(/调大这个服务的内存上限|超过了分配给它的上限/);
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
    expect(result.reason).toContain('看容器日志');
    expect(result.reason).toContain('没有匹配到任何停止');
    // 崩溃前 CDS 可能刚用 docker start 把它拉起来，不许一口咬定跟 CDS 无关。
    expect(result.reason).not.toContain('不是任何人在 CDS 上的操作');
    expect(result.reason).toContain('这不等于 CDS 没碰过它');
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
    expect(result.reason).toContain('没有匹配到任何停止操作');
    expect(result.reason).not.toContain('没有人在 CDS 上停它');
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

// 上面那条只证明「分类器对两种意图说不同的话」，不证明「停止路径真的记了 stop」——
// 把路由里的 'cds-infra-stop' 参数删掉，它照样全绿（predicate-and-wiring-discipline 形状 2）。
// 所以这里扫真实调用点：停止 / 删除 / 远端停止三条路径必须显式表态，重启与重同步保持默认。
describe('infra 停止意图的接线', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');

  // 扫全部调用点，不是只扫想得起来的那两个文件：上一版漏掉 project-infra-resync.ts，
  // 于是它的删除路径带着 recreate 意图溜过守卫（Codex P2，规则里的「守卫自己没接上线」）。
  // 总数也断言死，新增任何一处调用都会红，逼人当场表态是 stop 还是 recreate。
  const CALLER_FILES = ['routes/branches.ts', 'executor/routes.ts', 'routes/project-infra-resync.ts'];

  it('每个 stopInfraService 调用点都对停止还是重建表过态', () => {
    const stopCalls = CALLER_FILES.flatMap((rel) =>
      [...read(rel).matchAll(/stopInfraService\(([^)]*)\)/g)].map((m) => m[1]),
    );
    const explicitStops = stopCalls.filter((args) => args.includes("'cds-infra-stop'"));

    // 4 条停了不重建：删除服务 / 停止服务 / 远端停止 / resync 的 Phase 1 删除。
    expect(explicitStops.length).toBe(4);
    // 2 条确实会重建，留在默认值上：分支面板的重启 / resync 的 Phase 2 更新。
    expect(stopCalls.length - explicitStops.length).toBe(2);
  });
});

// 分类结论必须出现在展示用的 message 上。infra 容器不带 branch/profile label，
// 分支状态同步那条会提前 return，所以 docker-events 这一条是它唯一的出口；
// 结论只写进 details 的话，删掉这段接线不会有任何测试变红（形状 2）。
describe('人话段自足', () => {
  // 展示面拿的是「技术细节：」之前那一段。八条路径每一条都得在这一段里把话说完：
  // 要么给出结论（无需处理 / 不是崩溃 / 需要处理），要么给出下一步去查什么。
  // 只剩症状（「某容器停了」）就等于没说，那正是本 PR 要消灭的写法。
  const selfContained = (reason: string) => {
    const lead = reason.split('技术细节：')[0];
    return /无需处理|不是崩溃|需要处理|下一步|重启前先看|不会自动重建|等新容器/.test(lead);
  };

  const samples: Array<[string, Parameters<typeof classifyDockerLifecycleEvent>[0]]> = [
    ['oom', { ...base, action: 'die', exitCode: 137, oomKilled: true }],
    ['exit-0', { ...base, action: 'die', exitCode: 0 }],
    ['sigterm', { ...base, action: 'die', exitCode: 143 }],
    ['crash', { ...base, action: 'die', exitCode: 2 }],
    ['sigkill', { ...base, action: 'die', exitCode: 137, attrs: { signal: '9' } }],
    ['docker-kill', { ...base, action: 'kill', exitCode: 137 }],
    ['destroy', { ...base, action: 'destroy' }],
    ['cds-intent', {
      ...base,
      action: 'die',
      lifecycleIntent: {
        containerName: base.containerName,
        kind: 'cds-pre-run-replace',
        reason: '部署前替换同名旧容器',
        requestedAt: new Date().toISOString(),
        actor: 'ai',
        trigger: 'manual',
      },
    }],
  ];

  it.each(samples)('%s 的人话段自己就能读懂，不只剩症状', (_name, event) => {
    expect(selfContained(classifyDockerLifecycleEvent(event).reason)).toBe(true);
  });
});

describe('分类结论进展示面的接线', () => {
  it('docker-events 事件的 message 用分类结论，而不是只带 kind 的通用串', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/container-diagnostics.ts'),
      'utf8',
    );
    // 认准 docker-events 那一条：message 由 classification 起头，并取用 classification.reason。
    // 只搜文件里有没有 'classification' 的话，details 里那份就能把守卫哄绿。
    expect(source).toMatch(/message:\s*classification[\s\S]{0,600}classification\.reason/);
    // 必须按「技术细节：」切人话段。按第一个句号切会丢掉 OOM / 正常退出 / destroy
    // 那几条放在后面句子里的结论与下一步（Codex 第六轮 P2）。
    expect(source).toContain("classification.reason.split('技术细节：')[0]");
    expect(source).not.toContain("classification.reason.split('。')[0]");
  });
});
