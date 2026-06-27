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
 * 部署模式中文标签。deployMode 是后端解析出的 activeDeployMode（如 express /
 * static / dev），空串视为「源码 / 默认模式」。常见模式给中文名，其余原样返回。
 */
export function deployModeLabel(mode?: string): string {
  const m = (mode || '').trim();
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
 *   - 进行中（finishedAt 缺）：elapsed = now - startedAt；超阈值 → stuck，封顶。
 */
export function computeDeployDurationDisplay(
  startedAt: number,
  finishedAt: number | undefined,
  now: number,
  thresholdMs: number = STUCK_DEPLOY_THRESHOLD_MS,
): DeployDurationDisplay {
  const end = finishedAt ?? now;
  const elapsedMs = Math.max(0, end - startedAt);
  if (finishedAt !== undefined) {
    return { elapsedMs, stuck: false, cappedMs: elapsedMs };
  }
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
