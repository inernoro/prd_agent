/**
 * 诊断语句的唯一构造器。
 *
 * 契约见 .claude/rules/external-cause-first.md：任何解释「为什么会这样」的输出，
 * 第一句必须说清是谁的什么动作引起的、要不要紧，内因排到「技术细节：」之后。
 *
 * 这个文件存在的理由是：那条契约以前靠「八条分支各自小心地拼字符串 + 十五条守卫
 * 事后抽查措辞」维持，于是连着六轮 review 都在同一个地方漏（结论漏在第二句、
 * 某条路径没给下一步、某个分支被守卫的 path filter 漏掉）。现在把它换成
 * 「分支只填结构体，句子由这里唯一渲染」：
 *
 *   - 忘了给结论      -> Verdict 是必填字段，编译不过
 *   - 给了结论没给下一步 -> act / inspect 变体的字段是必填的，编译不过
 *   - 结论跑到第二句   -> 顺序写死在 renderCause 里，分支碰不到
 *   - 内因混进外因段   -> 同上
 *   - 追不到施动者却不说 -> Initiator 是四选一，unmatched 是显式的值而不是空
 *
 * 也就是把「能用类型表达的不变量」从测试断言搬进类型系统。守卫只留类型表达不了的那部分。
 */
import type { ContainerLifecycleIntent } from './container-diagnostics.js';

/**
 * 「要不要紧 + 下一步」。刻意做成有限枚举而不是自由文本：
 * 判断一旦能自由书写，下一轮就会有人只写现象不写结论，而那正是本规则要禁的事。
 */
export type Verdict =
  /** 不用管。because 补一句为什么不用管（可选，不承载下一步）。 */
  | { kind: 'no-action'; because?: string }
  /** 不用管，但要等一件事发生——必须说清等什么，否则读者只能干等。 */
  | { kind: 'wait'; until: string }
  /** 要动手——必须说清动什么。 */
  | { kind: 'act'; nextStep: string }
  /** 要先查——必须说清查哪儿。 */
  | { kind: 'inspect'; where: string };

/**
 * 「谁」。四选一，穷尽了这类事件的全部可能来源。
 * unmatched 是一个显式的选择，不是「忘了填」的空值：选它就必须说清没匹配到什么。
 */
export type Initiator =
  /** CDS 自己的操作，且留下了意图记录（谁、什么时候、哪个入口都在里面）。 */
  | { kind: 'cds-intent'; intent: ContainerLifecycleIntent }
  /** 内核（OOM killer 这类）。 */
  | { kind: 'kernel' }
  /** 容器里的进程自己。caveat 用来限定这个归因（例如自动重启刚拉起来的进程崩了也走这条）。 */
  | { kind: 'process'; caveat?: string }
  /** 追不到。missing 说明「没匹配到什么」，读者据此知道 CDS 查过哪些账本。 */
  | { kind: 'unmatched'; missing: string };

export interface CauseStatement {
  /** 谁 */
  initiator: Initiator;
  /** 发生了什么：主语 + 动作，只陈述现象，不下判断 */
  happening: string;
  /** 归属标注，渲染在 cds-intent 句式的括号里（如「分支 main」） */
  scope: string;
  /** 要不要紧 + 下一步 */
  verdict: Verdict;
  /** 对结论的澄清（如「这不是崩溃」），可选，同样不承载下一步 */
  clarification?: string;
  /** 上游记录的原因原文。有就原样摆出来，不许被固定文案盖掉 */
  recordedReason?: string;
  /** 内因证据：signal / exitCode / operation / requestId… 一个都不删，只是排在后面 */
  evidence: Array<string | false | undefined | null>;
}

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
  'replica-set': 'CDS 副本集管理',
  executor: 'CDS 远端执行器',
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
  'replica-set-readiness-failed': '在副本就绪检查失败后触发',
};

/**
 * 把 actor / trigger 翻译成人话。两张表只翻译已知取值；翻不出来的原样带出——
 * 它很可能是个人名或新加的调用方，编一个「系统自动」出来只会掩盖真实施动者。
 */
export function describeIntentInitiator(intent: ContainerLifecycleIntent): string {
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

function renderVerdict(verdict: Verdict): string {
  switch (verdict.kind) {
    case 'no-action':
      return verdict.because ? `无需处理，${verdict.because}` : '无需处理';
    case 'wait':
      return `无需处理，等${verdict.until}`;
    case 'act':
      return `需要处理。下一步：${verdict.nextStep}`;
    case 'inspect':
      return `下一步：${verdict.where}`;
    default: {
      // 新增 Verdict 变体而没在这里处理，这一行编译不过——结论的渲染永远是穷尽的。
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function renderLead(statement: CauseStatement): string {
  const initiator = statement.initiator;
  switch (initiator.kind) {
    case 'cds-intent':
      return `由 ${describeIntentInitiator(initiator.intent)}${statement.happening}（${statement.scope}）`;
    case 'kernel':
      return `${statement.happening}，CDS 这边没有匹配到任何停止 / 替换 / 清理操作，这一下是内核发的`;
    case 'process':
      return `${statement.happening}，CDS 这边没有匹配到任何停止操作`
        + (initiator.caveat ? `——${initiator.caveat}` : '');
    case 'unmatched':
      return `${statement.happening}，但 CDS 这边没有匹配到${initiator.missing}`;
    default: {
      // 同上：新增 Initiator 变体必须在这里给出句式。
      const exhaustive: never = initiator;
      return exhaustive;
    }
  }
}

/**
 * 全仓唯一拼这句话的地方。顺序写死在这里，调用方绕不过去：
 *
 *   <谁 + 发生了什么>——<要不要紧 + 下一步>。[澄清。][CDS 记录的原因：原文。]技术细节：<内因>
 *
 * 展示面只取「技术细节：」之前那一段也读得完整（container-diagnostics 就是这么用的）。
 */
export function renderCause(statement: CauseStatement): string {
  const lead = renderLead(statement);
  const verdict = renderVerdict(statement.verdict);
  const clarification = statement.clarification ? `${statement.clarification}。` : '';
  const recorded = statement.recordedReason ? `CDS 记录的原因：${statement.recordedReason}。` : '';
  const evidence = statement.evidence.filter(Boolean).join(' ');
  const technical = evidence ? `技术细节：${evidence}` : '';
  return `${lead}——${verdict}。${clarification}${recorded}${technical}`;
}
