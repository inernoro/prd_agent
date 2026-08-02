/**
 * acceptance-severity — 「这份验收报告够不够格叫醒人」的唯一判定源。
 *
 * 补的是哪一段：验收报告归档走 POST /api/reports，落库后**一个事件都不发**。
 * 于是「昨天那轮验收报出了 2 个 P0」这件事，只有主动打开报告中心翻列表的人才知道；
 * 没人翻，它就跟没发生过一样。CDS 已经有站内信账本（notice-ledger）+ 外发通道
 * （notice-outbound-map），铃是现成的，报告这条线一直没接上去。本文件是那条线的判据侧。
 *
 * 三条纪律：
 *
 * 1. **纯函数，不碰 IO、不认识事件名**。事件类型/文案/深链类别归 cds-events-bus.ts
 *    那两张穷尽 Record 管（见该文件头）。本文件只回答一个问题：给定 verdict 和缺陷
 *    计数，这份报告是不是「阻断级」。判据能被表驱动单测钉死，是它单独成文件的理由。
 *
 * 2. **键名归一化，不假设生产者的大小写**。CDS 的 defectCounts 是自由键
 *    `Record<string, number>`：cdscli 的 --defects 示例写 `p0=0,p1=2`（小写），
 *    验收报告正文里的「缺陷分级速览」写 `P0`（大写），两边从来没对齐过。
 *    判据若只认一种写法，就是「语义相同、写法不同的输入让判据翻转」那类窄判据
 *    （.claude/rules/predicate-and-wiring-discipline.md 形状 1），而且**失败方向是静默的**
 *    —— 大小写不匹配时不会报错，只会永远不告警。
 *
 * 3. **宁可少叫醒人，也不训练出「忽略告警」的习惯**。这条口径与 cds-events-bus.ts 里
 *    `'self.refresh.failed': false`（网络抖动是常态噪声）同源。所以本判据刻意**不**把
 *    「有条件通过 + 若干 P1」当成阻断：那是每日验收的常态形状，天天响等于没响。
 */

/** 验收标准里的四档严重级（doc/rule.acceptance.map-enterprise.md / standard-v2.md）。 */
export const ACCEPTANCE_SEVERITY_LEVELS = ['P0', 'P1', 'P2', 'P3'] as const;
export type AcceptanceSeverityLevel = (typeof ACCEPTANCE_SEVERITY_LEVELS)[number];

/** 归一化后的缺陷计数。缺席的档位表示生产者没报，不等于 0（区分「报了 0」与「没报」）。 */
export type AcceptanceSeverityCounts = Partial<Record<AcceptanceSeverityLevel, number>>;

export type AcceptanceVerdict = 'pass' | 'conditional' | 'fail';

/** 去掉 markdown 强调符与首尾空白（含全角空格），把单元格/键名压成纯文本。 */
function plain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[`*_]/g, '')
    .replace(/[　\s]+/g, ' ')
    .trim();
}

/**
 * 严重度记号归一化 —— **全 CDS 唯一一份**。
 *
 * 吃下同语义的不同写法：`P0` / `p0` / `**P1**` / ` p 2 ` / 全角空格包裹，
 * 以及夹在长文本里的 `P3 视觉瑕疵`（缺陷表单元格常是这种）。认不出返回 null。
 *
 * 为什么必须只有一份（本仓库形状 3 的典型土壤）：告警判据（本文件）与缺陷归因简报
 * （acceptance-defect-digest）都要把自由写法映射到 P0-P3。两份各自演化的后果是
 * **简报说「这个模块有 2 个 P0」而告警从来没响过**——两边都不报错，只是对同一份
 * 数据给出不同答案，而且没有任何一侧看得出自己错了。故简报侧从本文件 import，
 * 不再自持一份。
 */
export function normalizeSeverity(raw: unknown): AcceptanceSeverityLevel | null {
  const text = plain(raw);
  if (!text) return null;
  const exact = /^p\s*([0-3])$/i.exec(text);
  if (exact) return `P${exact[1]}` as AcceptanceSeverityLevel;
  const loose = /(?:^|[^a-z0-9])p\s*([0-3])(?![0-9])/i.exec(text);
  return loose ? (`P${loose[1]}` as AcceptanceSeverityLevel) : null;
}

/**
 * 把自由键的 defectCounts 归一成 P0-P3（**告警口径**）。
 *
 * 键名判定走上面的 normalizeSeverity（唯一一份），本函数只管计数语义。
 * 非有限数跳过、负数按 0；小数四舍五入（生产者本该发整数，但**宁可保住告警信号
 * 也不要因为一个 1.5 把整条阻断判据静默抹掉**）。
 *
 * 返回 null 表示「一个可识别的档位都没有」，调用方据此区分「没报缺陷计数」
 * 与「报了但全是 0」——前者不能当作「没有缺陷」的证据。
 *
 * 与简报侧 `acceptance-defect-digest.normalizeDefectCounts` 的差别是**刻意的**，
 * 不是漂移：那边为聚合统计服务，丢弃 0 并把重复键相加；本函数为告警判据服务，
 * 必须保留「明确报了 0」这一事实——「自称通过却带 P1」正是靠它与缺席区分开。
 */
export function normalizeDefectCounts(raw: unknown): AcceptanceSeverityCounts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: AcceptanceSeverityCounts = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const level = normalizeSeverity(key);
    if (!level) continue;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    out[level] = Math.max(0, Math.round(n));
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface AcceptanceOutcome {
  /** 是否够格叫醒人。false 时其余字段仍然可用（供列表/看板展示）。 */
  blocking: boolean;
  /** 中文短语，直接进站内信正文；非阻断时为空串。 */
  reason: string;
  /** 归一化后的计数；生产者没报时为 null。 */
  counts: AcceptanceSeverityCounts | null;
  /** 结论与缺陷自相矛盾：自称通过，却带着未决的 P0/P1。 */
  conflict: boolean;
}

const EMPTY_OUTCOME: AcceptanceOutcome = { blocking: false, reason: '', counts: null, conflict: false };

/**
 * 判定一份验收报告是否阻断级。三条触发条件，各自对应一种「不叫醒人就会被漏掉」的事实：
 *
 *  1. `verdict === 'fail'` —— 明确不通过。
 *  2. `P0 > 0` —— 验收标准把 P0 直接定义为 fail 级（standard-v2.md：「撑破/主操作够不到 = P0 → fail」），
 *     所以哪怕 verdict 写着通过，P0 存在本身就是阻断事实。
 *  3. `verdict === 'pass'` 却带 P0/P1 —— 标准原文承认这是**自动校验抓不到**的语义矛盾
 *     （standard-v2.md：「Verdict 一致性(verdict=通过 却存在未决 P0/P1)属语义校验,自动校验只做结构层」），
 *     明说要由「人工/工具」把关。本判据就是那个工具。
 *
 * 刻意**不**触发的那一种：`conditional` + 若干 P1。有条件通过本来就意味着「带着已知问题放行」，
 * 结论与缺陷并不矛盾，且这是每日验收的常态形状 —— 把它算成阻断，铃就会天天响到没人再看（纪律 3）。
 */
export function classifyAcceptanceOutcome(
  verdict: string | null | undefined,
  defectCounts: unknown,
): AcceptanceOutcome {
  const counts = normalizeDefectCounts(defectCounts);
  const normalizedVerdict = typeof verdict === 'string' ? verdict.trim().toLowerCase() : '';
  const v = (['pass', 'conditional', 'fail'] as string[]).includes(normalizedVerdict)
    ? (normalizedVerdict as AcceptanceVerdict)
    : null;

  const p0 = counts?.P0 ?? 0;
  const p1 = counts?.P1 ?? 0;

  // 自称通过却带未决 P0/P1 —— 与结论直接矛盾，最该被人看见的一种形状。
  const conflict = v === 'pass' && p0 + p1 > 0;

  const reasons: string[] = [];
  if (v === 'fail') reasons.push('验收判定为不通过');
  if (p0 > 0) reasons.push(`存在 ${p0} 个 P0 阻断缺陷`);
  if (conflict) {
    reasons.push(
      p0 > 0
        ? '但报告结论写的是「通过」，结论与缺陷自相矛盾'
        : `报告结论写的是「通过」，却仍有 ${p1} 个 P1 未决缺陷`,
    );
  }

  if (reasons.length === 0) return { ...EMPTY_OUTCOME, counts };
  return { blocking: true, reason: reasons.join('；'), counts, conflict };
}

/** `P0 2 / P1 1 / P2 0 / P3 0` 形态的紧凑摘要，进通知正文；没报计数时返回空串。 */
export function formatSeveritySummary(counts: AcceptanceSeverityCounts | null): string {
  if (!counts) return '';
  const parts = ACCEPTANCE_SEVERITY_LEVELS.filter((level) => counts[level] !== undefined).map(
    (level) => `${level} ${counts[level]}`,
  );
  return parts.join(' / ');
}
