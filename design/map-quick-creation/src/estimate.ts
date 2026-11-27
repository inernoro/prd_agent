/* 原型的时长与耗时预估（只用于原型，不进源码差异）。
 * 正式实现由服务端给出：配音语速取实际所用音色的实测值，生成耗时取同风格、同时长的历史中位数。
 * 物理关系：成片时长 ≈ 旁白字数 ÷ 配音语速。所以「要多长」最终落在「旁白写多少字、分几幕」上，
 * 服务端校验脚本的总时长落在目标的 ±15%，不够就补写，不能靠模型自觉。 */
import type { DurationChoice, OutputKind, QcAttachment, QcEstimate } from '@/pages/quick-creation-agent/types';

/** 中文配音约每秒 4.2 字（每分钟约 250 字） */
export const CHARS_PER_SEC = 4.2;
/** 一幕约 14 秒：一个画面讲一件事 */
const SEC_PER_SCENE = 14;
const OPTIONS = [60, 180, 300, 600] as const;

const nearest = (sec: number) => OPTIONS.reduce((a, b) => (Math.abs(b - sec) < Math.abs(a - sec) ? b : a), 60 as number);
export const scenesFor = (sec: number) => Math.max(4, Math.min(40, Math.round(sec / SEC_PER_SCENE)));
const fmt = (sec: number) => (sec < 60 ? `${sec} 秒` : `${Math.round(sec / 60)} 分钟`);

export function autoSecFor(chars: number) {
  if (!chars) return 60;
  /* 全文照念太长，自动取约三分之一讲重点，落在 1–5 分钟的档位上 */
  return Math.min(300, nearest((chars / CHARS_PER_SEC) * 0.35));
}

export function estimate(input: { kind: OutputKind; docs: QcAttachment[]; duration: DurationChoice }): QcEstimate {
  const chars = input.docs.reduce((n, a) => n + (a.chars ?? 0), 0);
  const fullSec = chars ? Math.round(chars / CHARS_PER_SEC) : undefined;
  const autoSec = autoSecFor(chars);
  const targetSec = input.duration === 'auto' ? autoSec : input.duration;
  const m = targetSec / 60;
  const generateMin: [number, number] = [Math.round(20 + m * 5), Math.round(30 + m * 8)];
  const basis = chars
    ? `稿件 ${chars.toLocaleString('en-US')} 字，全文照念约 ${fmt(fullSec ?? 0)}；${input.duration === 'auto' ? `自动取约 ${fmt(autoSec)}讲重点` : `按约 ${fmt(targetSec)}写分镜`}`
    : `内容来自对话；${input.duration === 'auto' ? '自动取约 1 分钟' : `按约 ${fmt(targetSec)}写分镜`}`;
  /* 试看只做片头和第 1 幕：约占整片的一成多一点（排队之外） */
  const trialMin: [number, number] = [Math.max(3, Math.round(generateMin[0] * 0.12)), Math.max(5, Math.round(generateMin[1] * 0.15))];
  return { choice: input.duration, targetSec, autoSec, ...(fullSec ? { fullSec, chars } : {}), scenes: scenesFor(targetSec), generateMin, basis, trialDefault: targetSec >= 180, trialMin };
}
