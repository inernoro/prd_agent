import { describe, expect, it } from 'vitest';
import { recordingExtension, selectRecordingMimeType } from '../recordingMedia';

describe('selectRecordingMimeType', () => {
  it('iPhone 同时支持 MP4 与 WebM 时优先选择可回放的 MP4/AAC', () => {
    const supported = new Set(['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus']);
    expect(selectRecordingMimeType((mime) => supported.has(mime)))
      .toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('不支持 MP4 的浏览器回退到 WebM/Opus', () => {
    expect(selectRecordingMimeType((mime) => mime === 'audio/webm;codecs=opus'))
      .toBe('audio/webm;codecs=opus');
  });

  it('浏览器没有声明任何候选格式时交给 MediaRecorder 自选', () => {
    expect(selectRecordingMimeType(() => false)).toBe('');
  });
});

describe('recordingExtension', () => {
  it('MP4 音频使用 m4a 扩展名', () => {
    expect(recordingExtension('audio/mp4')).toBe('.m4a');
  });
});
