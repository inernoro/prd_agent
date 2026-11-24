// 服务状态说明的唯一构造器（`external-cause-first.md` 第四节）。
//
// 能力接口里的「为什么不健康」、任务被拒 / 被中止时的说明，全部由调用方填结构体、由这里渲染成
// 一句「谁 + 做了什么 → 于是怎样 → 要不要紧 / 下一步 → 技术细节」。分支碰不到句子的顺序，
// 「要不要紧」是有限枚举，带下一步的变体里下一步是必填字段——忘了给，编译不过。

export type ConditionActor =
  /** 部署侧给的东西不对：环境变量、运行镜像。label 说是哪一样。 */
  | { kind: 'deployment'; label: '部署配置' | '运行镜像' }
  /** OpenDesign 引擎进程自己。 */
  | { kind: 'engine' }
  /** 本服务按流程在做的事（任务结束后的清空、启动自检）。 */
  | { kind: 'service' }
  /** MAP（调用方）。 */
  | { kind: 'caller' }
  /** 追不到外因：必须说清查过哪些记录没匹配上。 */
  | { kind: 'unknown'; checked: string };

export type ConditionUrgency =
  | { kind: 'none' }
  | { kind: 'wait'; until: string }
  | { kind: 'act'; action: string }
  | { kind: 'investigate'; where: string };

export interface ServiceCondition {
  code: string;
  actor: ConditionActor;
  /** 人话动作 / 事件，接在主语后面。 */
  event: string;
  /** 用户或 MAP 能感知的后果。 */
  impact: string;
  urgency: ConditionUrgency;
  retryable: boolean;
  technical: Record<string, string | number | boolean | null>;
}

export interface RenderedCondition {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, string | number | boolean | null>;
}

function subject(actor: ConditionActor): string {
  switch (actor.kind) {
    case 'deployment': return actor.label;
    case 'engine': return 'OpenDesign 引擎进程';
    case 'service': return '本服务';
    case 'caller': return '调用方（MAP）';
    case 'unknown': return `未查明的原因（已核对：${actor.checked}，均未匹配）`;
  }
}

function urgencyText(urgency: ConditionUrgency): string {
  switch (urgency.kind) {
    case 'none': return '这是正常步骤，无需处理';
    case 'wait': return `等待${urgency.until}，无需人工处理`;
    case 'act': return `需要处理：${urgency.action}`;
    case 'investigate': return `需要排查：${urgency.where}`;
  }
}

export function renderCondition(condition: ServiceCondition): RenderedCondition {
  const technical = Object.entries(condition.technical)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
  const message = `${subject(condition.actor)}${condition.event}，${condition.impact}：${urgencyText(condition.urgency)}。`
    + (technical ? `技术细节：${technical}` : '');
  return {
    code: condition.code,
    message,
    retryable: condition.retryable,
    details: { code: condition.code, ...condition.technical },
  };
}
