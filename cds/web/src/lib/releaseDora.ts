/**
 * 发布中心 DORA 四项指标的展示判定 SSOT（纯函数，可单测）。
 *
 * 这里唯一要守住的规矩：**样本不足时给诚实文案，绝不给一个看起来精确的假数字**。
 * 事故值：变更失败率在「最近 30 天一次都没发布」时若渲染成 0%，用户会据此认为
 * 发布链路很健康——那是一个凭空编造、且与事实完全相反的结论。同款教训见
 * releaseEta.ts 的「无样本 remainingMs 一律 null，不是 0」。
 *
 * 为什么在前端再写一遍文案而不是让后端下发：与 releaseEta.ts 同一个编译边界——
 * web 的 tsconfig 只 include web/src，全仓没有 web → src 的 import 通道。
 * 后端只下发**数字与样本量**，「怎么说人话」这一层判定只此一处。
 */

export interface ReleaseDoraMetrics {
  windowDays: number;
  fromAt: string;
  toAt: string;
  frequency: {
    successCount: number;
    perDay: number;
    medianIntervalMs: number | null;
  };
  changeFailure: {
    total: number;
    failed: number;
    ratio: number | null;
  };
  recovery: {
    sampleCount: number;
    p50Ms: number | null;
    p90Ms: number | null;
    ongoingCount: number;
  };
  leadTime: {
    sampleCount: number;
    eligibleCount: number;
    p50Ms: number | null;
    p90Ms: number | null;
  };
}

export interface ReleaseDoraCard {
  key: 'frequency' | 'changeFailure' | 'recovery' | 'leadTime';
  label: string;
  /** 主数字，或「样本不足」 */
  value: string;
  /** 副行：样本量 / 为什么没有数字 */
  hint: string;
  /** true = 本项没有可信数字，UI 应弱化展示，不许当成 0 来解读 */
  insufficient: boolean;
}

/** 毫秒 → 中文粗粒度时长。指标看的是量级，不需要秒级精度。 */
export function formatDoraDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-';
  // 先判「不足一分钟」再取整：Math.round 会把 30 秒说成「1 分钟」，
  // 那是把一个下界当成了实测值，属于同一类「看着精确的假数字」。
  if (ms < 60_000) return '不足 1 分钟';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${totalHours} 小时 ${minutes} 分钟` : `${totalHours} 小时`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

function insufficientCard(
  key: ReleaseDoraCard['key'],
  label: string,
  hint: string,
): ReleaseDoraCard {
  return { key, label, value: '样本不足', hint, insufficient: true };
}

/**
 * metrics 缺省 = 跑旧构建的 CDS 没下发这个字段。此时四项一律退化成「样本不足」，
 * 页面照常渲染——绝不因为少一个字段就白屏，也绝不拿 0 冒充。
 */
export function describeReleaseDora(metrics: ReleaseDoraMetrics | undefined): ReleaseDoraCard[] {
  const windowDays = metrics?.windowDays ?? 30;
  const windowLabel = `最近 ${windowDays} 天`;
  if (!metrics) {
    const hint = '当前 CDS 版本未下发 DORA 指标';
    return [
      insufficientCard('frequency', '发布频率', hint),
      insufficientCard('changeFailure', '变更失败率', hint),
      insufficientCard('recovery', '恢复时长 p50', hint),
      insufficientCard('leadTime', '变更前置时间 p50', hint),
    ];
  }

  const { frequency, changeFailure, recovery, leadTime } = metrics;

  const frequencyCard: ReleaseDoraCard = frequency.successCount === 0
    ? insufficientCard('frequency', '发布频率', `${windowLabel}没有成功发布`)
    : {
      key: 'frequency',
      label: '发布频率',
      value: frequency.perDay >= 1
        ? `${frequency.perDay.toFixed(1)} 次/天`
        : `${frequency.successCount} 次/${windowDays} 天`,
      hint: frequency.medianIntervalMs == null
        ? `${windowLabel}仅 1 次成功发布，暂无间隔中位`
        : `相邻发布间隔中位 ${formatDoraDuration(frequency.medianIntervalMs)}`,
      insufficient: false,
    };

  const changeFailureCard: ReleaseDoraCard = changeFailure.ratio == null
    ? insufficientCard('changeFailure', '变更失败率', `${windowLabel}仅 ${changeFailure.total} 次发布`)
    : {
      key: 'changeFailure',
      label: '变更失败率',
      value: `${Math.round(changeFailure.ratio * 1000) / 10}%`,
      hint: `${changeFailure.failed}/${changeFailure.total} 次发布失败或事后被回滚`,
      insufficient: false,
    };

  // 「尚未恢复」单列而不是混进中位：把一条还在烧的故障按当前时刻算进 p50，
  // 会让这个数字每刷新一次就变大一点，看着像在恶化，其实只是时间在走。
  const ongoingSuffix = recovery.ongoingCount > 0 ? ` · ${recovery.ongoingCount} 次尚未恢复` : '';
  const recoveryCard: ReleaseDoraCard = recovery.sampleCount === 0
    ? insufficientCard(
      'recovery',
      '恢复时长 p50',
      recovery.ongoingCount > 0
        ? `${recovery.ongoingCount} 次失败发布尚未恢复，暂无完整样本`
        : `${windowLabel}没有失败发布`,
    )
    : {
      key: 'recovery',
      label: '恢复时长 p50',
      value: formatDoraDuration(recovery.p50Ms),
      hint: `p90 ${formatDoraDuration(recovery.p90Ms)} · ${recovery.sampleCount} 个样本${ongoingSuffix}`,
      insufficient: false,
    };

  const leadTimeCard: ReleaseDoraCard = leadTime.sampleCount === 0
    ? insufficientCard(
      'leadTime',
      '变更前置时间 p50',
      leadTime.eligibleCount > 0
        // 缺 commit 提交时间的发布不猜也不补：口径见 services/release-commit-clock.ts。
        ? `${leadTime.eligibleCount} 次发布缺少 commit 提交时间`
        : `${windowLabel}没有成功发布`,
    )
    : {
      key: 'leadTime',
      label: '变更前置时间 p50',
      value: formatDoraDuration(leadTime.p50Ms),
      hint: `p90 ${formatDoraDuration(leadTime.p90Ms)} · 覆盖 ${leadTime.sampleCount}/${leadTime.eligibleCount} 次发布`,
      insufficient: false,
    };

  return [frequencyCard, changeFailureCard, recoveryCard, leadTimeCard];
}
