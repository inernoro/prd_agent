import { describe, expect, it } from 'vitest';
import {
  StreamingPcm16Resampler,
  PcmFrameAccumulator,
  encodeLivePcmFrame,
  floatToPcm16,
  reduceLiveTranscriptionView,
} from '../liveTranscription';

describe('实时转写 PCM 协议', () => {
  it('48kHz 一百毫秒音频稳定降采样为 16kHz 一千六百点', () => {
    const input = Float32Array.from({ length: 4_800 }, (_, index) =>
      Math.sin(index / 20) * 0.5);
    const resampler = new StreamingPcm16Resampler(48_000);

    const output = resampler.process(input);

    expect(output.length).toBe(1_600);
    expect(output.some(sample => sample !== 0)).toBe(true);
  });

  it('连续小块与单个大块的输出总长度一致，避免长录音逐块漂移', () => {
    const chunks = Array.from({ length: 100 }, () => new Float32Array(480).fill(0.25));
    const chunked = new StreamingPcm16Resampler(48_000);
    const chunkedLength = chunks.reduce((total, chunk) => total + chunked.process(chunk).length, 0);
    const whole = new StreamingPcm16Resampler(48_000).process(new Float32Array(48_000).fill(0.25));

    expect(chunkedLength).toBe(whole.length);
    expect(whole.length).toBe(16_000);
  });

  it('任意 AudioWorklet 小块都聚合为固定一百毫秒帧，停止时保留尾帧', () => {
    const accumulator = new PcmFrameAccumulator(1_600);
    const frames = [
      ...accumulator.push(new Int16Array(700).fill(1)),
      ...accumulator.push(new Int16Array(1_000).fill(2)),
      ...accumulator.push(new Int16Array(1_500).fill(3)),
    ];
    const tail = accumulator.flush();

    expect(frames.map(frame => frame.length)).toEqual([1_600, 1_600]);
    expect(tail).toBeNull();

    accumulator.push(new Int16Array(321).fill(4));
    expect(accumulator.flush()?.length).toBe(321);
  });

  it('帧头使用四字节小端顺序号，PCM16 紧随其后', () => {
    const encoded = encodeLivePcmFrame(258, Int16Array.from([0x1234, -2]));
    const view = new DataView(encoded);

    expect(view.getInt32(0, true)).toBe(258);
    expect(view.getInt16(4, true)).toBe(0x1234);
    expect(view.getInt16(6, true)).toBe(-2);
  });

  it('浮点振幅做饱和转换，不发生整数回绕', () => {
    expect(floatToPcm16(2)).toBe(32767);
    expect(floatToPcm16(-2)).toBe(-32768);
  });
});

describe('实时转写展示状态', () => {
  it('partial 更新文字，final 固化文字', () => {
    const partial = reduceLiveTranscriptionView('', { type: 'partial', text: '第一句' });
    const completed = reduceLiveTranscriptionView(partial.text, { type: 'final', text: '第一句完成' });

    expect(partial).toMatchObject({ text: '第一句', state: 'live' });
    expect(completed).toMatchObject({ text: '第一句完成', state: 'completed' });
  });

  it('降级保留已有局部文字并明确进入批处理校准', () => {
    const degraded = reduceLiveTranscriptionView('已识别部分', {
      type: 'degraded',
      message: '结束后自动校准',
    });

    expect(degraded).toEqual({
      text: '已识别部分',
      state: 'degraded',
      message: '结束后自动校准',
    });
  });
});
