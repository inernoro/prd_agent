/**
 * 音箱日志样例的时间轴。
 *
 * 一轮对话的唤醒、听写、执行、完成都落在同一条会话上，只改这条会话的内容。
 * 19:58:08 到 19:58:16 正好 8 秒；19:59:51 是另一条会话。
 */

export const SAMPLE_START = '19:58:08';
export const SAMPLE_END = '19:58:16';
export const SAMPLE_DURATION_MS = 8_000;
export const SAMPLE_DURATION_SEC = 8;
export const NEXT_ROUND_AT = '19:59:51';
export const ROUND2_MS = 1_800;

export const WAKE_WORD = '米多同学';
export const COMMAND = '打开任务台';
export const REPLY = '我在';
export const USER_NAME = '林夏';
export const SPEAKER_NAME = '米多';
export const MENU_NAME = '任务台';
export const TIMEOUT_NOTE = '没有听清，请再说一次';

export const SAMPLE_ID = 'conv-195808';
export const ROUND2_ID = 'conv-195951';
export const TIMEOUT_ID = 'conv-timeout';

const FLASH_END = 420;
const WAKE_SETTLE = 360;
const WAKE_STEP = 70;
const DICTATE_START = 900;
const EXECUTE_START = 5_200;
const COMMAND_STEP = 480;
const TIMEOUT_START = 4_000;

export const KEYFRAME_WAKE_MS = 430;
export const KEYFRAME_DICTATE_MS = 3_600;
export const KEYFRAME_EXECUTE_MS = 7_400;
export const KEYFRAME_TIMEOUT_MS = 6_500;

export type Phase = 'idle' | 'wake' | 'dictate' | 'execute' | 'done' | 'timeout';
export type FrameId = 'idle' | 'wake' | 'dictate' | 'execute' | 'done' | 'timeout';
export type ScriptId = 'idle' | 'sample' | 'timeout';

export const KEYFRAMES: { id: FrameId; label: string }[] = [
  { id: 'idle', label: '待机' },
  { id: 'wake', label: '唤醒' },
  { id: 'dictate', label: '听写' },
  { id: 'execute', label: '执行' },
  { id: 'done', label: '完成' },
  { id: 'timeout', label: '超时' },
];

export const KEYFRAME_SEEK: Record<FrameId, { script: ScriptId; ms: number }> = {
  idle: { script: 'idle', ms: 0 },
  wake: { script: 'sample', ms: KEYFRAME_WAKE_MS },
  dictate: { script: 'sample', ms: KEYFRAME_DICTATE_MS },
  execute: { script: 'sample', ms: KEYFRAME_EXECUTE_MS },
  done: { script: 'sample', ms: SAMPLE_DURATION_MS },
  timeout: { script: 'timeout', ms: KEYFRAME_TIMEOUT_MS },
};

const PHASE_NAME: Record<Exclude<Phase, 'idle' | 'done'>, string> = {
  wake: '唤醒',
  dictate: '听写',
  execute: '执行',
  timeout: '超时',
};

export type Line = {
  key: string;
  kind: 'user' | 'miduo' | 'result';
  name: string;
  text: string;
  settled: boolean;
  showSettleMark: boolean;
  flash: boolean;
  lit: boolean;
  stage: string | null;
  volume: number[] | null;
  note: string | null;
  time: string | null;
};

export type Conversation = {
  id: string;
  startedAt: string;
  phase: Phase;
  lines: Line[];
  result: { menu: string; durationSec: number; at: string } | null;
};

export type PlayerSnap = {
  script: ScriptId;
  ms: number;
  round2: number | null;
  rate: 1 | 0.5;
  reduceMotion: boolean;
  theme: 'dark' | 'light';
  playing: boolean;
  frame: FrameId | null;
};

export type ScreenModel = {
  clock: string;
  page: 'home' | 'tasks';
  conversations: Conversation[];
  snap: PlayerSnap;
};

export function addSeconds(hms: string, seconds: number): string {
  const [h, m, s] = hms.split(':').map(Number);
  const total = h * 3600 + m * 60 + s + seconds;
  const hh = Math.floor(total / 3600) % 24;
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 只标出和上一帧不一样的字，没变的字不重新入场。 */
export function changedCharIndexes(prev: string, next: string): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < next.length; i += 1) {
    if (prev[i] !== next[i]) indexes.push(i);
  }
  return indexes;
}

/**
 * 阅读历史时不把视口拽走。贴在底部时才跟着新内容。
 * scrollHeight 用增长前的高度，nextScrollHeight 用增长后的高度。
 */
export function nextScrollTop(input: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  nextScrollHeight: number;
  threshold?: number;
}): number {
  const threshold = input.threshold ?? 32;
  const fromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  if (fromBottom <= threshold) return Math.max(0, input.nextScrollHeight - input.clientHeight);
  return input.scrollTop;
}

export function waitLabel(phase: Phase, phaseStart: number, ms: number): string | null {
  if (phase === 'idle' || phase === 'done') return null;
  const elapsed = ms - phaseStart;
  if (elapsed <= 2_000) return null;
  return `${PHASE_NAME[phase]} · 已等待 ${Math.floor(elapsed / 1000)} 秒`;
}

function uttered(text: string, start: number, step: number, ms: number, settleAt: number) {
  if (ms < start) return { text: '', settled: false, visible: false };
  if (ms >= settleAt) return { text, settled: true, visible: true };
  const count = Math.min(text.length, Math.floor((ms - start) / step) + 1);
  return { text: text.slice(0, count), settled: false, visible: true };
}

/** 听写阶段才有波形；没有音量数据时返回 null，调用方不渲染。 */
export function volumeAt(ms: number, hasVolume: boolean, dictateStart: number, dictateEnd: number): number[] | null {
  if (!hasVolume || ms < dictateStart || ms >= dictateEnd) return null;
  const shift = Math.floor((ms - dictateStart) / 140);
  const base = [0.25, 0.55, 0.92, 0.48, 0.78, 0.36, 0.66];
  return base.map((level, index) => {
    const wave = 0.55 + 0.45 * Math.sin((index + shift) * 0.85);
    return Math.round(Math.min(1, level * wave) * 100) / 100;
  });
}

function line(partial: Partial<Line> & Pick<Line, 'key' | 'kind' | 'name'>): Line {
  return {
    text: '',
    settled: false,
    showSettleMark: false,
    flash: false,
    lit: false,
    stage: null,
    volume: null,
    note: null,
    time: null,
    ...partial,
  };
}

function samplePhase(ms: number): { phase: Phase; phaseStart: number } {
  if (ms >= SAMPLE_DURATION_MS) return { phase: 'done', phaseStart: SAMPLE_DURATION_MS };
  if (ms >= EXECUTE_START) return { phase: 'execute', phaseStart: EXECUTE_START };
  if (ms >= DICTATE_START) return { phase: 'dictate', phaseStart: DICTATE_START };
  return { phase: 'wake', phaseStart: 0 };
}

function buildTurn(input: {
  id: string;
  startedAt: string;
  ms: number;
  phase: Phase;
  phaseStart: number;
  hasVolume: boolean;
  dictateEnd: number;
  withCommand: boolean;
  commandSettle: number;
  result: Conversation['result'];
}): Conversation {
  const wake = uttered(WAKE_WORD, 0, WAKE_STEP, input.ms, WAKE_SETTLE);
  const command = input.withCommand
    ? uttered(COMMAND, DICTATE_START, COMMAND_STEP, input.ms, input.commandSettle)
    : { text: '', settled: false, visible: false };
  const stage = waitLabel(input.phase, input.phaseStart, input.ms);
  const lines: Line[] = [];
  if (wake.visible) {
    lines.push(line({
      key: 'user-wake',
      kind: 'user',
      name: USER_NAME,
      text: wake.text,
      settled: wake.settled,
      showSettleMark: wake.settled,
    }));
  }
  lines.push(line({
    key: 'miduo',
    kind: 'miduo',
    name: SPEAKER_NAME,
    text: input.ms >= FLASH_END ? REPLY : '',
    flash: input.ms < FLASH_END,
    lit: input.ms < DICTATE_START,
    stage,
    volume: volumeAt(input.ms, input.hasVolume, DICTATE_START, input.dictateEnd),
    note: input.phase === 'timeout' ? TIMEOUT_NOTE : null,
  }));
  if (command.visible) {
    lines.push(line({
      key: 'user-command',
      kind: 'user',
      name: USER_NAME,
      text: command.text,
      settled: command.settled,
      showSettleMark: command.settled,
    }));
  }
  if (input.result) {
    lines.push(line({
      key: 'result',
      kind: 'result',
      name: input.result.menu,
      text: `已打开 · 本轮 ${input.result.durationSec} 秒`,
      settled: true,
      time: input.result.at,
    }));
  }
  return {
    id: input.id,
    startedAt: input.startedAt,
    phase: input.phase,
    lines,
    result: input.result,
  };
}

export function projectSample(ms: number): Conversation {
  const bounded = Math.max(0, Math.min(SAMPLE_DURATION_MS, ms));
  const { phase, phaseStart } = samplePhase(bounded);
  return buildTurn({
    id: SAMPLE_ID,
    startedAt: SAMPLE_START,
    ms: bounded,
    phase,
    phaseStart,
    hasVolume: true,
    dictateEnd: EXECUTE_START,
    withCommand: true,
    commandSettle: EXECUTE_START,
    result: phase === 'done'
      ? { menu: MENU_NAME, durationSec: SAMPLE_DURATION_SEC, at: SAMPLE_END }
      : null,
  });
}

export function projectRound2(ms: number): Conversation {
  const bounded = Math.max(0, ms);
  const phase: Phase = bounded >= DICTATE_START ? 'dictate' : 'wake';
  const phaseStart = phase === 'dictate' ? DICTATE_START : 0;
  return buildTurn({
    id: ROUND2_ID,
    startedAt: NEXT_ROUND_AT,
    ms: bounded,
    phase,
    phaseStart,
    hasVolume: false,
    dictateEnd: Number.POSITIVE_INFINITY,
    withCommand: false,
    commandSettle: Number.POSITIVE_INFINITY,
    result: null,
  });
}

export function projectTimeout(ms: number): Conversation {
  const bounded = Math.max(0, ms);
  const phase: Phase = bounded >= TIMEOUT_START ? 'timeout' : bounded >= DICTATE_START ? 'dictate' : 'wake';
  const phaseStart = phase === 'timeout' ? TIMEOUT_START : phase === 'dictate' ? DICTATE_START : 0;
  return buildTurn({
    id: TIMEOUT_ID,
    startedAt: '20:03:12',
    ms: bounded,
    phase,
    phaseStart,
    hasVolume: false,
    dictateEnd: TIMEOUT_START,
    withCommand: false,
    commandSettle: Number.POSITIVE_INFINITY,
    result: null,
  });
}

const HISTORY: Conversation[] = [
  {
    id: 'hist-194106',
    startedAt: '19:41:06',
    phase: 'done',
    result: null,
    lines: [
      line({ key: 'u', kind: 'user', name: USER_NAME, text: '现在几点', settled: true }),
      line({ key: 'm', kind: 'miduo', name: SPEAKER_NAME, text: '晚上七点四十一', settled: true }),
    ],
  },
  {
    id: 'hist-194722',
    startedAt: '19:47:22',
    phase: 'done',
    result: null,
    lines: [
      line({ key: 'u', kind: 'user', name: USER_NAME, text: '把音量调小一点', settled: true }),
      line({ key: 'm', kind: 'miduo', name: SPEAKER_NAME, text: '好，已经调小', settled: true }),
    ],
  },
  {
    id: 'hist-195240',
    startedAt: '19:52:40',
    phase: 'done',
    result: null,
    lines: [
      line({ key: 'u', kind: 'user', name: USER_NAME, text: '今天还有会吗', settled: true }),
      line({ key: 'm', kind: 'miduo', name: SPEAKER_NAME, text: '今晚没有会', settled: true }),
    ],
  },
  {
    id: 'hist-195512',
    startedAt: '19:55:12',
    phase: 'done',
    result: null,
    lines: [
      line({ key: 'u', kind: 'user', name: USER_NAME, text: '提醒我明早看周报', settled: true }),
      line({ key: 'm', kind: 'miduo', name: SPEAKER_NAME, text: '好，明早九点提醒你', settled: true }),
    ],
  },
];

/** 只纳入会改变日志高度的字段。音量起伏只改波形柱高，容器高度不变，不触发跟随。 */
export function logScrollSignature(conversations: Conversation[]): string {
  return conversations.map((item) => {
    const lines = item.lines.map((row) => [
      row.text,
      row.stage ?? '',
      row.note ?? '',
      row.time ?? '',
      row.showSettleMark ? '1' : '0',
      row.volume ? '1' : '0',
    ].join('\u0001')).join('\u0002');
    return `${item.id}:${item.phase}:${lines}`;
  }).join('|');
}

export function buildScreen(snap: PlayerSnap): ScreenModel {
  const conversations = HISTORY.map((item) => ({ ...item, lines: item.lines.map((row) => ({ ...row })) }));
  let clock = '待机';
  if (snap.script === 'sample') {
    const sample = projectSample(snap.ms);
    conversations.push(sample);
    clock = snap.ms >= SAMPLE_DURATION_MS ? SAMPLE_END : addSeconds(SAMPLE_START, Math.floor(snap.ms / 1000));
    if (snap.round2 !== null) {
      conversations.push(projectRound2(snap.round2));
      clock = addSeconds(NEXT_ROUND_AT, Math.floor(snap.round2 / 1000));
    }
  } else if (snap.script === 'timeout') {
    conversations.push(projectTimeout(snap.ms));
    clock = '20:03:12';
  }
  const sample = conversations.find((item) => item.id === SAMPLE_ID);
  return {
    clock,
    page: sample?.phase === 'done' ? 'tasks' : 'home',
    conversations,
    snap,
  };
}

export function screenAt(partial: Partial<PlayerSnap> & Pick<PlayerSnap, 'script' | 'ms'>): ScreenModel {
  return buildScreen({
    round2: null,
    rate: 1,
    reduceMotion: true,
    theme: 'dark',
    playing: false,
    frame: null,
    ...partial,
  });
}
