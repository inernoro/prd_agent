/**
 * release-health-snapshot — 发布中心读生产健康的**唯一入口**。
 *
 * 为什么要有这一层：发布中心（`GET /api/releases/center`）此前对每个发布目标
 * 同步打一次 healthcheckUrl。于是「有人打开发布中心」这个纯读动作，会变成对
 * 生产站点的一串外呼——页面被刷得越勤，生产被打得越狠，而且这些探测的结果
 * 谁也不记账：关掉页面就什么都不剩，发布失败后没人知道生产什么时候恢复的。
 * 存活监控本来就在按固定间隔探同一批目标并留全量采样，发布中心读它的快照即可，
 * 既去掉了请求放大，也让「发布中心显示的健康」和「状态页显示的可用率」同源。
 *
 * 为什么是 setter 而不是构造注入：`createServer()` 在 index.ts 的模块顶层执行，
 * 而 `UptimeMonitorService` 在其后的函数作用域里才 new 出来——闭包捕获不到。
 * 与其为了传一个只读函数把启动顺序整个翻过来，不如留一个晚绑定的注册位：
 * 没注册时诚实返回 unknown，绝不偷偷回退到实时探测（那正是要治的病）。
 */

import type { ReleaseTarget } from '../types.js';
import type { ReleaseHealthProbe } from './release-service.js';
import { releaseProbeTargetId, releaseProbeSkipReason } from './release-probe-target.js';

/** 快照源需要的最小形状。刻意不引用 UptimeTargetRecord 全量字段，避免把监控内部结构焊死在发布中心上。 */
export interface ReleaseHealthSnapshot {
  status: 'up' | 'down' | 'paused' | 'unknown';
  probeUrl?: string;
  /** 最近一次采样；从未探过为 null */
  lastSample: { t: number; up: boolean; ms: number; code?: number; err?: string } | null;
  pausedReason?: string;
  excluded?: boolean;
  /** 探测间隔（秒），用于「等待首次探测」文案给出诚实的等待时长 */
  intervalSeconds?: number;
}

export type ReleaseHealthSource = (probeTargetId: string) => ReleaseHealthSnapshot | undefined;

let source: ReleaseHealthSource | null = null;
let disabledReason = '';

/**
 * 由 index.ts 在存活监控构造完成后调用。重复调用以最后一次为准（测试会用到）。
 *
 * `reason` 用于「监控被关掉了」这种确定性状态：此时**不要注册 source**，而是把原因传进来。
 * 事故值（Codex P2）：`CDS_UPTIME_ENABLED=0` / `CDS_UPTIME_RELEASE_ENABLED=0` 时 source
 * 照常注册，但记录永远建不出来，`getRecord` 恒为 undefined，于是发布中心永久显示
 * 「稍后自动开始探测」—— 一个永远不会兑现的承诺。而实时探测已经拿掉了，这一列就永远在骗人。
 */
export function setReleaseHealthSource(next: ReleaseHealthSource | null, reason = ''): void {
  source = next;
  disabledReason = next ? '' : reason.trim();
}

/**
 * 读某个发布目标的健康快照。**不发任何网络请求**——这是本模块存在的全部理由，
 * 任何「快照缺失就顺手探一下」的兜底都会把请求放大原样带回来。
 */
export function readReleaseHealthSnapshot(target: ReleaseTarget): ReleaseHealthProbe {
  const url = (target.ssh?.healthcheckUrl || '').trim();
  const now = new Date().toISOString();

  // 目标自身不可探测（未配地址 / 已停用 / 已归档 / 非 SSH 目标）：直接用与状态页
  // 同一个判定源给人话原因，别让发布中心和状态页对同一个目标说两套话。
  const skipReason = releaseProbeSkipReason(target);
  if (skipReason) {
    return { status: 'unknown', url, checkedAt: now, message: skipReason };
  }

  if (!source) {
    return {
      status: 'unknown',
      url,
      checkedAt: now,
      message: disabledReason || '存活监控未启用，发布中心不再实时探测生产',
    };
  }

  const record = source(releaseProbeTargetId(target));
  if (!record) {
    return { status: 'unknown', url, checkedAt: now, message: '存活监控尚未纳入该目标，稍后自动开始探测' };
  }
  if (record.excluded) {
    return { status: 'unknown', url: record.probeUrl || url, checkedAt: now, message: '该目标已被排除名单命中，未纳入存活监控' };
  }

  const sample = record.lastSample;
  if (!sample) {
    const eta = record.intervalSeconds && record.intervalSeconds > 0
      ? `，约 ${record.intervalSeconds} 秒后出首个结果`
      : '';
    return { status: 'unknown', url: record.probeUrl || url, checkedAt: now, message: `等待首次探测${eta}` };
  }

  const checkedAt = new Date(sample.t).toISOString();
  const probeUrl = record.probeUrl || url;
  if (record.status === 'paused') {
    return {
      status: 'unknown',
      url: probeUrl,
      checkedAt,
      responseTimeMs: sample.ms,
      message: record.pausedReason || '存活监控已暂停探测该目标',
    };
  }
  if (record.status === 'up') {
    return { status: 'healthy', url: probeUrl, checkedAt, responseTimeMs: sample.ms };
  }
  if (record.status === 'down') {
    return {
      status: 'failed',
      url: probeUrl,
      checkedAt,
      responseTimeMs: sample.ms,
      message: sample.err || (sample.code ? `healthcheck HTTP ${sample.code}` : 'healthcheck failed'),
    };
  }
  // 'unknown'：去抖还没攒够，已有采样但还不足以定性。给出最近一次的原始结果而不是
  // 直接判定，免得单次抖动在发布中心显示成「生产挂了」。
  return {
    status: 'unknown',
    url: probeUrl,
    checkedAt,
    responseTimeMs: sample.ms,
    message: sample.up ? '存活判定累积中（最近一次探测正常）' : sample.err || '存活判定累积中（最近一次探测失败）',
  };
}
