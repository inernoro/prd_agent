/**
 * 构建/部署历史元数据的前端展示 SSOT（2026-06-27）。
 *
 * 后端 OperationLog 新增 triggerSource / deployMode / commitSha 三类元数据
 * （见 cds/src/types.ts 的 additive block）；这里负责把它们翻译成中文标签，
 * 并提供「卡死耗时封顶」的纯逻辑，给 HistoryRow / ActiveDeployment 共用。
 *
 * 阈值与后端 cds/src/services/build-log-meta.ts 的 STUCK_DEPLOY_THRESHOLD_MS 保持一致
 * （60 分钟）。前端无法直接 import 后端代码，故此处复制常量并加注释指明 SSOT 来源。
 */

export type BuildTriggerSource = 'webhook' | 'manual' | 'retry' | 'cooldown-rewarm' | 'system';

/** 触发器中文标签。未知/缺失返回空串（调用方据此决定是否渲染该字段）。 */
export function triggerSourceLabel(source?: string): string {
  return (
    {
      webhook: 'GitHub 推送',
      manual: '手动部署',
      retry: '自动重试',
      'cooldown-rewarm': '调度唤醒',
      system: '系统触发',
    } as Record<string, string>
  )[source || ''] || '';
}

/**
 * 部署模式中文标签。deployMode 是后端解析出的 activeDeployMode（如 express / static / dev）。
 * 必须区分两种「空」（Codex P2）：
 *   - `undefined`/`null`（旧历史行根本没有这个新增元数据）→ 「未记录」，**不臆造**部署类型
 *     （这些老行可能其实是 prebuilt/release 部署，谎报成「源码/默认」会让历史比改前更不准）。
 *   - 显式空串 `''`（新行、deriveDeployMode 对源码部署返回 ''）→ 「源码 / 默认」。
 * 与下方「版本」chip 的 commitSha ? … : '未记录' 口径一致。常见模式给中文名，其余原样返回。
 */
export function deployModeLabel(mode?: string | null): string {
  if (mode == null) return '未记录';
  const m = mode.trim();
  if (!m) return '源码 / 默认';
  return (
    {
      express: '极速版（CI 预构建）',
      static: '静态部署',
      dev: '开发模式',
      prod: '发布版',
      production: '发布版',
      release: '发布版',
    } as Record<string, string>
  )[m] || m;
}

/**
 * 「疑似卡住」阈值（毫秒）。SSOT 在后端 build-log-meta.ts，前端复制保持一致。
 * 仍在进行中的部署超过此值未就绪 → 不再显示越长越离谱的真实数字，封顶 + 打徽章。
 */
export const STUCK_DEPLOY_THRESHOLD_MS = 60 * 60 * 1000;

export interface DeployDurationDisplay {
  /** 实际经过的毫秒数（封顶前）。 */
  elapsedMs: number;
  /** 是否判定为卡住（仍在进行中且超过阈值）。 */
  stuck: boolean;
  /** UI 应显示的封顶毫秒数：卡住时封到阈值，否则等于 elapsedMs。 */
  cappedMs: number;
}

/**
 * 计算部署耗时的展示值 + 是否卡住。与后端 computeDeployDurationDisplay 同语义。
 *
 *   - 已结束（finishedAt 有值）：照实显示真实耗时，不判卡住（历史就该如实展示）。
 *   - **已终结但缺 finishedAt**（旧历史行：字段后加的，legacy 投影传 undefined）：不是进行中，
 *     绝不能拿 now 充当结束时间——否则旧的 success 行会显示虚高耗时、超 60min 还误报「疑似卡住」。
 *     无可信结束时间 → 耗时按 0（caller 可显示「—」），且永不判卡住（Codex P2「Respect completed
 *     rows without finishedAt」）。
 *   - 真正进行中（finishedAt 缺 + isRunning）：elapsed = now - startedAt；超阈值 → stuck，封顶。
 *
 * isRunning 缺省 true：保持旧调用点行为（只传 finishedAt 的场景按「无 finishedAt=进行中」）。
 */
export function computeDeployDurationDisplay(
  startedAt: number,
  finishedAt: number | undefined,
  now: number,
  thresholdMs: number = STUCK_DEPLOY_THRESHOLD_MS,
  isRunning: boolean = true,
): DeployDurationDisplay {
  if (finishedAt !== undefined) {
    const elapsedMs = Math.max(0, finishedAt - startedAt);
    return { elapsedMs, stuck: false, cappedMs: elapsedMs };
  }
  if (!isRunning) {
    // 终态但没有结束戳：耗时未知，不虚高、不卡住。
    return { elapsedMs: 0, stuck: false, cappedMs: 0 };
  }
  const elapsedMs = Math.max(0, now - startedAt);
  const stuck = elapsedMs > thresholdMs;
  return { elapsedMs, stuck, cappedMs: stuck ? thresholdMs : elapsedMs };
}

/** 把毫秒格式化成 `Ns` / `Nm` / `Nm Ns` / `Nh Nm` / `Nd Nh`。 */
export function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}
