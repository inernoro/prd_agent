// 生图耗时「平均预期」SSOT：历史完成耗时的指数滑动平均，存 localStorage。
// 设备本地、非敏感、发版后旧值无害（仅作等待预估），符合 no-localstorage.md 例外清单。
// 首样本前用 40s 兜底（实测单图约 40~44s）。供 GenSweepLoader（展示预估）与
// AdvancedVisualAgentTab 的采样 effect（running→done 记录真实耗时）共用，单一来源不漂移。

const GEN_AVG_KEY = 'visualGenAvgMs';
const GEN_AVG_DEFAULT_MS = 40_000;
const GEN_AVG_MIN_MS = 5_000;
const GEN_AVG_MAX_MS = 180_000;

export function getGenAvgMs(): number {
  try {
    const v = Number(localStorage.getItem(GEN_AVG_KEY));
    if (Number.isFinite(v) && v >= GEN_AVG_MIN_MS && v <= GEN_AVG_MAX_MS) return v;
  } catch {
    /* localStorage 不可用时走默认 */
  }
  return GEN_AVG_DEFAULT_MS;
}

export function recordGenDurationMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 2_000 || ms > 300_000) return; // 异常值不纳入平均
  const next = Math.round(getGenAvgMs() * 0.7 + ms * 0.3); // 指数滑动平均，新样本权重 0.3
  try {
    localStorage.setItem(GEN_AVG_KEY, String(Math.min(GEN_AVG_MAX_MS, Math.max(GEN_AVG_MIN_MS, next))));
  } catch {
    /* 忽略写失败 */
  }
}
