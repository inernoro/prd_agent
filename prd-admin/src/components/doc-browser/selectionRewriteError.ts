// 把「上游模型平台/网关吐回来的原始报错」翻译成用户能照着做下一步的一句话。
//
// 为什么需要（2026-08-25 用户截图）：划词改写失败时条子上写的是
// `未提供令牌 (request id: 2026...)` —— 那是上游平台的原文，经网关 chunk.Error
// 一路原样透传到界面。用户看不懂「令牌」是谁的令牌，也不知道该找谁，
// 只能干瞪眼（expectation-management.md：失败要给可执行的下一步，不是甩一个错误码）。
//
// 原文不丢：翻译后的句子给用户看，raw 挂在 title 上供排查，
// 做不到的不假装做到（no-rootless-tree.md）——认不出来的错就说「没能完成」并把原文带上。
//
// 只放确定认得出的几类：宁可落到兜底，也不要靠猜把一类错说成另一类。

export interface FriendlyRewriteError {
  /** 给用户看的一句话 */
  message: string;
  /** 下一步该干什么；认不出来的错没有这一项 */
  hint?: string;
  /** 上游原文，一个字不改，用于 title / 日志 */
  raw: string;
}

interface Rule {
  test: RegExp;
  message: string;
  hint: string;
}

/*
 * 顺序即优先级。判据用「原文里确实会出现的词」，不做语义猜测：
 * 401/密钥类要排在限流之前——上游常把两者写在同一句里，而没密钥是更根上的原因。
 */
const RULES: Rule[] = [
  {
    test: /令牌|token|api[\s_-]?key|unauthorized|forbidden|\b401\b|\b403\b/i,
    message: 'AI 服务没配好：模型平台没收到密钥',
    hint: '这不是你的操作问题，请管理员到「模型平台」检查本应用的密钥是否已配置且未过期',
  },
  {
    test: /余额|欠费|insufficient|balance|quota[\s_-]?exceeded|billing/i,
    message: '模型平台余额或配额不足',
    hint: '请管理员在模型平台充值或调整配额后重试',
  },
  {
    test: /限流|频率|rate[\s_-]?limit|too many requests|\b429\b/i,
    message: 'AI 服务当前排队中',
    hint: '过一会儿点「重试」，或先改写更短的一段',
  },
  {
    test: /超时|timeout|timed out|deadline/i,
    message: '模型响应超时',
    hint: '点「重试」；选区很长时可以拆成几句分别改',
  },
  {
    test: /没有可用|no available|候选耗尽|all .*unavailable|model[\s_-]?not[\s_-]?found/i,
    message: '没有可用的模型',
    hint: '请管理员检查该功能绑定的模型池里是否还有健康成员',
  },
];

/** 上游原文 → 用户能看懂的一句话。认不出来就兜底，并始终带回原文。 */
export function toFriendlyRewriteError(raw: string | undefined | null): FriendlyRewriteError {
  const text = (raw ?? '').trim();
  if (!text) return { message: 'AI 改写没能完成', raw: '' };
  for (const rule of RULES) {
    if (rule.test.test(text)) return { message: rule.message, hint: rule.hint, raw: text };
  }
  return { message: 'AI 改写没能完成', raw: text };
}
