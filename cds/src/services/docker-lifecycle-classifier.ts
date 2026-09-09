import type { ContainerLifecycleIntent, ContainerLifecycleIntentKind } from './container-diagnostics.js';

// 这里产出的 reason 会原样写进 branch.lastStopReason / service.errorMessage / 活动日志，
// 也就是人在分支面板上读到的那句话。按 .claude/rules/external-cause-first.md：
// 第一句必须回答「是谁的什么动作引起的、要不要紧」，signal / exitCode / operation /
// requestId 这些内因一个都不删（排障要用），但一律排到「技术细节：」之后。
// 反面教材就是这个文件的上一版：「CDS 生命周期操作导致容器停止：<name> signal=9；
// 已匹配 CDS 意图 cds-pre-run-replace（... actor=ai trigger=manual）」——外因字段其实
// 全采集到了，只是塞在第 40 个字之后的括号里，人读到的第一印象是一次事故。

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

// actor / trigger 是自由字符串，这两张表只翻译已知取值；翻不出来的原样带出（它很可能
// 是个人名或新加的调用方，编一个「系统自动」出来只会掩盖真实施动者）。
const ACTOR_LABELS: Record<string, string> = {
  ai: 'AI Agent',
  cds: 'CDS',
  system: 'CDS 系统',
  'system:webhook': 'GitHub webhook',
  scheduler: 'CDS 定时调度',
  janitor: 'CDS 后台清理',
  'auto-lifecycle': 'CDS 自动生命周期管理',
  'auto-restart': 'CDS 自动重启',
  'docker-events': 'CDS 事件同步',
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: '手动触发',
  webhook: '代码推送自动触发',
  scheduler: '定时任务自动触发',
  janitor: '后台清理任务自动触发',
  system: '系统自动触发',
  'auto-lifecycle': '自动生命周期管理触发',
  'auto-restart': '自动重启流程触发',
  'preview-access': '有人访问预览地址唤醒触发',
};

// 每种 CDS 意图对应「发生了什么」+「要不要紧」。Record 写全枚举，新增 kind 时 TS 会红，
// 逼着人补这两句话，而不是让新意图静默退化成一句没有结论的通用文案。
const INTENT_NARRATIVE: Record<ContainerLifecycleIntentKind, { story: string; verdict: string }> = {
  'cds-pre-run-replace': {
    story: '部署，CDS 按流程停掉了上一版容器',
    verdict: '这是替换旧容器的正常步骤，无需处理；新容器起来后预览自动恢复',
  },
  'cds-stop': {
    story: '停止这个服务，容器随之退出',
    // 不写死「无需处理」：同一个 kind 既承接手动停止与调度降温，也承接
    // replica-member-not-ready 这类失败收尾（replica-set.ts:994）。说成无需处理
    // 会把就绪失败盖掉，所以把判断交给紧随其后的那句 CDS 记录原因（Codex P2）。
    verdict: '这是 CDS 主动停的，不是崩溃；原因见下一句，若它指向一次失败，重启前先看容器日志',
  },
  'cds-remove': {
    story: '删除这个容器',
    verdict: '这是主动删除，无需处理',
  },
  'cds-stale-cleanup': {
    story: '清理残留容器，这个无主容器被回收',
    verdict: '这是正常回收，无需处理',
  },
  'cds-infra-stop': {
    story: '停止这个基础设施容器（停完即删除）',
    verdict: '这是主动停止，不会自动重建；要它回来就去项目设置的基础设施里重新启动',
  },
  'cds-infra-recreate': {
    story: '重建基础设施容器，旧容器被先删除',
    verdict: '这是重建流程的一部分，等新容器起来即可',
  },
};

function describeInitiator(intent: ContainerLifecycleIntent): string {
  const actorRaw = String(intent.actor || '').trim();
  const triggerRaw = String(intent.trigger || '').trim();
  const actor = ACTOR_LABELS[actorRaw] || actorRaw;
  const trigger = TRIGGER_LABELS[triggerRaw] || (triggerRaw ? `以 ${triggerRaw} 方式触发` : '');
  if (actor && trigger) return `${actor} ${trigger}`;
  if (actor) return actor;
  if (trigger) return `CDS ${trigger}`;
  // 追不到施动者就说追不到（no-rootless-tree），不许拿「系统」顶上。
  return 'CDS（未记录触发者）';
}

function technicalTail(parts: Array<string | false | undefined | null>): string {
  const body = parts.filter(Boolean).join(' ');
  return body ? `技术细节：${body}` : '';
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

  if (event.oomKilled || action === 'oom') {
    return {
      source: 'oom',
      nextServiceStatus: 'error',
      nextBranchStatus: 'error',
      // 归因到此为止：内核确实因内存不足杀了它，但「谁的内存不够」这条事件答不了。
      // CDS 默认不给分支服务容器下发 --memory（container.ts 2026-05-28 起彻底删除），
      // 所以写「超过了它的内存上限、调大上限即可」会把宿主级内存压力指到错误的地方。
      reason: `${subject}被内核的 OOM killer 杀掉了 —— 内存不够，不是任何人在 CDS 上的操作。`
        + `但「谁的内存不够」这条事件答不了：可能是这个服务自己吃太多，也可能是宿主整体内存被挤爆`
        + `（CDS 默认不给分支服务容器设 --memory 上限，所以后者更常见）。`
        + `下一步：先看这个容器有没有内存限制、它的内存曲线，再对照宿主的内存记录与 dmesg 判断是哪一种。`
        + technicalTail([name, exitText, oom || 'OOMKilled=true', signalText]),
      stopClass: 'oom-kill',
      unexpected: true,
    };
  }

  if (intent) {
    const narrative = INTENT_NARRATIVE[intent.kind]
      || { story: `执行「${intent.reason}」`, verdict: '这是 CDS 的主动操作，无需处理' };
    return {
      source: 'cds',
      nextServiceStatus: 'stopped',
      nextBranchStatus: 'idle',
      // 一句话里同时给出「谁做了什么」和「要不要紧」——只读到第一个句号的人
      // 也不会把一次正常替换看成事故；随后单独一句摆出上游记录的原因原文。
      reason: `由 ${describeInitiator(intent)}${narrative.story}（${scope}）——${narrative.verdict}。`
        + (intent.reason ? `CDS 记录的原因：${intent.reason}。` : '')
        + technicalTail([
          name,
          exitText,
          signalText,
          `kind=${intent.kind}`,
          intent.operation ? `operation=${intent.operation}` : '',
          intent.source ? `source=${intent.source}` : '',
          intent.requestId ? `requestId=${intent.requestId}` : '',
          intent.operationId ? `operationId=${intent.operationId}` : '',
          intent.actor ? `actor=${intent.actor}` : '',
          intent.trigger ? `trigger=${intent.trigger}` : '',
        ]),
      stopClass: intent.kind,
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
        // 外因追不到就如实说追不到，并给出去哪儿接着查 —— 这比编一个像样的原因有用。
        reason: `${subject}被 SIGKILL 强制终止，但 CDS 这边没有匹配到任何停止 / 替换 / 清理操作，`
          + `也没有 OOMKilled 证据，所以追不到是谁干的：多半来自 CDS 之外（宿主上的人工 `
          + `docker kill/stop、别的工具、或宿主重启）。下一步：查宿主的 docker events 与登录操作记录。`
          + technicalTail([name, exitText, signalText]),
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
          ? `${subject}里的主进程收到停止信号后正常退出，CDS 这边没有对应的停止操作记录，`
            + `多半是宿主或容器编排发的停止。这不是崩溃；服务确实已经不在跑了，需要它就重新启动。`
            + technicalTail([name, exitText, signalText])
          : `${subject}里的主进程自己正常结束了（退出码 0），没有人在 CDS 上停它。`
            + `这不是崩溃；如果这个服务本该常驻，多半是容器里的命令跑完就退了，下一步看容器日志确认。`
            + technicalTail([name, exitText, signalText]),
        stopClass: 'normal-exit',
        unexpected: false,
      };
    }
    return {
      source: 'crash',
      nextServiceStatus: 'error',
      nextBranchStatus: 'error',
      reason: `${subject}里的进程自己崩了（退出码 ${exitCode ?? '未知'}），不是任何人在 CDS 上的操作，`
        + `通常是应用启动失败或运行中抛异常退出。下一步：看容器日志最后几十行定位崩溃点。`
        + technicalTail([name, exitText, oom, signalText]),
      stopClass: 'process-exit-error',
      unexpected: true,
    };
  }

  if (action === 'kill') {
    return {
      source: 'external',
      nextServiceStatus: 'error',
      nextBranchStatus: 'error',
      reason: `${subject}收到了 docker kill，但 CDS 这边没有匹配到任何停止 / 删除 / 重部署意图，`
        + `所以追不到是谁干的：很可能是宿主上的人工操作或另一个工具。`
        + `下一步：查宿主的 docker events 与登录操作记录。`
        + technicalTail([name, exitText, signalText]),
      stopClass: 'external-docker-kill',
      unexpected: true,
    };
  }

  return {
    source: 'system',
    nextServiceStatus: 'stopped',
    nextBranchStatus: 'idle',
    reason: `${subject}被 Docker 删除（destroy/remove 事件），CDS 这边没有匹配到对应的删除意图。`
      + `这通常是重建或清理流程的收尾动作；若这会儿并没有人在部署或清理，就要查宿主上是谁删的。`
      + technicalTail([name, exitText, oom]),
    stopClass: 'docker-destroy-remove',
    unexpected: false,
  };
}
