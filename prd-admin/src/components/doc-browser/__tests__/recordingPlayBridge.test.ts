import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RECORDING_PLAY_REQUEST_EVENT,
  requestRecordingPlay,
  onRecordingPlayRequest,
  __resetRecordingPlayBridge,
} from '../recordingPlayBridge';

const SRC = path.resolve(__dirname, '..');

/**
 * 这套单测跑在没有 DOM 的环境里。通道两端都要 window，所以这里搭一个最小的
 * EventTarget 当 window——不是给它开豁免，是让它在测试里也走真实的事件路径。
 */
const hadWindow = 'window' in globalThis;
beforeAll(() => {
  if (!hadWindow) {
    (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
  }
});
afterAll(() => {
  if (!hadWindow) delete (globalThis as unknown as { window?: EventTarget }).window;
});
beforeEach(() => { __resetRecordingPlayBridge(); vi.useRealTimers(); });

describe('录音播放窄通道', () => {
  it('request 会触发已订阅的 handler', () => {
    const handler = vi.fn();
    const off = onRecordingPlayRequest(handler);
    requestRecordingPlay();
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    requestRecordingPlay();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('事件名两端共用同一个常量，不是各写一份字符串', () => {
    expect(RECORDING_PLAY_REQUEST_EVENT).toBe('map:recording-play-request');
  });

  /**
   * 这条守卫防的是「建了一半的接线」：通道本身有单测、两端却没人用，
   * 按钮点了没反应而测试全绿。删掉任一端这条都会红。
   */
  it('两端都真的接上了：状态卡在 request，播放器在 subscribe', () => {
    const card = fs.readFileSync(path.join(SRC, 'DocBrowser.tsx'), 'utf-8');
    expect(card).toContain('requestRecordingPlay');
    expect(card).toContain('onPlayRequest={requestRecordingPlay}');

    const player = fs.readFileSync(path.join(SRC, 'AudioWavePlayer.tsx'), 'utf-8');
    expect(player).toContain('onRecordingPlayRequest');
  });

  /*
   * 「进入结果页并开始播放」时，请求发生在播放器挂载之前。此前靠 setTimeout(120)
   * 等它挂上来，那 120ms 把用户手势的活跃期一起等没了，移动端 Safari 因此拒播。
   * 现在改由通道闩住这一次请求，播放器订阅时补发——这两条钉的就是它。
   */
  it('挂载前发出的请求会在播放器订阅时补发一次', () => {
    requestRecordingPlay();
    const handler = vi.fn();
    const off = onRecordingPlayRequest(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
  });

  it('闩只补发一次：第二个播放器订阅上来不会又响一遍', () => {
    requestRecordingPlay();
    const first = vi.fn();
    const offFirst = onRecordingPlayRequest(first);
    const second = vi.fn();
    const offSecond = onRecordingPlayRequest(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    offFirst();
    offSecond();
  });

  it('已经有播放器在听时不闩：换页重挂一个播放器不会自己响', () => {
    const live = vi.fn();
    const offLive = onRecordingPlayRequest(live);
    requestRecordingPlay();
    expect(live).toHaveBeenCalledTimes(1);
    offLive();

    const later = vi.fn();
    const offLater = onRecordingPlayRequest(later);
    expect(later).not.toHaveBeenCalled();
    offLater();
  });

  it('过期的请求不补发：十几秒前那一下再响，用户已不认得是自己点的', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T00:00:00Z'));
    requestRecordingPlay();
    vi.setSystemTime(new Date('2026-08-28T00:00:20Z'));
    const handler = vi.fn();
    const off = onRecordingPlayRequest(handler);
    expect(handler).not.toHaveBeenCalled();
    off();
    vi.useRealTimers();
  });

  /*
   * 自动起播被浏览器拦下（NotAllowedError）不是「这段录音坏了」。此前它和真正的
   * 播放失败共用一条 catch，于是整块播放器被换成红底「无法播放 + 下载原录音」——
   * 用户看到的是故障，实际只差点一下。这条钉住控件不许被换掉。
   */
  it('播放器把「被拦下」与「真的播不了」分成两条路', () => {
    const player = fs.readFileSync(path.join(SRC, 'AudioWavePlayer.tsx'), 'utf-8');
    expect(player).toContain("name === 'NotAllowedError'");
    expect(player).toContain('setAutoplayBlocked(true)');
    // 被拦下时不得走进那条把整块播放器换成下载兜底的分支
    expect(player).not.toContain(".catch(() => setError('当前浏览器无法播放这段录音'))");
  });

  it('结果页的 ?play=1 不再靠定时器等播放器挂载', () => {
    const page = fs.readFileSync(
      path.resolve(SRC, '../../pages/document-store/RecordingResultPage.tsx'),
      'utf-8',
    );
    const autoplay = page.slice(page.indexOf("searchParams.get('play')"));
    expect(autoplay.slice(0, 800)).not.toContain('setTimeout');
  });
});
