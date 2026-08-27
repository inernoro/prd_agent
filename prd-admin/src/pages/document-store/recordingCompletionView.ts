/**
 * 录音链路「完成 / 整理中 / AI 不可用 / 麦克风自检」四种告知的措辞判据。
 *
 * 和 `recordingCaptureView.ts` 同一个理由：这几句话每一句都挂着一个真实数量或一个
 * 真实状态码，判据混在组件里既没法单测，也很容易在下一次改版里被换成一个
 * 「看起来对」的近似值（predicate-and-wiring-discipline 形状 6）。
 */

/** 转录全部完成后那一条绿卡（设计稿 v2-S3 / cap-S5）。 */
export function describeCompletionSummary(input: {
  sentences: number;
  speakers: number;
  hasSummary: boolean;
  hasTodos: boolean;
}): { title: string; detail: string } | null {
  if (input.sentences <= 0) return null;
  const parts = [`${input.sentences} 句`];
  // 说话人数为 0 是「没区分出来」，那是另一张卡（cap-S11）该说的事，这里就不提
  if (input.speakers > 0) parts.push(`${input.speakers} 位说话人`);
  if (input.hasSummary && input.hasTodos) parts.push('纪要与待办已就绪');
  else if (input.hasSummary) parts.push('纪要已就绪');
  else if (input.hasTodos) parts.push('待办已就绪');
  return { title: input.hasSummary || input.hasTodos ? '全部完成' : '原文已完成', detail: parts.join(' · ') };
}

/** 后台整理进行中那一条（设计稿 cap-S6）：点名到具体哪一种产物，并给一个「不用等」的出口。 */
export function describeOrganizeProgress(input: {
  styleLabel?: string | null;
  remainingSec?: number | null;
}): { title: string; detail: string } {
  const what = input.styleLabel?.trim();
  const title = what ? `正在生成${what}` : '正在整理这段录音';
  const eta = input.remainingSec != null && input.remainingSec > 0 ? `约 ${Math.round(input.remainingSec)}s · ` : '';
  return { title, detail: `${eta}可以先去播放和阅读` };
}

/**
 * 这次失败是不是「AI 服务整体不可用」（设计稿 cap-S9）。
 *
 * 只认后端明确给出的这几个码。用「消息里含不含某几个字」去判会随文案漂移
 * （形状 1：判据比它该管的范围窄，也比它该管的范围散）。
 */
const AI_UNAVAILABLE_CODES = new Set([
  'LLM_UNAVAILABLE',
  'LLM_ALL_CANDIDATES_FAILED',
  'MODEL_POOL_EXHAUSTED',
  'GATEWAY_UNAVAILABLE',
  'ERR_UPSTREAM_UNAVAILABLE',
]);

export function isAiUnavailableFailure(code: string | null | undefined): boolean {
  return AI_UNAVAILABLE_CODES.has((code ?? '').trim().toUpperCase());
}

/**
 * 麦克风自检结论（设计稿 cap-S1 的副行「麦克风正常 · 音量适中」）。
 *
 * 判据是这段录音里真实的峰值电平：太低说明没收到声音或音量太小，
 * 接近满格说明会削波。不给「正常」以外的结论时也要说清是哪一档，
 * 不许一律显示「麦克风正常」——那是一句不会红的证据。
 */
export function describeMicHealth(peakLevel: number, elapsedSec: number): string {
  if (elapsedSec < 2) return '正在检测麦克风';
  if (peakLevel < 0.02) return '几乎没有收到声音 · 检查麦克风是否静音';
  if (peakLevel < 0.12) return '麦克风正常 · 音量偏低';
  if (peakLevel > 0.97) return '麦克风正常 · 音量偏高，可能削波';
  return '麦克风正常 · 音量适中';
}
