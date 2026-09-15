import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyDockerLifecycleEvent,
  refineLegacyStopKind,
  LEGACY_REASON_KINDS,
} from '../../src/services/docker-lifecycle-classifier.js';
import { renderCause } from '../../src/services/cause-statement.js';
import type { ContainerLifecycleIntent } from '../../src/services/container-diagnostics.js';

const base = {
  containerName: 'cds-prd-agent-main-api-prd-agent',
  attrs: {},
};

const intentOf = (over: Partial<ContainerLifecycleIntent> = {}): ContainerLifecycleIntent => ({
  containerName: base.containerName,
  kind: 'cds-pre-run-replace',
  reason: '部署前替换同名旧容器',
  requestedAt: new Date().toISOString(),
  ...over,
});

// ── 第一层：句子的形状由唯一渲染器保证，只需要测它一个 ──
//
// 以前这些不变量是十五条守卫分头抽查八条路径的措辞，于是总有路径没被覆盖到
// （exit-0 的结论就这么漏在第二句六轮没人发现）。现在句子只有一个出口，
// 测它等于测全部路径。
describe('renderCause 是句子的唯一出口', () => {
  const sample = (over = {}) => renderCause({
    initiator: { kind: 'process' },
    happening: '某容器里的进程退出了',
    scope: '分支 main',
    verdict: { kind: 'inspect', where: '看容器日志' },
    evidence: ['exitCode=2', 'signal=9'],
    ...over,
  });

  it('结论落在第一个句号之前', () => {
    const first = sample().split('。')[0];
    expect(first).toContain('下一步：看容器日志');
  });

  it('内因一个不少，但全在「技术细节：」之后', () => {
    const reason = sample();
    const marker = reason.indexOf('技术细节：');
    expect(marker).toBeGreaterThan(0);
    expect(reason.slice(0, marker)).not.toMatch(/exitCode=|signal=/);
    expect(reason).toContain('exitCode=2');
    expect(reason).toContain('signal=9');
  });

  it('上游记录的原因原样带出，不被固定文案盖掉', () => {
    expect(sample({ recordedReason: 'replica-member-not-ready' }))
      .toContain('CDS 记录的原因：replica-member-not-ready');
  });

  it('四种结论各自渲染出可行动的话', () => {
    expect(sample({ verdict: { kind: 'no-action' } })).toContain('无需处理');
    expect(sample({ verdict: { kind: 'wait', until: '新容器起来' } })).toContain('等新容器起来');
    expect(sample({ verdict: { kind: 'act', nextStep: '重新启动' } })).toContain('下一步：重新启动');
    expect(sample({ verdict: { kind: 'inspect', where: '容器日志' } })).toContain('下一步：容器日志');
  });

  it('追不到施动者时说清查过哪些账本，不编一个来源', () => {
    const reason = sample({ initiator: { kind: 'unmatched', missing: '任何停止意图' } });
    expect(reason).toContain('CDS 这边没有匹配到任何停止意图');
  });
});

// ── 第二层：分类判断（哪一类、要不要紧）——句子的形状不在这里重复测 ──
describe('classifyDockerLifecycleEvent 的分类判断', () => {
  it('匹配到 CDS 意图：可追溯字段一个不丢', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 137,
      attrs: { signal: '9' },
      branchName: 'main',
      lifecycleIntent: intentOf({
        requestId: 'req-123',
        operationId: 'op-123',
        actor: 'system:webhook',
        trigger: 'webhook',
        operation: 'deploy-pre-run-replace',
        source: 'container.runService',
      }),
    });

    expect(result.source).toBe('cds');
    expect(result.unexpected).toBe(false);
    expect(result.nextServiceStatus).toBe('stopped');
    expect(result.stopClass).toBe('cds-pre-run-replace');
    expect(result.reason.startsWith('由 GitHub webhook 代码推送自动触发部署')).toBe(true);
    expect(result.reason).toContain('分支 main');
    for (const field of ['requestId=req-123', 'operationId=op-123', 'operation=deploy-pre-run-replace', 'source=container.runService', 'trigger=webhook', 'signal=9']) {
      expect(result.reason).toContain(field);
    }
  });

  it('停止的三种语义给出三种不同的下一步', () => {
    const reasonOf = (kind: ContainerLifecycleIntent['kind'], reason: string) =>
      classifyDockerLifecycleEvent({
        ...base, action: 'die', exitCode: 0,
        lifecycleIntent: intentOf({ kind, reason, actor: 'ai', trigger: 'manual' }),
      }).reason;

    // 有人主动停的：原地重启即可
    expect(reasonOf('cds-stop', '用户在分支面板停止服务')).toContain('重新启动');
    // 自动降温：本来就会自动回来，不该催人去点
    expect(reasonOf('cds-stop-idle', '调度器降温（保留容器，可秒级唤醒）')).toContain('无需处理');
    // 失败收尾：不许说成无需处理，要先查
    const failure = reasonOf('cds-stop-after-failure', 'replica-member-not-ready');
    expect(failure).toContain('看容器日志确认那次失败的原因');
    expect(failure).not.toContain('无需处理');
  });

  it('基础设施的停止 / 删除 / 重建，下一步各不相同', () => {
    const reasonOf = (kind: ContainerLifecycleIntent['kind']) =>
      classifyDockerLifecycleEvent({
        ...base, action: 'die',
        lifecycleIntent: intentOf({ kind, reason: 'x', actor: 'ai', trigger: 'manual' }),
      }).reason;

    expect(reasonOf('cds-infra-stop')).toContain('重新启动');
    // 删除把登记也删了，叫人去「重新启动」等于指向一个不存在的入口
    expect(reasonOf('cds-infra-remove')).toContain('重新添加');
    expect(reasonOf('cds-infra-remove')).not.toContain('重新启动');
    expect(reasonOf('cds-infra-recreate')).toContain('等新容器起来');
  });

  it('未知 actor 原样带出，两者都缺时明说未记录', () => {
    const named = classifyDockerLifecycleEvent({
      ...base, action: 'kill',
      lifecycleIntent: intentOf({ kind: 'cds-stop', actor: 'alice@example.com', trigger: 'manual' }),
    });
    expect(named.reason.startsWith('由 alice@example.com 手动触发')).toBe(true);

    const anonymous = classifyDockerLifecycleEvent({
      ...base, action: 'destroy',
      lifecycleIntent: intentOf({ kind: 'cds-stale-cleanup', reason: '清理残留容器' }),
    });
    expect(anonymous.reason).toContain('未记录触发者');
  });

  it('OOM：不许归因成容器自己的内存上限', () => {
    const result = classifyDockerLifecycleEvent({ ...base, action: 'die', exitCode: 137, oomKilled: true });
    expect(result.source).toBe('oom');
    expect(result.stopClass).toBe('oom-kill');
    expect(result.reason).toContain('OOM killer');
    // CDS 默认不给分支服务容器下发 --memory，说「调大它的上限」会把宿主级压力指错地方
    expect(result.reason).toContain('宿主整体内存');
    expect(result.reason).not.toMatch(/调大这个服务的内存上限|超过了分配给它的上限/);
  });

  it('没匹配到停止意图，不等于跟 CDS 无关', () => {
    const crash = classifyDockerLifecycleEvent({ ...base, action: 'die', exitCode: 2, branchName: 'feature/x' });
    expect(crash.source).toBe('crash');
    expect(crash.stopClass).toBe('process-exit-error');
    // 自动重启走 docker start，同样不留停止意图——不许一口咬定跟 CDS 无关
    expect(crash.reason).toContain('这不等于 CDS 没碰过它');
    expect(crash.reason).not.toContain('不是任何人在 CDS 上的操作');
  });

  it('正常退出与 SIGTERM 退出分别措辞，且都说明不是崩溃', () => {
    const zero = classifyDockerLifecycleEvent({ ...base, action: 'die', exitCode: 0 });
    expect(zero.stopClass).toBe('normal-exit');
    expect(zero.unexpected).toBe(false);
    expect(zero.reason).toContain('这不是崩溃');

    const sigterm = classifyDockerLifecycleEvent({ ...base, action: 'die', exitCode: 143 });
    expect(sigterm.stopClass).toBe('normal-exit');
    expect(sigterm.reason).toContain('收到停止信号后正常退出');
  });

  it('外因追不到的三条，都说清没匹配到什么并给出去哪儿查', () => {
    const cases = [
      classifyDockerLifecycleEvent({ ...base, action: 'die', exitCode: 137, attrs: { signal: '9' } }),
      classifyDockerLifecycleEvent({ ...base, action: 'kill', exitCode: 137 }),
      classifyDockerLifecycleEvent({ ...base, action: 'destroy' }),
    ];
    for (const result of cases) {
      expect(result.reason).toContain('CDS 这边没有匹配到');
      expect(result.reason).toContain('下一步：');
    }
    expect(cases[0].stopClass).toBe('sigkill-no-oom-evidence');
    expect(cases[1].stopClass).toBe('external-docker-kill');
    expect(cases[2].stopClass).toBe('docker-destroy-remove');
  });

  it('没有分支名时退回容器名，不猜一个分支出来', () => {
    const result = classifyDockerLifecycleEvent({ ...base, action: 'die', exitCode: 2 });
    expect(result.reason).toContain(`${base.containerName} 这个容器`);
    expect(result.reason).not.toContain('分支 ');
  });
});

// ── 第三层：状态优先。能用状态的必须用状态，关键字匹配只兜存量 ──
describe('状态优先，关键字只兜存量', () => {
  it('已经表过态的意图，不许被关键字改判', () => {
    // reason 里带「失败」，但调用方明确表态这是降温——以状态为准
    expect(refineLegacyStopKind({
      containerName: 'x', kind: 'cds-stop-idle', reason: '降温失败重试后停机', requestedAt: '',
    })).toBe('cds-stop-idle');
  });

  it('只有通用 cds-stop 才回退到关键字归类', () => {
    const legacy = (reason: string) =>
      refineLegacyStopKind({ containerName: 'x', kind: 'cds-stop', reason, requestedAt: '' });
    expect(legacy('replica-member-not-ready')).toBe('cds-stop-after-failure');
    expect(legacy('调度器降温（保留容器，可秒级唤醒）')).toBe('cds-stop-idle');
    expect(legacy('auto-lifecycle 自动停止（保留容器，可秒级唤醒）')).toBe('cds-stop-idle');
    expect(legacy('项目已暂停，撤销本次自动唤醒')).toBe('cds-stop-idle');
    // 归不了类就老实留在 cds-stop，不硬凑
    expect(legacy('用户在分支面板停止服务')).toBe('cds-stop');
  });

  it('覆盖守卫：每个真实调用点都必须表态，一个都不许靠关键字兜底', () => {
    // 判据分工要分清楚：源码里的调用点**必须**给状态（它自己最清楚在干什么），
    // 关键字表只服务运行时读到的历史意图记录。
    // 第一版守卫写成「要么带状态、要么落得进匹配表」，结果撤回一处表态它照样绿——
    // 那等于默许新代码退回猜字符串，正是这次收敛要消灭的东西。
    const sources = ['../../src/index.ts', '../../src/services/replica-set.ts', '../../src/executor/routes.ts', '../../src/routes/branches.ts']
      .map((rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8'))
      .join('\n');

    // 逐个调用切片，而不是拿一条正则去套多行写法——守卫自己漏抓，就成了新的漏网源。
    // 只认容器停止那一类调用（containerService.stop / container.stop），
    // 别把 scheduler.stop()、monitor.stop() 这些同名方法卷进来。
    const calls = [...sources.matchAll(/\b(?:containerService|container)\.stop\(/g)]
      .map((match) => {
        const at = match.index ?? 0;
        const end = sources.indexOf('});', at);
        return sources.slice(at, end > at ? end : at + 400);
      })
      .map((segment) => ({ segment, reason: segment.match(/,\s*'([^']+)'/)?.[1] }))
      .filter((call): call is { segment: string; reason: string } => Boolean(call.reason));
    expect(calls.length).toBeGreaterThanOrEqual(6);

    const withoutState = calls
      .filter((call) => !call.segment.includes('kind:'))
      .map((call) => call.reason);

    expect(withoutState).toEqual([]);
  });

  it('匹配表覆盖历史上真实写入过的每一种 reason', () => {
    // 这些字面量来自 stop() 加 kind 之前的调用点，老容器上的意图记录就是这几种。
    // 少一条能归类的，历史事件就会退回通用 cds-stop，说成「有人主动停的」。
    const historical: Array<[string, string]> = [
      ['replica-member-not-ready', 'cds-stop-after-failure'],
      ['调度器降温（保留容器，可秒级唤醒）', 'cds-stop-idle'],
      ['auto-lifecycle 自动停止（保留容器，可秒级唤醒）', 'cds-stop-idle'],
      ['项目已暂停，撤销本次自动唤醒', 'cds-stop-idle'],
    ];
    for (const [reason, expected] of historical) {
      expect(refineLegacyStopKind({ containerName: 'x', kind: 'cds-stop', reason, requestedAt: '' }))
        .toBe(expected);
    }
    // 表本身不许空转：每条规则都得有一个真实样本命中它
    for (const rule of LEGACY_REASON_KINDS) {
      expect(historical.some(([reason]) => rule.pattern.test(reason))).toBe(true);
    }
  });

  it('接线守卫：每个 stopInfraService 调用点都对停止 / 删除 / 重建表过态', () => {
    const files = ['../../src/routes/branches.ts', '../../src/executor/routes.ts', '../../src/routes/project-infra-resync.ts'];
    const args = files
      .flatMap((rel) => [...fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
        .matchAll(/stopInfraService\(([^)]*)\)/g)]
        .map((m) => m[1]));

    expect(args.filter((a) => a.includes("'cds-infra-remove'")).length).toBe(2);
    expect(args.filter((a) => a.includes("'cds-infra-stop'")).length).toBe(2);
    // 其余留在默认的 recreate 上：重启与 resync 的更新阶段确实会起新容器
    expect(args.filter((a) => !a.includes('cds-infra-')).length).toBe(2);
  });

  it('展示面接线：docker-events 的 message 取完整人话段，不按句号截断', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/container-diagnostics.ts'),
      'utf8',
    );
    expect(source).toMatch(/message:\s*classification[\s\S]{0,600}classification\.reason/);
    expect(source).toContain("classification.reason.split('技术细节：')[0]");
    expect(source).not.toContain("classification.reason.split('。')[0]");
  });
});
