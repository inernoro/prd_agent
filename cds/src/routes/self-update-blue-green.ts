/**
 * Self-Update Blue-Green Branch — self-update / self-force-sync 路由的"切换"判定 + 编排(B'.5)
 *
 * 这是一段**可单测**的纯函数式分支:
 *   1. 判定本次 self-update 是否符合"走蓝绿"四个条件
 *      (env CDS_ENABLE_BLUE_GREEN=1 / 非 CDS_DISABLE / supervisor 非空 / 需要 restart)
 *   2. 调 supervisor.switchActive(),把 stage 转成 SSE step 事件喷给前端
 *   3. 成功 → sendSSE 'done' { mode:'blue-green' } + recordSelfUpdate updateMode='blue-green';
 *      失败 → emit warning 让调用方继续走老 process.exit + spawn 路径
 *   4. 不调 process.exit / spawn — 那是老路径职责;蓝绿成功路径的 daemon "原地存活"
 *
 * 跟 .claude/rules/compute-then-send.md 的契合:
 *   - "判定"阶段(decideShouldUseBlueGreen)纯计算,可 100% mock 单测
 *   - "发送"阶段(runBlueGreenSwitch)只接收 supervisor 引用,不做二次 resolve
 *
 * 调用方约定:返回 { handled: true, success: true } 时 caller 必须 return,
 *   不再走 老 process.exit + spawn 路径;handled=true success=false 时 caller 继续走老路径。
 */
import type { BlueGreenSupervisor } from '../services/blue-green-supervisor.js';
import type {
  SwitchResult,
  SupervisorStage,
} from '../services/blue-green-supervisor.types.js';

/** stateService.recordSelfUpdate 接受的精简形态(routes/branches.ts 已有相同字段)。 */
export interface SelfUpdateRecorder {
  recordSelfUpdate(record: {
    ts: string;
    branch: string;
    fromSha: string;
    toSha: string;
    trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
    status: 'success' | 'failed' | 'aborted';
    durationMs?: number;
    error?: string;
    actor?: string;
    /** B'.5 起新增 'blue-green' 联合分支。 */
    updateMode?:
      | 'hot-reload'
      | 'restart'
      | 'noOp'
      | 'web-only'
      | 'doc-only'
      | 'blue-green';
    [k: string]: unknown;
  }): void;
}

/**
 * 蓝绿适用性判定输入。`needsRestart` 由 self-update 路由的 analyzeChangeImpact 输出;
 * 没分析过(如 self-update 旧路径在 esbuild 之后才到这一步)就传 true。
 */
export interface BlueGreenEligibilityInput {
  /** process.env / 测试覆盖。读 CDS_ENABLE_BLUE_GREEN / CDS_DISABLE_BLUE_GREEN。 */
  env: NodeJS.ProcessEnv;
  /** Bootstrap 注入的 supervisor。null = 完全禁用蓝绿。 */
  supervisor: BlueGreenSupervisor | null;
  /** 本次更新是否需要 daemon 重启(false 等于 web-only / doc-only / no-op,这些不需要切 daemon)。 */
  needsRestart: boolean;
  /** validate(pnpm install + tsc --noEmit)是否通过(false 直接 abort,根本不到这一步)。 */
  validationPassed: boolean;
}

export interface BlueGreenEligibilityResult {
  /** 是否走蓝绿。 */
  eligible: boolean;
  /** 不走蓝绿时,人类可读的"为啥"(测试断言用)。 */
  reason?:
    | 'env-not-enabled'
    | 'env-explicitly-disabled'
    | 'no-supervisor'
    | 'no-restart-needed'
    | 'validation-failed';
}

/**
 * 判定函数 — 纯计算。所有四个条件全满足才返 eligible:true。
 *
 * 优先级(任一不满足直接返回):
 *   1. CDS_DISABLE_BLUE_GREEN=1 (紧急熔断,优先于 ENABLE)
 *   2. CDS_ENABLE_BLUE_GREEN=1
 *   3. supervisor != null
 *   4. needsRestart=true && validationPassed=true
 */
export function decideShouldUseBlueGreen(
  input: BlueGreenEligibilityInput,
): BlueGreenEligibilityResult {
  // 1. 紧急熔断优先级最高
  if (input.env.CDS_DISABLE_BLUE_GREEN === '1') {
    return { eligible: false, reason: 'env-explicitly-disabled' };
  }
  // 2. 显式 enable 才走
  if (input.env.CDS_ENABLE_BLUE_GREEN !== '1') {
    return { eligible: false, reason: 'env-not-enabled' };
  }
  // 3. supervisor 必须实例化
  if (!input.supervisor) {
    return { eligible: false, reason: 'no-supervisor' };
  }
  // 4. 不需要重启 / validate 失败 → 不走蓝绿
  if (!input.validationPassed) {
    return { eligible: false, reason: 'validation-failed' };
  }
  if (!input.needsRestart) {
    return { eligible: false, reason: 'no-restart-needed' };
  }
  return { eligible: true };
}

/**
 * 把 supervisor stage 翻译成 self-update SSE step name。
 * 历史上 self-update 用 'fetch' / 'pull' / 'validate' / 'build-backend' / 'restart' 这套
 * step,加蓝绿后**追加**几个 'blue-green-*' step 让前端面板能区分。
 */
export function blueGreenStepName(stage: SupervisorStage): string {
  switch (stage) {
    case 'lock-acquire':
      return 'blue-green-lock';
    case 'spawn-green':
      return 'blue-green-spawn';
    case 'wait-healthz':
      return 'blue-green-healthz';
    case 'nginx-write':
    case 'nginx-validate':
    case 'nginx-reload':
      return 'blue-green-nginx';
    case 'verify-target':
      return 'blue-green-verify';
    case 'promote-green':
      return 'blue-green-promote';
    case 'shutdown-blue':
      return 'blue-green-shutdown';
    case 'commit-color':
      return 'blue-green-commit';
    case 'done':
      return 'blue-green';
  }
}

/**
 * SSE 响应对象的最小契约 — 只用 end()。express Response 与 node ServerResponse
 * 都满足。把它定义成 structural type 避免和 express vs http 类型互掐。
 */
export interface SseEndable {
  end(): void;
}

export interface RunBlueGreenSwitchInput<TRes extends SseEndable = SseEndable> {
  /** Bootstrap 注入的 supervisor(必须非空,decideShouldUseBlueGreen 已守门)。 */
  supervisor: BlueGreenSupervisor;
  /** SSE 写函数(self-update / self-force-sync 路由共用 sendSSE)。 */
  sendSSE: (res: TRes, event: string, payload: unknown) => void;
  /** SSE 'step' 写函数(self-update 路由提供)。 */
  send: (step: string, status: 'running' | 'done' | 'error' | 'warning', title: string) => void;
  /** SSE 响应对象。 */
  res: TRes;
  /** 用于 recordSelfUpdate updateMode='blue-green'。 */
  stateService: SelfUpdateRecorder;
  /** Self-update 主流程开始时间(用于流水 durationMs)。 */
  startedAt: number;
  fromSha: string;
  newHead: string;
  branch: string;
  trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
  actor: string;
  /** 切换超时(传给 supervisor.switchActive)。可选。 */
  healthCheckTimeoutMs?: number;
}

export interface RunBlueGreenSwitchResult {
  /** 是否调用方应当 return(成功蓝绿走完 + sendSSE done + 流水入库 = true)。 */
  handled: true;
  /** 蓝绿是否成功。false 时调用方继续走老 process.exit + spawn 路径。 */
  success: boolean;
  /** Supervisor 返回的 SwitchResult,便于上层日志 / 测试断言。 */
  switchResult: SwitchResult;
}

/**
 * 真正调用 supervisor.switchActive,把 stage 转成 SSE step。
 * - 成功:sendSSE 'done' { mode:'blue-green', commitHash, fromColor, toColor }, recordSelfUpdate
 *   updateMode='blue-green',res.end(),返回 { success:true }
 * - 失败:仅 send warning 'blue-green' fallback,**不**写流水 不**关流**(留给老路径继续);
 *   返回 { success:false }
 */
export async function runBlueGreenSwitch<TRes extends SseEndable = SseEndable>(
  input: RunBlueGreenSwitchInput<TRes>,
): Promise<RunBlueGreenSwitchResult> {
  const {
    supervisor,
    sendSSE,
    send,
    res,
    stateService,
    startedAt,
    fromSha,
    newHead,
    branch,
    trigger,
    actor,
    healthCheckTimeoutMs,
  } = input;

  send('blue-green', 'running', '启动蓝绿切换…');

  const switchResult = await supervisor.switchActive({
    healthCheckTimeoutMs,
    onStage: (stage, msg) => {
      const step = blueGreenStepName(stage);
      send(step, 'running', `${msg}`);
    },
  });

  if (switchResult.ok) {
    send(
      'blue-green',
      'done',
      `蓝绿切换完成 ${switchResult.fromColor}→${switchResult.toColor} (${switchResult.totalElapsedMs}ms)`,
    );
    sendSSE(res, 'done', {
      message: `蓝绿切换完成: HEAD=${newHead || fromSha},daemon 不重启,业务流量 0 中断`,
      commitHash: newHead || fromSha,
      mode: 'blue-green',
      fromColor: switchResult.fromColor,
      toColor: switchResult.toColor,
      fromPort: switchResult.fromPort,
      toPort: switchResult.toPort,
      totalElapsedMs: switchResult.totalElapsedMs,
    });
    try {
      res.end();
    } catch {
      /* already ended */
    }
    stateService.recordSelfUpdate({
      ts: new Date().toISOString(),
      branch: branch || '',
      fromSha,
      toSha: newHead || fromSha,
      trigger,
      status: 'success',
      durationMs: Date.now() - startedAt,
      actor,
      updateMode: 'blue-green',
    });
    return { handled: true, success: true, switchResult };
  }

  // 失败:emit warning,调用方继续走老 process.exit + spawn 路径
  const failedMsg =
    switchResult.error ?? switchResult.failedStage ?? 'unknown';
  send(
    'blue-green',
    'warning',
    `蓝绿切换失败,回退到完整重启路径:${failedMsg}`,
  );
  return { handled: true, success: false, switchResult };
}
