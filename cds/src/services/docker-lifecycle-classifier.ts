import type { ContainerLifecycleIntent, ContainerLifecycleIntentKind } from './container-diagnostics.js';
import { renderCause, type CauseStatement, type Verdict } from './cause-statement.js';

// 这里产出的 reason 会原样写进 branch.lastStopReason / service.errorMessage / 活动日志，
// 也就是人在分支面板上读到的那句话。
//
// 本文件只负责**判断**：这次停止属于哪一类、谁干的、要不要紧。句子怎么排由
// cause-statement.ts 的 renderCause 唯一决定，八条路径都碰不到拼接。
// 这么分是有来历的：上一版八条路径各自拼字符串，靠十五条守卫抽查措辞，结果连着
// 六轮 review 都在同一个地方漏（结论掉到第二句、某条路径没给下一步、展示面截断把
// 结论切掉）。判断收敛成有限枚举之后，那几类漏法在编译期就不成立了。

export interface DockerLifecycleEventForClassification {
  action: string;
  containerName?: string;
  status?: string;
  exitCode?: number;
  oomKilled?: boolean;
  attrs: Record<string, string>;
  lifecycleIntent?: ContainerLifecycleIntent;
  // 人话的目标称呼。docker 事件里只有 cds.branch.id 这个 label，没有分支名，所以这是
  // 可选的：调用方（index.ts 的事件同步已从 stateService 拿到 branch）能给就给，
  // 给不出就退化成容器名 —— 宁可称呼笨一点，也不猜一个分支名出来。
  branchName?: string;
}

export interface DockerLifecycleClassification {
  source: 'crash' | 'system' | 'cds' | 'external' | 'oom';
  nextServiceStatus: 'error' | 'stopped';
  nextBranchStatus: 'error' | 'idle';
  reason: string;
  stopClass: string;
  unexpected: boolean;
}

/**
 * 每种 CDS 意图对应「发生了什么」+「要不要紧」。
 *
 * Record 写全枚举：新增一种意图而不在这里给出结论，编译就过不去。这比「新增后忘了写、
 * 静默退化成一句没有结论的通用文案」强——后者正是 cds-infra-stop 那次的漏法。
 */
const INTENT_NARRATIVE: Record<
  ContainerLifecycleIntentKind,
  { happening: string; verdict: Verdict; clarification?: string }
> = {
  'cds-pre-run-replace': {
    happening: '部署，CDS 按流程停掉了上一版容器',
    verdict: { kind: 'wait', until: '新容器起来，预览会自动恢复' },
  },
  'cds-stop': {
    happening: '停止这个服务，容器随之退出',
    verdict: { kind: 'act', nextStep: '要它继续跑就在分支面板重新启动' },
    clarification: '这不是崩溃',
  },
  'cds-stop-idle': {
    happening: '把这个服务降温停机',
    verdict: {
      kind: 'no-action',
      because: '容器保留着可以秒级唤醒，这是 CDS 的自动省资源策略，需要时会自动或手动重新拉起',
    },
    clarification: '这不是崩溃',
  },
  'cds-stop-after-failure': {
    // 「发生了什么」与 cds-stop 相同（都是停止）；不同的是为什么停、要不要紧——
    // 那两样在 verdict 与 clarification 里，不必挤进现象描述。
    happening: '停止这个服务',
    verdict: { kind: 'inspect', where: '看容器日志确认那次失败的原因，修掉再重启' },
    clarification: '这不是有人主动停的，是一次失败之后的收尾',
  },
  'cds-remove': {
    happening: '删除这个容器',
    verdict: { kind: 'no-action' },
  },
  'cds-stale-cleanup': {
    happening: '清理残留容器，这个无主容器被回收',
    verdict: { kind: 'no-action', because: '它已经没有对应的分支或服务了' },
  },
  'cds-infra-stop': {
    happening: '停止这个基础设施容器',
    verdict: { kind: 'act', nextStep: '要它回来就去项目设置的基础设施里重新启动' },
  },
  'cds-infra-remove': {
    // 与 stop 的差别全在下一步：登记也一起删了，原来的条目不存在了，重启无从点起。
    happening: '删除这个基础设施服务，容器与登记一起删',
    verdict: { kind: 'act', nextStep: '原来的登记已经没了，要它回来得去项目设置的基础设施里重新添加一个' },
  },
  'cds-infra-recreate': {
    happening: '重建基础设施容器，旧容器被先删除',
    verdict: { kind: 'wait', until: '新容器起来' },
  },
};

/**
 * 存量兜底：状态拿不到时，才用关键字把自由文本归类回状态。
 *
 * 新写入的路径都已经直接给状态（调用方最清楚自己在干什么），所以这张表只服务
 * 一种输入：老容器上还留着的意图记录——那时 stop() 还没有 kind，全都记成通用的
 * cds-stop，语义只藏在 reason 字符串里。
 *
 * 它是数据不是 if：新增一条就在这里加一行，且下面的覆盖守卫会扫真实调用点的
 * reason 字面量，任何一条既没有显式状态、又落不进这张表的，测试直接红。
 */
export const LEGACY_REASON_KINDS: ReadonlyArray<{ pattern: RegExp; kind: ContainerLifecycleIntentKind }> = [
  { pattern: /not[- ]?ready|readiness|failed|failure|失败|超时/i, kind: 'cds-stop-after-failure' },
  { pattern: /降温|auto-lifecycle|已暂停|撤销本次自动唤醒|idle/i, kind: 'cds-stop-idle' },
];

/** 通用 cds-stop 才需要归类；已经表过态的意图原样用，不许被关键字改判。 */
export function refineLegacyStopKind(intent: ContainerLifecycleIntent): ContainerLifecycleIntentKind {
  if (intent.kind !== 'cds-stop') return intent.kind;
  const reason = String(intent.reason || '');
  return LEGACY_REASON_KINDS.find((rule) => rule.pattern.test(reason))?.kind ?? 'cds-stop';
}

export function classifyDockerLifecycleEvent(
  event: DockerLifecycleEventForClassification,
): DockerLifecycleClassification {
  const action = String(event.action || '').toLowerCase();
  const exitCode = Number.isFinite(event.exitCode) ? event.exitCode : undefined;
  const exitText = exitCode !== undefined ? `exitCode=${exitCode}` : '';
  const oom = event.oomKilled ? 'OOMKilled=true' : '';
  const signalText = event.attrs?.signal ? `signal=${event.attrs.signal}` : '';
  const name = event.containerName || 'unknown-container';
  const branchName = String(event.branchName || '').trim();
  // scope 用来在括号里标归属，subject 用来当句子主语；两者都以中文收尾，
  // 免得「容器 cds-x-api里的进程」这种中英粘连。
  const scope = branchName ? `分支 ${branchName}` : `容器 ${name}`;
  const subject = branchName ? `分支 ${branchName} 的容器` : `${name} 这个容器`;
  const intent = event.lifecycleIntent;

  /** 八条路径的共同出口：只填结构体，句子交给唯一渲染器。 */
  const say = (statement: Omit<CauseStatement, 'scope'>): string =>
    renderCause({ ...statement, scope });

  if (event.oomKilled || action === 'oom') {
    return {
      source: 'oom',
      nextServiceStatus: 'error',
      nextBranchStatus: 'error',
      reason: say({
        initiator: { kind: 'kernel' },
        happening: `${subject}被内核的 OOM killer 杀掉了（内存不够）`,
        // 归因到此为止：内核确实因内存不足杀了它，但「谁的内存不够」这条事件答不了。
        // CDS 默认不给分支服务容器下发 --memory，所以写「调大它的内存上限」会把
        // 宿主级内存压力指到错误的地方。
        clarification: '「谁的内存不够」这条事件答不了：可能是这个服务自己吃太多，'
          + '也可能是宿主整体内存被挤爆（CDS 默认不给分支服务容器设 --memory 上限，所以后者更常见）',
        verdict: {
          kind: 'inspect',
          where: '先看这个容器有没有内存限制、它的内存曲线，再对照宿主的内存记录与 dmesg 判断是哪一种',
        },
        evidence: [name, exitText, oom || 'OOMKilled=true', signalText],
      }),
      stopClass: 'oom-kill',
      unexpected: true,
    };
  }

  if (intent) {
    const kind = refineLegacyStopKind(intent);
    const narrative = INTENT_NARRATIVE[kind]
      || { happening: `执行「${intent.reason}」`, verdict: { kind: 'no-action' } as Verdict };
    return {
      source: 'cds',
      nextServiceStatus: 'stopped',
      nextBranchStatus: 'idle',
      reason: say({
        initiator: { kind: 'cds-intent', intent },
        happening: narrative.happening,
        clarification: narrative.clarification,
        verdict: narrative.verdict,
        // 上游记录的原因原文不许被固定文案盖掉。
        recordedReason: intent.reason || undefined,
        evidence: [
          name,
          exitText,
          signalText,
          `kind=${kind}`,
          intent.operation ? `operation=${intent.operation}` : '',
          intent.source ? `source=${intent.source}` : '',
          intent.requestId ? `requestId=${intent.requestId}` : '',
          intent.operationId ? `operationId=${intent.operationId}` : '',
          intent.actor ? `actor=${intent.actor}` : '',
          intent.trigger ? `trigger=${intent.trigger}` : '',
        ],
      }),
      stopClass: kind,
      unexpected: false,
    };
  }

  if (action === 'die') {
    const normalExit = exitCode === 0 || exitCode === 143;
    const sigkill = exitCode === 137;
    if (sigkill) {
      return {
        source: 'external',
        nextServiceStatus: 'error',
        nextBranchStatus: 'error',
        reason: say({
          // 追不到就选 unmatched，并说清查过哪些账本——这比编一个像样的原因有用。
          initiator: { kind: 'unmatched', missing: '任何停止 / 替换 / 清理操作，也没有 OOMKilled 证据' },
          happening: `${subject}被 SIGKILL 强制终止`,
          clarification: '追不到是谁干的，多半来自 CDS 之外（宿主上的人工 docker kill/stop、别的工具、或宿主重启）',
          verdict: { kind: 'inspect', where: '查宿主的 docker events 与登录操作记录' },
          evidence: [name, exitText, signalText],
        }),
        stopClass: 'sigkill-no-oom-evidence',
        unexpected: true,
      };
    }
    if (normalExit) {
      return {
        source: 'system',
        nextServiceStatus: 'stopped',
        nextBranchStatus: 'idle',
        reason: exitCode === 143
          ? say({
            initiator: { kind: 'process', caveat: '多半是宿主或容器编排发的停止' },
            happening: `${subject}里的主进程收到停止信号后正常退出`,
            clarification: '这不是崩溃；服务确实已经不在跑了',
            verdict: { kind: 'act', nextStep: '需要它就重新启动' },
            evidence: [name, exitText, signalText],
          })
          : say({
            initiator: { kind: 'process' },
            happening: `${subject}里的主进程自己正常结束了（退出码 0）`,
            clarification: '这不是崩溃',
            verdict: {
              kind: 'inspect',
              where: '看容器日志确认它是不是本该常驻；多半是容器里的命令跑完就退了',
            },
            evidence: [name, exitText, signalText],
          }),
        stopClass: 'normal-exit',
        unexpected: false,
      };
    }
    return {
      source: 'crash',
      nextServiceStatus: 'error',
      nextBranchStatus: 'error',
      reason: say({
        // 没匹配到停止意图只能说明「没有匹配到停止操作」，不能反推 CDS 没碰过它：
        // 自动重启走的是 docker start，同样不留停止意图。
        initiator: { kind: 'process', caveat: '但这不等于 CDS 没碰过它，自动重启刚把它拉起来也会走到这里' },
        happening: `${subject}里的进程自己退出了（退出码 ${exitCode ?? '未知'}）`,
        clarification: '通常是应用启动失败或运行中抛异常退出',
        verdict: { kind: 'inspect', where: '看容器日志最后几十行定位崩溃点' },
        evidence: [name, exitText, oom, signalText],
      }),
      stopClass: 'process-exit-error',
      unexpected: true,
    };
  }

  if (action === 'kill') {
    return {
      source: 'external',
      nextServiceStatus: 'error',
      nextBranchStatus: 'error',
      reason: say({
        initiator: { kind: 'unmatched', missing: '任何停止 / 删除 / 重部署意图' },
        happening: `${subject}收到了 docker kill`,
        clarification: '追不到是谁干的：很可能是宿主上的人工操作或另一个工具',
        verdict: { kind: 'inspect', where: '查宿主的 docker events 与登录操作记录' },
        evidence: [name, exitText, signalText],
      }),
      stopClass: 'external-docker-kill',
      unexpected: true,
    };
  }

  return {
    source: 'system',
    nextServiceStatus: 'stopped',
    nextBranchStatus: 'idle',
    reason: say({
      initiator: { kind: 'unmatched', missing: '对应的删除意图' },
      happening: `${subject}被 Docker 删除（destroy/remove 事件）`,
      clarification: '这通常是重建或清理流程的收尾动作，多数情况无需处理',
      verdict: { kind: 'inspect', where: '若这会儿并没有人在部署或清理，就去查宿主上是谁删的' },
      evidence: [name, exitText, oom],
    }),
    stopClass: 'docker-destroy-remove',
    unexpected: false,
  };
}
