import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RECORDING_PLAY_REQUEST_EVENT,
  requestRecordingPlay,
  onRecordingPlayRequest,
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
});
