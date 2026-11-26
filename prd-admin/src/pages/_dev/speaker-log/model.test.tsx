import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpeakerLogScreen } from './SpeakerLogPrototype';
import {
  COMMAND,
  KEYFRAMES,
  KEYFRAME_DICTATE_MS,
  KEYFRAME_EXECUTE_MS,
  KEYFRAME_TIMEOUT_MS,
  KEYFRAME_WAKE_MS,
  NEXT_ROUND_AT,
  REPLY,
  ROUND2_ID,
  SAMPLE_DURATION_MS,
  SAMPLE_DURATION_SEC,
  SAMPLE_END,
  SAMPLE_ID,
  SAMPLE_START,
  USER_NAME,
  addSeconds,
  CAPTION_HOLD_MS,
  captionHoldRemaining,
  changedCharIndexes,
  freshCaptionIndexes,
  logScrollSignature,
  stampChangedChars,
  nextScrollTop,
  projectRound2,
  projectSample,
  projectTimeout,
  screenAt,
} from './model';

const noop = () => undefined;
const actions = { jump: noop, setRate: noop, replay: noop, toggleReduce: noop, setTheme: noop };

function renderAt(partial: Parameters<typeof screenAt>[0]) {
  return renderToStaticMarkup(
    <SpeakerLogScreen model={screenAt(partial)} actions={actions} />,
  );
}

describe('音箱日志样例时间', () => {
  it('19:58:08 经过 8 秒是 19:58:16', () => {
    expect(addSeconds(SAMPLE_START, SAMPLE_DURATION_SEC)).toBe(SAMPLE_END);
    expect(SAMPLE_DURATION_MS).toBe(8_000);
  });

  it('同一轮只保留一个会话编号', () => {
    const wake = projectSample(KEYFRAME_WAKE_MS);
    const dictate = projectSample(KEYFRAME_DICTATE_MS);
    const execute = projectSample(KEYFRAME_EXECUTE_MS);
    const done = projectSample(SAMPLE_DURATION_MS);
    expect(new Set([wake.id, dictate.id, execute.id, done.id])).toEqual(new Set([SAMPLE_ID]));
    expect(wake.phase).toBe('wake');
    expect(dictate.phase).toBe('dictate');
    expect(execute.phase).toBe('execute');
    expect(done.phase).toBe('done');
  });

  it('完成后给出实际打开的菜单和本轮秒数', () => {
    const done = projectSample(SAMPLE_DURATION_MS);
    expect(done.startedAt).toBe('19:58:08');
    expect(done.result).toEqual({ menu: '任务台', durationSec: 8, at: '19:58:16' });
    expect(done.lines.find((row) => row.kind === 'result')?.text).toBe('已打开 · 本轮 8 秒');
  });

  it('唤醒闪光结束后立刻出现我在', () => {
    const before = projectSample(419);
    const after = projectSample(KEYFRAME_WAKE_MS);
    expect(before.lines.find((row) => row.kind === 'miduo')?.text).toBe('');
    expect(before.lines.find((row) => row.kind === 'miduo')?.flash).toBe(true);
    expect(after.lines.find((row) => row.kind === 'miduo')?.text).toBe(REPLY);
    expect(after.lines.find((row) => row.kind === 'miduo')?.flash).toBe(false);
    expect(after.lines.find((row) => row.kind === 'miduo')?.lit).toBe(true);
  });

  it('听写超过 2 秒才显示阶段和已等待秒数，并带音量波形', () => {
    expect(projectSample(2_900).lines.find((row) => row.kind === 'miduo')?.stage).toBeNull();
    const at = projectSample(2_901);
    expect(at.lines.find((row) => row.kind === 'miduo')?.stage).toBe('听写 · 已等待 2 秒');
    const dictate = projectSample(KEYFRAME_DICTATE_MS);
    const miduo = dictate.lines.find((row) => row.kind === 'miduo');
    expect(miduo?.stage).toBe('听写 · 已等待 2 秒');
    expect(miduo?.volume).not.toBeNull();
    expect(dictate.lines.find((row) => row.key === 'user-command')?.text).toBe(COMMAND);
    expect(dictate.lines.find((row) => row.key === 'user-command')?.settled).toBe(false);
  });

  it('听写结束才定稿，执行阶段不再显示波形', () => {
    const execute = projectSample(KEYFRAME_EXECUTE_MS);
    const command = execute.lines.find((row) => row.key === 'user-command');
    expect(command?.settled).toBe(true);
    expect(execute.lines.find((row) => row.kind === 'miduo')?.volume).toBeNull();
    expect(execute.lines.find((row) => row.kind === 'miduo')?.stage).toBe('执行 · 已等待 2 秒');
    expect(execute.result).toBeNull();
  });

  it('没有音量数据时不产生波形', () => {
    const listening = projectTimeout(2_000);
    const timedOut = projectTimeout(KEYFRAME_TIMEOUT_MS);
    expect(listening.lines.find((row) => row.kind === 'miduo')?.volume).toBeNull();
    expect(timedOut.lines.find((row) => row.kind === 'miduo')?.volume).toBeNull();
    expect(timedOut.phase).toBe('timeout');
    expect(timedOut.lines.find((row) => row.kind === 'miduo')?.stage).toBe('超时 · 已等待 2 秒');
    expect(timedOut.lines.find((row) => row.kind === 'miduo')?.note).toBe('没有听清，请再说一次');
  });

  it('19:59:51 是独立的下一轮，不改写上一轮', () => {
    const screen = screenAt({ script: 'sample', ms: SAMPLE_DURATION_MS, round2: 1_800 });
    const first = screen.conversations.find((item) => item.id === SAMPLE_ID);
    const second = screen.conversations.find((item) => item.id === ROUND2_ID);
    expect(first?.result?.at).toBe(SAMPLE_END);
    expect(first?.lines.some((row) => row.text.includes(COMMAND))).toBe(true);
    expect(second?.startedAt).toBe(NEXT_ROUND_AT);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.lines.some((row) => row.text.includes(COMMAND))).toBe(false);
    expect(second?.lines.find((row) => row.kind === 'miduo')?.text).toBe(REPLY);
    expect(second?.lines.find((row) => row.kind === 'miduo')?.volume).toBeNull();
    expect(projectRound2(1_800).phase).toBe('dictate');
  });

  it('阶段名冒出来时滚动签名会变，音量起伏不会', () => {
    const beforeLabel = projectSample(2_820);
    const withLabel = projectSample(2_901);
    expect(beforeLabel.phase).toBe(withLabel.phase);
    expect(beforeLabel.lines.map((row) => row.text).join()).toBe(withLabel.lines.map((row) => row.text).join());
    expect(beforeLabel.lines.find((row) => row.kind === 'miduo')?.stage).toBeNull();
    expect(withLabel.lines.find((row) => row.kind === 'miduo')?.stage).toBe('听写 · 已等待 2 秒');
    expect(logScrollSignature([beforeLabel])).not.toBe(logScrollSignature([withLabel]));

    const executeQuiet = projectSample(7_200);
    const executeWaiting = projectSample(7_201);
    expect(executeQuiet.phase).toBe('execute');
    expect(executeWaiting.lines.find((row) => row.kind === 'miduo')?.stage).toBe('执行 · 已等待 2 秒');
    expect(logScrollSignature([executeQuiet])).not.toBe(logScrollSignature([executeWaiting]));

    const loud = projectSample(3_000);
    const soft = projectSample(3_140);
    expect(loud.lines.find((row) => row.kind === 'miduo')?.volume).not.toEqual(
      soft.lines.find((row) => row.kind === 'miduo')?.volume,
    );
    expect(logScrollSignature([loud])).toBe(logScrollSignature([soft]));
  });

  it('只标变化的字，阅读历史时不改滚动位置', () => {
    expect(changedCharIndexes('打开', '打开任')).toEqual([2]);
    expect(changedCharIndexes('打开任', '打开任')).toEqual([]);
    const first = stampChangedChars([], '', '米', 0);
    const both = stampChangedChars(first, '米', '米多', 70);
    expect(freshCaptionIndexes(both, 100)).toEqual([0, 1]);
    expect(freshCaptionIndexes(both, CAPTION_HOLD_MS)).toEqual([1]);
    expect(freshCaptionIndexes(both, 70 + CAPTION_HOLD_MS)).toEqual([]);
    expect(captionHoldRemaining(both, 100)).toBe(60);
    expect(nextScrollTop({
      scrollTop: 40, scrollHeight: 400, clientHeight: 200, nextScrollHeight: 520,
    })).toBe(40);
    expect(nextScrollTop({
      scrollTop: 200, scrollHeight: 400, clientHeight: 200, nextScrollHeight: 520,
    })).toBe(320);
  });
});

describe('音箱日志画面', () => {
  it('六个关键帧、四种播放方式和深浅面板都能点到', () => {
    const html = renderAt({ script: 'idle', ms: 0, frame: 'idle' });
    for (const frame of KEYFRAMES) expect(html).toContain(frame.label);
    expect(html).toContain('正常速度');
    expect(html).toContain('慢放');
    expect(html).toContain('重播');
    expect(html).toContain('减少动态效果');
    expect(html).toContain('深色');
    expect(html).toContain('浅色');
    expect(html).toContain('data-opaque="1"');
    expect(html).toContain(USER_NAME);
  });

  it('完成时打开任务台，听写有波形，超时没有波形', () => {
    const done = renderAt({ script: 'sample', ms: SAMPLE_DURATION_MS, frame: 'done' });
    expect(done).toContain('data-page="tasks"');
    expect(done).toContain('data-kind="result"');
    expect(done).toContain('data-text="已打开 · 本轮 8 秒"');
    expect(done).toContain('19:58:16');
    expect(done).toContain('19:58:08');

    const dictate = renderAt({ script: 'sample', ms: KEYFRAME_DICTATE_MS, frame: 'dictate' });
    expect(dictate).toContain('data-waveform="1"');
    expect(dictate).toContain('听写 · 已等待 2 秒');
    expect(dictate).toContain('data-settled="0"');

    const timeout = renderAt({ script: 'timeout', ms: KEYFRAME_TIMEOUT_MS, frame: 'timeout' });
    expect(timeout).not.toContain('data-waveform');
    expect(timeout).toContain('没有听清，请再说一次');
    expect(timeout).toContain('data-page="home"');
  });

  it('下一轮追加在原会话之后', () => {
    const html = renderAt({ script: 'sample', ms: SAMPLE_DURATION_MS, round2: 1_800 });
    expect(html.indexOf(SAMPLE_ID)).toBeGreaterThan(-1);
    expect(html.indexOf(ROUND2_ID)).toBeGreaterThan(html.indexOf(SAMPLE_ID));
    expect(html).toContain(NEXT_ROUND_AT);
  });

  it('浅色面板挂上浅色主题，样式本身不走玻璃', () => {
    const html = renderAt({ script: 'idle', ms: 0, theme: 'light' });
    expect(html).toContain('data-theme="light"');
    const css = readFileSync(new URL('./speaker-log.css', import.meta.url), 'utf8');
    expect(css).toContain('background: var(--bg-base)');
    expect(css).not.toContain('backdrop-filter');
  });
});
